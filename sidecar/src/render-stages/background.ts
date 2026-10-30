import {
	blurBrightness,
	blurSigma,
	type CanvasBackground,
	gradientCoefficients,
	gradientGrid,
	hexToRgb,
	loopedMediaTime,
	pushPullLevels,
	renderableClipBackground,
} from "../../../shared/background.ts";
import { ffmpegFrameRate } from "../../../shared/frame-rate.ts";
import {
	type Asset,
	type Project,
	type Segment,
	segmentDuration,
} from "../../../shared/project.ts";
import { backgroundOf } from "../../../shared/schema/defaults.ts";
import { styleProfileConfig } from "../../../shared/styles.ts";
import { filtergraphPath } from "../render-graphics.ts";
import { opacityFilter } from "./opacity.ts";
import { padFilter } from "./transform.ts";
import { fadeFilters, revealFilters } from "./transitions.ts";
import type { RenderStageContext, StageOutput } from "./types.ts";

/**
 * Canvas and clip backgrounds (W2-V8).
 *
 * - The canvas (`baseSource`) is input 0 turned into `[base]`: the legacy
 *   style color, an explicit color, a two-stop gradient (evaluated with `geq`
 *   on a small grid, then scaled up: the gradient is linear, so bilinear
 *   scaling reproduces it), or a library image/video scaled to cover and
 *   looped. A project blur keeps the style color here and fills under each
 *   base-track clip instead.
 * - A clip background (`clipBackgroundFilters`) is drawn under the clip's
 *   placed layer (the clip scaled into its box on a transparent frame the
 *   size of `padFilter`), so the composite places both together. Color uses
 *   `lutrgb`; gradients use the grid `geq`; a blur fill extends the clip into
 *   the empty area with a push-pull pyramid (premultiplied downscales, then
 *   each level laid over the upscaled coarser one), blurs it with `gblur`
 *   and dims it. The stage only sees the placed layer, so the fill is an
 *   extension of the clip's edges rather than a zoomed copy.
 *
 * With no explicit background the argv stays byte-identical to the legacy
 * render.
 */

/** What the canvas needs from the render: media paths and, optionally, assets. */
export interface BaseSourceContext
	extends Pick<RenderStageContext, "mediaPath"> {
	/**
	 * The library asset of a canvas image or video. With it, a frame render of
	 * a video canvas shows the frame the looped export shows at that time;
	 * without it, frame renders show the video's first frame.
	 */
	asset?(assetId: string): Pick<Asset, "duration" | "kind"> | undefined;
}

export interface BaseSource {
	/** FFmpeg arguments for input 0. */
	args: string[];
	/** Statements that turn input 0 into the `[base]` canvas. */
	filters: string[];
}

const number = (value: number) => {
	const rounded = Number(value.toFixed(9));
	return `${Object.is(rounded, -0) ? 0 : rounded}`;
};

/**
 * `geq` channel expressions of a two-stop gradient on a grid. Each channel is
 * the first stop plus its difference times the clamped position.
 */
export function gradientGeq(
	background: Extract<CanvasBackground, { type: "gradient" }>,
	frame: { height: number; width: number },
	grid: { height: number; width: number }
): string {
	const { a, b, c } = gradientCoefficients(background.angle, frame, grid);
	const position = `clip((${number(a)})*X+(${number(b)})*Y+(${number(c)}),0,1)`;
	const from = hexToRgb(background.color);
	const to = hexToRgb(background.color2);
	const channel = (name: "r" | "g" | "b") =>
		`${name}='${from[name]}+(${to[name] - from[name]})*${position}'`;
	return `geq=${channel("r")}:${channel("g")}:${channel("b")}`;
}

function colorInput(
	color: string,
	size: { height: number; width: number },
	fps: number,
	length: number
): string[] {
	return [
		"-f",
		"lavfi",
		"-i",
		`color=c=${color}:s=${size.width}x${size.height}:r=${ffmpegFrameRate(fps)}:d=${length}`,
	];
}

/**
 * The canvas behind every layer: input 0 and the `[base]` label. `duration`
 * already includes any waveform drain tail; a frame render generates one
 * frame.
 */
