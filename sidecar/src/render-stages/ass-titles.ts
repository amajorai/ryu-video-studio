import type { Project, Title } from "../../../shared/project.ts";
import { chosenFontFamily } from "../../../shared/schema/font.ts";
import {
	activeWordAt,
	fitStyleAccel,
	glyphGroups,
	glyphOffsetAt,
	glyphVisibleAt,
	groupLead,
	planTitleEvents,
	type TitleGlyph,
	type TitleLayout,
	type TitleMotion,
	type TitleTiming,
	titleAt,
	titleAtLocal,
	titleChannelProgress,
	titleEventTimes,
	titleLayout,
	titleMotionAt,
	titleTimingOf,
	usesGlyphMotion,
} from "../../../shared/text-animation.ts";
import {
	assAlignment,
	assBold,
	estimateTextSize,
	glyphFillColor,
	isStyledTitle,
	type ResolvedTitleStyle,
	TITLE_FONTS,
	titleStyleOf,
	WORD_BLOCK_PADDING,
} from "../../../shared/text-style.ts";
import { assBgr, assText, assTimestamp } from "./ass-common.ts";

/** Alpha of a hard text shadow (`BackColour`), as the legacy style draws it. */
const SHADOW_ALPHA = 0x80;
/** Alpha of a blurred (soft) shadow pass. */
const SOFT_SHADOW_ALPHA = 0x50;
/** Smallest BorderStyle 3 Outline: libass draws no box at Outline 0. */
const MIN_BOX_OUTLINE = 1;
const BOX_LAYER = 1;
const SHADOW_LAYER = 2;
const TEXT_LAYER = 3;

const num = (value: number) => String(Math.round(value * 100) / 100);
const hex2 = (alpha: number) =>
	Math.round(Math.min(255, Math.max(0, alpha)))
		.toString(16)
		.toUpperCase()
		.padStart(2, "0");
/** `&HAABBGGRR` for a style line. */
const styleColor = (hex: string, alpha = 0) =>
	`&H${hex2(alpha)}${assBgr(hex).toUpperCase()}`;
/** ASS alpha for a layer whose own alpha is `base`, faded to `opacity`. */
const fadedAlpha = (base: number, opacity: number) =>
	255 - (255 - base) * Math.min(1, Math.max(0, opacity));
const flag = (on: boolean) => (on ? -1 : 0);

const textStyleName = (title: Title) => `T_${title.id}`;
const boxStyleName = (title: Title) => `TB_${title.id}`;
const wordBoxStyleName = (title: Title) => `TH_${title.id}`;

const fontPx = (title: Title, project: Project) =>
	Math.round(title.fontSize * project.height);

function styleLine(
	name: string,
	title: Title,
	style: ResolvedTitleStyle,
	project: Project,
	colors: { back: string; outline: string; primary: string },
	borderStyle: 1 | 3,
	outline: number,
	shadow: number
): string {
	const size = fontPx(title, project);
	return [
		`Style: ${name}`,
		chosenFontFamily(style) ?? TITLE_FONTS[style.fontFamily].assName,
		size,
		colors.primary,
		styleColor(style.highlightColor),
		colors.outline,
		colors.back,
		assBold(style.fontWeight),
		flag(style.italic),
		flag(style.underline),
		flag(style.strike),
		100,
		100,
		num(style.letterSpacing * size),
		0,
		borderStyle,
		num(outline),
		num(shadow),
		assAlignment(style.align),
		0,
		0,
		0,
		1,
	].join(",");
}

/**
 * `Style:` lines for titles that use text styles: `T_<id>` for the text and,
 * for a square-cornered box, `TB_<id>` (BorderStyle 3 draws the box in its
 * OutlineColour, padded by Outline). Legacy titles keep the `Default` style.
 */
