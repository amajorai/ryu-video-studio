/**
 * Display copy for each caption preset, by preset id. The Companion UI
 * translates the label and description; only the id is stored in a project
 * (`CaptionStyle.presetId`), so renaming a label never changes saved data.
 * Labels are whole, sense-specific names ("Word reveal", "News broadcast"),
 * so they do not share a catalog key with an unrelated verb or noun.
 */
export const CAPTION_PRESET_COPY = {
	classic: {
		description: "White bold text with a thin outline.",
		label: "Classic",
	},
	punch: {
		description: "Heavy uppercase words that pop as they are spoken.",
		label: "Punch",
	},
	karaoke: {
		description: "Words fill with color as they are sung.",
		label: "Karaoke",
	},
	boxed: {
		description: "Clean text on a translucent dark box.",
		label: "Boxed",
	},
	spotlight: {
		description: "The spoken word sits on a colored block.",
		label: "Spotlight",
	},
	minimal: {
		description: "Small, light text with a soft shadow.",
		label: "Minimal",
	},
	broadcast: {
		description: "News-style white text on a blue band.",
		label: "News broadcast",
	},
	glow: {
		description: "Bright green words with a magenta edge.",
		label: "Glow",
	},
	reveal: {
		description: "Monospace words appear one at a time.",
		label: "Word reveal",
	},
	marker: {
		description: "Hand-drawn yellow words that bounce.",
		label: "Marker",
	},
	cinema: {
		description: "Quiet serif subtitles for film.",
		label: "Cinema",
	},
	headline: {
		description: "Tall condensed captions at the top.",
		label: "Headline",
	},
} as const satisfies Record<string, { description: string; label: string }>;

/** A built-in caption preset id. */
export type CaptionPresetId = keyof typeof CAPTION_PRESET_COPY;
