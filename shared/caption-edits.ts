import { z } from "zod";
import {
	type Asset,
	type Caption,
	captionSchema,
	type Project,
	validateProject,
	withActiveCaptions,
} from "./project.ts";
import {
	parseSubtitles,
	parseSubtitlesLenient,
	type SkippedCue,
	type SubtitleImport,
} from "./subtitles.ts";

export const captionEditRequestSchema = z
	.object({
		action: z.enum(["append", "remove", "replace"]),
		captionIds: z.array(z.uuid()).max(5000).default([]),
		captions: z.array(captionSchema).max(5000).default([]),
		revision: z.number().int().nonnegative(),
		trackId: z.uuid().nullable().default(null),
	})
	.strict();

export type CaptionEditRequest = z.infer<typeof captionEditRequestSchema>;

export type EditCaptionsInput = z.input<typeof captionEditRequestSchema>;

/** Apply one bounded caption edit to the source or an existing language track. */
export function editCaptions(
	project: Project,
	assets: readonly Asset[],
	input: EditCaptionsInput
): Project {
	const request = captionEditRequestSchema.parse(input);
	const current = request.trackId
		? project.captionTracks.find((track) => track.id === request.trackId)
				?.captions
		: project.captions;
	if (!current) {
		throw new Error("Caption track not found.");
	}
	let captions: Caption[];
	if (request.action === "replace") {
		captions = request.captions;
	} else if (request.action === "append") {
		captions = [...current, ...request.captions];
	} else {
		const removed = new Set(request.captionIds);
		captions = current.filter((caption) => !removed.has(caption.id));
	}
	const next = request.trackId
		? {
				...project,
				captionTracks: project.captionTracks.map((track) =>
					track.id === request.trackId ? { ...track, captions } : track
				),
			}
		: withActiveCaptions({ ...project, captionTrackId: null }, captions);
	return validateProject(next, [...assets]);
}

export const captionImportRequestSchema = z
	.object({
		format: z.enum(["srt", "vtt", "ass"]),
		/** Keep valid cues and report skipped ones instead of failing on the first. */
		lenient: z.boolean().default(false),
		/** `replace` swaps the target captions; `append` adds after them. */
		mode: z.enum(["replace", "append"]).default("replace"),
		revision: z.number().int().nonnegative(),
		text: z.string().min(1).max(2_000_000),
		trackId: z.uuid().nullable().default(null),
	})
	.strict();
export type CaptionImportInput = z.input<typeof captionImportRequestSchema>;

export interface CaptionImportResult {
	imported: number;
	project: Project;
	skipped: SkippedCue[];
}

/** Import subtitle text into the source captions or a language track. */
export function importCaptions(
	project: Project,
	assets: readonly Asset[],
	input: CaptionImportInput
): CaptionImportResult {
	const request = captionImportRequestSchema.parse(input);
	let parsed: SubtitleImport;
	if (request.lenient) {
		parsed = parseSubtitlesLenient(request.text, request.format);
		if (!parsed.captions.length) {
			throw new Error(
				`No valid captions found; ${parsed.skipped.length} cue${parsed.skipped.length === 1 ? " was" : "s were"} skipped.`
			);
		}
	} else {
		parsed = {
			captions: parseSubtitles(request.text, request.format),
			skipped: [],
		};
	}
	const next = editCaptions(project, assets, {
		action: request.mode,
		captions: parsed.captions,
		revision: request.revision,
		trackId: request.trackId,
	});
	return {
		imported: parsed.captions.length,
		project: next,
		skipped: parsed.skipped,
	};
}

/** Subtitle format of a picked file, from its extension. */
export function subtitleFormatOfFile(
	name: string
): "srt" | "vtt" | "ass" | null {
	const extension = name.toLowerCase().split(".").at(-1);
	if (extension === "srt" || extension === "vtt") {
		return extension;
	}
	return extension === "ass" || extension === "ssa" ? "ass" : null;
}

/** One user-confirmable emoji suggestion for a caption. */
export interface EmojiSuggestion {
	captionId: string;
	emoji: string;
}

/**
 * One or two emoji graphemes: pictographs, optionally joined (ZWJ) and
 * carrying variation selectors or skin-tone modifiers; nothing else.
 */
export function isEmoji(value: string): boolean {
	const graphemes = [
		...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
			value
		),
	];
	if (graphemes.length < 1 || graphemes.length > 2) {
		return false;
	}
	return graphemes.every(({ segment }) =>
		/^\p{Extended_Pictographic}+$/u.test(
			segment.replace(/\u{200D}|\u{FE0F}|\p{Emoji_Modifier}/gu, "")
		)
	);
}

const emojiResponseSchema = z.object({
	suggestions: z
		.array(z.object({ id: z.string(), emoji: z.string().trim() }))
		.max(5000),
});

/** System and user prompt asking `model.complete` for per-caption emoji. */
export function emojiPrompt(captions: readonly Caption[]): {
	prompt: string;
	system: string;
} {
	return {
		prompt: JSON.stringify(
			captions.slice(0, 400).map((caption) => ({
				id: caption.id,
				text: caption.text,
			}))
		),
		system:
			'You add emoji to video captions. For captions where one emoji clearly fits the meaning, suggest exactly one. Skip neutral captions. Reply with JSON only: {"suggestions":[{"id":"<caption id>","emoji":"<emoji>"}]}.',
	};
}

/**
 * Parse the model's reply into suggestions for known captions. Unknown ids,
 * non-emoji values, and duplicates are dropped; malformed replies yield [].
 */
export function parseEmojiSuggestions(
	reply: string,
	captions: readonly Caption[]
): EmojiSuggestion[] {
	const json = reply.match(/\{[\s\S]*\}/)?.[0];
	if (!json) {
		return [];
	}
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch {
		return [];
	}
	const parsed = emojiResponseSchema.safeParse(data);
	if (!parsed.success) {
		return [];
	}
	const known = new Set(captions.map((caption) => caption.id));
	const seen = new Set<string>();
	const suggestions: EmojiSuggestion[] = [];
	for (const item of parsed.data.suggestions) {
		if (known.has(item.id) && !seen.has(item.id) && isEmoji(item.emoji)) {
			seen.add(item.id);
			suggestions.push({ captionId: item.id, emoji: item.emoji });
		}
	}
	return suggestions;
}

/**
 * Append confirmed emoji to their captions. Word-timed captions carry the
 * emoji on their last word so the text still matches its word alignment.
 */
export function applyEmojiSuggestions(
	captions: readonly Caption[],
	suggestions: readonly EmojiSuggestion[]
): Caption[] {
	const byId = new Map(suggestions.map((item) => [item.captionId, item.emoji]));
	return captions.map((caption) => {
		const emoji = byId.get(caption.id);
		if (!emoji || caption.text.length + emoji.length + 1 > 2000) {
			return caption;
		}
		const words = caption.words?.map((word, index, list) =>
			index === list.length - 1
				? { ...word, text: `${word.text} ${emoji}` }
				: word
		);
		return {
			...caption,
			text: `${caption.text} ${emoji}`,
			...(words ? { words } : {}),
		};
	});
}