export function titleStyles(project: Project): string[] {
	return project.titles.filter(isStyledTitle).flatMap((keyed) => {
		// Keyframed text styles start from their value at the title's start;
		// events override what changes later (`styleOverrideTags`).
		const title = titleAtLocal(keyed, 0);
		const style = titleStyleOf(title);
		const height = project.height;
		const softShadow = style.shadowBlur > 0;
		const lines = [
			styleLine(
				textStyleName(title),
				title,
				style,
				project,
				{
					back: styleColor(style.shadowColor, SHADOW_ALPHA),
					outline: styleColor(style.outlineColor),
					primary: styleColor(title.color),
				},
				1,
				style.outlineWidth * height,
				softShadow ? 0 : style.shadowDepth * height
			),
		];
		if (title.animationIn === "word-highlight-block") {
			// The active word's box: BorderStyle 3 draws a box behind each glyph
			// in OutlineColour, padded by Outline; the text itself stays hidden.
			lines.push(
				styleLine(
					wordBoxStyleName(title),
					title,
					style,
					project,
					{
						back: styleColor(style.highlightColor, 0xff),
						outline: styleColor(style.highlightColor),
						primary: styleColor(title.color, 0xff),
					},
					3,
					Math.max(
						MIN_BOX_OUTLINE,
						WORD_BLOCK_PADDING * fontPx(title, project)
					),
					0
				)
			);
		}
		if (style.backgroundColor && usesSquareBox(keyed, style)) {
			lines.push(
				styleLine(
					boxStyleName(title),
					title,
					style,
					project,
					{
						back: styleColor(style.backgroundColor, 0xff),
						outline: styleColor(
							style.backgroundColor,
							fadedAlpha(0, style.backgroundOpacity)
						),
						primary: styleColor(title.color, 0xff),
					},
					3,
					Math.max(MIN_BOX_OUTLINE, style.backgroundPaddingY * height),
					0
				)
			);
		}
		return lines;
	});
}

/**
 * Whether a title may draw a square-cornered box (and so needs the `TB_`
 * style): its radius is zero at the start or keyframed (and may reach zero).
 */
function usesSquareBox(title: Title, style: ResolvedTitleStyle): boolean {
	return (
		style.backgroundRadius === 0 ||
		(title.keyframes ?? []).some((key) => key.property === "backgroundRadius")
	);
}

/** Interpolated tag values at the two ends of one event. */
interface Ends {
	a: TitleMotion;
	b: TitleMotion;
}

/** `\tag<a>` at the start and the matching `\t` target at the end. */
function animatedTags(
	pairs: readonly [string, string][]
): [lead: string, target: string] {
	return [
		pairs.map(([a]) => a).join(""),
		pairs
			.filter(([a, b]) => a !== b)
			.map(([, b]) => b)
			.join(""),
	];
}

function withTransform(lead: string, target: string, duration: number) {
	return target ? `${lead}\\t(0,${duration},${target})` : lead;
}

type Point = readonly [number, number];

function position(a: Point, b: Point) {
	const same = num(a[0]) === num(b[0]) && num(a[1]) === num(b[1]);
	return same
		? `\\pos(${num(a[0])},${num(a[1])})`
		: `\\move(${num(a[0])},${num(a[1])},${num(b[0])},${num(b[1])})`;
}

