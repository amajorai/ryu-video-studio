import {
	type ClipColorLabel,
	clipColorLabelSchema,
	type Segment,
} from "../../../shared/project.ts";

/** Longest clip label the schema accepts. */
export const MAX_CLIP_LABEL_LENGTH = 80;

/** Swatch shown for each clip color tag, in schema order. */
export const CLIP_COLOR_SWATCHES: Readonly<Record<ClipColorLabel, string>> = {
	red: "#e5484d",
	orange: "#f76b15",
	yellow: "#ffc53d",
	green: "#30a46c",
	teal: "#12a594",
	blue: "#3e63dd",
	purple: "#8e4ec6",
	pink: "#d6409f",
};

export const CLIP_COLOR_LABELS: readonly ClipColorLabel[] =
	clipColorLabelSchema.options;

const capitalized = (value: string) =>
	`${value.charAt(0).toUpperCase()}${value.slice(1)}`;

/** Human name of a color tag ("Teal"). */
export const clipColorName = (color: ClipColorLabel) => capitalized(color);

/**
 * Normalize typed label text: trimmed, whitespace collapsed, and capped to
 * the schema limit. Blank text clears the label.
 */
export function normalizeClipLabel(text: string): string | undefined {
	const label = text
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_CLIP_LABEL_LENGTH)
		.trim();
	return label ? label : undefined;
}

/**
 * Patch that renames a clip. Returns `null` when nothing would change, so
 * callers do not record an empty history step.
 */
export function clipLabelPatch(
	segment: Pick<Segment, "label">,
	text: string
): Pick<Segment, "label"> | null {
	const label = normalizeClipLabel(text);
	return label === segment.label ? null : { label };
}

/** Patch that sets or clears (`undefined`) a clip's color tag. */
export function clipColorPatch(
	segment: Pick<Segment, "color">,
	color: ClipColorLabel | undefined
): Pick<Segment, "color"> | null {
	return color === segment.color ? null : { color };
}