export function baseSource(
	project: Project,
	duration: number,
	frameTime: number | undefined,
	context?: BaseSourceContext
): BaseSource {
	const length = frameTime === undefined ? duration : 1 / project.fps;
	const frameShift =
		frameTime === undefined ? "" : `,setpts=PTS+${frameTime}/TB`;
	const canvas = { height: project.height, width: project.width };
	const background = backgroundOf(project);
	if (background.type === "gradient") {
		const grid = gradientGrid(canvas.width, canvas.height);
		return {
			args: colorInput("black", grid, project.fps, length),
			filters: [
				`[0:v]format=gbrp,${gradientGeq(background, canvas, grid)},scale=${canvas.width}:${canvas.height}:flags=bilinear,setsar=1,format=yuv420p${frameShift}[base]`,
			],
		};
	}
	if (background.type === "image") {
		if (!context) {
			throw new Error("A background image needs the render's media paths.");
		}
		const media = context.asset?.(background.assetId);
		// A frame render of a looped video seeks to where the export's loop is
		// at `frameTime`; images (and unknown media) have one picture.
		const seek =
			frameTime !== undefined && media?.kind === "video"
				? loopedMediaTime(frameTime, media.duration)
				: 0;
		return {
			args: [
				"-stream_loop",
				"-1",
				...(seek > 0 ? ["-ss", `${seek}`] : []),
				"-t",
				`${length}`,
				"-i",
				context.mediaPath(background.assetId),
			],
			filters: [
				`[0:v]setpts=PTS-STARTPTS,fps=${ffmpegFrameRate(project.fps)},scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase,crop=${canvas.width}:${canvas.height},setsar=1,format=yuv420p${frameShift}[base]`,
			],
		};
	}
	const color =
		background.type === "color"
			? background.color
			: styleProfileConfig(project.styleProfile).background;
	return {
		args: colorInput(color, canvas, project.fps, length),
		filters: [`[0:v]format=yuv420p${frameShift}[base]`],
	};
}

/** Size of the clip's placed layer: the transparent frame `padFilter` builds. */
export function placedLayerSize(
	segment: Segment,
	project: Project
): { height: number; width: number } {
	const match = /^pad=(\d+):(\d+):/.exec(padFilter(segment, project));
	if (!match) {
		throw new Error("The clip layer size could not be determined.");
	}
	return { height: Number(match[2]), width: Number(match[1]) };
}

/**
 * Statements that turn `[source]` (the placed clip) into an opaque blur fill
 * the size of the layer, labelled `[output]`.
 */
export function blurFillFilters(
	background: Extract<CanvasBackground, { type: "blur" }>,
	layer: { height: number; width: number },
	source: string,
	output: string
): string[] {
	const levels = pushPullLevels(layer.width, layer.height);
	const label = (name: string, index: number) => `${output}${name}${index}`;
	const size = (index: number) => {
		const level = levels[index];
		if (!level) {
			throw new Error("Missing blur fill level.");
		}
		return `${level.width}:${level.height}`;
	};
	const filters: string[] = [];
	const last = levels.length - 1;
	// Push: premultiplied area downscales, so empty pixels do not darken.
	filters.push(
		`[${source}]format=gbrap,premultiply=inplace=1,scale=${size(0)}:flags=area[${label("p", 0)}]`
	);
	for (let index = 0; index < last; index++) {
		filters.push(
			`[${label("p", index)}]split=2[${label("keep", index)}][${label("down", index)}]`,
			`[${label("down", index)}]scale=${size(index + 1)}:flags=area[${label("p", index + 1)}]`
		);
	}
	// Pull: the coarsest level becomes opaque, then each finer level (with
	// straight alpha again) is laid over the upscaled coarser fill.
	filters.push(
		`[${label("p", last)}]unpremultiply=inplace=1,format=gbrp[${label("fill", last)}]`
	);
	for (let index = last - 1; index >= 0; index--) {
		filters.push(
			`[${label("fill", index + 1)}]scale=${size(index)}:flags=bilinear[${label("up", index)}]`,
			`[${label("keep", index)}]unpremultiply=inplace=1[${label("straight", index)}]`,
			`[${label("up", index)}][${label("straight", index)}]overlay=x=0:y=0:format=gbrp[${label("fill", index)}]`
		);
	}
	const grid = levels[0] ?? { height: 1, width: 1 };
	const gridSigma = (blurSigma(background.amount) * grid.width) / layer.width;
	const finish = [
		...(gridSigma > 0 ? [`gblur=sigma=${number(gridSigma)}`] : []),
		`colorchannelmixer=rr=${blurBrightness(background.dim)}:gg=${blurBrightness(background.dim)}:bb=${blurBrightness(background.dim)}`,
		`scale=${layer.width}:${layer.height}:flags=bicubic`,
		"format=rgba",
	];
	filters.push(`[${label("fill", 0)}]${finish.join(",")}[${output}]`);
	return filters;
}

/**
 * The clip's own alpha chain (opacity, fades, reveal and clip animation), in
 * the same order and clip-local time as `render-segment-video.ts`, for the
 * fill under it. Empty when the clip is always fully opaque.
 */