/** `point` rotated clockwise (screen coordinates, y down) by `degrees`. */
export function rotatePoint(point: Point, degrees: number): [number, number] {
	const radians = (degrees * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	return [point[0] * cos - point[1] * sin, point[0] * sin + point[1] * cos];
}

interface EventContext {
	/** The title's style at its start: what its `Style:` lines hold. */
	base: Title;
	duration: number;
	ends: Ends;
	/** Timeline seconds the event starts and ends at. */
	from: number;
	/** Adjacent glyphs moving as one event (see `planTitleEvents`). */
	glyphGroup: number;
	layout: TitleLayout;
	mid: number;
	/** The resolved title at instants inside the event (`PROBE_FRACTIONS`). */
	probes: StyleProbe[];
	project: Project;
	rowCount: number;
	style: ResolvedTitleStyle;
	timing: TitleTiming;
	/** The title with keyframed styles resolved at the event's middle. */
	title: Title;
	/**
	 * The title with keyframed styles resolved at the event's two ends: the
	 * style tags animate between them with `\\t` (`styleOverrideTags`).
	 */
	titles: { a: Title; b: Title };
	to: number;
}

/** One instant inside an event where the style curves are probed. */
interface StyleProbe {
	/** Fraction of the event (0..1). */
	fraction: number;
	/** Timeline seconds. */
	time: number;
	/** The title with keyframed styles resolved then. */
	title: Title;
}

/** Fractions of an event where its style curves are probed for `\\t`. */
const PROBE_FRACTIONS = [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875];

/** One style value across an event, and its value in the `Style:` line. */
interface StyleTrack {
	base: number;
	tag: (value: number) => string;
	value: (title: Title) => number;
}

/**
 * A color across an event, as for `StyleTrack`; without `base` the start
 * color is always set. Its progress is read from the channel's eased
 * keyframe progress, since resolved colors are rounded.
 */
interface ColorTrack {
	base?: string;
	color: (title: Title) => string;
	property: "backgroundColor" | "color";
	tag: (bgr: string) => string;
}

/**
 * A style tag that animates across the event: the start value when it
 * differs from the `Style:` line, then `\\t(0,duration,accel,…)` to the end
 * value, its acceleration fitted to the curve's normalized progress at the
 * probes (`fitStyleAccel`; 1 for a linear stretch).
 */
function animatedTag(
	lead: string,
	base: string,
	target: string,
	samples: readonly (readonly [number, number])[],
	duration: number
): string {
	let tags = lead === base ? "" : lead;
	if (target !== lead) {
		const accel = fitStyleAccel(samples);
		tags += `\\t(0,${duration},${accel === 1 ? "" : `${accel},`}${target})`;
	}
	return tags;
}

/** Normalized progress of `values` from their first to their last entry. */
function normalized(
	probes: readonly StyleProbe[],
	at: (probe: StyleProbe) => number,
	a: number,
	b: number
): [number, number][] {
	const span = b - a;
	if (Math.abs(span) < 1e-9) {
		return [];
	}
	return probes.map((probe) => [probe.fraction, (at(probe) - a) / span]);
}

/** The tags of every track, each animated over the event. */
function styleTrackTags(
	context: EventContext,
	tracks: readonly StyleTrack[],
	colors: readonly ColorTrack[] = []
): string {
	const { base, duration, probes, titles } = context;
	let tags = "";
	for (const track of tracks) {
		const a = track.value(titles.a);
		const b = track.value(titles.b);
		tags += animatedTag(
			track.tag(a),
			track.tag(track.base),
			track.tag(b),
			normalized(probes, (probe) => track.value(probe.title), a, b),
			duration
		);
	}
	for (const color of colors) {
		const local = (time: number) =>
			titleChannelProgress(base, color.property, time - base.start);
		tags += animatedTag(
			color.tag(assBgr(color.color(titles.a))),
			color.base === undefined ? "" : color.tag(assBgr(color.base)),
			color.tag(assBgr(color.color(titles.b))),
			normalized(
				probes,
				(probe) => local(probe.time),
				local(context.from),
				local(Math.max(context.from, context.to - 1e-7))
			),
			duration
		);
	}
	return tags;
}

/**
 * Font size (pixels) of a resolved title: unrounded while font size is
 * keyframed, so `\\t` follows the curve, else the `Style:` line's pixels.
 */
const sizeOf = (title: Title, project: Project) =>
	(title.keyframes ?? []).some((key) => key.property === "fontSize")
		? title.fontSize * project.height
		: fontPx(title, project);

/** Font size and letter spacing tracks of an event. */
function sizeTracks(context: EventContext): StyleTrack[] {
	const { base, project } = context;
	return [
		{
			base: fontPx(base, project),
			tag: (value) => `\\fs${num(value)}`,
			value: (resolved) => sizeOf(resolved, project),
		},
		{
			base: titleStyleOf(base).letterSpacing * fontPx(base, project),
			tag: (value) => `\\fsp${num(value)}`,
			value: (resolved) =>
				titleStyleOf(resolved).letterSpacing * sizeOf(resolved, project),
		},
	];
}

/**
 * Overrides for keyframed text styles: font size and letter spacing, and the
 * fill color for text passes (`fill`), each set at the event's start where
 * it differs from the title's `Style:` line and animated to the event's end
 * with `\\t`, so libass interpolates them every frame.
 */
function styleOverrideTags(context: EventContext, fill: boolean): string {
	return styleTrackTags(
		context,
		sizeTracks(context),
		fill
			? [
					{
						base: context.base.color,
						color: (resolved) => resolved.color,
						property: "color",
						tag: (bgr) => `\\1c&H${bgr}&`,
					},
				]
			: []
	);
}

/** The title anchor (pixels) of a motion state: the rotation pivot. */
function titleAnchor(context: EventContext, motion: TitleMotion): Point {
	return [motion.x * context.project.width, motion.y * context.project.height];
}

/**
 * Unrotated offset (pixels) of row `row` from the title anchor, with a glyph
 * y offset; both scale with the title, as in the preview.
 */
function rowOffset(
	context: EventContext,
	motion: TitleMotion,
	row: number,
	extraY = 0,
	end: "a" | "b" = "a"
): Point {
	const { project, rowCount } = context;
	const title = context.titles[end];
	const rowStep =
		titleStyleOf(title).lineHeight * sizeOf(title, project) * motion.scale;
	return [
		0,
		extraY * project.height * motion.scale +
			(row - (rowCount - 1) / 2) * rowStep,
	];
}

/**
 * `\\pos`/`\\move` (plus `\\org` when rotated) for a part of the title placed
 * at `offsetA`/`offsetB` from the title anchor at the event's two ends.
 *
 * libass rotates around one fixed `\\org` for the whole event, while the title
 * must rotate around its own (moving) anchor. With the pivot at the start
 * anchor `O`, a point drawn at `p` lands at `O + R(p - O)`, so the end point is
 * pre-rotated by `R⁻¹`: the drawn path is then the straight line between the
 * true anchors, exact whenever rotation is constant across the event.
 * Intervals where a rotated title both moves and turns are split into short
 * sub-events by `titleEvents`, so the remaining error stays sub-pixel-small.
 */
function placement(
	context: EventContext,
	offsetA: Point,
	offsetB: Point,
	shift: Point = [0, 0]
): string {
	const { a, b } = context.ends;
	const anchorA = titleAnchor(context, a);
	const anchorB = titleAnchor(context, b);
	const rotated = a.rotation !== 0 || b.rotation !== 0;
	const travel: Point = [anchorB[0] - anchorA[0], anchorB[1] - anchorA[1]];
	const drawnTravel = rotated ? rotatePoint(travel, -b.rotation) : travel;
	const pivot: Point = [anchorA[0] + shift[0], anchorA[1] + shift[1]];
	const start: Point = [pivot[0] + offsetA[0], pivot[1] + offsetA[1]];
	const end: Point = [
		pivot[0] + drawnTravel[0] + offsetB[0],
		pivot[1] + drawnTravel[1] + offsetB[1],
	];
	const origin = rotated ? `\\org(${num(pivot[0])},${num(pivot[1])})` : "";
	return `${position(start, end)}${origin}`;
}

function motionTags(context: EventContext, blurBase = 0): [string, string] {
	const { a, b } = context.ends;
	const height = context.project.height;
	const pairs: [string, string][] = [];
	if (a.scale !== 1 || b.scale !== 1) {
		pairs.push([
			`\\fscx${num(a.scale * 100)}\\fscy${num(a.scale * 100)}`,
			`\\fscx${num(b.scale * 100)}\\fscy${num(b.scale * 100)}`,
		]);
	}
	if (a.rotation !== 0 || b.rotation !== 0) {
		pairs.push([`\\frz${num(-a.rotation)}`, `\\frz${num(-b.rotation)}`]);
	}
	const blurA = blurBase + a.blur * height;
	const blurB = blurBase + b.blur * height;
	if (blurA > 0 || blurB > 0) {
		pairs.push([`\\blur${num(blurA)}`, `\\blur${num(blurB)}`]);
	}
	return animatedTags(pairs);
}

function alphaTags(
	context: EventContext,
	bases: readonly [component: 1 | 3 | 4, base: number][]
): [string, string] {
	const { a, b } = context.ends;
	return animatedTags(
		bases.map(([component, base]) => [
			`\\${component}a&H${hex2(fadedAlpha(base, a.opacity))}&`,
			`\\${component}a&H${hex2(fadedAlpha(base, b.opacity))}&`,
		])
	);
}

type GlyphClass = "hidden" | "highlight" | "plain";

/**
 * Row text with hidden glyphs kept for layout, the active word colored, and
 * (for a gradient fill) each glyph in its own color.
 */
function rowText(
	row: readonly TitleGlyph[],
	classOf: (glyph: TitleGlyph) => GlyphClass,
	restore: string,
	colors: { base: string; highlight: string },
	fillOf?: (glyph: TitleGlyph, position: number) => string
): string {
	let current: GlyphClass = "plain";
	let currentColor = colors.base;
	let text = "";
	row.forEach((glyph, position) => {
		const next = classOf(glyph);
		if (next === "hidden") {
			if (current !== "hidden") {
				text += "{\\alpha&HFF&}";
			}
			current = next;
			text += assText(glyph.char);
			return;
		}
		const color =
			next === "highlight"
				? colors.highlight
				: (fillOf?.(glyph, position) ?? colors.base);
		if (next !== current || color !== currentColor) {
			text += `{${current === "hidden" ? restore : ""}\\1c&H${color}&}`;
			current = next;
			currentColor = color;
		}
		text += assText(glyph.char);
	});
	return text;
}

/**
 * `outline` draws only the outline (and hard shadow) of a blurred title:
 * libass blurs the border instead of the fill when a title has an outline,
 * so a blurred, outlined title is drawn as an outline pass and a borderless
 * fill pass, both blurred.
 */
type Pass = "outline" | "shadow" | "text";

/** Whether a title is drawn as separate outline and fill passes. */
const splitsOutline = (style: ResolvedTitleStyle) =>
	style.textBlur > 0 && style.outlineWidth > 0;

/** Text (or soft-shadow) dialogue for one event interval. */
function textEvents(
	context: EventContext,
	pass: Pass,
	from: number,
	to: number
): string[] {
	const { ends, layout, mid, project, style, timing, title } = context;
	const height = project.height;
	const shadow = pass === "shadow";
	const shiftX = shadow ? style.shadowDepth : 0;
	const shiftY = shadow ? style.shadowDepth : 0;
	const [motionLead, motionTarget] = motionTags(
		context,
		(shadow ? (style.shadowBlur * height) / 1080 : 0) + style.textBlur * height
	);
	const [alphaLead, alphaTarget] = alphaTags(
		context,
		shadow
			? [
					[1, SOFT_SHADOW_ALPHA],
					[3, SOFT_SHADOW_ALPHA],
				]
			: [
					[1, pass === "outline" ? 0xff : 0],
					[3, 0],
					[4, SHADOW_ALPHA],
				]
	);
	const lead = withTransform(
		`${motionLead}${alphaLead}`,
		`${motionTarget}${alphaTarget}`,
		context.duration
	);
	const restore = withTransform(alphaLead, alphaTarget, context.duration);
	const color = shadow ? style.shadowColor : title.color;
	const colors = {
		base: assBgr(color),
		highlight: shadow ? assBgr(color) : assBgr(style.highlightColor),
	};
	let passTags = styleOverrideTags(context, !shadow);
	if (shadow) {
		passTags += `\\1c&H${colors.base}&\\3c&H${colors.base}&\\shad0`;
	} else if (pass === "text" && splitsOutline(style)) {
		// The outline pass drew the border and shadow; blur the bare fill.
		passTags += "\\bord0\\shad0";
	}
	// Highlight-block titles keep the active word's text color; its box is
	// drawn by `wordBoxEvents`.
	const active =
		timing.animationIn === "word-highlight-block"
			? null
			: activeWordAt(timing, layout, mid);
	const visible = (glyph: TitleGlyph) =>
		glyphVisibleAt(timing, layout, glyph, mid);
	const baseClass = (glyph: TitleGlyph): GlyphClass => {
		if (!visible(glyph)) {
			return "hidden";
		}
		return active !== null && glyph.word === active ? "highlight" : "plain";
	};
	const fillOf =
		style.gradientColor && !shadow
			? (glyph: TitleGlyph, position: number) =>
					assBgr(
						glyphFillColor(
							title,
							style,
							position,
							layout.rows[glyph.row]?.length ?? 1
						)
					)
			: undefined;
	const events: string[] = [];
	const shift: Point = [shiftX * height, shiftY * height];
	const emit = (
		row: number,
		glyphs: readonly TitleGlyph[],
		classOf: (glyph: TitleGlyph) => GlyphClass,
		offset: (time: number) => number
	) => {
		const place = placement(
			context,
			rowOffset(context, ends.a, row, offset(from), "a"),
			rowOffset(context, ends.b, row, offset(to), "b"),
			shift
		);
		const text = rowText(glyphs, classOf, restore, colors, fillOf);
		events.push(
			`Dialogue: ${shadow ? SHADOW_LAYER : TEXT_LAYER},${assTimestamp(from)},${assTimestamp(to)},${textStyleName(title)},,0,0,0,,{\\an${assAlignment(style.align)}${place}${passTags}${lead}}${text}`
		);
	};
	layout.rows.forEach((glyphs, row) => {
		if (glyphs.length === 0) {
			return;
		}
		if (!usesGlyphMotion(timing)) {
			emit(row, glyphs, baseClass, () => 0);
			return;
		}
		for (const group of glyphGroups(glyphs, context.glyphGroup)) {
			if (!group.some(visible)) {
				continue;
			}
			const members = new Set(group);
			// A group moves with its middle glyph (the glyph itself when 1).
			const lead = groupLead(group);
			if (!lead) {
				continue;
			}
			emit(
				row,
				glyphs,
				(other) => (members.has(other) ? baseClass(other) : "hidden"),
				(time) => glyphOffsetAt(timing, layout, lead, time)
			);
		}
	});
	return events;
}

/** A rounded-rectangle drawing path of `width` by `height` with corner `r`. */
export function roundedRectPath(
	width: number,
	height: number,
	radius: number
): string {
	const r = Math.min(radius, width / 2, height / 2);
	const k = r * 0.4477;
	const w = num(width);
	const h = num(height);
	return [
		`m ${num(r)} 0`,
		`l ${num(width - r)} 0`,
		`b ${num(width - k)} 0 ${w} ${num(k)} ${w} ${num(r)}`,
		`l ${w} ${num(height - r)}`,
		`b ${w} ${num(height - k)} ${num(width - k)} ${h} ${num(width - r)} ${h}`,
		`l ${num(r)} ${h}`,
		`b ${num(k)} ${h} 0 ${num(height - k)} 0 ${num(height - r)}`,
		`l 0 ${num(r)}`,
		`b 0 ${num(k)} ${num(k)} 0 ${num(r)} 0`,
	].join(" ");
}

const addPoints = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];

