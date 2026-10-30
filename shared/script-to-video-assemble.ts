/**
 * Script to video assembly: place narration and per-scene visuals into a
 * timed edit with captions aligned to the narration.
 */
import { MIN_CLIP_SPEED } from "./audio.ts";
import { type ChunkWord, rechunk } from "./caption-chunking.ts";
import { MAX_SEGMENTS } from "./limits.ts";
import {
	type Asset,
	activeCaptions,
	type Caption,
	isTrackAudible,
	type Keyframe,
	newSegment,
	type Project,
	projectDuration,
	type Segment,
	validateProject,
	withActiveCaptions,
} from "./project.ts";
import {
	type PlacedScriptAvatar,
	placeScriptAvatars,
} from "./script-extras.ts";
import {
	alignNarrationWords,
	spread,
	tokensOf,
} from "./script-to-video-align.ts";
import {
	type AssembledScriptScene,
	DEFAULT_SCRIPT_CHUNKING,
	KEN_BURNS_DRIFT,
	KEN_BURNS_MIN_SCALE,
	KEN_BURNS_ZOOM,
	MAX_PROJECT_CAPTIONS,
	MIN_SCENE_SECONDS,
	MIN_STRETCH_SPEED,
	type NarrationTiming,
	type ScriptAssembleInput,
	type ScriptAssembleOptions,
	type ScriptAssembleRequest,
	type ScriptAssembly,
	scriptAssembleRequestSchema,
} from "./script-to-video-schema.ts";
import { firstFreeTrack } from "./track-placement.ts";

/** Scene windows: each starts after the previous narration plus `gap`. */
export function scriptSceneTimes(
	durations: readonly number[],
	at: number,
	gap: number
): { end: number; start: number }[] {
	let cursor = at;
	return durations.map((duration, index) => {
		const start = cursor + (index ? gap : 0);
		cursor = start + duration;
		return { end: cursor, start };
	});
}

/**
 * Linear Ken Burns keyframes: zoom in on even scenes, out on odd ones,
 * never below `KEN_BURNS_MIN_SCALE` so the drift never uncovers the frame.
 */
export function kenBurnsKeyframes(
	duration: number,
	index: number,
	newId: () => string
): Keyframe[] {
	const zoomIn = index % 2 === 0;
	const drift = (index % 4 < 2 ? 1 : -1) * KEN_BURNS_DRIFT;
	// Round down so the last keyframe never passes the clip end.
	const end = Math.floor(duration * 1_000_000) / 1_000_000;
	return [
		{
			id: newId(),
			property: "scale",
			time: 0,
			value: zoomIn ? KEN_BURNS_MIN_SCALE : KEN_BURNS_ZOOM,
		},
		{
			id: newId(),
			property: "scale",
			time: end,
			value: zoomIn ? KEN_BURNS_ZOOM : KEN_BURNS_MIN_SCALE,
		},
		{ id: newId(), property: "x", time: 0, value: -drift },
		{ id: newId(), property: "x", time: end, value: drift },
	];
}

/**
 * Visual clips covering `[start, start + duration]`: a still held for the
 * duration; a long enough video trimmed; a slightly short one slowed down
 * (not below `MIN_STRETCH_SPEED`); a much shorter one tiled, the last tile
 * slowed just enough to absorb a sub-frame remainder. Tiling is checked
 * against `budget` (clips left under `MAX_SEGMENTS`) before any clip is
 * allocated.
 */
function visualClips(
	asset: Asset,
	start: number,
	duration: number,
	track: number,
	newId: () => string,
	budget: number,
	index: number
): Segment[] {
	const base = (at: number, length: number, speed = 1): Segment => ({
		...newSegment(asset, at, track),
		id: newId(),
		sourceIn: 0,
		sourceOut: length * speed,
		speed,
		volume: 0,
	});
	if (asset.kind === "image" || asset.duration >= duration) {
		return [base(start, duration)];
	}
	const ratio = asset.duration / duration;
	if (ratio >= MIN_STRETCH_SPEED) {
		return [base(start, duration, Math.max(MIN_CLIP_SPEED, ratio))];
	}
	if (asset.duration < MIN_SCENE_SECONDS) {
		throw new Error(
			`Scene ${index + 1} video is too short to fill the narration; use a still or a longer clip.`
		);
	}
	const tiles = Math.ceil(duration / asset.duration);
	if (tiles > budget) {
		throw new Error(
			`Scene ${index + 1} video would need ${tiles} repeats to fill the narration; use a still or a longer clip.`
		);
	}
	const clips: Segment[] = [];
	let cursor = 0;
	while (duration - cursor > 1e-9) {
		const remaining = duration - cursor;
		const afterThis = remaining - asset.duration;
		if (afterThis <= 0) {
			clips.push(base(start + cursor, remaining));
			break;
		}
		if (afterThis < MIN_SCENE_SECONDS) {
			// Stretch the last full tile over the sub-frame remainder.
			clips.push(base(start + cursor, remaining, asset.duration / remaining));
			break;
		}
		clips.push(base(start + cursor, asset.duration));
		cursor += asset.duration;
	}
	return clips;
}

