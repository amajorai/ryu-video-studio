import { z } from "zod";
import {
	type Asset,
	activeCaptions,
	type Caption,
	type Project,
	validateProject,
} from "./project.ts";
import {
	type CaptionStyle,
	type CaptionWordAnimation,
	captionStyleSchema,
} from "./schema/caption-style.ts";
import {
	captionStyleOf,
	type ResolvedCaptionStyle,
} from "./schema/defaults.ts";

/** A named, original caption look offered in the preset gallery. */
export interface CaptionPreset {
	description: string;
	id: string;
	label: string;
	style: CaptionStyle;
}

const preset = (
	id: string,
	label: string,
	description: string,
	style: Omit<CaptionStyle, "presetId">
): CaptionPreset => ({
	description,
	id,
	label,
	style: { ...style, presetId: id },
});

/** Twelve original caption presets, in gallery order. `classic` is the legacy look. */
export const CAPTION_PRESETS: readonly CaptionPreset[] = [
	preset("classic", "Classic", "White bold text with a thin outline.", {
		backgroundOpacity: 0,
		color: "#ffffff",
		fontFamily: "system-sans",
		fontSize: 0.045,
		fontWeight: 700,
		highlightColor: "#ffd43b",
		outlineColor: "#000000",
		outlineWidth: 0.002,
		positionY: 0.92,
		shadowDepth: 0,
		uppercase: false,
		wordAnimation: "highlight",
	}),
	preset(
		"punch",
		"Punch",
		"Heavy uppercase words that pop as they are spoken.",
		{
			backgroundOpacity: 0,
			color: "#ffffff",
			fontFamily: "montserrat",
			fontSize: 0.06,
			fontWeight: 800,
			highlightColor: "#facc15",
			maxLines: 2,
			outlineColor: "#000000",
			outlineWidth: 0.005,
			positionY: 0.72,
			shadowDepth: 0.003,
			uppercase: true,
			wordAnimation: "pop",
		}
	),
	preset("karaoke", "Karaoke", "Words fill with color as they are sung.", {
		backgroundOpacity: 0,
		color: "#ffffff",
		fontFamily: "poppins",
		fontSize: 0.05,
		fontWeight: 700,
		highlightColor: "#22d3ee",
		outlineColor: "#0f172a",
		outlineWidth: 0.003,
		positionY: 0.9,
		shadowDepth: 0,
		uppercase: false,
		wordAnimation: "karaoke",
	}),
	preset("boxed", "Boxed", "Clean text on a translucent dark box.", {
		backgroundColor: "#000000",
		backgroundOpacity: 0.72,
		color: "#ffffff",
		fontFamily: "inter",
		fontSize: 0.042,
		fontWeight: 600,
		highlightColor: "#ffffff",
		outlineColor: "#000000",
		outlineWidth: 0.006,
		positionY: 0.9,
		shadowDepth: 0,
		uppercase: false,
		wordAnimation: "none",
	}),
	preset("spotlight", "Spotlight", "The spoken word sits on a colored block.", {
		backgroundOpacity: 0,
		color: "#ffffff",
		fontFamily: "montserrat",
		fontSize: 0.055,
		fontWeight: 800,
		highlightColor: "#7c3aed",
		maxLines: 2,
		outlineColor: "#000000",
		outlineWidth: 0.004,
		positionY: 0.75,
		shadowDepth: 0,
		uppercase: true,
		wordAnimation: "box",
	}),
	preset("minimal", "Minimal", "Small, light text with a soft shadow.", {
		backgroundOpacity: 0,
		color: "#f8fafc",
		fontFamily: "inter",
		fontSize: 0.036,
		fontWeight: 500,
		highlightColor: "#f8fafc",
		outlineColor: "#000000",
		outlineWidth: 0,
		positionY: 0.93,
		shadowDepth: 0.002,
		uppercase: false,
		wordAnimation: "none",
	}),
	preset("broadcast", "Broadcast", "News-style white text on a blue band.", {
		backgroundColor: "#1d4ed8",
		backgroundOpacity: 0.9,
		color: "#ffffff",
		fontFamily: "roboto",
		fontSize: 0.04,
		fontWeight: 700,
		highlightColor: "#fde047",
		outlineColor: "#1d4ed8",
		outlineWidth: 0.008,
		positionY: 0.86,
		shadowDepth: 0,
		uppercase: false,
		wordAnimation: "highlight",
	}),
	preset("glow", "Glow", "Bright green words with a magenta edge.", {
		backgroundOpacity: 0,
		color: "#4ade80",
		fontFamily: "poppins",
		fontSize: 0.05,
		fontWeight: 700,
		highlightColor: "#ffffff",
		outlineColor: "#c026d3",
		outlineWidth: 0.004,
		positionY: 0.88,
		shadowDepth: 0.002,
		uppercase: false,
		wordAnimation: "highlight",
	}),
	preset("reveal", "Reveal", "Monospace words appear one at a time.", {
		backgroundColor: "#111827",
		backgroundOpacity: 0.6,
		color: "#e5e7eb",
		fontFamily: "source-code-pro",
		fontSize: 0.038,
		fontWeight: 500,
		highlightColor: "#e5e7eb",
		outlineColor: "#111827",
		outlineWidth: 0.005,
		positionY: 0.9,
		shadowDepth: 0,
		uppercase: false,
		wordAnimation: "reveal",
	}),
	preset("marker", "Marker", "Hand-drawn yellow words that bounce.", {
		backgroundOpacity: 0,
		color: "#fde047",
		fontFamily: "permanent-marker",
		fontSize: 0.055,
		fontWeight: 400,
		highlightColor: "#ffffff",
		outlineColor: "#000000",
		outlineWidth: 0.004,
		positionY: 0.8,
		shadowDepth: 0.003,
		uppercase: false,
		wordAnimation: "bounce",
	}),
	preset("cinema", "Cinema", "Quiet serif subtitles for film.", {
		backgroundOpacity: 0,
		color: "#fefce8",
		fontFamily: "merriweather",
		fontSize: 0.038,
		fontWeight: 400,
		highlightColor: "#fefce8",
		outlineColor: "#000000",
		outlineWidth: 0.0015,
		positionY: 0.93,
		shadowDepth: 0.002,
		uppercase: false,
		wordAnimation: "none",
	}),
	preset("headline", "Headline", "Tall condensed captions at the top.", {
		backgroundOpacity: 0,
		color: "#ffffff",
		fontFamily: "bebas-neue",
		fontSize: 0.075,
		fontWeight: 400,
		highlightColor: "#f97316",
		maxLines: 2,
		outlineColor: "#000000",
		outlineWidth: 0.003,
		positionY: 0.2,
		shadowDepth: 0,
		uppercase: true,
		wordAnimation: "highlight",
	}),
];