/**
 * The box's offset from the text (`backgroundOffsetX/Y`, canvas fractions),
 * in the title's local frame: it scales with the title and, being part of
 * the placement offset, turns with it about the anchor.
 */
function boxShift(context: EventContext, motion: TitleMotion): Point {
	const { project, style } = context;
	return [
		style.backgroundOffsetX * project.width * motion.scale,
		style.backgroundOffsetY * project.height * motion.scale,
	];
}

/**
 * Style tags of a square box event: size and spacing, the box color
 * (`\\3c`) and its padding (`\\bord`, or `\\xbord`/`\\ybord` when the
 * axes differ), each animated from the event's start to its end.
 */
function squareBoxTags(context: EventContext, color: string): string {
	const { base, project, titles } = context;
	const baseStyle = titleStyleOf(base);
	const border = (padding: number) =>
		Math.max(MIN_BOX_OUTLINE, padding * project.height);
	const axis = (
		key: "backgroundPaddingX" | "backgroundPaddingY",
		tag: string
	): StyleTrack => ({
		base: border(baseStyle.backgroundPaddingY),
		tag: (value) => `\\${tag}${num(value)}`,
		value: (resolved) => border(titleStyleOf(resolved)[key]),
	});
	const square = (resolved: Title) => {
		const style = titleStyleOf(resolved);
		return (
			num(border(style.backgroundPaddingX)) ===
			num(border(style.backgroundPaddingY))
		);
	};
	const borders =
		square(titles.a) && square(titles.b)
			? [axis("backgroundPaddingY", "bord")]
			: [
					axis("backgroundPaddingX", "xbord"),
					axis("backgroundPaddingY", "ybord"),
				];
	return styleTrackTags(
		context,
		[...sizeTracks(context), ...borders],
		[
			{
				base: baseStyle.backgroundColor ?? color,
				color: (resolved) => titleStyleOf(resolved).backgroundColor ?? color,
				property: "backgroundColor",
				tag: (bgr) => `\\3c&H${bgr}&`,
			},
		]
	);
}

