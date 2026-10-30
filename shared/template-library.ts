import {
	type Asset,
	type Graphic,
	newProject,
	newSegment,
	type Project,
	type ProjectFps,
	type Segment,
	type Title,
} from "./project.ts";
import type { CanvasBackground } from "./schema/background.ts";
import type { TemplateSlot } from "./schema/template.ts";
import type { ClipAnimation } from "./schema/transition.ts";
import {
	type SoundtrackLayer,
	type SoundtrackMood,
	soundtrackBarSeconds,
} from "./soundtrack.ts";
import { summarizeTemplate, type TemplateSummary } from "./templates.ts";

/**
 * Built-in project templates (W4-N2). Each is an original layout written as
 * data: slots measured in bars of its music tempo, so every cut lands on a
 * downbeat of the local soundtrack it is paired with. Slots start from one
 * neutral placeholder matte; a template becomes a project through
 * `builtInTemplateProject`, which is pure given the placeholder and music
 * assets the sidecar creates.
 */

/** Color of the placeholder matte every built-in slot starts with. */
export const TEMPLATE_PLACEHOLDER_COLOR = "#2E3440";
/** Library name of the shared placeholder matte. */
export const TEMPLATE_PLACEHOLDER_NAME = "Template placeholder";
/** Track of the music bed in built-in templates. */
export const TEMPLATE_MUSIC_TRACK = 3;
/** Level of the music bed under the slot media. */
export const TEMPLATE_MUSIC_VOLUME = 0.5;

type TitleStyle = Partial<
	Pick<
		Title,
		| "align"
		| "animationIn"
		| "animationOut"
		| "backgroundColor"
		| "backgroundOpacity"
		| "backgroundOffsetX"
		| "backgroundOffsetY"
		| "backgroundPadding"
		| "backgroundPaddingX"
		| "backgroundPaddingY"
		| "backgroundRadius"
		| "fontFamily"
		| "fontWeight"
		| "italic"
		| "letterSpacing"
		| "outlineColor"
		| "outlineWidth"
		| "shadowColor"
		| "shadowDepth"
	>
>;

export interface BuiltInSlot {
	animation?: ClipAnimation;
	/** Length in bars. */
	bars: number;
	brightness?: number;
	fadeIn?: number;
	fadeOut?: number;
	/** Absent means true. */
	fixedDuration?: boolean;
	kind: "video" | "image";
	label: string;
	opacity?: number;
	scale?: number;
	/** Bar the slot starts on; absent means right after the previous slot. */
	startBar?: number;
	track?: number;
	x?: number;
	y?: number;
}

export interface BuiltInTitle extends TitleStyle {
	bars: number;
	color: string;
	fontSize: number;
	startBar: number;
	text: string;
	x: number;
	y: number;
}

export interface BuiltInGraphic {
	bars: number;
	fill: string;
	height: number;
	opacity: number;
	shape?: Graphic["shape"];
	startBar: number;
	width: number;
	x: number;
	y: number;
}

export interface BuiltInTemplate {
	background: CanvasBackground;
	category: string;
	description: string;
	fps: ProjectFps;
	graphics: BuiltInGraphic[];
	height: number;
	id: string;
	music: { bpm: number; layers?: SoundtrackLayer[]; mood: SoundtrackMood };
	slots: BuiltInSlot[];
	title: string;
	titles: BuiltInTitle[];
	width: number;
}

const lowerThird: TitleStyle = {
	align: "left",
	animationIn: "slide-right",
	animationOut: "fade",
	backgroundColor: "#111318",
	backgroundOpacity: 0.72,
	backgroundPadding: 0.012,
	backgroundRadius: 0.15,
	fontFamily: "inter",
	fontWeight: 600,
};

const headline: TitleStyle = {
	animationIn: "pop",
	animationOut: "fade",
	fontFamily: "montserrat",
	fontWeight: 800,
	shadowColor: "#000000",
	shadowDepth: 0.004,
};

