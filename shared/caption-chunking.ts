import { z } from "zod";
import {
	filterProfanity,
	type ProfanityMatcher,
	type ProfanityMode,
	profanityMatcher,
	profanityWordsSchema,
} from "./profanity.ts";
import {
	type Asset,
	activeCaptions,
	type Caption,
	type Project,
	validateProject,
	withActiveCaptions,
} from "./project.ts";
import {
	type CaptionChunking,
	captionChunkingSchema,
} from "./schema/caption-style.ts";

/** Caption words carry at most 20 measured words per cue (schema bound). */
export const MAX_CAPTION_WORDS = 20;
/** Word grouping defaults when `chunking` leaves a limit unset. */
export const DEFAULT_CHUNK_WORDS = 6;
export const DEFAULT_CHUNK_CHARS = 32;
/** A pause this long between words always starts a new caption. */
export const CHUNK_PAUSE = 0.7;

export interface ResolvedCaptionChunking {
	closeGaps: number;
	emoji: boolean;
	maxChars: number;
	maxWords: number;
	minDuration: number;
	mode: CaptionChunking["mode"];
	profanity: ProfanityMode;
}

/** Chunking settings with their defaults resolved (the stored value stays sparse). */
export function chunkingOf(
	chunking: CaptionChunking | undefined
): ResolvedCaptionChunking {
	const mode = chunking?.mode ?? "segments";
	// `segments` keeps cues whole unless a limit is set explicitly.
	const segments = mode === "segments";
	let maxWords = Math.min(
		MAX_CAPTION_WORDS,
		chunking?.maxWords ?? (segments ? MAX_CAPTION_WORDS : DEFAULT_CHUNK_WORDS)
	);
	if (mode === "single-word") {
		maxWords = 1;
	}
	return {
		closeGaps: chunking?.closeGaps ?? 0,
		emoji: chunking?.emoji ?? false,
		maxChars:
			chunking?.maxChars ??
			(segments ? Number.POSITIVE_INFINITY : DEFAULT_CHUNK_CHARS),
		maxWords,
		minDuration: chunking?.minDuration ?? 0,
		mode,
		profanity: chunking?.profanity ?? "none",
	};
}

/** One timed word with the caption-level context it came from. */
export interface ChunkWord {
	/** The source cue's end, on the cue's last word. */
	cueEnd?: number;
	/** The source cue's start, on the cue's first word. */
	cueStart?: number;
	end: number;
	highlightColor?: string;
	/** Word id when the timing was measured; estimated words have none. */
	id?: string;
	/** Index of the source caption, so `segments` mode keeps cue boundaries. */
	source: number;
	sourceAssetId?: string;
	speakerId?: string;
	start: number;
	text: string;
}

/**
 * The words of one caption: its measured words, or the text split on
 * whitespace with times spread across the cue in proportion to length.
 */
export function captionWords(caption: Caption, source = 0): ChunkWord[] {
	const base = {
		highlightColor: caption.highlightColor,
		source,
		sourceAssetId: caption.sourceAssetId,
	};
	const bounded = (words: ChunkWord[]): ChunkWord[] =>
		words.map((word, index) => ({
			...word,
			...(index === 0 ? { cueStart: caption.start } : {}),
			...(index === words.length - 1 ? { cueEnd: caption.end } : {}),
		}));
	if (caption.words?.length) {
		return bounded(
			caption.words.map((word) => ({
				...base,
				end: word.end,
				id: word.id,
				speakerId: word.speakerId ?? caption.speakerId,
				start: word.start,
				text: word.text,
			}))
		);
	}
	const tokens = caption.text.split(/\s+/).filter(Boolean);
	const weights = tokens.map((token) => token.length + 1);
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	const span = caption.end - caption.start;
	let cursor = caption.start;
	return bounded(
		tokens.map((text, index) => {
			const start = cursor;
			cursor =
				index === tokens.length - 1
					? caption.end
					: cursor + (span * (weights[index] ?? 0)) / total;
			return {
				...base,
				end: cursor,
				speakerId: caption.speakerId,
				start,
				text,
			};
		})
	);
}

const sameContext = (a: ChunkWord, b: ChunkWord) =>
	a.speakerId === b.speakerId &&
	a.sourceAssetId === b.sourceAssetId &&
	(a.id === undefined) === (b.id === undefined);

const charsOf = (words: readonly ChunkWord[]) =>
	words.reduce(
		(sum, word, index) => sum + word.text.length + (index ? 1 : 0),
		0
	);