/** Box events: BorderStyle 3 per row, or one rounded `\p1` drawing. */
function boxEvents(context: EventContext, from: number, to: number): string[] {
	const { ends, layout, project, style, title } = context;
	if (!style.backgroundColor) {
		return [];
	}
	const [motionLead, motionTarget] = motionTags(context);
	const boxAlpha = fadedAlpha(0, style.backgroundOpacity);
	const span = `${assTimestamp(from)},${assTimestamp(to)}`;
	if (style.backgroundRadius === 0) {
		const [alphaLead, alphaTarget] = alphaTags(context, [[3, boxAlpha]]);
		const boxTags = squareBoxTags(context, style.backgroundColor);
		const lead = withTransform(
			`\\1a&HFF&${boxTags}${motionLead}${alphaLead}`,
			`${motionTarget}${alphaTarget}`,
			context.duration
		);
		return layout.rows.flatMap((glyphs, row) =>
			glyphs.length === 0
				? []
				: [
						`Dialogue: ${BOX_LAYER},${span},${boxStyleName(title)},,0,0,0,,{\\an${assAlignment(style.align)}${placement(context, addPoints(rowOffset(context, ends.a, row, 0, "a"), boxShift(context, ends.a)), addPoints(rowOffset(context, ends.b, row, 0, "b"), boxShift(context, ends.b)))}${lead}}${assText(glyphs.map((glyph) => glyph.char).join(""))}`,
					]
		);
	}
	const size = estimateTextSize(title.text, style, fontPx(title, project));
	const width = size.width + 2 * style.backgroundPaddingX * project.height;
	const height = size.height + 2 * style.backgroundPaddingY * project.height;
	const shift = { center: 0, left: 0.5, right: -0.5 }[style.align];
	const centerOffset = (motion: TitleMotion): Point =>
		addPoints(
			[shift * size.width * motion.scale, 0],
			boxShift(context, motion)
		);
	const [alphaLead, alphaTarget] = alphaTags(context, [[1, boxAlpha]]);
	const lead = withTransform(
		`${motionLead}${alphaLead}`,
		`${motionTarget}${alphaTarget}`,
		context.duration
	);
	// The drawing's shape is sampled (`sampledStyleChannels`); its color
	// animates across the event.
	const color = styleTrackTags(
		context,
		[],
		[
			{
				color: (resolved) =>
					titleStyleOf(resolved).backgroundColor ??
					(style.backgroundColor as string),
				property: "backgroundColor",
				tag: (bgr) => `\\1c&H${bgr}&`,
			},
		]
	);
	return [
		`Dialogue: ${BOX_LAYER},${span},${textStyleName(title)},,0,0,0,,{\\an5${placement(context, centerOffset(ends.a), centerOffset(ends.b))}\\bord0\\shad0${color}${lead}\\p1}${roundedRectPath(width, height, style.backgroundRadius * height)}`,
	];
}

