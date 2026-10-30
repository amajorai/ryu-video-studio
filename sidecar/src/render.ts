import { join } from "node:path";
import { loopedMediaTime } from "../../shared/background.ts";
import {
	duckKey,
	type ResolvedDuck,
	resolveDuck,
} from "../../shared/ducking.ts";
import {
	ffmpegFrameRate,
	framesToTime,
	timeToFrames,
} from "../../shared/frame-rate.ts";
import { MAX_TRACK_INDEX } from "../../shared/limits.ts";
import { keepsCanvasAspect } from "../../shared/output-resolution.ts";
import {
	type Asset,
	type Project,
	projectDuration,
	type Segment,
	segmentDuration,
	validateProject,
} from "../../shared/project.ts";
import {
	needsOutputScale,
	type RenderPlan,
	resolveRenderPlan,
} from "../../shared/render-options.ts";
import type { AssetColorTransfer } from "../../shared/schema/asset.ts";
import { backgroundOf } from "../../shared/schema/defaults.ts";
import { curvePreservesPitch } from "../../shared/schema/speed-curve.ts";
import {
	CURVE_SAMPLE_RATE,
	clipSourceOffset,
	clipSpeedAt,
	hasSpeedCurve,
} from "../../shared/speed-curve.ts";
import { subtitlesFontsOption } from "./fonts.ts";
import { MEDIA_FORMATS } from "./media.ts";
import { avatarFilters } from "./render-avatars.ts";
import {
	AUDIO_GROUP_CLIPS,
	audioGroupFileName,
	CHUNK_AUDIO_FILE,
	CHUNK_LIST_FILE,
	CHUNK_SEEK_PREROLL,
	chunkEncodeArgs,
	chunkFileName,
	concatList,
	graphFileName,
	INLINE_GRAPH_LIMIT,
	planRenderChunks,
	type RenderProgram,
	type RenderStep,
	type RenderWindow,
	restampFilter,
	segmentInWindow,
	shouldChunkRender,
	type WindowSeek,
	windowedProject,
	windowSeconds,
	windowSeek,
	withFilterScript,
} from "./render-chunks.ts";
import { encodeArgs, type RenderBuildOptions } from "./render-encode.ts";
import { graphicsFilters, type OverlayChain } from "./render-graphics.ts";
import {
	audioMixFilters,
	MIX_SAMPLE_RATE,
	segmentAudioFilters,
	waveformFilters,
} from "./render-segment-audio.ts";
import { segmentVideoFilters } from "./render-segment-video.ts";
import { spatialFilters } from "./render-spatial.ts";
import { adjustmentAfterTrack } from "./render-stages/adjustment.ts";
import { type BaseSource, baseSource } from "./render-stages/background.ts";
import type { ExtraInput, RenderStageContext } from "./render-stages/types.ts";
import {
	previousDrawnClips,
	segmentAudible,
	segmentDrawsVideo,
} from "./render-stages/visibility.ts";
import { SILENT_CURVE_AUDIO } from "./varispeed.ts";

/**
 * Render orchestrator. `buildRender` turns a project into FFmpeg argv:
 *
 * - inputs: the canvas (`baseSource`), one per clip, one per mesh, then any
 *   extra inputs the clip stages request;
 * - per clip, in track then start order: waveform source, video chain and
 *   placement (`render-segment-video.ts`), audio chain (`render-segment-audio.ts`);
 * - adjustment layers after each track (`adjustmentAfterTrack`);
 * - shape graphics, avatars, stage-world blocks, meshes and the ASS burn-in;
 * - the audio mix and the encoder arguments (`render-encode.ts`).
 *
 * Export options resolve into a `RenderPlan` (`shared/render-options.ts`)
 * that adds the output finishing: a transparent canvas for alpha exports, a
 * fit-and-pad scale to the output size, the GIF palette pass, and the
 * audio-only graph that skips every video stage.
 *
 * The per-stage behaviour lives in `render-stages/*.ts`; the golden suite in
 * `render-golden.test.ts` pins the argv of the default options.
 *
 * Long timelines render in chunks (`render-chunks.ts`, W4-Q1):
 * `buildRenderProgram` returns either the one-pass argv or a program of
 * window renders (`window` option: the same graph on the timeline clock,
 * limited to the clips and overlays of one window, into a lossless
 * intermediate), audio sub-mixes summed in one last audio pass, and a final
 * join-and-encode step.
 */

export { assCaptions } from "./render-ass.ts";
export type {
	RenderChunk,
	RenderProgram,
	RenderStep,
	RenderWindow,
} from "./render-chunks.ts";
export type { RenderBuildOptions } from "./render-encode.ts";
export { RenderQueue } from "./render-queue.ts";

export interface MeshInput {
	end: number;
	path: string;
	sequence?: boolean;
	start: number;
}