export const BUILT_IN_TEMPLATES: readonly BuiltInTemplate[] = [
	{
		id: "7d3c0a11-0000-4000-8000-000000000001",
		title: "Vlog intro",
		category: "Social",
		description:
			"A quick channel opener: an establishing shot, two fast cutaways and a hero shot under a bold greeting and your channel name.",
		width: 1920,
		height: 1080,
		fps: 30,
		background: { type: "color", color: "#0F1115" },
		music: { mood: "upbeat", bpm: 124 },
		slots: [
			{ label: "Opening shot", kind: "video", bars: 2, fadeIn: 0.3 },
			{ label: "Cutaway 1", kind: "video", bars: 1 },
			{ label: "Cutaway 2", kind: "video", bars: 1 },
			{
				label: "Hero shot",
				kind: "video",
				bars: 2,
				fadeOut: 0.6,
				animation: { in: "zoom", inDuration: 0.4 },
			},
		],
		titles: [
			{
				...headline,
				text: "Welcome back",
				startBar: 0.5,
				bars: 1.5,
				x: 0.5,
				y: 0.78,
				fontSize: 0.09,
				color: "#FFFFFF",
			},
			{
				...headline,
				text: "Your channel name",
				startBar: 4.25,
				bars: 1.75,
				x: 0.5,
				y: 0.5,
				fontSize: 0.1,
				color: "#FFD166",
			},
		],
		graphics: [],
	},
	{
		id: "7d3c0a11-0000-4000-8000-000000000002",
		title: "Product promo",
		category: "Marketing",
		description:
			"A hero reveal, three feature beats with lower-third callouts, and a closing call to action.",
		width: 1920,
		height: 1080,
		fps: 30,
		background: {
			type: "gradient",
			color: "#141B2D",
			color2: "#24324F",
			angle: 135,
		},
		music: { mood: "corporate", bpm: 110 },
		slots: [
			{
				label: "Product hero",
				kind: "video",
				bars: 2,
				fadeIn: 0.4,
				animation: { in: "zoom", inDuration: 0.6 },
			},
			{ label: "Feature 1", kind: "video", bars: 1 },
			{ label: "Feature 2", kind: "video", bars: 1 },
			{ label: "Feature 3", kind: "video", bars: 1 },
			{ label: "Call to action shot", kind: "video", bars: 2, fadeOut: 0.8 },
		],
		titles: [
			{
				...headline,
				text: "Meet the product",
				startBar: 0.5,
				bars: 1.5,
				x: 0.5,
				y: 0.8,
				fontSize: 0.08,
				color: "#FFFFFF",
			},
			...[1, 2, 3].map(
				(feature): BuiltInTitle => ({
					...lowerThird,
					text: `Feature ${feature}`,
					startBar: 1 + feature,
					bars: 0.9,
					x: 0.24,
					y: 0.84,
					fontSize: 0.05,
					color: "#FFFFFF",
				})
			),
			{
				...headline,
				text: "Available now",
				startBar: 5.25,
				bars: 1.75,
				x: 0.5,
				y: 0.5,
				fontSize: 0.1,
				color: "#7FDBFF",
			},
		],
		graphics: [
			{
				startBar: 2,
				bars: 3,
				x: 0.05,
				y: 0.9,
				width: 0.02,
				height: 0.07,
				fill: "#7FDBFF",
				opacity: 1,
			},
		],
	},
	{
		id: "7d3c0a11-0000-4000-8000-000000000003",
		title: "Recap montage",
		category: "Social",
		description:
			"Eight one-bar shots cut on the downbeat with a title over the first shot and a sign-off over the last.",
		width: 1920,
		height: 1080,
		fps: 30,
		background: { type: "color", color: "#000000" },
		music: { mood: "upbeat", bpm: 124 },
		slots: Array.from(
			{ length: 8 },
			(_, index): BuiltInSlot => ({
				label: `Shot ${index + 1}`,
				kind: "video",
				bars: 1,
				...(index === 0 ? { fadeIn: 0.25 } : {}),
				...(index === 7 ? { fadeOut: 0.6 } : {}),
			})
		),
		titles: [
			{
				...headline,
				text: "This week in review",
				startBar: 0,
				bars: 1.75,
				x: 0.5,
				y: 0.5,
				fontSize: 0.09,
				color: "#FFFFFF",
			},
			{
				...headline,
				text: "See you next time",
				startBar: 7,
				bars: 1,
				x: 0.5,
				y: 0.5,
				fontSize: 0.08,
				color: "#FFFFFF",
			},
		],
		graphics: [],
	},
	{
		id: "7d3c0a11-0000-4000-8000-000000000004",
		title: "Quote card",
		category: "Social",
		description:
			"A square card: a dimmed background photo, a framed panel and a large quote with its attribution.",
		width: 1080,
		height: 1080,
		fps: 30,
		background: { type: "color", color: "#1B1B1F" },
		music: { mood: "ambient", bpm: 70, layers: ["pad"] },
		slots: [
			{
				label: "Background photo",
				kind: "image",
				bars: 3,
				brightness: -0.25,
				scale: 1.08,
				fadeIn: 0.6,
				fadeOut: 0.6,
			},
		],
		titles: [
			{
				text: "“Make something you would want to watch.”",
				startBar: 0.25,
				bars: 2.6,
				x: 0.5,
				y: 0.46,
				fontSize: 0.065,
				color: "#FFFFFF",
				fontFamily: "playfair-display",
				fontWeight: 700,
				italic: true,
				animationIn: "word-reveal",
				animationOut: "fade",
			},
			{
				text: "Your name",
				startBar: 0.75,
				bars: 2.1,
				x: 0.5,
				y: 0.66,
				fontSize: 0.04,
				color: "#E5C07B",
				fontFamily: "inter",
				fontWeight: 500,
				letterSpacing: 0.1,
				animationIn: "fade",
				animationOut: "fade",
			},
		],
		graphics: [
			{
				startBar: 0,
				bars: 3,
				x: 0.08,
				y: 0.28,
				width: 0.84,
				height: 0.48,
				fill: "#000000",
				opacity: 0.45,
			},
		],
	},
	{
		id: "7d3c0a11-0000-4000-8000-000000000005",
		title: "Podcast clip",
		category: "Social",
		description:
			"A vertical clip for short-form feeds: the speaker framed in the middle, the episode title above and the guest name below.",
		width: 1080,
		height: 1920,
		fps: 30,
		background: {
			type: "gradient",
			color: "#1E1B4B",
			color2: "#0B0A1F",
			angle: 180,
		},
		music: { mood: "lo-fi", bpm: 80, layers: ["pad", "bass"] },
		slots: [
			{
				label: "Speaker video",
				kind: "video",
				bars: 6,
				fixedDuration: false,
				scale: 0.9,
				fadeIn: 0.3,
				fadeOut: 0.5,
			},
		],
		titles: [
			{
				...headline,
				animationIn: "fade",
				text: "Episode title",
				startBar: 0,
				bars: 6,
				x: 0.5,
				y: 0.16,
				fontSize: 0.045,
				color: "#FFFFFF",
			},
			{
				...lowerThird,
				align: "center",
				text: "Guest name",
				startBar: 0.5,
				bars: 5.5,
				x: 0.5,
				y: 0.82,
				fontSize: 0.035,
				color: "#C4B5FD",
			},
		],
		graphics: [],
	},
	{
		id: "7d3c0a11-0000-4000-8000-000000000006",
		title: "Slideshow",
		category: "Personal",
		description:
			"Six photos, two bars each, with gentle fades between them under a soft opening title.",
		width: 1920,
		height: 1080,
		fps: 30,
		background: { type: "color", color: "#101010" },
		music: { mood: "warm", bpm: 96 },
		slots: Array.from(
			{ length: 6 },
			(_, index): BuiltInSlot => ({
				label: `Photo ${index + 1}`,
				kind: "image",
				bars: 2,
				fadeIn: 0.5,
				fadeOut: 0.5,
				animation: { in: "zoom", inDuration: 1 },
			})
		),
		titles: [
			{
				text: "Our story",
				startBar: 0.25,
				bars: 1.5,
				x: 0.5,
				y: 0.5,
				fontSize: 0.1,
				color: "#FFFFFF",
				fontFamily: "playfair-display",
				fontWeight: 700,
				animationIn: "fade",
				animationOut: "fade",
				shadowColor: "#000000",
				shadowDepth: 0.004,
			},
		],
		graphics: [],
	},
	{
		id: "7d3c0a11-0000-4000-8000-000000000007",
		title: "Event highlight",
		category: "Events",
		description:
			"An arrival shot, four quick moments and a two-bar finale under the event name and date.",
		width: 1920,
		height: 1080,
		fps: 30,
		background: { type: "color", color: "#000000" },
		music: { mood: "cinematic", bpm: 90 },
		slots: [
			{ label: "Arrival", kind: "video", bars: 2, fadeIn: 0.5 },
			{ label: "Moment 1", kind: "video", bars: 1 },
			{ label: "Moment 2", kind: "video", bars: 1 },
			{ label: "Moment 3", kind: "video", bars: 1 },
			{ label: "Moment 4", kind: "video", bars: 1 },
			{ label: "Finale", kind: "video", bars: 2, fadeOut: 1 },
		],
		titles: [
			{
				...headline,
				text: "Event name",
				startBar: 0.5,
				bars: 1.5,
				x: 0.5,
				y: 0.45,
				fontSize: 0.1,
				color: "#FFFFFF",
			},
			{
				text: "Date · Place",
				startBar: 0.75,
				bars: 1.25,
				x: 0.5,
				y: 0.58,
				fontSize: 0.04,
				color: "#F4D35E",
				fontFamily: "inter",
				fontWeight: 500,
				letterSpacing: 0.08,
				animationIn: "fade",
				animationOut: "fade",
			},
			{
				...headline,
				text: "Thank you",
				startBar: 6.5,
				bars: 1.5,
				x: 0.5,
				y: 0.5,
				fontSize: 0.09,
				color: "#FFFFFF",
			},
		],
		graphics: [],
	},
	{
		id: "7d3c0a11-0000-4000-8000-000000000008",
		title: "Tutorial step",
		category: "Education",
		description:
			"An intro shot, two numbered steps with lower-third instructions, and the finished result.",
		width: 1920,
		height: 1080,
		fps: 30,
		background: { type: "color", color: "#0E1116" },
		music: { mood: "ambient", bpm: 96, layers: ["pad", "arpeggio"] },
		slots: [
			{ label: "Intro", kind: "video", bars: 2, fadeIn: 0.3 },
			{ label: "Step 1", kind: "video", bars: 3 },
			{ label: "Step 2", kind: "video", bars: 3 },
			{ label: "Result", kind: "video", bars: 2, fadeOut: 0.6 },
		],
		titles: [
			{
				...headline,
				text: "How to…",
				startBar: 0.25,
				bars: 1.75,
				x: 0.5,
				y: 0.5,
				fontSize: 0.09,
				color: "#FFFFFF",
			},
			{
				...lowerThird,
				text: "Step 1: describe the first action",
				startBar: 2.25,
				bars: 2.6,
				x: 0.32,
				y: 0.86,
				fontSize: 0.045,
				color: "#FFFFFF",
			},
			{
				...lowerThird,
				text: "Step 2: describe the next action",
				startBar: 5.25,
				bars: 2.6,
				x: 0.32,
				y: 0.86,
				fontSize: 0.045,
				color: "#FFFFFF",
			},
			{
				...headline,
				text: "Done!",
				startBar: 8.5,
				bars: 1.5,
				x: 0.5,
				y: 0.8,
				fontSize: 0.08,
				color: "#8BE9A8",
			},
		],
		graphics: [
			{
				startBar: 2,
				bars: 6,
				x: 0.04,
				y: 0.06,
				width: 0.06,
				height: 0.1,
				fill: "#8BE9A8",
				opacity: 0.9,
				shape: "ellipse",
			},
		],
	},
];