/**
 * The box behind the active word of a word-highlight-block title: the row's
 * text in the `TH_` style (BorderStyle 3), with the fill hidden and every
 * glyph but the active word's made fully transparent.
 */
function wordBoxEvents(
	context: EventContext,
	from: number,
	to: number
): string[] {
	const { ends, layout, mid, style, timing, title } = context;
	if (timing.animationIn !== "word-highlight-block") {
		return [];
	}
	const active = activeWordAt(timing, layout, mid);
	if (active === null) {
		return [];
	}
	const [motionLead, motionTarget] = motionTags(context);
	const [alphaLead, alphaTarget] = alphaTags(context, [[3, 0]]);
	const { project } = context;
	const pad = (resolved: Title) =>
		Math.max(MIN_BOX_OUTLINE, WORD_BLOCK_PADDING * sizeOf(resolved, project));
	const boxTags = styleTrackTags(context, [
		...sizeTracks(context),
		{
			base: Math.max(
				MIN_BOX_OUTLINE,
				WORD_BLOCK_PADDING * fontPx(context.base, project)
			),
			tag: (value) => `\\bord${num(value)}`,
			value: pad,
		},
	]);
	const lead = withTransform(
		`\\1a&HFF&${boxTags}${motionLead}${alphaLead}`,
		`${motionTarget}${alphaTarget}`,
		context.duration
	);
	const restore = withTransform(alphaLead, alphaTarget, context.duration);
	const span = `${assTimestamp(from)},${assTimestamp(to)}`;
	return layout.rows.flatMap((glyphs, row) => {
		if (!glyphs.some((glyph) => glyph.word === active)) {
			return [];
		}
		let shown = true;
		let text = "";
		for (const glyph of glyphs) {
			const show = glyph.word === active;
			if (show !== shown) {
				text += show ? `{${restore}}` : "{\\3a&HFF&}";
				shown = show;
			}
			text += assText(glyph.char);
		}
		return [
			`Dialogue: ${BOX_LAYER},${span},${wordBoxStyleName(title)},,0,0,0,,{\\an${assAlignment(style.align)}${placement(context, rowOffset(context, ends.a, row, 0, "a"), rowOffset(context, ends.b, row, 0, "b"))}${lead}}${text}`,
		];
	});
}