/** Render options plus resolvers the orchestrator hands to the stages. */
export interface BuildRenderOptions extends RenderBuildOptions {
	/**
	 * Speed-curve clips' audio rendered ahead along their curves
	 * (`prepareCurveAudio` in `varispeed.ts`), by clip id: read in place of
	 * the clip's own audio and its `atempo` piece plan. Required for an
	 * audible tape-style curve (`speedCurve.preservePitch: false`).
	 */
	curveAudio?: ReadonlyMap<string, string>;
	/**
	 * The `fontsdir` for titles and captions (bundled plus imported fonts,
	 * from `FontLibrary.renderFontsDirectory`). Defaults to the bundled fonts;
	 * null uses system fonts only.
	 */
	fontsDirectory?: string | null;
	/** Local path of an imported LUT; required once clips reference LUTs (W2-V5). */
	lutPath?: (lutId: string) => string;
	/**
	 * Frame sequences of shape-keyframed graphics drawn ahead of the graph
	 * (`prepareShapeSequences` in `render-graphics.ts`), by sequence name.
	 * Required for any animated shape longer than a frame render's
	 * neighbourhood.
	 */
	shapeSequences?: ReadonlyMap<string, string>;
	/**
	 * Render only this window of a video export, silent, into a lossless
	 * chunk intermediate (W4-Q1). Set by `buildRenderProgram`.
	 */
	window?: RenderWindow;
}

/**
 * The extra input of a speed-curve clip's pre-rendered audio, when the
 * render was given one. An audible tape-style curve without it is refused:
 * FFmpeg has no time-varying tape-style rate to fall back to.
 */
function curveAudioInput(
	segment: Segment,
	curveAudio: ReadonlyMap<string, string> | undefined,
	audible: boolean,
	nextIndex: () => number
): { args: string[]; label: string } | undefined {
	if (!hasSpeedCurve(segment)) {
		return;
	}
	const path = curveAudio?.get(segment.id);
	if (!path) {
		if (audible && !curvePreservesPitch(segment.speedCurve)) {
			throw new Error(
				"Tape-style speed-curve audio is rendered before the export graph; this render was not given it."
			);
		}
		return;
	}
	if (path === SILENT_CURVE_AUDIO) {
		// Outside the export range: silence of the clip's exact length.
		return {
			args: [
				"-f",
				"lavfi",
				"-i",
				`anullsrc=r=${CURVE_SAMPLE_RATE}:cl=stereo,atrim=end_sample=${Math.max(1, Math.round(segmentDuration(segment) * CURVE_SAMPLE_RATE))}`,
			],
			label: `[${nextIndex()}:a]`,
		};
	}
	return {
		args: ["-i", path],
		label: `[${nextIndex()}:a]`,
	};
}

function missingLut(lutId: string): string {
	throw new Error(`The LUT ${lutId} is not available to this render.`);
}

function sourceInputArgs(
	segment: Segment,
	asset: Asset | undefined,
	fps: number,
	path: string,
	frameTime: number | undefined
): string[] {
	const args = asset?.kind === "image" ? ["-loop", "1"] : [];
	const seek =
		frameTime !== undefined && asset?.kind === "image"
			? 0
			: segment.sourceIn +
				(frameTime === undefined
					? 0
					: clipSourceOffset(segment, Math.max(0, frameTime - segment.start)));
	const length =
		frameTime === undefined
			? segment.sourceOut - segment.sourceIn
			: Math.max(
					0.1,
					clipSpeedAt(segment, Math.max(0, frameTime - segment.start)) / fps
				) + (asset?.kind === "audio" ? 1 : 0);
	args.push(
		"-protocol_whitelist",
		"file,pipe",
		"-format_whitelist",
		MEDIA_FORMATS,
		"-ss",
		String(seek),
		"-t",
		String(length),
		"-i",
		path
	);
	return args;
}

/**
 * Input of a clip in a window render: clips that cross the window start skip
 * the source before it on its own frame grid (`windowSeek`, all but about
 * `CHUNK_SEEK_PREROLL`), and every clip stops decoding a second past the
 * window end.
 */
function windowInputArgs(
	segment: Segment,
	asset: Asset | undefined,
	path: string,
	skipTo: WindowSeek | undefined,
	windowEnd: number
): string[] {
	const image = asset?.kind === "image";
	const skip = skipTo?.skip ?? 0;
	const local = Math.min(
		segmentDuration(segment),
		windowEnd - segment.start + CHUNK_SEEK_PREROLL
	);
	const length = Math.max(
		0.1,
		Number(
			(
				clipSourceOffset(segment, local) - clipSourceOffset(segment, skip)
			).toFixed(6)
		)
	);
	const seek = image ? 0 : (skipTo?.seek ?? segment.sourceIn);
	return [
		...(image ? ["-loop", "1"] : []),
		"-protocol_whitelist",
		"file,pipe",
		"-format_whitelist",
		MEDIA_FORMATS,
		"-ss",
		String(seek),
		"-t",
		String(length),
		"-i",
		path,
	];
}

/**
 * Add the skipped source frames back to a clip's source timing (`ticks`
 * from `windowSeek`), so every decoded frame keeps the clip-clock time the
 * one-pass render gives it: the window counterpart of the single-frame
 * offset in `render-segment-video.ts`. Returns `undefined` when the chain
 * does not start with the expected timing filter; the clip is then decoded
 * from its start instead.
 */
