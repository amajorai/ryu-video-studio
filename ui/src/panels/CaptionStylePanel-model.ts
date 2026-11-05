import { z } from "zod";
import { activeTrackStyle } from "../../../shared/caption-style.ts";
import { profanityWordsSchema } from "../../../shared/profanity.ts";
import type { Project } from "../../../shared/project.ts";
import type {
	CaptionChunking,
	CaptionStyle,
} from "../../../shared/schema/caption-style.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { studioFormat } from "../i18n/format.ts";

export const PROFANITY_KEY = "caption-profanity-words";
export const MAX_IMPORT_BYTES = 2_000_000;

export type Runtime = EditorRuntime & { project: Project };

/** Style target: the active language track when one is selected. */
export const styleTargetTrackId = (project: Project): string | null =>
	project.captionTrackId ?? null;

/** The style currently stored for the target (project or active track). */
export const storedStyle = (project: Project): CaptionStyle | undefined =>
	project.captionTrackId ? activeTrackStyle(project) : project.captionStyle;

/** Status line after an import, from the route's extras. */
export function importSummary(extras: Record<string, unknown>): string {
	const imported = typeof extras.imported === "number" ? extras.imported : 0;
	const skipped = Array.isArray(extras.skipped) ? extras.skipped : [];
	const base = studioFormat(
		"Imported {count, plural, one {# caption} other {# captions}}.",
		{ count: imported }
	);
	if (!skipped.length) {
		return base;
	}
	const first = z
		.object({ line: z.number(), reason: z.string() })
		.safeParse(skipped[0]);
	const skippedText = studioFormat(
		"Skipped {count, plural, one {# malformed cue} other {# malformed cues}}.",
		{ count: skipped.length }
	);
	const detail = first.success
		? ` ${studioFormat("First: line {line}, {reason}", {
				line: first.data.line,
				reason: first.data.reason,
			})}`
		: "";
	return `${base} ${skippedText}${detail}`;
}

/** Comma or newline separated words, validated against the route schema. */
export function parseProfanityList(text: string): string[] {
	const words = [
		...new Set(
			text
				.split(/[\s,]+/)
				.map((word) => word.trim())
				.filter(Boolean)
		),
	];
	const parsed = profanityWordsSchema.safeParse(words);
	return parsed.success ? parsed.data : [];
}

/** Body for `caption-rechunk` (profanity words only when filtering). */
export function rechunkBody(
	chunking: CaptionChunking,
	profanityWords: readonly string[],
	trackId: string | null
): Record<string, unknown> {
	const body: Record<string, unknown> = { chunking, trackId };
	if ((chunking.profanity ?? "none") !== "none" && profanityWords.length) {
		body.profanityWords = [...profanityWords];
	}
	return body;
}

/** The text a number field shows for `value` (empty when unset). */
export function numberFieldText(value: number | undefined): string {
	return value === undefined ? "" : String(Number(value.toFixed(4)));
}

/**
 * Parse a number field's text: `null` for an empty field, `undefined` for
 * text that is not a number yet, otherwise the value clamped into range.
 */
export function parseNumberField(
	text: string,
	min: number,
	max: number
): number | null | undefined {
	const trimmed = text.trim();
	if (!trimmed) {
		return null;
	}
	const next = Number(trimmed);
	if (!Number.isFinite(next)) {
		return undefined;
	}
	return Math.min(max, Math.max(min, next));
}