/** The legacy event: one `Default`-style line with inline overrides. */
function legacyTitleEvents(title: Title, project: Project): string[] {
	const x = Math.round(title.x * project.width);
	const y = Math.round(title.y * project.height);
	const travelX = Math.round(project.width * 0.08);
	const travelY = Math.round(project.height * 0.08);
	const fadeIn = Math.round(title.fadeIn * 1000);
	const from: Record<string, [number, number]> = {
		"slide-down": [x, y - travelY],
		"slide-left": [x + travelX, y],
		"slide-right": [x - travelX, y],
		"slide-up": [x, y + travelY],
	};
	const start = from[title.animation];
	const motion = start
		? `\\move(${start[0]},${start[1]},${x},${y},0,${fadeIn})`
		: `\\pos(${x},${y})`;
	const style = `{\\an5${motion}\\fs${Math.round(title.fontSize * project.height)}\\c&H${assBgr(title.color)}&\\fad(${fadeIn},${Math.round(title.fadeOut * 1000)})}`;
	return [
		`Dialogue: 1,${assTimestamp(title.start)},${assTimestamp(title.end)},Default,,0,0,0,,${style}${assText(title.text)}`,
	];
}

/** Sub-event length for intervals where a rotated title moves and turns. */
const ROTATING_MOVE_FRAMES = 2;