function sceneWords(
	scene: ScriptAssembleRequest["scenes"][number],
	index: number,
	start: number,
	duration: number,
	timing: NarrationTiming | undefined,
	newId: () => string
): ChunkWord[] {
	const aligned = alignNarrationWords(
		scene.text,
		timing?.words ?? [],
		duration
	);
	const measured = Boolean(timing?.measured && timing.words.length);
	return aligned.map((word) => {
		const chunk: ChunkWord = {
			end: start + word.end,
			source: index,
			sourceAssetId: scene.narrationAssetId,
			start: start + word.start,
			text: word.text,
		};
		if (measured) {
			chunk.id = newId();
		}
		return chunk;
	});
}

function requireAsset(
	assets: readonly Asset[],
	id: string,
	role: "narration" | "visual",
	index: number
): Asset {
	const asset = assets.find((candidate) => candidate.id === id);
	if (!asset) {
		throw new Error(`Scene ${index + 1} ${role} is not in the library.`);
	}
	if (role === "narration" && asset.kind !== "audio") {
		throw new Error(`Scene ${index + 1} narration must be audio media.`);
	}
	if (role === "visual" && asset.kind === "audio") {
		throw new Error(`Scene ${index + 1} visual must be a video or image.`);
	}
	return asset;
}

/**
 * The first free audio track over `[start, end)` that is also audible (not
 * muted, not excluded by solo), so the narration the captions come from is
 * heard.
 */
function audibleFreeTrack(
	project: Project,
	assets: readonly Asset[],
	start: number,
	end: number
): number | undefined {
	let from = 0;
	for (;;) {
		const track = firstFreeTrack(project, start, end, {
			assets,
			from,
			kind: "audio",
		});
		if (track === undefined || isTrackAudible(project, track)) {
			return track;
		}
		from = track + 1;
	}
}

/**
 * Assemble narrated scenes: narration clips back to back on the first free
 * audible audio track, each scene's visual sized to its narration on the first free
 * visual track (Ken Burns on stills, stock audio muted), and captions from
 * the narration text timed by `alignNarrationWords` and grouped by caption
 * chunking. Existing captions overlapping the assembly are replaced.
 */
