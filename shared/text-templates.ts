import { z } from "zod";
import {
	type Asset,
	type Graphic,
	graphicSchema,
	type Project,
	type Title,
	titleSchema,
	validateProject,
} from "./project.ts";
import type { FontChoice } from "./schema/font.ts";

/**
 * Original text templates: title presets (lower thirds, title cards, callouts,
 * quotes, calls to action) with optional vector graphics. Times are relative
 * to where the template is placed.
 */

export const textTemplateCategorySchema = z.enum([
	"lower-third",
	"title-card",
	"callout",
	"quote",
	"call-to-action",
	"social",
]);
export type TextTemplateCategory = z.infer<typeof textTemplateCategorySchema>;

const offset = z.number().finite().min(0).max(60);

export const templateTitleSchema = titleSchema
	.omit({ end: true, id: true, start: true, templateId: true })
	.extend({ duration: offset.optional(), offset })
	.strict();
export type TemplateTitle = z.input<typeof templateTitleSchema>;

export const templateGraphicSchema = graphicSchema
	.omit({ end: true, id: true, start: true })
	.extend({ duration: offset.optional(), offset })
	.strict();
export type TemplateGraphic = z.input<typeof templateGraphicSchema>;

export const textTemplateSchema = z
	.object({
		category: textTemplateCategorySchema,
		description: z.string().trim().min(1).max(200),
		duration: z.number().finite().min(0.5).max(60),
		graphics: z.array(templateGraphicSchema).max(4).optional(),
		id: z
			.string()
			.regex(/^[a-z0-9-]+$/)
			.max(64),
		name: z.string().trim().min(1).max(60),
		titles: z.array(templateTitleSchema).min(1).max(4),
	})
	.strict();
export type TextTemplate = z.input<typeof textTemplateSchema>;

const LOWER_Y = 0.82;

