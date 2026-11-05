/**
 * "Fix names and terms": a per-project glossary of wrong→right pairs that
 * batch-replaces whole words or phrases in captions (their line text and
 * timed words) and source transcripts, plus an optional model pass that
 * suggests pairs for misheard proper nouns and jargon.
 */
import { z } from "zod";
import type { Caption, Project } from "./project.ts";
import {
	captionGlossarySchema,
	type GlossaryEntry,
	glossaryEntrySchema,
	MAX_GLOSSARY_ENTRIES,
} from "./schema/caption-glossary.ts";

export {
	captionGlossarySchema,
	type GlossaryEntry,
	glossaryEntrySchema,
	MAX_GLOSSARY_ENTRIES,
};

const escapeRegExp = (text: string) =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Letters, digits, apostrophes: a match must not sit inside a longer word. */
const WORD_CHAR = "[\\p{L}\\p{N}'’]";

/**
 * One case-insensitive matcher per entry: whole words or phrases only, with
 * any run of spaces in `from` matching any run of spaces in the text.
 */
function matchers(glossary: readonly GlossaryEntry[]) {
	return glossary
		.filter((entry) => entry.from.trim() && entry.from.trim() !== entry.to)
		.map((entry) => ({
			pattern: new RegExp(
				`(?<!${WORD_CHAR})${entry.from
					.trim()
					.split(/\s+/)
					.map(escapeRegExp)
					.join("\\s+")}(?!${WORD_CHAR})`,
				"giu"
			),
			to: entry.to,
		}));
}

/** Replace glossary terms in one text; returns the text and the replacement count. */
export function applyGlossaryToText(
	text: string,
	glossary: readonly GlossaryEntry[]
): { count: number; text: string } {
	let count = 0;
	let next = text;
	for (const { pattern, to } of matchers(glossary)) {
		next = next.replace(pattern, (match) => {
			if (match === to) {
				return match;
			}
			count += 1;
			return to;
		});
	}
	return { count, text: next };
}

/**
 * Apply the glossary to captions: line text and each timed word. A word
 * entry only matches single words; a multi-word `from` fixes the line text,
 * and the words it spans are rewritten in place when they match word for
 * word (so word highlighting stays timed).
 */
export function applyGlossaryToCaptions(
	captions: readonly Caption[],
	glossary: readonly GlossaryEntry[]
): { captions: Caption[]; replacements: number } {
	let replacements = 0;
	const next = captions.map((caption) => {
		const line = applyGlossaryToText(caption.text, glossary);
		replacements += line.count;
		if (!caption.words?.length) {
			return line.count ? { ...caption, text: line.text } : caption;
		}
		const words = rewriteWords(caption.words, glossary);
		replacements += line.count ? 0 : words.count;
		return line.count || words.count
			? { ...caption, text: line.text, words: words.words }
			: caption;
	});
	return { captions: next, replacements };
}

type CaptionWord = NonNullable<Caption["words"]>[number];

/** Rewrite timed words: phrases spanning several words keep the first word's slot. */
function rewriteWords(
	words: readonly CaptionWord[],
	glossary: readonly GlossaryEntry[]
): { count: number; words: CaptionWord[] } {
	let count = 0;
	let result = [...words];
	for (const entry of glossary) {
		const parts = entry.from.trim().split(/\s+/);
		const bare = (text: string) =>
			text.toLocaleLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
		const next: CaptionWord[] = [];
		for (let index = 0; index < result.length; ) {
			const window = result.slice(index, index + parts.length);
			const matches =
				window.length === parts.length &&
				window.every(
					(word, offset) =>
						bare(word.text) === (parts[offset] ?? "").toLocaleLowerCase()
				);
			const first = window[0];
			const last = window.at(-1);
			if (matches && first && last) {
				const trailing = last.text.match(/[^\p{L}\p{N}]+$/u)?.[0] ?? "";
				const text = `${entry.to}${trailing}`;
				if (text !== window.map((word) => word.text).join(" ")) {
					count += 1;
				}
				next.push({ ...first, end: last.end, text });
				index += parts.length;
			} else if (result[index]) {
				next.push(result[index] as CaptionWord);
				index += 1;
			} else {
				index += 1;
			}
		}
		result = next;
	}
	return { count, words: result };
}

/** Merge new pairs into a glossary: a later pair for the same `from` wins. */
export function mergeGlossary(
	current: readonly GlossaryEntry[],
	additions: readonly GlossaryEntry[]
): GlossaryEntry[] {
	const byKey = new Map<string, GlossaryEntry>();
	for (const entry of [...current, ...additions]) {
		const from = entry.from.trim();
		const to = entry.to.trim();
		if (from && to && from !== to) {
			byKey.set(from.toLocaleLowerCase(), { from, to });
		}
	}
	return [...byKey.values()].slice(0, MAX_GLOSSARY_ENTRIES);
}

