import {
	type CaptionEventPart,
	captionEvents,
} from "../../../shared/caption-events.ts";
import {
	captionDisplayText,
	captionLineBreaks,
	captionsAreStyled,
	captionWordState,
	effectiveCaptionStyle,
	speakerColorOf,
	WORD_BOUNCE,
	WORD_POP,
} from "../../../shared/caption-style.ts";
import {
	activeCaptions,
	type Caption,
	type Project,
} from "../../../shared/project.ts";
import type { ResolvedCaptionStyle } from "../../../shared/schema/defaults.ts";
import { chosenFontFamily } from "../../../shared/schema/font.ts";
import { assBold, TITLE_FONTS } from "../../../shared/text-style.ts";
import { assBgr, assText, assTimestamp } from "./ass-common.ts";

/** Style name used by styled caption events; `Default` stays the legacy look. */
export const CAPTION_STYLE_NAME = "Caption";

/** Whether captions use the styled path (a chosen style or speaker tint). */
export const usesStyledCaptions = captionsAreStyled;

const decimal = (value: number) => Number(value.toFixed(2));
/** ASS alpha byte (`00` opaque, `FF` transparent) for an opacity. */
const assAlpha = (opacity: number) =>
	Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255)
		.toString(16)
		.toUpperCase()
		.padStart(2, "0");
const assColor = (hex: string, opacity = 1) =>
	`&H${assAlpha(opacity)}${assBgr(hex).toUpperCase()}`;

/** Box padding for the boxed style or the `box` word animation, in pixels. */
const boxPadding = (style: ResolvedCaptionStyle, height: number) =>
	decimal(
		Math.max(style.outlineWidth * height, style.fontSize * height * 0.15)
	);

/** The `Caption` style line for a resolved style. */
export function styledCaptionLine(project: Project): string {
	const style = effectiveCaptionStyle(project);
	const height = project.height;
	const boxed = style.backgroundOpacity > 0;
	const box = assColor(style.backgroundColor, style.backgroundOpacity);
	const fields = [
		`Style: ${CAPTION_STYLE_NAME}`,
		chosenFontFamily(style) ?? TITLE_FONTS[style.fontFamily].assName,
		Math.round(style.fontSize * height),
		assColor(style.color),
		assColor(style.highlightColor),
		boxed ? box : assColor(style.outlineColor),
		boxed ? box : "&H80000000",
		assBold(style.fontWeight),
		0,
		0,
		0,
		100,
		100,
		0,
		0,
		boxed ? 3 : 1,
		boxed ? boxPadding(style, height) : decimal(style.outlineWidth * height),
		boxed ? 0 : decimal(style.shadowDepth * height),
		2,
		40,
		40,
		Math.round(height * 0.08),
		1,
	];
	return fields.join(",");
}

/**
 * The `Default` style shared by legacy captions and legacy titles, plus the
 * `Caption` style when captions are styled. Legacy projects keep exactly the
 * one historical line.
 */
export function captionStyleLine(project: Project): string {
	const legacy = `Style: Default,Arial,${Math.round(project.height * 0.045)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,2,40,40,${Math.round(project.height * 0.08)},1`;
	return usesStyledCaptions(project)
		? `${legacy}\n${styledCaptionLine(project)}`
		: legacy;
}

/** Legacy events: the `Default` style with the active word highlighted. */
function legacyDialogue(project: Project): string[] {
	return activeCaptions(project).flatMap((caption) =>
		captionEvents(caption).map((event) => {
			const highlight = assBgr(caption.highlightColor ?? "#ffd43b");
			const words = event.parts
				.map(
					(part) =>
						`${caption.words?.length ? `{\\c&H${part.active ? highlight : "FFFFFF"}&}` : ""}${assText(part.text)}`
				)
				.join("");
			return `Dialogue: 0,${assTimestamp(event.start)},${assTimestamp(event.end)},Default,,0,0,0,,${words}`;
		})
	);
}

interface CaptionContext {
	base: (part: CaptionEventPart) => string;
	breaks: Set<number>;
	highlight: string;
	position: string;
	style: ResolvedCaptionStyle;
}

/** Display text of a part: uppercase applied and line breaks as `\N`. */
function partText(part: CaptionEventPart, context: CaptionContext): string {
	const text = captionDisplayText(part.text, context.style);
	return assText(
		context.breaks.has(part.index) ? `\n${text.trimStart()}` : text
	);
}

/** `\t` swell for a word that starts exactly at its event. */
function swellTags(
	shape: { grow: number; scale: number; settle: number },
	startsHere: boolean
): string {
	if (!startsHere) {
		return "";
	}
	const peak = Math.round(shape.scale * 100);
	const grow = Math.round(shape.grow * 1000);
	const settle = Math.round(shape.settle * 1000);
	return `\\t(0,${grow},\\fscx${peak}\\fscy${peak})\\t(${grow},${settle},\\fscx100\\fscy100)`;
}