/** The preset with `id`, or undefined for custom or unknown ids. */
export const captionPreset = (id: string | undefined) =>
	CAPTION_PRESETS.find((item) => item.id === id);

/** Overlay `patch` on `base`, ignoring undefined values in the patch. */
export function mergeCaptionStyle(
	base: CaptionStyle | undefined,
	patch: CaptionStyle | undefined
): CaptionStyle | undefined {
	if (!(base || patch)) {
		return;
	}
	// A newly chosen font source replaces the other one from the base, so a
	// track's system font is not shadowed by the project's imported font.
	const { customFont, systemFont, ...rest } = base ?? {};
	const merged: Record<string, unknown> = { ...rest };
	if (customFont && patch?.systemFont === undefined) {
		merged.customFont = customFont;
	}
	if (systemFont && patch?.customFont === undefined) {
		merged.systemFont = systemFont;
	}
	for (const [key, value] of Object.entries(patch ?? {})) {
		if (value !== undefined) {
			merged[key] = value;
		}
	}
	return captionStyleSchema.parse(merged);
}

/** The style stored on the active caption track, if any. */
export const activeTrackStyle = (
	project: Pick<Project, "captionTrackId" | "captionTracks">
): CaptionStyle | undefined =>
	project.captionTrackId
		? project.captionTracks.find((track) => track.id === project.captionTrackId)
				?.style
		: undefined;