export function clipAlphaFilters(segment: Segment): string[] {
	const length = segmentDuration(segment);
	const opacity = opacityFilter(segment);
	const chain = [
		...(opacity === "colorchannelmixer=aa=1" ? [] : [opacity]),
		...fadeFilters(segment, length),
		...revealFilters(segment, undefined, length),
	];
	if (chain.length === 0) {
		return [];
	}
	return [
		`setpts=PTS-${segment.start}/TB`,
		...chain,
		`setpts=PTS+${segment.start}/TB`,
	];
}

/**
 * A per-clip background composited under the clip before it joins the canvas.
 * Clips without one (waveforms, clip-level images, and keyed or masked clips
 * under a project blur) pass through unchanged.
 *
 * The fill and the clip form one layer whose alpha is the clip's own alpha
 * chain. An always-opaque clip simply goes over its opaque fill. Otherwise the
 * fill gets the clip's alpha chain (alpha `f`), loses the clip's alpha `a`
 * (`f - a`, so it only fills what the clip leaves empty) and is added to the
 * clip premultiplied: the layer's alpha is `f` everywhere, so a crossfade,
 * fade or partial opacity shows the layers below through clip and fill alike.
 */
export function clipBackgroundFilters(
	segment: Segment,
	project: Project,
	inputLabel: string,
	options: Pick<RenderStageContext, "transparentCanvas"> &
		Partial<Pick<RenderStageContext, "mediaPath">> = {}
): StageOutput {
	// A transparent (alpha) export replaces the project canvas, so the
	// project blur fill is not drawn under base-track clips either.
	const background = renderableClipBackground(
		options.transparentCanvas ? { background: undefined } : project,
		segment
	);
	if (!background) {
		return { filters: [], label: inputLabel };
	}
	const layer = placedLayerSize(segment, project);
	const front = `${inputLabel}bgfront`;
	const source = `${inputLabel}bgsource`;
	const fill = `${inputLabel}bgfill`;
	const output = `${inputLabel}bg`;
	const alpha = clipAlphaFilters(segment);
	const cover = `${inputLabel}bgcover`;
	const filters = [
		alpha.length === 0
			? `[${inputLabel}]split=2[${front}][${source}]`
			: `[${inputLabel}]split=3[${front}][${source}][${cover}]`,
	];
	if (background.type === "color") {
		const { b, g, r } = hexToRgb(background.color);
		filters.push(
			`[${source}]format=rgba,lutrgb=r=${r}:g=${g}:b=${b}:a=255[${fill}]`
		);
	} else if (background.type === "image") {
		if (!options.mediaPath) {
			throw new Error(
				"A clip background image needs the render's media paths."
			);
		}
		// One picture (a video's first frame), scaled to cover the clip box and
		// repeated on every clip frame by the overlay's end-of-input repeat.
		const template = `${inputLabel}bgtemplate`;
		const picture = `${inputLabel}bgimage`;
		filters.push(
			`[${source}]format=rgba,lutrgb=r=0:g=0:b=0:a=255[${template}]`,
			`movie=filename=${filtergraphPath(options.mediaPath(background.assetId))},trim=end_frame=1,scale=${layer.width}:${layer.height}:force_original_aspect_ratio=increase,crop=${layer.width}:${layer.height},setsar=1,format=rgba[${picture}]`,
			`[${template}][${picture}]overlay=x=0:y=0:eof_action=repeat:format=auto,format=rgba[${fill}]`
		);
	} else if (background.type === "gradient") {
		const grid = gradientGrid(layer.width, layer.height);
		filters.push(
			`[${source}]scale=${grid.width}:${grid.height},format=gbrp,${gradientGeq(background, layer, grid)},scale=${layer.width}:${layer.height}:flags=bilinear,format=rgba[${fill}]`
		);
	} else {
		filters.push(...blurFillFilters(background, layer, source, fill));
	}
	if (alpha.length === 0) {
		filters.push(
			`[${fill}][${front}]overlay=x=0:y=0:format=auto,format=rgba[${output}]`
		);
		return { filters, label: output };
	}
	const faded = `${inputLabel}bgfaded`;
	const coverPlanes = `${inputLabel}bgcoverp`;
	const rest = `${inputLabel}bgrest`;
	const frontPremultiplied = `${inputLabel}bgfrontp`;
	filters.push(
		`[${fill}]${alpha.join(",")},format=gbrap[${faded}]`,
		`[${cover}]format=gbrap[${coverPlanes}]`,
		`[${faded}][${coverPlanes}]blend=c0_mode=normal:c1_mode=normal:c2_mode=normal:c3_mode=subtract,premultiply=inplace=1[${rest}]`,
		`[${front}]format=gbrap,premultiply=inplace=1[${frontPremultiplied}]`,
		`[${rest}][${frontPremultiplied}]blend=all_mode=addition,unpremultiply=inplace=1,format=rgba[${output}]`
	);
	return { filters, label: output };
}