export const TEXT_TEMPLATES: readonly TextTemplate[] = [
	{
		category: "lower-third",
		description: "Name and role on a dark bar, left aligned.",
		duration: 5,
		graphics: [
			{
				fill: "#111318",
				height: 0.13,
				offset: 0,
				opacity: 0.82,
				width: 0.42,
				x: 0.05,
				y: 0.75,
				animation: "slide-right",
				entryDuration: 0.35,
			},
		],
		id: "lower-third-bar",
		name: "Dark bar",
		titles: [
			{
				align: "left",
				color: "#ffffff",
				fadeIn: 0.2,
				fadeOut: 0.3,
				fontFamily: "inter",
				fontSize: 0.045,
				fontWeight: 700,
				offset: 0.1,
				outlineWidth: 0,
				text: "Alex Morgan",
				x: 0.07,
				y: 0.79,
				animationIn: "slide-right",
				animationInDuration: 0.4,
			},
			{
				align: "left",
				color: "#c7cbd4",
				fadeIn: 0.3,
				fadeOut: 0.3,
				fontFamily: "inter",
				fontSize: 0.03,
				fontWeight: 400,
				offset: 0.25,
				outlineWidth: 0,
				text: "Product designer",
				x: 0.07,
				y: 0.845,
				animationIn: "fade",
			},
		],
	},
	{
		category: "lower-third",
		description: "Accent stripe beside a bold name and a lighter role.",
		duration: 5,
		graphics: [
			{
				fill: "#ff5a36",
				height: 0.1,
				offset: 0,
				opacity: 1,
				width: 0.02,
				x: 0.05,
				y: 0.765,
				animation: "slide-up",
				entryDuration: 0.3,
			},
		],
		id: "lower-third-accent",
		name: "Accent stripe",
		titles: [
			{
				align: "left",
				color: "#ffffff",
				fadeIn: 0.25,
				fadeOut: 0.3,
				fontFamily: "montserrat",
				fontSize: 0.042,
				fontWeight: 800,
				offset: 0.1,
				shadowDepth: 0.002,
				text: "Jordan Lee",
				x: 0.08,
				y: 0.79,
				animationIn: "slide-left",
			},
			{
				align: "left",
				color: "#ffd2c4",
				fadeIn: 0.3,
				fadeOut: 0.3,
				fontFamily: "montserrat",
				fontSize: 0.028,
				fontWeight: 500,
				letterSpacing: 0.08,
				offset: 0.2,
				outlineWidth: 0,
				shadowDepth: 0.0015,
				text: "FIELD REPORTER",
				x: 0.08,
				y: 0.84,
				animationIn: "fade",
			},
		],
	},
	{
		category: "lower-third",
		description: "A single rounded pill with the speaker name.",
		duration: 4,
		id: "lower-third-pill",
		name: "Pill",
		titles: [
			{
				backgroundColor: "#ffffff",
				backgroundOpacity: 0.95,
				backgroundPadding: 0.016,
				backgroundPaddingX: 0.028,
				backgroundPaddingY: 0.014,
				backgroundRadius: 0.5,
				color: "#141414",
				fadeIn: 0.2,
				fadeOut: 0.2,
				fontFamily: "poppins",
				fontSize: 0.038,
				fontWeight: 700,
				offset: 0,
				outlineWidth: 0,
				text: "Sam Rivera · Host",
				x: 0.5,
				y: LOWER_Y,
				animationIn: "pop",
				animationInDuration: 0.35,
				animationOut: "pop",
				animationOutDuration: 0.3,
			},
		],
	},
	{
		category: "lower-third",
		description: "Breaking-style label box beside a headline.",
		duration: 6,
		id: "lower-third-headline",
		name: "Headline strap",
		titles: [
			{
				align: "left",
				backgroundColor: "#d7263d",
				backgroundPadding: 0.012,
				color: "#ffffff",
				fadeIn: 0.15,
				fadeOut: 0.3,
				fontFamily: "oswald",
				fontSize: 0.04,
				fontWeight: 700,
				offset: 0,
				outlineWidth: 0,
				text: "LIVE",
				x: 0.06,
				y: LOWER_Y,
				animationIn: "slide-right",
				animationInDuration: 0.3,
			},
			{
				align: "left",
				backgroundColor: "#101114",
				backgroundOpacity: 0.85,
				backgroundPadding: 0.012,
				color: "#ffffff",
				fadeIn: 0.2,
				fadeOut: 0.3,
				fontFamily: "oswald",
				fontSize: 0.04,
				fontWeight: 500,
				offset: 0.2,
				outlineWidth: 0,
				text: "City council approves the new riverside park",
				x: 0.15,
				y: LOWER_Y,
				animationIn: "typewriter",
				animationInDuration: 1.2,
			},
		],
	},
	{
		category: "lower-third",
		description: "Minimal underlined name with a soft shadow.",
		duration: 4,
		id: "lower-third-underline",
		name: "Underline",
		titles: [
			{
				align: "left",
				color: "#ffffff",
				fadeIn: 0.3,
				fadeOut: 0.3,
				fontFamily: "roboto",
				fontSize: 0.04,
				fontWeight: 500,
				offset: 0,
				outlineWidth: 0,
				shadowBlur: 2,
				shadowColor: "#000000",
				shadowDepth: 0.002,
				text: "Taylor Kim",
				underline: true,
				x: 0.07,
				y: LOWER_Y,
				animationIn: "blur-in",
				animationInDuration: 0.5,
			},
		],
	},
	{
		category: "title-card",
		description: "Heavy condensed headline that pops in.",
		duration: 3,
		id: "title-bold-pop",
		name: "Bold pop",
		titles: [
			{
				color: "#ffffff",
				fadeIn: 0.1,
				fadeOut: 0.3,
				fontFamily: "anton",
				fontSize: 0.12,
				fontWeight: 400,
				offset: 0,
				outlineColor: "#000000",
				outlineWidth: 0.004,
				text: "BIG ANNOUNCEMENT",
				x: 0.5,
				y: 0.5,
				animationIn: "pop",
				animationInDuration: 0.35,
				animationOut: "zoom-out",
				animationOutDuration: 0.3,
			},
		],
	},
	{
		category: "title-card",
		description: "Wide-tracked serif title that fades in slowly.",
		duration: 5,
		id: "title-cinematic",
		name: "Cinematic",
		titles: [
			{
				color: "#f4efe6",
				fadeIn: 1.2,
				fadeOut: 1,
				fontFamily: "playfair-display",
				fontSize: 0.075,
				fontWeight: 500,
				letterSpacing: 0.25,
				offset: 0,
				outlineWidth: 0,
				text: "THE LONG ROAD HOME",
				x: 0.5,
				y: 0.5,
				animationIn: "blur-in",
				animationInDuration: 1.2,
				animationOut: "fade",
			},
		],
	},
	{
		category: "title-card",
		description: "Monospaced text typed out one character at a time.",
		duration: 4,
		id: "title-typewriter",
		name: "Typewriter",
		titles: [
			{
				color: "#e8ffe8",
				fadeIn: 0,
				fadeOut: 0.3,
				fontFamily: "source-code-pro",
				fontSize: 0.055,
				fontWeight: 500,
				offset: 0,
				outlineWidth: 0,
				text: "> booting the story...",
				x: 0.5,
				y: 0.5,
				animationIn: "typewriter",
				animationInDuration: 1.6,
			},
		],
	},
	{
		category: "title-card",
		description: "Glowing outlined title with a gentle pulse.",
		duration: 4,
		id: "title-glow",
		name: "Glow pulse",
		titles: [
			{
				color: "#ffffff",
				fadeIn: 0.3,
				fadeOut: 0.3,
				fontFamily: "montserrat",
				fontSize: 0.09,
				fontWeight: 900,
				offset: 0,
				outlineColor: "#25d5ff",
				outlineWidth: 0.005,
				shadowBlur: 6,
				shadowColor: "#25d5ff",
				shadowDepth: 0.002,
				text: "NIGHT SHIFT",
				x: 0.5,
				y: 0.5,
				animationIn: "zoom-in",
				animationLoop: "pulse",
			},
		],
	},
	{
		category: "title-card",
		description: "Tall headline that drops in and bounces.",
		duration: 3,
		id: "title-bounce",
		name: "Bounce",
		titles: [
			{
				color: "#ffe14d",
				fadeIn: 0.1,
				fadeOut: 0.3,
				fontFamily: "bebas-neue",
				fontSize: 0.13,
				fontWeight: 400,
				offset: 0,
				outlineColor: "#1b1b1b",
				outlineWidth: 0.004,
				text: "GAME DAY",
				x: 0.5,
				y: 0.5,
				animationIn: "bounce",
				animationInDuration: 0.8,
			},
		],
	},
	{
		category: "title-card",
		description: "Chapter number above a chapter name.",
		duration: 4,
		id: "title-chapter",
		name: "Chapter",
		titles: [
			{
				color: "#d9d9d9",
				fadeIn: 0.4,
				fadeOut: 0.4,
				fontFamily: "oswald",
				fontSize: 0.035,
				fontWeight: 400,
				letterSpacing: 0.3,
				offset: 0,
				outlineWidth: 0,
				text: "CHAPTER ONE",
				x: 0.5,
				y: 0.42,
				animationIn: "slide-up",
			},
			{
				color: "#ffffff",
				fadeIn: 0.4,
				fadeOut: 0.4,
				fontFamily: "playfair-display",
				fontSize: 0.08,
				fontWeight: 700,
				offset: 0.3,
				outlineWidth: 0,
				text: "Beginnings",
				x: 0.5,
				y: 0.52,
				animationIn: "slide-up",
			},
		],
	},
	{
		category: "title-card",
		description: "Words appear one after another.",
		duration: 4,
		id: "title-word-reveal",
		name: "Word reveal",
		titles: [
			{
				color: "#ffffff",
				fadeIn: 0,
				fadeOut: 0.3,
				fontFamily: "inter",
				fontSize: 0.07,
				fontWeight: 800,
				offset: 0,
				text: "Make every second count",
				x: 0.5,
				y: 0.5,
				animationIn: "word-reveal",
				animationInDuration: 1.5,
			},
		],
	},
	{
		category: "callout",
		description: "Rounded speech-style box for a short note.",
		duration: 4,
		id: "callout-bubble",
		name: "Note bubble",
		titles: [
			{
				backgroundColor: "#ffffff",
				backgroundPadding: 0.018,
				backgroundRadius: 0.35,
				color: "#1d1d1f",
				fadeIn: 0.15,
				fadeOut: 0.2,
				fontFamily: "poppins",
				fontSize: 0.036,
				fontWeight: 400,
				offset: 0,
				outlineWidth: 0,
				text: "Tip: hold Shift to snap",
				x: 0.72,
				y: 0.28,
				animationIn: "pop",
				animationInDuration: 0.3,
			},
		],
	},
	{
		category: "callout",
		description: "An arrow pointing at a labelled spot.",
		duration: 4,
		graphics: [
			{
				fill: "#ffcc00",
				height: 0.08,
				offset: 0,
				opacity: 1,
				shape: "arrow",
				width: 0.12,
				x: 0.5,
				y: 0.46,
				animation: "slide-left",
				entryDuration: 0.3,
			},
		],
		id: "callout-arrow",
		name: "Arrow label",
		titles: [
			{
				align: "left",
				backgroundColor: "#ffcc00",
				backgroundPadding: 0.01,
				color: "#111111",
				fadeIn: 0.2,
				fadeOut: 0.2,
				fontFamily: "roboto",
				fontSize: 0.035,
				fontWeight: 700,
				offset: 0.15,
				outlineWidth: 0,
				text: "Look here",
				x: 0.64,
				y: 0.5,
				animationIn: "slide-left",
				animationInDuration: 0.3,
			},
		],
	},
	{
		category: "callout",
		description: "Each word lights up in turn, karaoke style.",
		duration: 4,
		id: "callout-highlight",
		name: "Word highlight",
		titles: [
			{
				color: "#ffffff",
				fadeIn: 0.2,
				fadeOut: 0.2,
				fontFamily: "montserrat",
				fontSize: 0.06,
				fontWeight: 800,
				highlightColor: "#3ddc84",
				offset: 0,
				outlineWidth: 0.003,
				text: "Read every word out loud",
				x: 0.5,
				y: 0.7,
				animationIn: "word-highlight",
			},
		],
	},
	{
		category: "quote",
		description: "Italic serif quote with an attribution line.",
		duration: 6,
		id: "quote-card",
		name: "Quote",
		titles: [
			{
				color: "#ffffff",
				fadeIn: 0.6,
				fadeOut: 0.5,
				fontFamily: "merriweather",
				fontSize: 0.05,
				fontWeight: 400,
				italic: true,
				lineHeight: 1.4,
				offset: 0,
				outlineWidth: 0,
				shadowDepth: 0.002,
				text: "“Simple things,\ndone with care.”",
				x: 0.5,
				y: 0.45,
				animationIn: "fade",
			},
			{
				color: "#cfcfcf",
				fadeIn: 0.5,
				fadeOut: 0.5,
				fontFamily: "inter",
				fontSize: 0.03,
				fontWeight: 500,
				letterSpacing: 0.1,
				offset: 0.8,
				outlineWidth: 0,
				text: "— A. Writer",
				x: 0.5,
				y: 0.62,
				animationIn: "slide-up",
			},
		],
	},
	{
		category: "call-to-action",
		description: "A red pill asking viewers to subscribe (no logos).",
		duration: 4,
		id: "cta-subscribe",
		name: "Subscribe pill",
		titles: [
			{
				backgroundColor: "#e62117",
				backgroundPadding: 0.016,
				backgroundRadius: 0.5,
				color: "#ffffff",
				fadeIn: 0.1,
				fadeOut: 0.2,
				fontFamily: "roboto",
				fontSize: 0.045,
				fontWeight: 700,
				letterSpacing: 0.04,
				offset: 0,
				outlineWidth: 0,
				text: "SUBSCRIBE",
				x: 0.5,
				y: 0.8,
				animationIn: "pop",
				animationInDuration: 0.35,
				animationLoop: "pulse",
				animationOut: "pop",
				animationOutDuration: 0.3,
			},
		],
	},
	{
		category: "call-to-action",
		description: "Boxed prompt to follow for the next part.",
		duration: 4,
		id: "cta-follow",
		name: "Follow for more",
		titles: [
			{
				backgroundColor: "#111111",
				backgroundOpacity: 0.9,
				backgroundPadding: 0.016,
				backgroundRadius: 0.2,
				color: "#ffffff",
				fadeIn: 0.1,
				fadeOut: 0.2,
				fontFamily: "poppins",
				fontSize: 0.045,
				fontWeight: 700,
				highlightColor: "#ffd43b",
				offset: 0,
				outlineWidth: 0,
				text: "Follow for part 2",
				x: 0.5,
				y: 0.8,
				animationIn: "bounce",
				animationInDuration: 0.7,
			},
		],
	},
	{
		category: "call-to-action",
		description: "Thank-you end card in a script face.",
		duration: 5,
		id: "cta-thanks",
		name: "Thanks for watching",
		titles: [
			{
				color: "#ffffff",
				fadeIn: 0.6,
				fadeOut: 0.6,
				fontFamily: "lobster",
				fontSize: 0.1,
				fontWeight: 400,
				offset: 0,
				outlineWidth: 0,
				shadowBlur: 3,
				shadowDepth: 0.003,
				text: "Thanks for watching",
				x: 0.5,
				y: 0.45,
				animationIn: "blur-in",
				animationInDuration: 0.8,
				animationOut: "blur-out",
				animationOutDuration: 0.6,
			},
		],
	},
	{
		category: "social",
		description: "Hand-lettered marker text with a rolling wave.",
		duration: 4,
		id: "social-marker-wave",
		name: "Marker wave",
		titles: [
			{
				color: "#ffffff",
				fadeIn: 0.2,
				fadeOut: 0.2,
				fontFamily: "permanent-marker",
				fontSize: 0.08,
				fontWeight: 400,
				offset: 0,
				outlineColor: "#000000",
				outlineWidth: 0.004,
				text: "wait for it",
				x: 0.5,
				y: 0.3,
				animationIn: "wave",
				animationInDuration: 0.8,
				animationLoop: "wave",
			},
		],
	},
	{
		category: "social",
		description: "Bold label on a box knocked down and right of the text.",
		duration: 4,
		id: "social-offset-block",
		name: "Offset block",
		titles: [
			{
				backgroundColor: "#ff5d8f",
				backgroundPaddingX: 0.024,
				backgroundPaddingY: 0.01,
				backgroundOffsetX: 0.008,
				backgroundOffsetY: 0.014,
				color: "#111111",
				fadeIn: 0.15,
				fadeOut: 0.2,
				fontFamily: "bebas-neue",
				fontSize: 0.07,
				fontWeight: 400,
				offset: 0,
				outlineWidth: 0,
				text: "NEW DROP",
				x: 0.5,
				y: 0.28,
				animationIn: "pop",
				animationInDuration: 0.3,
			},
		],
	},
	{
		category: "social",
		description: "Stacked bold caption with a floating motion.",
		duration: 4,
		id: "social-stacked",
		name: "Stacked hook",
		titles: [
			{
				color: "#ffffff",
				fadeIn: 0.15,
				fadeOut: 0.2,
				fontFamily: "anton",
				fontSize: 0.075,
				fontWeight: 400,
				lineHeight: 1.1,
				offset: 0,
				outlineColor: "#000000",
				outlineWidth: 0.005,
				text: "YOU WON'T\nBELIEVE THIS",
				x: 0.5,
				y: 0.25,
				animationIn: "zoom-in",
				animationInDuration: 0.3,
				animationLoop: "float",
			},
		],
	},
	{
		category: "social",
		description: "Tilted sticker-style label that wobbles.",
		duration: 4,
		id: "social-sticker",
		name: "Sticker label",
		titles: [
			{
				backgroundColor: "#ffe600",
				backgroundPadding: 0.014,
				backgroundRadius: 0.15,
				color: "#111111",
				fadeIn: 0.1,
				fadeOut: 0.2,
				fontFamily: "bebas-neue",
				fontSize: 0.07,
				fontWeight: 400,
				offset: 0,
				outlineWidth: 0,
				rotation: -6,
				text: "NEW",
				x: 0.78,
				y: 0.22,
				animationIn: "pop",
				animationInDuration: 0.3,
				animationLoop: "wobble",
			},
		],
	},
];