/** Whether the project (or its active track) chose a caption style. */
export const hasCaptionStyle = (
	project: Pick<Project, "captionStyle" | "captionTrackId" | "captionTracks">
): boolean =>
	project.captionStyle !== undefined || activeTrackStyle(project) !== undefined;

/** The project style overlaid by the active track's style, defaults resolved. */
export function effectiveCaptionStyle(
	project: Pick<
		Project,
		"captionStyle" | "captionTrackId" | "captionTracks" | "height"
	>
): ResolvedCaptionStyle {
	return captionStyleOf({
		captionStyle: mergeCaptionStyle(
			project.captionStyle,
			activeTrackStyle(project)
		),
		height: project.height,
	});
}

/** The color of a project speaker, when the id resolves. */
export const speakerColorOf = (
	project: Pick<Project, "speakers">,
	speakerId: string | undefined
): string | undefined =>
	speakerId
		? project.speakers?.find((speaker) => speaker.id === speakerId)?.color
		: undefined;

/** Whether any caption (or word) is labelled with a known speaker. */
export const hasSpeakerTint = (
	project: Pick<Project, "speakers">,
	captions: readonly Caption[]
): boolean =>
	Boolean(project.speakers?.length) &&
	captions.some(
		(caption) =>
			speakerColorOf(project, caption.speakerId) !== undefined ||
			(caption.words ?? []).some(
				(word) => speakerColorOf(project, word.speakerId) !== undefined
			)
	);

/**
 * Whether captions use the styled look (a chosen style or speaker tint).
 * Otherwise the render and preview keep the exact legacy output.
 */
export const captionsAreStyled = (project: Project): boolean =>
	hasCaptionStyle(project) || hasSpeakerTint(project, activeCaptions(project));

/** Caption text as displayed (uppercase applied). */
export const captionDisplayText = (
	text: string,
	style: Pick<ResolvedCaptionStyle, "uppercase">
): string => (style.uppercase ? text.toUpperCase() : text);

/** Average glyph advance in ems for line estimates. */
const GLYPH_EM = 0.55;
/** Captions use at most this share of the canvas width per line. */
const LINE_WIDTH = 0.9;

/** Characters that fit on one caption line at this style and canvas. */
export function captionLineChars(
	style: Pick<ResolvedCaptionStyle, "fontSize">,
	canvas: Pick<Project, "height" | "width">
): number {
	const glyph = style.fontSize * canvas.height * GLYPH_EM;
	return Math.max(8, Math.floor((canvas.width * LINE_WIDTH) / glyph));
}

/**
 * Indexes of the words that start a new line: the text is split into the
 * fewest lines that fit (at most `maxLines`), balanced by character count.
 */
export function captionLineBreaks(
	words: readonly string[],
	style: Pick<ResolvedCaptionStyle, "fontSize" | "maxLines">,
	canvas: Pick<Project, "height" | "width">
): number[] {
	const total = words.reduce(
		(sum, word, index) => sum + word.length + (index ? 1 : 0),
		0
	);
	const lines = Math.min(
		style.maxLines,
		words.length,
		Math.ceil(total / captionLineChars(style, canvas))
	);
	if (lines <= 1) {
		return [];
	}
	const target = total / lines;
	const breaks: number[] = [];
	let used = 0;
	words.forEach((word, index) => {
		const before = used;
		used += word.length + (index ? 1 : 0);
		const line = breaks.length + 1;
		if (
			index > 0 &&
			breaks.length < lines - 1 &&
			// Break before this word when that lands closer to the line target.
			Math.abs(before - target * line) < Math.abs(used - target * line) &&
			before >= target * line * 0.6
		) {
			breaks.push(index);
		}
	});
	return breaks;
}