/** Override tags for one part of one boundary event. */
function partTags(
	part: CaptionEventPart,
	eventStart: number,
	context: CaptionContext,
	project: Project
): string {
	const { style } = context;
	const animation = style.wordAnimation;
	const state = captionWordState(animation, eventStart + 0.0005, part);
	const base = context.base(part);
	const tags: string[] = [];
	if (!state.visible) {
		return "\\alpha&HFF&";
	}
	if (state.highlighted) {
		tags.push(`\\c&H${assBgr(context.highlight)}&`);
	} else if (base !== style.color) {
		tags.push(`\\c&H${assBgr(base)}&`);
	}
	const startsHere = Math.abs(part.start - eventStart) < 0.0005;
	if (state.active && animation === "pop") {
		tags.push(swellTags(WORD_POP, startsHere));
	} else if (state.active && animation === "bounce") {
		tags.push(swellTags(WORD_BOUNCE, startsHere));
	}
	if (state.boxed) {
		tags.push(
			`\\3c&H${assBgr(context.highlight)}&\\3a&H00&\\bord${boxPadding(style, project.height)}`
		);
	}
	return tags.join("");
}

/** Boundary events for highlight, pop, bounce, box, and reveal. */
function wordEvents(
	caption: Caption,
	context: CaptionContext,
	project: Project
): string[] {
	return captionEvents(caption).map((event) => {
		let previousTagged = false;
		const text = event.parts
			.map((part) => {
				const tags = partTags(part, event.start, context, project);
				const reset = tags || previousTagged ? `{\\r${tags}}` : "";
				previousTagged = Boolean(tags);
				return `${reset}${partText(part, context)}`;
			})
			.join("");
		return `Dialogue: 0,${assTimestamp(event.start)},${assTimestamp(event.end)},${CAPTION_STYLE_NAME},,0,0,0,,${context.position}${text}`;
	});
}

/** One karaoke event: each word fills with the highlight as it is spoken. */
function karaokeEvent(caption: Caption, context: CaptionContext): string {
	const parts = captionEvents(caption)[0]?.parts ?? [];
	const centis = (time: number) => Math.round((time - caption.start) * 100);
	let cursor = 0;
	const text = parts
		.map((part) => {
			const start = Math.max(cursor, centis(part.start));
			const end = Math.max(start, centis(part.end));
			const gap = start - cursor;
			cursor = end;
			const base = assBgr(context.base(part));
			return `${gap > 0 ? `{\\k${gap}}` : ""}{\\2c&H${base}&\\kf${end - start}}${partText(part, context)}`;
		})
		.join("");
	return `Dialogue: 0,${assTimestamp(caption.start)},${assTimestamp(caption.end)},${CAPTION_STYLE_NAME},,0,0,0,,${context.position}{\\1c&H${assBgr(context.highlight)}&}${text}`;
}

/** One event for captions without word animation (or without word timing). */
function staticEvent(caption: Caption, context: CaptionContext): string {
	const parts = captionEvents(caption)[0]?.parts ?? [];
	let previousTagged = false;
	const text = parts
		.map((part) => {
			const base = context.base(part);
			const tags = base === context.style.color ? "" : `\\c&H${assBgr(base)}&`;
			const reset = tags || previousTagged ? `{\\r${tags}}` : "";
			previousTagged = Boolean(tags);
			return `${reset}${partText(part, context)}`;
		})
		.join("");
	return `Dialogue: 0,${assTimestamp(caption.start)},${assTimestamp(caption.end)},${CAPTION_STYLE_NAME},,0,0,0,,${context.position}${text}`;
}

/** Words of a caption without word timing, re-flowed into balanced lines. */
function flowedCaption(
	caption: Caption,
	style: ResolvedCaptionStyle,
	project: Project
): Caption {
	if (caption.words?.length || caption.text.includes("\n")) {
		return caption;
	}
	const tokens = caption.text.split(/\s+/).filter(Boolean);
	const breaks = new Set(captionLineBreaks(tokens, style, project));
	return {
		...caption,
		text: tokens
			.map((token, index) =>
				index === 0 ? token : `${breaks.has(index) ? "\n" : " "}${token}`
			)
			.join(""),
	};
}

/** Styled caption events: position, colors, speaker tint, and word animation. */
export function styledCaptionDialogue(project: Project): string[] {
	const style = effectiveCaptionStyle(project);
	const position = `{\\an2\\pos(${Math.round(style.positionX * project.width)},${Math.round(style.positionY * project.height)})}`;
	return activeCaptions(project).flatMap((source) => {
		const caption = flowedCaption(source, style, project);
		const words = caption.words?.map((word) => word.text) ?? [];
		const context: CaptionContext = {
			base: (part) => speakerColorOf(project, part.speakerId) ?? style.color,
			breaks: new Set(captionLineBreaks(words, style, project)),
			highlight: caption.highlightColor ?? style.highlightColor,
			position,
			style,
		};
		if (!caption.words?.length || style.wordAnimation === "none") {
			return [staticEvent(caption, context)];
		}
		if (style.wordAnimation === "karaoke") {
			return [karaokeEvent(caption, context)];
		}
		return wordEvents(caption, context, project);
	});
}

/** Caption dialogue events: legacy output unless captions are styled. */
export function captionDialogue(project: Project): string[] {
	return usesStyledCaptions(project)
		? styledCaptionDialogue(project)
		: legacyDialogue(project);
}
