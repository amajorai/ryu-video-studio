/**
 * Script to video (W4-G4): split a script into narrated scenes, then
 * assemble generated narration and per-scene visuals into a timed edit with
 * captions aligned to the narration.
 *
 * Everything here is pure and deterministic (ids come from an injectable
 * factory). The UI pipeline asks `model.complete` for scenes
 * (`scriptSplitRequest` / `parseScriptPlan`, or `heuristicScriptScenes`
 * offline), produces narration and visuals through the existing generation
 * and stock gates, and posts `scriptAssembleRequestSchema` to
 * `POST /projects/:id/script-assemble`, which runs `assembleScriptVideo`.
 */
import { z } from "zod";
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
	type CaptionChunking,
	captionChunkingSchema,
} from "./schema/caption-style.ts";
import { bounded, idSchema, timeSchema } from "./schema/primitives.ts";
import {
	type PlacedScriptAvatar,
	placeScriptAvatars,
	scriptAvatarSchema,
	scriptMusicSchema,
} from "./script-extras.ts";
import { firstFreeTrack } from "./track-placement.ts";

/** Longest script the planner accepts, in characters. */
export const MAX_SCRIPT_CHARS = 20_000;
/** Most scenes one script produces or one assembly places. */
export const MAX_SCRIPT_SCENES = 40;
/** Narration text per scene (the caption and TTS input). */
export const MAX_SCENE_NARRATION_CHARS = 2000;
/** Shortest narration clip the assembler places, in seconds. */
export const MIN_SCENE_SECONDS = 0.04;
/** Ken Burns zoom applied across a still, as a scale factor. */
export const KEN_BURNS_ZOOM = 1.12;
/** Ken Burns horizontal drift, in normalized frame units (±1 is half the frame). */
export const KEN_BURNS_DRIFT = 0.03;
/**
 * Smallest Ken Burns scale. A box of scale `s` centred at `x` covers the
 * frame while `|x| <= s - 1`; twice the drift keeps a margin at every
 * keyframe, and linear interpolation keeps it in between.
 */
export const KEN_BURNS_MIN_SCALE = 1 + 2 * KEN_BURNS_DRIFT;
/** Captions one project holds (the project schema bound). */
const MAX_PROJECT_CAPTIONS = 5000;
/** Video slower than this ratio is tiled instead of slowed down. */
export const MIN_STRETCH_SPEED = 0.5;
/** Captions the assembler builds when no chunking is given. */
export const DEFAULT_SCRIPT_CHUNKING: CaptionChunking = { mode: "words" };

const narrationText = z
	.string()
	.trim()
	.min(1)
	.max(MAX_SCENE_NARRATION_CHARS)
	.refine((value) => !value.includes("\0"), "Narration cannot contain NUL.");

/** One planned scene: what is said, what to search for, what to generate. */
export const scriptSceneSchema = z
	.object({
		narration: narrationText,
		visualQuery: z.string().trim().min(1).max(200),
		imagePrompt: z.string().trim().min(1).max(2000),
	})
	.strict();
export type ScriptScene = z.infer<typeof scriptSceneSchema>;

export const scriptPlanSchema = z
	.object({
		scenes: z.array(scriptSceneSchema).min(1).max(MAX_SCRIPT_SCENES),
	})
	.strict();
export type ScriptPlan = z.infer<typeof scriptPlanSchema>;

export const scriptTextSchema = z
	.string()
	.trim()
	.min(1, "Write a script first.")
	.max(
		MAX_SCRIPT_CHARS,
		`Keep the script under ${MAX_SCRIPT_CHARS} characters.`
	);

/** The `model.complete` input that splits `script` into scenes. */
export function scriptSplitRequest(
	script: string,
	options: { maxScenes?: number } = {}
): { prompt: string; system: string } {
	const text = scriptTextSchema.parse(script);
	const maxScenes = Math.min(
		MAX_SCRIPT_SCENES,
		Math.max(1, Math.round(options.maxScenes ?? 12))
	);
	return {
		system: [
			"You split a narration script into scenes for a short video.",
			'Return only JSON shaped {"scenes":[{"narration":string,"visualQuery":string,"imagePrompt":string}]}. No markdown.',
			`Produce 1 to ${maxScenes} scenes in script order.`,
			"narration is the exact script wording for that scene, without speaker labels or stage directions; together the scenes cover the whole script once.",
			"visualQuery is 2 to 6 plain keywords for searching stock footage (no quotes or operators).",
			"imagePrompt is one sentence describing an original still image for the scene, with no text, logos, or real people's names.",
		].join(" "),
		prompt: text,
	};
}