/**
 * Split intervals in which a rotated title both moves and changes rotation
 * into sub-events of `ROTATING_MOVE_FRAMES`, so each sub-event's fixed
 * `\\org` stays close to the title's own anchor (see `placement`).
 */
function refineRotatingMoves(
	title: Title,
	project: Project,
	timing: TitleTiming,
	times: readonly number[]
): number[] {
	const step = ROTATING_MOVE_FRAMES / Math.max(1, project.fps);
	const refined: number[] = [];
	for (let index = 0; index < times.length; index++) {
		const from = times[index] as number;
		refined.push(from);
		const to = times[index + 1];
		if (to === undefined || to - from <= step) {
			continue;
		}
		const a = titleMotionAt(title, from, timing);
		const b = titleMotionAt(title, Math.max(from, to - 1e-7), timing);
		const moves =
			Math.abs((a.x - b.x) * project.width) > 0.5 ||
			Math.abs((a.y - b.y) * project.height) > 0.5;
		if (!moves || a.rotation === b.rotation) {
			continue;
		}
		const parts = Math.ceil((to - from) / step);
		for (let part = 1; part < parts; part++) {
			// Centisecond boundaries, the resolution of ASS timestamps.
			const time =
				Math.round((from + ((to - from) * part) / parts) * 100) / 100;
			if (time > (refined.at(-1) as number) && time < to) {
				refined.push(time);
			}
		}
	}
	return refined;
}

/** Per-interval output cost of a styled title (for `planTitleEvents`). */
function eventCost(
	title: Title,
	style: ResolvedTitleStyle,
	layout: TitleLayout
) {
	const square = Boolean(style.backgroundColor) && style.backgroundRadius === 0;
	const rounded = Boolean(style.backgroundColor) && !square;
	const rows = layout.rows.filter((row) => row.length > 0).length;
	return {
		boxChars: square ? layout.count : rounded ? 200 : 0,
		boxLines: square ? rows : rounded ? 1 : 0,
		passes: (style.shadowBlur > 0 ? 2 : 1) + (splitsOutline(style) ? 1 : 0),
	};
}

/**
 * Dialogue events for one title. Legacy titles keep their single event.
 * Styled titles split at every motion boundary (`titleEventTimes`); inside an
 * event every value is linear, so each event is a `\\move` plus one `\\t`.
 * Output is bounded by `planTitleEvents` (glyph grouping, then thinning).
 */
export function titleEvents(title: Title, project: Project): string[] {
	if (!isStyledTitle(title)) {
		return legacyTitleEvents(title, project);
	}
	const base = titleAtLocal(title, 0);
	const timing = titleTimingOf(title);
	const layout = titleLayout(title.text);
	const plan = planTitleEvents(
		layout,
		refineRotatingMoves(
			title,
			project,
			timing,
			titleEventTimes(title, project.fps, timing)
		),
		usesGlyphMotion(timing),
		eventCost(base, titleStyleOf(base), layout)
	);
	const times = plan.times;
	const events: string[] = [];
	for (let index = 1; index < times.length; index++) {
		const from = times[index - 1] as number;
		const to = times[index] as number;
		if (to <= from) {
			continue;
		}
		const resolved = titleAt(title, (from + to) / 2);
		const style = titleStyleOf(resolved);
		const context: EventContext = {
			base,
			duration: Math.round((to - from) * 1000),
			ends: {
				a: titleMotionAt(title, from, timing),
				b: titleMotionAt(title, Math.max(from, to - 1e-7), timing),
			},
			glyphGroup: plan.glyphGroup,
			layout,
			mid: (from + to) / 2,
			project,
			rowCount: layout.rows.length,
			style,
			timing,
			title: resolved,
			from,
			probes: PROBE_FRACTIONS.map((fraction) => {
				const time = from + (to - from) * fraction;
				return { fraction, time, title: titleAt(title, time) };
			}),
			to,
			titles: {
				a: titleAt(title, from),
				b: titleAt(title, Math.max(from, to - 1e-7)),
			},
		};
		events.push(...boxEvents(context, from, to));
		events.push(...wordBoxEvents(context, from, to));
		if (style.shadowBlur > 0) {
			events.push(...textEvents(context, "shadow", from, to));
		}
		if (splitsOutline(style)) {
			events.push(...textEvents(context, "outline", from, to));
		}
		events.push(...textEvents(context, "text", from, to));
	}
	return events;
}