export function offsetSourceTiming(
	filters: readonly string[],
	n: number,
	speed: number,
	ticks: string
): string[] | undefined {
	const head = `[${n}:v]`;
	const index = filters.findIndex((filter) => filter.startsWith(head));
	const statement = filters[index];
	// A speed curve's remap (`speedCurveSetpts`) reads source seconds from
	// the first decoded frame; the skipped frames are added to that clock.
	const curveClock = "setpts='st(0,(PTS-STARTPTS)*TB);";
	if (statement?.startsWith(`${head}${curveClock}`)) {
		const next = [...filters];
		next[index] =
			`${head}setpts='st(0,(PTS-STARTPTS+${ticks})*TB);${statement.slice(head.length + curveClock.length)}`;
		return next;
	}
	const timing = `setpts=(PTS-STARTPTS)/${speed}`;
	if (!statement?.startsWith(`${head}${timing}`)) {
		return;
	}
	const rest = statement.slice(head.length + timing.length);
	if (!(rest.startsWith(",") || rest.startsWith("["))) {
		return;
	}
	const next = [...filters];
	next[index] = `${head}setpts=(PTS-STARTPTS+${ticks})/${speed}${rest}`;
	return next;
}

/**
 * The canvas of a window render: the usual canvas for the window's length,
 * restamped onto the timeline frame grid from the window's first frame. A
 * looped canvas video starts where the export's loop is at that time.
 */
function windowBase(
	p: Project,
	window: RenderWindow,
	assets: Asset[],
	mediaPath: (id: string) => string
): BaseSource {
	const length = framesToTime(window.frames + 1, p.fps);
	const base = baseSource(p, length, undefined, {
		asset: (id) => assets.find((candidate) => candidate.id === id),
		mediaPath,
	});
	const filters = [...base.filters];
	const last = filters.at(-1);
	if (!last?.endsWith("[base]")) {
		throw new Error("The canvas of a chunk render could not be placed.");
	}
	filters[filters.length - 1] =
		`${last.slice(0, -"[base]".length)},fps=${ffmpegFrameRate(p.fps)},setpts=PTS+${window.startFrame}[base]`;
	const background = backgroundOf(p);
	const media =
		background.type === "image"
			? assets.find((candidate) => candidate.id === background.assetId)
			: undefined;
	const loop = base.args.indexOf("-stream_loop");
	const seek =
		media?.kind === "video"
			? loopedMediaTime(windowSeconds(window, p.fps).start, media.duration)
			: 0;
	const args = [...base.args];
	if (seek > 0 && loop >= 0) {
		args.splice(loop + 2, 0, "-ss", `${seek}`);
	}
	return { args, filters };
}

/** Meshes with any frame in the window. */
function windowMeshes(
	meshes: MeshInput[],
	window: RenderWindow,
	fps: number
): MeshInput[] {
	const { end, start } = windowSeconds(window, fps);
	return meshes.filter((mesh) => mesh.start <= end && mesh.end >= start);
}

/** First frame of a mesh sequence a window needs. */
function meshStartFrame(
	mesh: MeshInput,
	window: RenderWindow,
	fps: number
): number {
	const before = windowSeconds(window, fps).start - mesh.start;
	return before > 0 ? timeToFrames(before, fps, "floor") : 0;
}

function meshInputArgs(
	mesh: MeshInput,
	fps: number,
	duration: number,
	frameTime: number | undefined,
	window?: RenderWindow
): string[] {
	if (mesh.sequence && window) {
		const first = meshStartFrame(mesh, window, fps);
		return [
			"-framerate",
			ffmpegFrameRate(fps),
			"-start_number",
			String(first),
			"-t",
			String(
				Math.max(
					1 / fps,
					Number((mesh.end - mesh.start - framesToTime(first, fps)).toFixed(6))
				)
			),
			"-i",
			join(mesh.path, "frame-%06d.png"),
		];
	}
	if (window && !mesh.sequence) {
		return [
			"-loop",
			"1",
			"-framerate",
			ffmpegFrameRate(fps),
			"-t",
			String(framesToTime(window.frames + 1, fps)),
			"-i",
			mesh.path,
		];
	}
	if (mesh.sequence) {
		return [
			"-framerate",
			ffmpegFrameRate(fps),
			"-t",
			String(mesh.end - mesh.start),
			"-i",
			join(mesh.path, "frame-%06d.png"),
		];
	}
	return [
		"-loop",
		"1",
		"-framerate",
		ffmpegFrameRate(fps),
		"-t",
		String(frameTime === undefined ? duration : Math.max(0.1, 1 / fps)),
		"-i",
		mesh.path,
	];
}