/** Longest topic or brief the script writer accepts. */
export const MAX_SCRIPT_TOPIC_CHARS = 2000;
/** Spoken words per second the writer aims for (about 150 words a minute). */
const WORDS_PER_SECOND = 2.5;

/**
 * The `model.complete` request that writes a narration script about `topic`.
 * The result is plain spoken text for `Script`, about `seconds` long.
 */
export function scriptWriterRequest(
	topic: string,
	options: { brief?: string; seconds?: number; title?: string } = {}
): { prompt: string; system: string } {
	const subject = topic.trim().slice(0, MAX_SCRIPT_TOPIC_CHARS);
	if (!subject) {
		throw new Error("Describe what the video is about first.");
	}
	const seconds = Math.min(
		600,
		Math.max(10, Math.round(options.seconds ?? 60))
	);
	const words = Math.round(seconds * WORDS_PER_SECOND);
	return {
		system: [
			"You write narration scripts for short videos.",
			`Write about ${words} words (roughly ${seconds} seconds spoken) in short paragraphs, one idea per paragraph.`,
			"Return only the words the narrator says: no title, headings, scene numbers, speaker labels, stage directions, bullet points, or markdown.",
			"Do not invent statistics, quotes, or facts you are not sure of.",
		].join(" "),
		prompt: JSON.stringify({
			topic: subject,
			...(options.title?.trim() ? { projectTitle: options.title.trim() } : {}),
			...(options.brief?.trim()
				? { brief: options.brief.trim().slice(0, MAX_SCRIPT_TOPIC_CHARS) }
				: {}),
		}),
	};
}

/**
 * Clean a written script: code fences, markdown headings, list markers,
 * speaker labels and bracketed stage directions are removed, paragraphs are
 * kept, and the text is capped at `MAX_SCRIPT_CHARS`.
 */