/** The template with `id`, or undefined. */
export function textTemplate(id: string): TextTemplate | undefined {
	return TEXT_TEMPLATES.find((template) => template.id === id);
}

export interface ApplyTextTemplateOptions {
	/**
	 * An imported or system font for every template title; each title keeps
	 * its own `fontFamily` as the fallback.
	 */
	font?: FontChoice | undefined;
	/** Make ids (defaults to `crypto.randomUUID`); tests pass a counter. */
	newId?: () => string;
	/** Placement time; moved earlier if the template would pass two hours. */
	start: number;
	/** Replacement text for each template title, in order. */
	texts?: readonly (string | undefined)[];
}

/** The title fields a template font choice sets (an imported font wins). */
function templateFont(font: FontChoice | undefined): FontChoice {
	if (font?.customFont) {
		return { customFont: font.customFont };
	}
	return font?.systemFont ? { systemFont: font.systemFont } : {};
}

const MAX_TIME = 7200;

/** Titles and graphics for one template placed at `options.start`. */
export function textTemplateLayers(
	template: TextTemplate,
	options: ApplyTextTemplateOptions
): { graphics: Graphic[]; titles: Title[] } {
	const parsed = textTemplateSchema.parse(template);
	const newId = options.newId ?? (() => crypto.randomUUID());
	const start = Math.max(
		0,
		Math.min(options.start, MAX_TIME - parsed.duration)
	);
	const window = (entry: { duration?: number; offset: number }) => {
		const from = start + Math.min(entry.offset, parsed.duration - 0.1);
		const until = Math.min(
			start + parsed.duration,
			from + (entry.duration ?? parsed.duration - entry.offset)
		);
		return { end: Math.max(from + 0.1, until), start: from };
	};
	const titles = parsed.titles.map((entry, index) => {
		const { duration: _duration, offset: _offset, ...rest } = entry;
		const text = options.texts?.[index]?.trim();
		return titleSchema.parse({
			...rest,
			...templateFont(options.font),
			...window(entry),
			id: newId(),
			templateId: parsed.id,
			text: text || rest.text,
		});
	});
	const graphics = (parsed.graphics ?? []).map((entry) => {
		const { duration: _duration, offset: _offset, ...rest } = entry;
		const timing = window(entry);
		return graphicSchema.parse({
			...rest,
			...timing,
			entryDuration: Math.min(rest.entryDuration, timing.end - timing.start),
			id: newId(),
		});
	});
	return { graphics, titles };
}

/** Append a template's titles and graphics to a project, validated. */
export function applyTextTemplate(
	project: Project,
	assets: readonly Asset[],
	templateId: string,
	options: ApplyTextTemplateOptions
): Project {
	const template = textTemplate(templateId);
	if (!template) {
		throw new Error(`Unknown text template ${templateId}.`);
	}
	const layers = textTemplateLayers(template, options);
	return validateProject(
		{
			...project,
			graphics: [...project.graphics, ...layers.graphics],
			titles: [...project.titles, ...layers.titles],
		},
		[...assets]
	);
}