/** The built-in template with this id, if any. */
export function builtInTemplate(id: string): BuiltInTemplate | undefined {
	return BUILT_IN_TEMPLATES.find((template) => template.id === id);
}

/** Total length of a built-in template, in seconds. */
export function builtInTemplateDuration(template: BuiltInTemplate): number {
	const bar = soundtrackBarSeconds(template.music.bpm);
	let cursor = 0;
	let end = 0;
	for (const slot of template.slots) {
		const start = slot.startBar ?? cursor;
		cursor = start + slot.bars;
		end = Math.max(end, cursor);
	}
	for (const item of [...template.titles, ...template.graphics]) {
		end = Math.max(end, item.startBar + item.bars);
	}
	return round(end * bar);
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * Deterministic UUID-shaped ids scoped by a seed, for building library
 * summaries without randomness. Projects use random ids.
 */
export function sequentialIds(seed: string): () => string {
	let hash = 2_166_136_261;
	for (const character of seed) {
		hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16_777_619);
	}
	const prefix = (hash >>> 0).toString(16).padStart(8, "0");
	let counter = 0;
	return () => {
		counter += 1;
		return `${prefix}-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
	};
}

export interface BuiltInTemplateMedia {
	/** Music bed; absent leaves the template silent with no audio slot. */
	music?: Asset;
	/** The neutral still every slot starts with (`kind: "image"`). */
	placeholder: Asset;
}

/**
 * The template project for a built-in: slot placeholders on track 0 (or the
 * slot's track), titles and graphics on the bar grid, the canvas
 * background, and the music bed as an audio slot so an audio asset can
 * replace it. The id is the template's own id.
 */
export function builtInTemplateProject(
	template: BuiltInTemplate,
	media: BuiltInTemplateMedia,
	newId: () => string = () => crypto.randomUUID()
): Project {
	const bar = soundtrackBarSeconds(template.music.bpm);
	const at = (bars: number) => round(bars * bar);
	const duration = builtInTemplateDuration(template);
	const segments: Segment[] = [];
	const slots: TemplateSlot[] = [];
	let cursor = 0;
	for (const slot of template.slots) {
		const startBar = slot.startBar ?? cursor;
		cursor = startBar + slot.bars;
		const start = at(startBar);
		const length = round(at(cursor) - start);
		const segment: Segment = {
			...newSegment(media.placeholder, start, slot.track ?? 0),
			id: newId(),
			sourceOut: length,
			fadeIn: slot.fadeIn ?? 0,
			fadeOut: slot.fadeOut ?? 0,
			scale: slot.scale ?? 1,
			x: slot.x ?? 0,
			y: slot.y ?? 0,
			opacity: slot.opacity ?? 1,
			brightness: slot.brightness ?? 0,
			label: slot.label,
		};
		if (slot.animation) {
			segment.animation = slot.animation;
		}
		segments.push(segment);
		slots.push({
			id: newId(),
			segmentId: segment.id,
			label: slot.label,
			kind: slot.kind,
			fixedDuration: slot.fixedDuration ?? true,
		});
	}
	if (media.music) {
		const length = Math.min(duration, media.music.duration);
		const music: Segment = {
			...newSegment(media.music, 0, TEMPLATE_MUSIC_TRACK),
			id: newId(),
			sourceOut: length,
			volume: TEMPLATE_MUSIC_VOLUME,
			fadeOut: Math.min(1, length / 2),
			label: "Music",
		};
		segments.push(music);
		slots.push({
			id: newId(),
			segmentId: music.id,
			label: "Music",
			kind: "audio",
			fixedDuration: false,
		});
	}
	const titles: Title[] = template.titles.map(
		({ bars, startBar, ...style }) => {
			const start = at(startBar);
			const end = at(startBar + bars);
			const fade = Math.min(0.3, (end - start) / 4);
			return {
				...style,
				id: newId(),
				start,
				end,
				fadeIn: fade,
				fadeOut: fade,
				animation: "fade",
			};
		}
	);
	const graphics: Graphic[] = template.graphics.map(
		({ bars, startBar, shape, ...rest }) => {
			const start = at(startBar);
			const end = at(startBar + bars);
			return {
				...rest,
				id: newId(),
				start,
				end,
				animation: "none",
				entryDuration: Math.min(0.35, end - start),
				shape: shape ?? "rectangle",
				stroke: "#FFFFFF",
				strokeWidth: 0,
			};
		}
	);
	return {
		...newProject(template.title),
		id: template.id,
		width: template.width,
		height: template.height,
		fps: template.fps,
		background: template.background,
		segments,
		titles,
		graphics,
		template: {
			slots,
			description: template.description,
			category: template.category,
		},
		updatedAt: new Date(0).toISOString(),
	};
}

/**
 * Library card for a built-in, built with deterministic ids from stand-in
 * media (one placeholder, music as long as the template).
 */
export function builtInTemplateSummary(
	template: BuiltInTemplate
): TemplateSummary {
	const ids = sequentialIds(template.id);
	const createdAt = new Date(0).toISOString();
	const placeholder: Asset = {
		id: ids(),
		name: TEMPLATE_PLACEHOLDER_NAME,
		kind: "image",
		duration: 5,
		width: template.width,
		height: template.height,
		hasAudio: false,
		createdAt,
	};
	const music: Asset = {
		id: ids(),
		name: "Music",
		kind: "audio",
		duration: builtInTemplateDuration(template),
		width: 0,
		height: 0,
		hasAudio: true,
		createdAt,
	};
	return summarizeTemplate(
		builtInTemplateProject(template, { music, placeholder }, ids),
		true
	);
}