/** `POST /projects/:id/caption-glossary` */
export const captionGlossaryRequestSchema = z
	.object({
		/** Replace the project's glossary; omitted keeps the saved one. */
		glossary: captionGlossarySchema.optional(),
		/** Apply the glossary now (default true); false only saves it. */
		apply: z.boolean().default(true),
		/** Also fix every caption language track, not only the source captions. */
		allTracks: z.boolean().default(false),
		/** Also fix the saved transcripts of media on the timeline. */
		transcripts: z.boolean().default(true),
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type CaptionGlossaryRequest = z.infer<
	typeof captionGlossaryRequestSchema
>;
export type CaptionGlossaryInput = z.input<typeof captionGlossaryRequestSchema>;

/** Most caption characters sent to the model for suggestions. */
const MAX_SUGGESTION_TEXT = 12_000;

/**
 * The `model.complete` request that proposes glossary pairs: misheard proper
 * nouns, brand names, and jargon in the caption text, given the project's
 * title and brief as context.
 */
export function glossarySuggestionRequest(
	captions: readonly Caption[],
	context: { brief?: string; title?: string } = {}
): { prompt: string; system: string } {
	const text = captions
		.map((caption) => caption.text)
		.join("\n")
		.slice(0, MAX_SUGGESTION_TEXT);
	if (!text.trim()) {
		throw new Error("Add or transcribe captions before asking for fixes.");
	}
	return {
		system: [
			"You proofread automatic captions for misheard names and terms.",
			'Return only JSON shaped {"fixes":[{"from":string,"to":string}]}.',
			"from is text exactly as it appears in the captions; to is the corrected spelling.",
			"Only fix proper nouns (people, places, brands, products) and technical jargon that speech recognition likely misheard. Do not fix grammar, punctuation, or style.",
			"Use the title and brief for context. If unsure, leave a term out. At most 30 fixes.",
		].join(" "),
		prompt: JSON.stringify({
			...(context.title ? { title: context.title.slice(0, 200) } : {}),
			...(context.brief ? { brief: context.brief.slice(0, 1000) } : {}),
			captions: text,
		}),
	};
}

/** Parse the model's suggestions; malformed pairs and no-op pairs are dropped. */
export function parseGlossarySuggestions(text: string): GlossaryEntry[] {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) {
		throw new Error("Ryu did not suggest any fixes. Try again.");
	}
	let value: unknown;
	try {
		value = JSON.parse(text.slice(start, end + 1));
	} catch {
		throw new Error("Ryu's suggestions could not be read. Try again.");
	}
	const fixes = z
		.object({ fixes: z.array(z.unknown()).max(100) })
		.safeParse(value);
	if (!fixes.success) {
		throw new Error("Ryu's suggestions could not be read. Try again.");
	}
	return mergeGlossary(
		[],
		fixes.data.fixes.flatMap((item) => {
			const parsed = glossaryEntrySchema.safeParse(item);
			return parsed.success ? [parsed.data] : [];
		})
	).slice(0, 30);
}

/**
 * Save and/or apply the glossary to a project: the source captions, and
 * every language track with `allTracks`. Returns the next project and the
 * number of replacements (the caller saves it and fixes transcripts).
 */
export function applyCaptionGlossary(
	project: Project,
	input: CaptionGlossaryInput
): { glossary: GlossaryEntry[]; project: Project; replacements: number } {
	const request = captionGlossaryRequestSchema.parse(input);
	const glossary = mergeGlossary(
		[],
		request.glossary ?? project.captionGlossary ?? []
	);
	let next: Project = {
		...project,
		...(request.glossary ? { captionGlossary: glossary } : {}),
	};
	if (!request.apply || glossary.length === 0) {
		return { glossary, project: next, replacements: 0 };
	}
	const source = applyGlossaryToCaptions(next.captions, glossary);
	let replacements = source.replacements;
	next = { ...next, captions: source.captions };
	if (request.allTracks) {
		next = {
			...next,
			captionTracks: next.captionTracks.map((track) => {
				const fixed = applyGlossaryToCaptions(track.captions, glossary);
				replacements += fixed.replacements;
				return fixed.replacements
					? { ...track, captions: fixed.captions }
					: track;
			}),
		};
	}
	return { glossary, project: next, replacements };
}