function meshTiming(
	mesh: MeshInput,
	fps: number,
	frameTime: number | undefined,
	window: RenderWindow | undefined
): string {
	if (frameTime !== undefined) {
		return `setpts=PTS-STARTPTS+${frameTime}/TB`;
	}
	if (window && mesh.sequence) {
		const offset =
			mesh.start + framesToTime(meshStartFrame(mesh, window, fps), fps);
		return `setpts=PTS-STARTPTS+${Number(offset.toFixed(9))}/TB`;
	}
	if (window) {
		// The looped still is read at the project rate, so its timebase is
		// one frame and the shift is a whole number of ticks.
		return `setpts=PTS-STARTPTS+${window.startFrame}`;
	}
	return mesh.sequence ? `setpts=PTS-STARTPTS+${mesh.start}/TB` : "null";
}

function meshOverlayFilters(
	meshInputs: MeshInput[],
	firstInput: number,
	frameTime: number | undefined,
	input: string,
	fps = 30,
	window?: RenderWindow
): OverlayChain {
	const filters: string[] = [];
	let last = input;
	for (const [index, mesh] of meshInputs.entries()) {
		const output = `mesh${index}`;
		const timing = meshTiming(mesh, fps, frameTime, window);
		filters.push(
			`[${firstInput + index}:v]format=rgba,${timing}[meshInput${index}]`
		);
		filters.push(
			`[${last}][meshInput${index}]overlay=x=0:y=0:eof_action=pass:enable='between(t,${mesh.start},${mesh.end})'[${output}]`
		);
		last = output;
	}
	return { filters, last };
}

/** Color transfers of the sources the timeline's clips read. */
function sourceTransfers(p: Project, assets: Asset[]): AssetColorTransfer[] {
	const used = new Set(p.segments.map((segment) => segment.assetId));
	const transfers = new Set<AssetColorTransfer>();
	for (const asset of assets) {
		if (used.has(asset.id) && asset.colorTransfer) {
			transfers.add(asset.colorTransfer);
		}
	}
	return [...transfers].sort();
}

/** A fully transparent canvas for alpha exports (replaces the background). */
export function transparentBase(p: Project, duration: number) {
	return {
		args: [
			"-f",
			"lavfi",
			"-i",
			// The lavfi input negotiates its own format; `format=rgba` inside it
			// keeps the alpha plane that a bare `color` input would drop.
			`color=c=black@0:s=${p.width}x${p.height}:r=${ffmpegFrameRate(p.fps)}:d=${duration},format=rgba`,
		],
		filters: ["[0:v]format=yuva420p[base]"],
	};
}

/**
 * Output finishing after the composite: the GIF palette pass (trimmed to the
 * export span) or a fit-and-pad scale to the output size.
 */