const endsSentence = (word: ChunkWord) => /[.!?…]["')\]]*$/.test(word.text);

/** Group words into chunks honoring the word and character limits. */
function groupWords(
	words: readonly ChunkWord[],
	settings: ResolvedCaptionChunking
): ChunkWord[][] {
	const chunks: ChunkWord[][] = [];
	let current: ChunkWord[] = [];
	for (const word of words) {
		const previous = current.at(-1);
		const fits =
			previous &&
			current.length < settings.maxWords &&
			charsOf([...current, word]) <= settings.maxChars &&
			sameContext(previous, word) &&
			(settings.mode === "segments"
				? previous.source === word.source
				: word.start - previous.end < CHUNK_PAUSE) &&
			(settings.mode === "segments" || !endsSentence(previous));
		if (previous && !fits) {
			chunks.push(current);
			current = [];
		}
		current.push(word);
	}
	if (current.length) {
		chunks.push(current);
	}
	return chunks;
}

interface Chunk {
	end: number;
	start: number;
	words: ChunkWord[];
}

const canMerge = (
	a: Chunk,
	b: Chunk,
	settings: ResolvedCaptionChunking
): boolean => {
	const last = a.words.at(-1);
	const first = b.words[0];
	return (
		settings.mode !== "single-word" &&
		Boolean(last && first && sameContext(last, first)) &&
		a.words.length + b.words.length <= MAX_CAPTION_WORDS &&
		charsOf([...a.words, ...b.words]) <= Math.max(settings.maxChars, 1)
	);
};

/**
 * Lengthen chunks shorter than `minDuration`: first by extending into the
 * silence before the next chunk, then by merging with a neighbour that shares
 * the speaker and still fits the limits.
 */
function enforceMinDuration(
	chunks: Chunk[],
	settings: ResolvedCaptionChunking
): Chunk[] {
	if (settings.minDuration <= 0) {
		return chunks;
	}
	const result: Chunk[] = [];
	for (let index = 0; index < chunks.length; index += 1) {
		const chunk = chunks[index];
		if (!chunk) {
			continue;
		}
		const next = chunks[index + 1];
		let current = { ...chunk };
		if (current.end - current.start < settings.minDuration) {
			current.end = Math.min(
				current.start + settings.minDuration,
				next ? Math.max(current.end, next.start) : Number.POSITIVE_INFINITY
			);
		}
		if (current.end - current.start < settings.minDuration) {
			const previous = result.at(-1);
			if (next && canMerge(current, next, settings)) {
				current = {
					end: next.end,
					start: current.start,
					words: [...current.words, ...next.words],
				};
				index += 1;
			} else if (previous && canMerge(previous, current, settings)) {
				result.pop();
				current = {
					end: current.end,
					start: previous.start,
					words: [...previous.words, ...current.words],
				};
			}
		}
		result.push(current);
	}
	return result;
}

/** Extend each chunk to the next one when the gap between them is shorter than `closeGaps`. */
function closeGaps(chunks: Chunk[], gap: number): Chunk[] {
	if (gap <= 0) {
		return chunks;
	}
	return chunks.map((chunk, index) => {
		const next = chunks[index + 1];
		return next && next.start > chunk.end && next.start - chunk.end < gap
			? { ...chunk, end: next.start }
			: chunk;
	});
}

function chunkCaption(chunk: Chunk, newId: () => string): Caption | null {
	const words = chunk.words.filter((word) => word.text.trim());
	const first = words[0];
	if (!first) {
		return null;
	}
	const text = words.map((word) => word.text).join(" ");
	const speakers = new Set(words.map((word) => word.speakerId));
	const speakerId = speakers.size === 1 ? first.speakerId : undefined;
	const caption: Caption = {
		end: chunk.end,
		id: newId(),
		start: chunk.start,
		text,
	};
	if (first.sourceAssetId) {
		caption.sourceAssetId = first.sourceAssetId;
	}
	if (words.every((word) => word.id)) {
		caption.words = words.map((word) => {
			const measured: NonNullable<Caption["words"]>[number] = {
				end: word.end,
				id: word.id ?? newId(),
				start: word.start,
				text: word.text,
			};
			if (word.speakerId) {
				measured.speakerId = word.speakerId;
			}
			return measured;
		});
	}
	if (first.highlightColor) {
		caption.highlightColor = first.highlightColor;
	}
	if (speakerId) {
		caption.speakerId = speakerId;
	}
	return caption;
}

/**
 * `segments` mode with no explicit limit keeps untimed cues whole: the
 * 20-word cap is the schema bound on measured `words`, not on cue text.
 */
function keepsUntimedCues(chunking: CaptionChunking | undefined): boolean {
	return (
		(chunking?.mode ?? "segments") === "segments" &&
		chunking?.maxWords === undefined &&
		chunking?.maxChars === undefined
	);
}

/** An untimed cue as one unit, its text (line breaks included) intact. */
function wholeCue(caption: Caption, source: number): ChunkWord[] {
	return [
		{
			cueEnd: caption.end,
			cueStart: caption.start,
			end: caption.end,
			highlightColor: caption.highlightColor,
			source,
			sourceAssetId: caption.sourceAssetId,
			speakerId: caption.speakerId,
			start: caption.start,
			text: caption.text,
		},
	];
}

export interface RechunkOptions {
	/** Id factory for new captions (tests inject a deterministic one). */
	newId?: () => string;
	/** Extra whole words treated as profanity, beyond the bundled list. */
	profanityWords?: readonly string[];
}

/**
 * Regroup captions by `chunking`: `segments` keeps each cue (splitting only
 * cues over the limits), `words` regroups all words up to `maxWords` /
 * `maxChars` (breaking at sentence ends, pauses, and speaker changes), and
 * `single-word` shows one word per caption. Short captions grow toward
 * `minDuration`, gaps under `closeGaps` close, profanity is masked or
 * removed, and every caption keeps its speaker, source asset, and highlight.
 * `words` overrides the measured words taken from the captions when given.
 */
export function rechunk(
	captions: readonly Caption[],
	words: readonly ChunkWord[] | undefined,
	chunking: CaptionChunking | undefined,
	options: RechunkOptions = {}
): Caption[] {
	const settings = chunkingOf(chunking);
	const newId = options.newId ?? (() => crypto.randomUUID());
	const matcher = profanityMatcher(options.profanityWords);
	const ordered = [...captions].sort((a, b) => a.start - b.start);
	const keepCues = keepsUntimedCues(chunking);
	const allWords = (
		words ??
		ordered.flatMap((caption, index) =>
			keepCues && !caption.words?.length
				? wholeCue(caption, index)
				: captionWords(caption, index)
		)
	)
		.map((word) => cleanWord(word, settings.profanity, matcher))
		.filter((word): word is ChunkWord => word !== null)
		.sort((a, b) => a.start - b.start);
	const chunks = groupWords(allWords, settings).map((group) => ({
		end: group.at(-1)?.cueEnd ?? group.at(-1)?.end ?? 0,
		start: group[0]?.cueStart ?? group[0]?.start ?? 0,
		words: group,
	}));
	const timed = closeGaps(
		enforceMinDuration(chunks, settings),
		settings.closeGaps
	);
	return timed
		.map((chunk) => chunkCaption(chunk, newId))
		.filter((caption): caption is Caption => caption !== null);
}

function cleanWord(
	word: ChunkWord,
	mode: ProfanityMode,
	matcher: ProfanityMatcher
): ChunkWord | null {
	const text = filterProfanity(word.text, mode, matcher).trim();
	if (!text) {
		return null;
	}
	return text === word.text ? word : { ...word, text };
}

export const captionRechunkRequestSchema = z
	.object({
		chunking: captionChunkingSchema,
		profanityWords: profanityWordsSchema.optional(),
		revision: z.number().int().nonnegative(),
		trackId: z.uuid().nullable().default(null),
	})
	.strict();
export type CaptionRechunkInput = z.input<typeof captionRechunkRequestSchema>;

/**
 * Rechunk the active captions (or a language track) and remember the
 * chunking settings on the project.
 */
export function rechunkProject(
	project: Project,
	assets: readonly Asset[],
	input: CaptionRechunkInput,
	options: Pick<RechunkOptions, "newId"> = {}
): Project {
	const request = captionRechunkRequestSchema.parse(input);
	const track = request.trackId
		? project.captionTracks.find((item) => item.id === request.trackId)
		: undefined;
	if (request.trackId && !track) {
		throw new Error("Caption track not found.");
	}
	const source = track ? track.captions : activeCaptions(project);
	if (!source.length) {
		throw new Error("There are no captions to rechunk.");
	}
	const captions = rechunk(source, undefined, request.chunking, {
		...options,
		profanityWords: request.profanityWords,
	});
	if (!captions.length) {
		throw new Error("Rechunking removed every caption.");
	}
	if (captions.length > 5000) {
		throw new Error("Rechunking would create more than 5000 captions.");
	}
	const withChunking = { ...project, captionChunking: request.chunking };
	const next = track
		? {
				...withChunking,
				captionTracks: project.captionTracks.map((item) =>
					item.id === track.id ? { ...item, captions } : item
				),
			}
		: withActiveCaptions(withChunking, captions);
	return validateProject(next, [...assets]);
}