/** Pop: a quick swell when the word starts. */
export const WORD_POP = { grow: 0.08, scale: 1.18, settle: 0.16 } as const;
/** Bounce: a larger swell that settles more slowly. */
export const WORD_BOUNCE = { grow: 0.09, scale: 1.25, settle: 0.2 } as const;

/** Per-word presentation at a moment, shared by the preview and tests. */
export interface CaptionWordState {
	active: boolean;
	/** The active word sits on a highlight-colored block (`box`). */
	boxed: boolean;
	/** Karaoke fill progress, 0 to 1. */
	fill: number;
	/** Text uses the highlight color. */
	highlighted: boolean;
	scale: number;
	visible: boolean;
}

function swell(
	shape: { grow: number; scale: number; settle: number },
	elapsed: number
): number {
	if (elapsed < 0 || elapsed >= shape.settle) {
		return 1;
	}
	if (elapsed < shape.grow) {
		return 1 + ((shape.scale - 1) * elapsed) / shape.grow;
	}
	return (
		shape.scale -
		((shape.scale - 1) * (elapsed - shape.grow)) / (shape.settle - shape.grow)
	);
}

/** How a word with timing `word` looks at `time` under `animation`. */
export function captionWordState(
	animation: CaptionWordAnimation,
	time: number,
	word: { end: number; start: number }
): CaptionWordState {
	const active = time >= word.start && time < word.end;
	const elapsed = time - word.start;
	let scale = 1;
	if (animation === "pop") {
		scale = swell(WORD_POP, elapsed);
	} else if (animation === "bounce") {
		scale = swell(WORD_BOUNCE, elapsed);
	}
	const span = Math.max(0.001, word.end - word.start);
	return {
		active,
		boxed: animation === "box" && active,
		fill:
			animation === "karaoke" ? Math.min(1, Math.max(0, elapsed / span)) : 0,
		highlighted:
			active &&
			(animation === "highlight" ||
				animation === "pop" ||
				animation === "bounce"),
		scale,
		visible: animation !== "reveal" || time >= word.start,
	};
}

export const captionStyleRequestSchema = z
	.object({
		/** `merge` overlays the fields given; `replace` stores exactly `style` (`{}` clears it). */
		mode: z.enum(["merge", "replace"]).default("merge"),
		revision: z.number().int().nonnegative(),
		style: captionStyleSchema,
		/** A language track to style; null styles the project captions. */
		trackId: z.uuid().nullable().default(null),
	})
	.strict();
export type CaptionStyleInput = z.input<typeof captionStyleRequestSchema>;

/** Save a caption style on the project or on one caption track. */
export function applyCaptionStyle(
	project: Project,
	assets: readonly Asset[],
	input: CaptionStyleInput
): Project {
	const request = captionStyleRequestSchema.parse(input);
	const resolve = (current: CaptionStyle | undefined) => {
		const next =
			request.mode === "replace"
				? mergeCaptionStyle(undefined, request.style)
				: mergeCaptionStyle(current, request.style);
		return next && Object.keys(next).length > 0 ? next : undefined;
	};
	let next: Project;
	if (request.trackId) {
		const track = project.captionTracks.find(
			(item) => item.id === request.trackId
		);
		if (!track) {
			throw new Error("Caption track not found.");
		}
		const style = resolve(track.style);
		next = {
			...project,
			captionTracks: project.captionTracks.map((item) => {
				if (item.id !== track.id) {
					return item;
				}
				const { style: _previous, ...rest } = item;
				return style ? { ...rest, style } : rest;
			}),
		};
	} else {
		const style = resolve(project.captionStyle);
		const { captionStyle: _previous, ...rest } = project;
		next = style ? { ...rest, captionStyle: style } : rest;
	}
	return validateProject(next, [...assets]);
}