function finishVideo(
	p: Project,
	plan: RenderPlan,
	input: string
): OverlayChain {
	if (plan.gif) {
		const { fps, height, width } = plan.gif;
		// A GIF whose size keeps the canvas aspect scales straight; any other
		// output size is fitted and letterboxed like the other containers.
		const sameAspect =
			height === Math.max(2, Math.round((width * p.height) / p.width));
		const scale = sameAspect
			? `scale=${width}:${height}:flags=lanczos`
			: `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
		return {
			filters: [
				`[${input}]trim=start=${plan.start}:end=${plan.start + plan.duration},setpts=PTS-STARTPTS,fps=${ffmpegFrameRate(fps)},${scale},split[gifFrames][gifPaletteSource]`,
				"[gifPaletteSource]palettegen=stats_mode=diff[gifPalette]",
				"[gifFrames][gifPalette]paletteuse=dither=sierra2_4a[gif]",
			],
			last: "gif",
		};
	}
	if (!needsOutputScale(plan, p)) {
		return { filters: [], last: input };
	}
	const { height, width } = plan.output;
	// A size that keeps the canvas aspect (tiers round to even sizes) scales
	// straight; any other size is fitted and letterboxed.
	if (keepsCanvasAspect(p, plan.output)) {
		return {
			filters: [
				`[${input}]scale=${width}:${height}:flags=lanczos,setsar=1[exportFrame]`,
			],
			last: "exportFrame",
		};
	}
	return {
		filters: [
			`[${input}]scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${plan.alpha ? "black@0" : "black"},setsar=1[exportFrame]`,
		],
		last: "exportFrame",
	};
}

export function buildRender(
	p: Project,
	assets: Asset[],
	mediaPath: (id: string, clipId?: string) => string,
	assFile?: string,
	meshInputs: MeshInput[] = [],
	frameTime?: number,
	options: BuildRenderOptions = {}
): string[] {
	validateProject(p, assets);
	return buildValidatedRender(
		p,
		assets,
		mediaPath,
		assFile,
		meshInputs,
		frameTime,
		options
	);
}

/**
 * `buildRender` for a project the caller already validated. A chunked export
 * builds one graph per window of the same project, and re-parsing every clip
 * of a long timeline once per window made planning quadratic in clip count.
 */
function buildValidatedRender(
	p: Project,
	assets: Asset[],
	mediaPath: (id: string, clipId?: string) => string,
	assFile: string | undefined,
	meshInputs: MeshInput[],
	frameTime: number | undefined,
	options: BuildRenderOptions
): string[] {
	const duration = projectDuration(p);
	if (!duration) {
		throw new Error("Add media, graphics, or an avatar before exporting.");
	}
	const {
		curveAudio,
		fontsDirectory,
		lutPath = missingLut,
		plan: givenPlan,
		shapeSequences,
		window,
		...request
	} = options;
	const resolvedPlan =
		frameTime === undefined
			? (givenPlan ??
				resolveRenderPlan(p, request, {
					sourceTransfers: sourceTransfers(p, assets),
					timelineDuration: duration,
				}))
			: undefined;
	if (window && !(resolvedPlan?.kind === "video" && !resolvedPlan.alpha)) {
		throw new Error(
			"Only opaque video exports render in chunks; render this export in one pass."
		);
	}
	// A chunk is silent: the audio is mixed in one pass over the whole span.
	const plan =
		window && resolvedPlan
			? { ...resolvedPlan, includeAudio: false }
			: resolvedPlan;
	const scoped = window ? windowedProject(p, window) : p;
	const windowEnd = window ? windowSeconds(window, p.fps).end : 0;
	const audioOnly = plan?.kind === "audio";
	// GIFs and frame sequences carry no audio, so no audio chain is built.
	const includeAudio =
		plan === undefined ||
		audioOnly ||
		(plan.kind === "video" && plan.includeAudio);
	const meshes = audioOnly
		? []
		: window
			? windowMeshes(meshInputs, window, p.fps)
			: meshInputs;
	const hasWaveform =
		!audioOnly &&
		p.segments.some(
			(segment) =>
				segment.visualization === "waveform" &&
				assets.find((asset) => asset.id === segment.assetId)?.kind === "audio"
		);
	const segments = p.segments
		.filter(
			(segment) =>
				(frameTime === undefined ||
					(frameTime >= segment.start &&
						frameTime <= segment.start + segmentDuration(segment))) &&
				(window === undefined || segmentInWindow(segment, window, p.fps))
		)
		.sort((a, b) => a.track - b.track || a.start - b.start);
	const baseDuration = duration + (hasWaveform ? 1 : 0);
	const canvasContext = {
		asset: (id: string) => assets.find((candidate) => candidate.id === id),
		mediaPath: (id: string) => mediaPath(id),
	};
	const base = plan?.alpha
		? transparentBase(p, baseDuration)
		: window
			? windowBase(p, window, assets, canvasContext.mediaPath)
			: baseSource(p, baseDuration, frameTime, canvasContext);
	const args = [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-y",
		"-filter_complex_threads",
		"1",
		...base.args,
	];
	/** How each windowed clip that skips ahead is opened. */
	const skips = new Map<string, WindowSeek>();
	const extraInputs: ExtraInput[] = [];
	const firstExtraInput = segments.length + meshes.length + 1;
	const filters: string[] = audioOnly ? [] : [...base.filters];
	const audio: string[] = [];
	const duckedAudio: string[] = [];
	const duckSettings: ResolvedDuck[] = [];
	const sidechainAudio: string[] = [];
	let last = "base";
	let adjustmentCount = 0;
	let nextAdjustmentTrack = 0;
	const flushAdjustments = (throughTrack: number) => {
		for (
			;
			nextAdjustmentTrack <= throughTrack;
			nextAdjustmentTrack++, adjustmentCount++
		) {
			const adjusted = adjustmentAfterTrack(
				scoped,
				nextAdjustmentTrack,
				last,
				adjustmentCount,
				{ lutPath }
			);
			filters.push(...adjusted.filters);
			last = adjusted.last;
		}
	};
	const previousClip = previousDrawnClips(p, assets);
	for (const [index, s] of segments.entries()) {
		const n = index + 1;
		const asset = assets.find((a) => a.id === s.assetId);
		const length = segmentDuration(s);
		const visualize =
			!audioOnly && asset?.kind === "audio" && s.visualization === "waveform";
		const audible =
			frameTime === undefined && includeAudio && segmentAudible(p, s, asset);
		if (!audioOnly) {
			flushAdjustments(s.track - 1);
		}
		const curveInput = curveAudioInput(
			s,
			curveAudio,
			audible,
			() => firstExtraInput + extraInputs.length
		);
		if (curveInput) {
			extraInputs.push({ args: curveInput.args });
		}
		if (visualize) {
			filters.push(
				...waveformFilters({
					audible,
					curveInput: curveInput?.label,
					n,
					p,
					s,
				})
			);
		}
		if (!audioOnly && segmentDrawsVideo(p, s, asset)) {
			const context: RenderStageContext = {
				inputIndex: (offset) => firstExtraInput + extraInputs.length + offset,
				lutPath,
				mediaPath: (id) => mediaPath(id),
				transparentCanvas: plan?.alpha === true,
			};
			const video = segmentVideoFilters({
				base: last,
				context,
				frameTime,
				length,
				n,
				p,
				previous: previousClip.get(s.id),
				s,
				visualize,
			});
			const skipTo =
				window && !visualize ? windowSeek(s, asset, window, p.fps) : undefined;
			const shifted = skipTo
				? offsetSourceTiming(video.filters, n, s.speed, skipTo.ticks)
				: undefined;
			if (skipTo && shifted) {
				skips.set(s.id, skipTo);
			}
			filters.push(...(shifted ?? video.filters));
			extraInputs.push(...video.inputs);
			last = video.last;
		}
		if (audible) {
			filters.push(
				...segmentAudioFilters({
					curveInput: curveInput?.label,
					length,
					n,
					p,
					s,
					visualize,
				})
			);
			const label = `[a${n}]`;
			audio.push(label);
			if (s.duckUnderVoice) {
				duckedAudio.push(label);
				duckSettings.push(resolveDuck(s.ducking));
			} else {
				sidechainAudio.push(label);
			}
		}
	}
	for (const segment of segments) {
		const asset = assets.find((a) => a.id === segment.assetId);
		const path = mediaPath(segment.assetId, segment.id);
		const windowed =
			window &&
			!(asset?.kind === "audio" && segment.visualization === "waveform");
		args.push(
			...(windowed
				? windowInputArgs(
						segment,
						asset,
						path,
						skips.get(segment.id),
						windowEnd
					)
				: sourceInputArgs(segment, asset, p.fps, path, frameTime))
		);
	}
	for (const mesh of meshes) {
		args.push(...meshInputArgs(mesh, p.fps, duration, frameTime, window));
	}
	if (!audioOnly) {
		flushAdjustments(MAX_TRACK_INDEX);
		const graphics = (project: Project, input: string) =>
			graphicsFilters(project, input, {
				...(frameTime === undefined ? {} : { frameTime }),
				...(shapeSequences ? { shapeSequences } : {}),
				...(window ? { window } : {}),
			});
		for (const overlay of [graphics, avatarFilters, spatialFilters]) {
			const chain = overlay(scoped, last);
			filters.push(...chain.filters);
			last = chain.last;
		}
		const meshChain = meshOverlayFilters(
			meshes,
			segments.length + 1,
			frameTime,
			last,
			p.fps,
			window
		);
		filters.push(...meshChain.filters);
		last = meshChain.last;
		if (assFile) {
			filters.push(
				`[${last}]subtitles=filename=${assFile}${subtitlesFontsOption(fontsDirectory)}[captioned]`
			);
			last = "captioned";
		}
		if (plan) {
			const finished = finishVideo(p, plan, last);
			filters.push(...finished.filters);
			last = finished.last;
		}
	}
	filters.push(
		...audioMixFilters({
			all: audio,
			ducked: duckedAudio,
			duckSettings,
			sidechain: sidechainAudio,
			until: duration,
		})
	);
	let mix = audio.length ? "mix" : undefined;
	if (audioOnly && mix) {
		// Hold the file to the timeline length when the last sound ends early.
		filters.push(`[mix]apad=whole_dur=${duration}[exportAudio]`);
		mix = "exportAudio";
	}
	if (audioOnly && !mix) {
		throw new Error("Nothing on the timeline is audible to export.");
	}
	for (const extra of extraInputs) {
		args.push(...extra.args);
	}
	if (window && plan) {
		// Chunks start at zero so the concat demuxer joins them end to end.
		filters.push(`[${last}]setpts=PTS-STARTPTS[chunkVideo]`);
		args.push(
			"-filter_complex",
			filters.join(";"),
			...chunkEncodeArgs(plan, "chunkVideo", window.frames)
		);
		return args;
	}
	args.push(
		"-filter_complex",
		filters.join(";"),
		...encodeArgs(p, plan ? { plan } : {}, {
			audio: mix,
			duration,
			frameTime,
			video: last,
		})
	);
	return args;
}

/** Options of `buildRenderProgram`: render options plus the output path. */
export interface RenderProgramOptions
	extends Omit<BuildRenderOptions, "window"> {
	/** Render in chunks even below the thresholds (verification and tests). */
	chunk?: boolean;
	/** Target chunk length in seconds (default 60). */
	chunkSeconds?: number;
	/** Output path of the finished export (the final step's output). */
	output: string;
}

/** Clips of one audio sub-mix: all ducking, or all driving the ducking. */
interface AudioGroup {
	/** Ducking every member shares; absent for the groups that drive it. */
	duck?: ResolvedDuck;
	segments: Segment[];
}

/**
 * Audible clips in groups of at most `AUDIO_GROUP_CLIPS`, in start order so
 * each group covers a short stretch of the timeline. Ducking clips and the
 * clips they duck under never share a group.
 */
function audioGroups(p: Project, assets: Asset[]): AudioGroup[] {
	const audible = p.segments
		.filter((segment) =>
			segmentAudible(
				p,
				segment,
				assets.find((asset) => asset.id === segment.assetId)
			)
		)
		.sort(
			(a, b) =>
				a.start - b.start || a.track - b.track || a.id.localeCompare(b.id)
		);
	const groups: AudioGroup[] = [];
	const pushGroups = (members: Segment[], duck?: ResolvedDuck) => {
		for (let at = 0; at < members.length; at += AUDIO_GROUP_CLIPS) {
			groups.push({
				...(duck ? { duck } : {}),
				segments: members.slice(at, at + AUDIO_GROUP_CLIPS),
			});
		}
	};
	pushGroups(audible.filter((segment) => segment.duckUnderVoice !== true));
	// Ducking is linear in the ducked signal for a fixed key, so clips that
	// share settings can be summed first and gated once.
	const byDuck = new Map<string, { duck: ResolvedDuck; members: Segment[] }>();
	for (const segment of audible) {
		if (segment.duckUnderVoice !== true) {
			continue;
		}
		const duck = resolveDuck(segment.ducking);
		const key = duckKey(duck);
		const entry = byDuck.get(key) ?? { duck, members: [] };
		entry.members.push(segment);
		byDuck.set(key, entry);
	}
	for (const { duck, members } of byDuck.values()) {
		pushGroups(members, duck);
	}
	return groups;
}

/**
 * The timeline sample (at `MIX_SAMPLE_RATE`) a group's file starts at: its
 * first clip's start, rounded down so every clip's own delay stays whole.
 */
function groupStartSample(group: AudioGroup): number {
	return Math.max(
		0,
		Math.floor(
			Math.min(...group.segments.map((s) => s.start)) * MIX_SAMPLE_RATE
		)
	);
}

/**
 * One audio sub-mix: each clip's usual chain (`segmentAudioFilters`) on a
 * clock that starts at the group's first clip, summed without limiting into
 * a float WAV, so the final mix can add the groups back exactly.
 */
function audioGroupArgs(
	p: Project,
	assets: Asset[],
	mediaPath: (id: string, clipId?: string) => string,
	group: AudioGroup,
	curveAudio: ReadonlyMap<string, string> | undefined
): string[] {
	const offset = groupStartSample(group) / MIX_SAMPLE_RATE;
	const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
	const filters: string[] = [];
	const labels: string[] = [];
	const curveInputs: string[] = [];
	for (const [n, segment] of group.segments.entries()) {
		const asset = assets.find((candidate) => candidate.id === segment.assetId);
		args.push(
			...sourceInputArgs(
				segment,
				asset,
				p.fps,
				mediaPath(segment.assetId, segment.id),
				undefined
			)
		);
		const curveInput = curveAudioInput(
			segment,
			curveAudio,
			true,
			() => group.segments.length + curveInputs.length / 2
		);
		if (curveInput) {
			curveInputs.push(...curveInput.args);
		}
		filters.push(
			...segmentAudioFilters({
				curveInput: curveInput?.label,
				length: segmentDuration(segment),
				n,
				p,
				s: { ...segment, start: segment.start - offset },
				visualize: false,
			})
		);
		labels.push(`[a${n}]`);
	}
	args.push(...curveInputs);
	filters.push(
		`${labels.join("")}amix=inputs=${labels.length}:normalize=0[groupMix]`
	);
	args.push(
		"-filter_complex",
		filters.join(";"),
		"-map",
		"[groupMix]",
		"-vn",
		"-c:a",
		"pcm_f32le",
		"-f",
		"wav"
	);
	return args;
}

/**
 * The last audio pass: every sub-mix delayed back to its place, the ducking
 * groups compressed against the sum of the rest (the gain depends only on
 * that sum, so ducking the group sums equals ducking each clip), then the
 * usual limiter, padded to the timeline and cut to the export span.
 */
function audioMixArgs(
	groups: AudioGroup[],
	plan: RenderPlan,
	duration: number
): string[] {
	const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
	const filters: string[] = [];
	const all: string[] = [];
	const ducked: string[] = [];
	const duckSettings: ResolvedDuck[] = [];
	const sidechain: string[] = [];
	for (const [index, group] of groups.entries()) {
		args.push("-i", audioGroupFileName(index));
		const label = `[group${index}]`;
		filters.push(
			`[${index}:a]adelay=${groupStartSample(group)}S:all=1${label}`
		);
		all.push(label);
		if (group.duck) {
			ducked.push(label);
			duckSettings.push(group.duck);
		} else {
			sidechain.push(label);
		}
	}
	filters.push(
		...audioMixFilters({
			all,
			ducked,
			duckSettings,
			sidechain,
			until: duration,
		})
	);
	filters.push(`[mix]apad=whole_dur=${duration}[exportAudio]`);
	args.push(
		"-filter_complex",
		filters.join(";"),
		"-map",
		"[exportAudio]",
		"-vn",
		...(plan.range ? ["-ss", String(plan.start)] : []),
		"-t",
		String(plan.duration),
		"-c:a",
		"pcm_f32le",
		"-f",
		"wav"
	);
	return args;
}

/** Name of a step's work files without the extension. */
function stepName(prefix: string, index: number): string {
	return `${prefix}-${String(index).padStart(4, "0")}`;
}

/**
 * The FFmpeg steps of one export. Short timelines (and GIFs, sequences,
 * audio files and alpha exports) are one `buildRender` step; its graph moves
 * to a script file in the work folder only when it is too long for one argv
 * string. Long ones (`shouldChunkRender`) are one silent lossless step per
 * chunk, audio sub-mixes of at most `AUDIO_GROUP_CLIPS` clips and one pass
 * that sums them, and a final step that joins the chunks with the concat
 * demuxer, restamps them on the frame grid and encodes them with the
 * export's own codec, audio and span arguments. Every chunked step reads its
 * graph from a script file (`-filter_complex_script`), and outputs and
 * helper files are relative to the work folder the steps run in.
 */
export function buildRenderProgram(
	p: Project,
	assets: Asset[],
	mediaPath: (id: string, clipId?: string) => string,
	assFile: string | undefined,
	meshInputs: MeshInput[],
	options: RenderProgramOptions
): RenderProgram {
	const { chunk, chunkSeconds, output, ...renderOptions } = options;
	validateProject(p, assets);
	const duration = projectDuration(p);
	if (!duration) {
		throw new Error("Add media, graphics, or an avatar before exporting.");
	}
	const {
		curveAudio,
		fontsDirectory,
		lutPath,
		plan: givenPlan,
		shapeSequences,
		...request
	} = renderOptions;
	const plan =
		givenPlan ??
		resolveRenderPlan(p, request, {
			sourceTransfers: sourceTransfers(p, assets),
			timelineDuration: duration,
		});
	const single = (): RenderProgram => {
		const args = buildValidatedRender(
			p,
			assets,
			mediaPath,
			assFile,
			meshInputs,
			undefined,
			{ ...renderOptions, plan }
		);
		const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
		if (Buffer.byteLength(graph) <= INLINE_GRAPH_LIMIT) {
			return { files: [], steps: [{ args, kind: "single", output }] };
		}
		const scripted = withFilterScript(args, graphFileName("single"));
		return {
			files: scripted.file ? [scripted.file] : [],
			steps: [{ args: scripted.args, kind: "single", output }],
		};
	};
	const chunkable = plan.kind === "video" && !plan.alpha;
	if (!(chunkable && (chunk || shouldChunkRender(p, plan)))) {
		return single();
	}
	const { chunks } = planRenderChunks(
		p,
		assets,
		{ duration: plan.duration, start: plan.start },
		chunkSeconds === undefined ? {} : { windowSeconds: chunkSeconds }
	);
	if (chunks.length < 2 && !chunk) {
		return single();
	}
	const files: RenderProgram["files"] = [
		{
			content: concatList(chunks.map((window) => chunkFileName(window.index))),
			name: CHUNK_LIST_FILE,
		},
	];
	const steps: RenderStep[] = [];
	const scripted = (
		args: string[],
		name: string,
		kind: RenderStep["kind"],
		stepOutput: string
	) => {
		const moved = withFilterScript(args, graphFileName(name));
		if (moved.file) {
			files.push(moved.file);
		}
		steps.push({ args: moved.args, kind, output: stepOutput });
	};
	for (const window of chunks) {
		scripted(
			buildValidatedRender(
				p,
				assets,
				mediaPath,
				assFile,
				meshInputs,
				undefined,
				{
					...(curveAudio ? { curveAudio } : {}),
					...(lutPath ? { lutPath } : {}),
					...(shapeSequences ? { shapeSequences } : {}),
					...(fontsDirectory === undefined ? {} : { fontsDirectory }),
					plan,
					window,
				}
			),
			stepName("chunk", window.index),
			"chunk",
			chunkFileName(window.index)
		);
	}
	const groups = plan.includeAudio ? audioGroups(p, assets) : [];
	for (const [index, group] of groups.entries()) {
		scripted(
			audioGroupArgs(p, assets, mediaPath, group, curveAudio),
			stepName("audio-group", index),
			"audio",
			audioGroupFileName(index)
		);
	}
	const audible = groups.length > 0;
	if (audible) {
		scripted(
			audioMixArgs(groups, plan, duration),
			"audio-mix",
			"audio-mix",
			CHUNK_AUDIO_FILE
		);
	}
	// The joined chunks already are the span, so the final encode starts at 0.
	const { range: _range, ...whole } = plan;
	const finalPlan: RenderPlan = { ...whole, start: 0 };
	const joinFilters = [`[0:v]${restampFilter(p.fps)}[joined]`];
	if (audible) {
		joinFilters.push("[1:a]anull[joinedAudio]");
	}
	scripted(
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-nostdin",
			"-y",
			"-f",
			"concat",
			"-i",
			CHUNK_LIST_FILE,
			...(audible ? ["-i", CHUNK_AUDIO_FILE] : []),
			"-filter_complex",
			joinFilters.join(";"),
			...encodeArgs(
				p,
				{ plan: finalPlan },
				{
					...(audible ? { audio: "joinedAudio" } : {}),
					duration,
					video: "joined",
				}
			),
		],
		"final",
		"final",
		output
	);
	return { chunks, files, steps };
}