export function assembleScriptVideo(
	project: Project,
	assets: readonly Asset[],
	input: ScriptAssembleInput,
	options: ScriptAssembleOptions = {}
): ScriptAssembly {
	const request = scriptAssembleRequestSchema.parse(input);
	const newId = options.newId ?? (() => crypto.randomUUID());
	const resolved = request.scenes.map((scene, index) => ({
		narration: requireAsset(assets, scene.narrationAssetId, "narration", index),
		scene,
		visual: requireAsset(assets, scene.visualAssetId, "visual", index),
	}));
	for (const [index, item] of resolved.entries()) {
		if (item.narration.duration < MIN_SCENE_SECONDS) {
			throw new Error(`Scene ${index + 1} narration is empty.`);
		}
	}
	const at = request.at ?? projectDuration(project);
	const gap = request.gap ?? 0;
	const times = scriptSceneTimes(
		resolved.map((item) => item.narration.duration),
		at,
		gap
	);
	const end = times.at(-1)?.end ?? at;
	const library = [...assets];
	const visualTrack = firstFreeTrack(project, at, end, {
		assets: library,
		kind: "visual",
	});
	if (visualTrack === undefined) {
		throw new Error("No free visual track can hold the assembled scenes.");
	}
	const fit = request.fit ?? "fill";
	const kenBurns = request.kenBurns ?? true;
	const visuals: Segment[] = [];
	const scenes: AssembledScriptScene[] = [];
	// Clips left for visuals once the narration clips are reserved.
	let budget = MAX_SEGMENTS - project.segments.length - resolved.length;
	if (budget < resolved.length) {
		throw new Error(
			`The project has no room for ${resolved.length * 2} more clips.`
		);
	}
	for (const [index, item] of resolved.entries()) {
		const window = times[index] ?? { end: at, start: at };
		const duration = window.end - window.start;
		const clips = visualClips(
			item.visual,
			window.start,
			duration,
			visualTrack,
			newId,
			// Leave one clip for each later scene's visual.
			budget - (resolved.length - index - 1),
			index
		).map((clip) => {
			const placed: Segment = { ...clip, fit };
			if (kenBurns && item.visual.kind === "image") {
				placed.keyframes = kenBurnsKeyframes(duration, index, newId);
			}
			return placed;
		});
		budget -= clips.length;
		visuals.push(...clips);
		scenes.push({
			end: window.end,
			narrationClipId: "",
			start: window.start,
			visualClipIds: clips.map((clip) => clip.id),
		});
	}
	const withVisuals = {
		...project,
		segments: [...project.segments, ...visuals],
	};
	const narrationTrack = audibleFreeTrack(withVisuals, library, at, end);
	if (narrationTrack === undefined) {
		throw new Error(
			"No free, audible audio track can hold the narration. Unmute a track or clear solo first."
		);
	}
	const narrations = resolved.map((item, index) => {
		const window = times[index] ?? { end: at, start: at };
		const clip: Segment = {
			...newSegment(item.narration, window.start, narrationTrack),
			id: newId(),
			sourceIn: 0,
			sourceOut: window.end - window.start,
		};
		const placed = scenes[index];
		if (placed) {
			placed.narrationClipId = clip.id;
		}
		return clip;
	});
	let next: Project = {
		...withVisuals,
		segments: [...withVisuals.segments, ...narrations],
	};
	let captionCount = 0;
	let replaced = 0;
	if (request.captions ?? true) {
		const words = resolved.flatMap((item, index) => {
			const window = times[index] ?? { end: at, start: at };
			return sceneWords(
				item.scene,
				index,
				window.start,
				window.end - window.start,
				options.narrationTiming?.(item.narration.id),
				newId
			);
		});
		const chunking =
			request.captionChunking ??
			project.captionChunking ??
			DEFAULT_SCRIPT_CHUNKING;
		const built = rechunk([], words, chunking, { newId });
		const existing = activeCaptions(next);
		const kept = existing.filter(
			(caption) => caption.end <= at || caption.start >= end
		);
		if (kept.length + built.length > MAX_PROJECT_CAPTIONS) {
			throw new Error(
				`Captions would exceed ${MAX_PROJECT_CAPTIONS}; choose phrase captions or a shorter script.`
			);
		}
		replaced = existing.length - kept.length;
		captionCount = built.length;
		const merged: Caption[] = [...kept, ...built].sort(
			(a, b) => a.start - b.start
		);
		next = withActiveCaptions(next, merged);
		if (request.captionChunking) {
			next = { ...next, captionChunking: request.captionChunking };
		}
	}
	let avatars: PlacedScriptAvatar[] = [];
	if (request.avatar) {
		const placed = placeScriptAvatars(
			next,
			scenes,
			request.avatar.preset,
			newId
		);
		avatars = placed.avatars;
		next = placed.project;
	}
	return {
		avatars,
		captions: captionCount,
		duration: end - at,
		narrationTrack,
		project: validateProject(next, library),
		replacedCaptions: replaced,
		scenes,
		visualTrack,
	};
}

/**
 * Narration timing from a stored transcript (source seconds): its words
 * when transcription measured them, otherwise its cues split into estimated
 * words, otherwise nothing.
 */
export function narrationTimingFromTranscript(
	transcript:
		| { cues: readonly Caption[]; words: readonly Caption[] }
		| null
		| undefined
): NarrationTiming | undefined {
	if (!transcript) {
		return undefined;
	}
	if (transcript.words.length) {
		return {
			measured: true,
			words: transcript.words.map(({ end, start, text }) => ({
				end,
				start,
				text,
			})),
		};
	}
	if (transcript.cues.length) {
		return {
			measured: false,
			words: transcript.cues.flatMap((cue) =>
				spread(tokensOf(cue.text), cue.start, cue.end)
			),
		};
	}
	return undefined;
}