export function parseWrittenScript(text: string): string {
	const cleaned = text
		.replace(/\r/g, "")
		.replace(/```[a-z]*\n?/gi, "")
		.split("\n")
		.map((line) =>
			line
				.replace(/^\s*#{1,6}\s+.*$/, "")
				.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
				.replace(/^\s*(?:narrator|voice ?over|vo|host)\s*:\s*/i, "")
				.replace(
					/\[[^\]\n]*\]|\([^)\n]*(?:music|sfx|pause|cut to)[^)\n]*\)/gi,
					""
				)
				.replace(/\*\*|__/g, "")
				.trim()
		)
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (!cleaned) {
		throw new Error("Ryu did not write a script. Try a more specific topic.");
	}
	return cleaned.slice(0, MAX_SCRIPT_CHARS).trim();
}

/** The storyboard's per-scene scripts, in scene order, as one script. */
export function storyboardScript(
	scenes: readonly { script: string }[]
): string {
	return scenes
		.map((scene) => scene.script.trim())
		.filter(Boolean)
		.join("\n\n")
		.slice(0, MAX_SCRIPT_CHARS)
		.trim();
}

const lenientSceneSchema = z.object({
	narration: z.string(),
	visualQuery: z.string().optional(),
	imagePrompt: z.string().optional(),
});

function jsonCandidate(text: string): unknown {
	const unfenced = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	try {
		return JSON.parse(unfenced);
	} catch {
		const open = unfenced.search(/[[{]/);
		const close = Math.max(
			unfenced.lastIndexOf("}"),
			unfenced.lastIndexOf("]")
		);
		if (open < 0 || close <= open) {
			throw new Error("The scene planner did not return JSON.");
		}
		try {
			return JSON.parse(unfenced.slice(open, close + 1));
		} catch {
			throw new Error("The scene planner returned malformed JSON.");
		}
	}
}

/**
 * Validate the planner's reply: JSON (optionally fenced or wrapped in prose)
 * holding `scenes` or a bare scene array. Missing search keywords or image
 * prompts are derived from the narration; empty narrations are dropped.
 */
export function parseScriptPlan(text: string): ScriptScene[] {
	const value = jsonCandidate(text);
	const list = Array.isArray(value)
		? value
		: z.object({ scenes: z.array(z.unknown()) }).parse(value).scenes;
	const scenes: ScriptScene[] = [];
	for (const item of list) {
		const parsed = lenientSceneSchema.safeParse(item);
		if (!parsed.success) {
			throw new Error("A planned scene is missing its narration.");
		}
		const narration = parsed.data.narration.replaceAll("\0", "").trim();
		if (!narration) {
			continue;
		}
		scenes.push(
			sceneFromNarration(
				narration,
				parsed.data.visualQuery,
				parsed.data.imagePrompt
			)
		);
	}
	return scriptPlanSchema.parse({ scenes }).scenes;
}

const STOP_WORDS = new Set(
	"a about after again also an and any are as at be because been before between both but by can could did do does down during each few for from had has have he her here his how i if in into is it its just let me more most my no not of off on once only or our out over own same she so some than that the their them then there these they this those through to too under until up us very was we were what when where which while who why will with would you your".split(
		" "
	)
);

/** Up to `limit` distinctive keywords of `text`, by frequency then first use. */
export function sceneKeywords(text: string, limit = 4): string[] {
	const counts = new Map<string, { count: number; first: number }>();
	const words = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
	for (const [index, word] of words.entries()) {
		const clean = word.replace(/'s$/, "").replace(/['-]+$/, "");
		if (clean.length < 3 || STOP_WORDS.has(clean) || /^\d+$/.test(clean)) {
			continue;
		}
		const entry = counts.get(clean);
		if (entry) {
			entry.count += 1;
		} else {
			counts.set(clean, { count: 1, first: index });
		}
	}
	return [...counts.entries()]
		.sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first)
		.slice(0, limit)
		.map(([word]) => word);
}

const truncate = (text: string, max: number) =>
	text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

function sceneFromNarration(
	narration: string,
	visualQuery?: string,
	imagePrompt?: string
): ScriptScene {
	const clipped = truncate(narration, MAX_SCENE_NARRATION_CHARS);
	const keywords = sceneKeywords(clipped).join(" ");
	return {
		imagePrompt: truncate(
			imagePrompt?.trim() ||
				`An original cinematic still illustrating: ${truncate(clipped, 300)}`,
			2000
		),
		narration: clipped,
		visualQuery: truncate(
			visualQuery?.trim() || keywords || truncate(clipped, 60),
			200
		),
	};
}

/** Sentences of `text`, keeping their closing punctuation. */
function sentences(text: string): string[] {
	return (text.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)/g) ?? [])
		.map((sentence) => sentence.trim())
		.filter(Boolean);
}

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * Split a script locally (no model): paragraphs first, then sentences
 * grouped to about `targetWords` words, merged down to `maxScenes`.
 */
export function heuristicScriptScenes(
	script: string,
	options: { maxScenes?: number; targetWords?: number } = {}
): ScriptScene[] {
	const text = scriptTextSchema.parse(script);
	const maxScenes = Math.min(
		MAX_SCRIPT_SCENES,
		Math.max(1, Math.round(options.maxScenes ?? 12))
	);
	const target = Math.max(5, options.targetWords ?? 35);
	const chunks: string[] = [];
	for (const paragraph of text.split(/\n\s*\n/)) {
		let current = "";
		for (const sentence of sentences(paragraph.replace(/\s+/g, " "))) {
			const next = current ? `${current} ${sentence}` : sentence;
			if (
				current &&
				(wordCount(next) > target || next.length > MAX_SCENE_NARRATION_CHARS)
			) {
				chunks.push(current);
				current = sentence;
			} else {
				current = next;
			}
		}
		if (current) {
			chunks.push(current);
		}
	}
	while (chunks.length > maxScenes) {
		// Merge the shortest adjacent pair that still fits one narration.
		let best = -1;
		let bestLength = Number.POSITIVE_INFINITY;
		for (let index = 0; index + 1 < chunks.length; index += 1) {
			const length =
				(chunks[index]?.length ?? 0) + (chunks[index + 1]?.length ?? 0) + 1;
			if (length <= MAX_SCENE_NARRATION_CHARS && length < bestLength) {
				best = index;
				bestLength = length;
			}
		}
		if (best < 0) {
			break;
		}
		chunks.splice(best, 2, `${chunks[best]} ${chunks[best + 1]}`);
	}
	return chunks
		.slice(0, maxScenes)
		.flatMap((chunk) =>
			chunk.length > MAX_SCENE_NARRATION_CHARS
				? [chunk.slice(0, MAX_SCENE_NARRATION_CHARS)]
				: [chunk]
		)
		.map((chunk) => sceneFromNarration(chunk));
}

/** A timed word, in seconds from the start of its narration clip. */
export interface NarrationWord {
	end: number;
	start: number;
	text: string;
}

const normalizeToken = (token: string) =>
	token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

const tokensOf = (text: string) => text.split(/\s+/).filter(Boolean);

/** Character edit distance between two short tokens. */
function editDistance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i += 1) {
		const current = [i];
		for (let j = 1; j <= b.length; j += 1) {
			current[j] = Math.min(
				(previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
				(previous[j] ?? 0) + 1,
				(current[j - 1] ?? 0) + 1
			);
		}
		previous = current;
	}
	return previous[b.length] ?? 0;
}

/**
 * Whether a transcribed word is the same script word, allowing ASR spelling
 * slips: at most a third of the longer token's characters differ.
 */
export function similarTokens(a: string, b: string): boolean {
	if (a === b) {
		return true;
	}
	const longest = Math.max(a.length, b.length);
	return longest >= 3 && editDistance(a, b) * 3 <= longest;
}

/**
 * Pair script tokens with transcribed words in order (a longest common
 * subsequence over similar tokens). Returns, per script token, the index of
 * the measured word it takes timing from; unrelated words never pair, so
 * a script word the transcript lacks is spread instead of mistimed.
 */
function alignTokens(
	script: readonly string[],
	measured: readonly string[]
): (number | undefined)[] {
	const rows = script.length + 1;
	const cols = measured.length + 1;
	const score = new Uint32Array(rows * cols);
	const same = (i: number, j: number) =>
		similarTokens(script[i - 1] ?? "", measured[j - 1] ?? "");
	for (let i = 1; i < rows; i += 1) {
		for (let j = 1; j < cols; j += 1) {
			score[i * cols + j] = same(i, j)
				? (score[(i - 1) * cols + j - 1] ?? 0) + 1
				: Math.max(
						score[(i - 1) * cols + j] ?? 0,
						score[i * cols + j - 1] ?? 0
					);
		}
	}
	const pairs: (number | undefined)[] = new Array(script.length);
	let i = script.length;
	let j = measured.length;
	while (i > 0 && j > 0) {
		if (
			same(i, j) &&
			score[i * cols + j] === (score[(i - 1) * cols + j - 1] ?? 0) + 1
		) {
			pairs[i - 1] = j - 1;
			i -= 1;
			j -= 1;
		} else if (
			(score[(i - 1) * cols + j] ?? 0) >= (score[i * cols + j - 1] ?? 0)
		) {
			i -= 1;
		} else {
			j -= 1;
		}
	}
	return pairs;
}

/** Spread `tokens` over `[start, end]` in proportion to their length. */
function spread(
	tokens: readonly string[],
	start: number,
	end: number
): NarrationWord[] {
	const weights = tokens.map((token) => token.length + 1);
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	let cursor = start;
	return tokens.map((text, index) => {
		const from = cursor;
		cursor =
			index === tokens.length - 1
				? end
				: cursor + ((end - start) * (weights[index] ?? 0)) / total;
		return { end: cursor, start: from, text };
	});
}

/**
 * Make word times strictly increasing inside `[0, duration]`, each word at
 * least `minimum` long (captions require `end > start`).
 */
function normalizeWordTimes(
	words: NarrationWord[],
	duration: number
): NarrationWord[] {
	if (!words.length) {
		return words;
	}
	const minimum = Math.min(0.02, duration / (words.length * 2));
	const result = words.map((word) => ({
		...word,
		end: Math.min(duration, Math.max(0, word.end)),
		start: Math.min(duration, Math.max(0, word.start)),
	}));
	let floor = 0;
	for (const word of result) {
		word.start = Math.max(word.start, floor);
		word.end = Math.max(word.end, word.start + minimum);
		floor = word.end;
	}
	let ceiling = duration;
	for (let index = result.length - 1; index >= 0; index -= 1) {
		const word = result[index];
		if (!word) {
			continue;
		}
		word.end = Math.min(word.end, ceiling);
		word.start = Math.min(word.start, word.end - minimum);
		ceiling = word.start;
	}
	return result;
}

/**
 * Time every token of the scene's narration `text` against `measured` words
 * from transcribing its audio. Matched tokens take the measured timing (the
 * script's spelling is kept); unmatched runs are spread between their timed
 * neighbours. With nothing measured the whole clip is spread by length.
 */
export function alignNarrationWords(
	text: string,
	measured: readonly NarrationWord[],
	duration: number
): NarrationWord[] {
	const tokens = tokensOf(text);
	if (!tokens.length || duration <= 0) {
		return [];
	}
	const usable = measured
		.filter(
			(word) =>
				Number.isFinite(word.start) &&
				Number.isFinite(word.end) &&
				word.end > word.start &&
				word.start < duration &&
				normalizeToken(word.text)
		)
		.sort((a, b) => a.start - b.start);
	if (!usable.length) {
		return normalizeWordTimes(spread(tokens, 0, duration), duration);
	}
	const pairs = alignTokens(
		tokens.map(normalizeToken),
		usable.map((word) => normalizeToken(word.text))
	);
	const words: (NarrationWord | undefined)[] = tokens.map((token, index) => {
		const match = pairs[index];
		const source = match === undefined ? undefined : usable[match];
		return source
			? {
					end: Math.min(duration, source.end),
					start: source.start,
					text: token,
				}
			: undefined;
	});
	let index = 0;
	while (index < tokens.length) {
		if (words[index]) {
			index += 1;
			continue;
		}
		let stop = index;
		while (stop < tokens.length && !words[stop]) {
			stop += 1;
		}
		const from = words[index - 1]?.end ?? 0;
		const to = words[stop]?.start ?? duration;
		const filled = spread(tokens.slice(index, stop), from, Math.max(from, to));
		for (const [offset, word] of filled.entries()) {
			words[index + offset] = word;
		}
		index = stop;
	}
	return normalizeWordTimes(
		words.filter((word): word is NarrationWord => word !== undefined),
		duration
	);
}

export const scriptAssembleSceneSchema = z
	.object({
		narrationAssetId: idSchema,
		visualAssetId: idSchema,
		text: narrationText,
	})
	.strict();

export const scriptAssembleRequestSchema = z
	.object({
		scenes: z.array(scriptAssembleSceneSchema).min(1).max(MAX_SCRIPT_SCENES),
		/** Caption grouping; defaults to the project's, else word chunks. */
		captionChunking: captionChunkingSchema.optional(),
		/** Build captions from the narration (default true). */
		captions: z.boolean().optional(),
		/** Timeline start; defaults to the end of the current edit. */
		at: timeSchema.optional(),
		/** Silence between scenes in seconds (default 0). */
		gap: bounded(0, 2).optional(),
		/** Slow zoom and drift on stills (default true). */
		kenBurns: z.boolean().optional(),
		/** How visuals fill the frame (default fill). */
		fit: z.enum(["fit", "fill"]).optional(),
		/**
		 * A local music bed scored over the assembly and ducked under the
		 * narration (see `shared/script-extras.ts`). The sidecar route adds it.
		 */
		music: scriptMusicSchema.optional(),
		/** One preset avatar presenter per scene, lip-synced by the sidecar route. */
		avatar: scriptAvatarSchema.optional(),
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type ScriptAssembleRequest = z.infer<typeof scriptAssembleRequestSchema>;
export type ScriptAssembleInput = z.input<typeof scriptAssembleRequestSchema>;

/** Measured timing for a narration asset, in source seconds. */
export interface NarrationTiming {
	/** True for word-level timing from transcription; false for estimates. */
	measured: boolean;
	words: NarrationWord[];
}

export interface ScriptAssembleOptions {
	/** Transcribed timing of a narration asset, when it has one. */
	narrationTiming?: (assetId: string) => NarrationTiming | undefined;
	newId?: () => string;
}

/** Where one scene landed on the timeline. */
export interface AssembledScriptScene {
	end: number;
	narrationClipId: string;
	start: number;
	visualClipIds: string[];
}

export interface ScriptAssembly {
	/** Presenter avatars added, one per scene (empty without `avatar`). */
	avatars: PlacedScriptAvatar[];
	/** Captions added (after chunking). */
	captions: number;
	/** Seconds of timeline the assembly occupies, including gaps. */
	duration: number;
	narrationTrack: number;
	project: Project;
	/** Existing captions removed because they overlapped the assembly. */
	replacedCaptions: number;
	scenes: AssembledScriptScene[];
	visualTrack: number;
}

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
