import type { Title } from "./project.ts";
import {
	type Keyframe,
	type KeyframeBezier,
	type KeyframeInterpolation,
	mixKeyframeColor,
	titleColorKeyframeProperties,
	titleStyleKeyframeProperties,
} from "./schema/keyframe.ts";
import type {
	TitleAnimationIn,
	TitleAnimationLoop,
	TitleAnimationOut,
} from "./schema/text-style.ts";
import { titleStyleOf } from "./text-style.ts";

/**
 * Title motion as pure functions of time, shared by the preview (sampled per
 * frame) and the ASS renderer (sampled at `titleEventTimes` and linearly
 * interpolated between them, which is exact for every piecewise-linear curve).
 */

/** Motion duration when an explicit animation has no duration of its own. */
export const DEFAULT_MOTION_DURATION = 0.5;
/** Slide travel as a fraction of the canvas (matches the legacy 8%). */
export const SLIDE_TRAVEL = 0.08;
/** Peak blur for blur-in/out, as a fraction of the canvas height. */
export const BLUR_PEAK = 0.012;
const BOUNCE_DROP = 0.12;
const WAVE_IN_HOP = 0.035;
const WAVE_LOOP_AMPLITUDE = 0.012;
const WAVE_LOOP_PERIOD = 1.2;
const WAVE_LOOP_PHASE = 0.125;
const FLOAT_AMPLITUDE = 0.01;
const FLOAT_PERIOD = 2;
const PULSE_AMPLITUDE = 0.05;
const PULSE_PERIOD = 1;
const WOBBLE_DEGREES = 4;
const WOBBLE_PERIOD = 0.8;
/** Samples per loop period for curved loops. */
const LOOP_SAMPLES = 12;
/**
 * Pieces an eased style interval is cut into; each piece is one `\\t` with
 * an acceleration fitted to the ease (`fitStyleAccel`). Ten keeps the
 * fitted power curve within about half an 8-bit step of every CSS ease over
 * a full 0–255 color change (eight leaves up to 0.74 of a step for
 * ease-in-out, which libass's own rounding then pushes past one).
 */
export const STYLE_EASE_PIECES = 10;
/** Upper bound on event boundaries per title, so long loops stay bounded. */
export const MAX_TITLE_EVENT_TIMES = 400;
/** Upper bound on ASS dialogue lines one title may produce. */
export const MAX_TITLE_EVENTS = 5000;
/**
 * Upper bound on text characters (rows repeated across events) one title may
 * produce, so per-glyph events on long titles cannot balloon the ASS file.
 */
export const MAX_TITLE_EVENT_CHARS = 400_000;

type Knots = readonly (readonly [number, number])[];

/** Piecewise-linear curves over animation progress `0..1`. */
const SCALE_IN: Partial<Record<TitleAnimationIn, Knots>> = {
	pop: [
		[0, 0.3],
		[0.6, 1.15],
		[1, 1],
	],
	"zoom-in": [
		[0, 0.3],
		[1, 1],
	],
};
const SCALE_OUT: Partial<Record<TitleAnimationOut, Knots>> = {
	pop: [
		[0, 1],
		[0.4, 1.15],
		[1, 0.3],
	],
	"zoom-out": [
		[0, 1],
		[1, 0.3],
	],
};
const BOUNCE_IN: Knots = [
	[0, -BOUNCE_DROP],
	[0.45, 0],
	[0.65, -BOUNCE_DROP / 3],
	[0.8, 0],
	[0.9, -BOUNCE_DROP / 10],
	[1, 0],
];
const LINEAR: Knots = [
	[0, 0],
	[1, 1],
];

/** Value of a piecewise-linear curve at `p`, clamped to its ends. */
export function piecewise(knots: Knots, p: number): number {
	const first = knots[0];
	if (!first) {
		return 0;
	}
	if (p <= first[0]) {
		return first[1];
	}
	for (let index = 1; index < knots.length; index++) {
		const a = knots[index - 1];
		const b = knots[index];
		if (a && b && p <= b[0]) {
			return a[1] + ((b[1] - a[1]) * (p - a[0])) / (b[0] - a[0] || 1);
		}
	}
	return knots.at(-1)?.[1] ?? 0;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Resolved timing of a title's in, out, and loop phases. */
export interface TitleTiming {
	animationIn: TitleAnimationIn;
	animationLoop: TitleAnimationLoop;
	animationOut: TitleAnimationOut;
	end: number;
	fadeIn: number;
	fadeOut: number;
	/** End of the in phase (`start` when there is none). */
	inEnd: number;
	/** Start of the out phase (`end` when there is none). */
	outStart: number;
	start: number;
}

/**
 * Resolve a title's phases. Without `animationIn` the legacy `animation`
 * applies over `fadeIn`; in and out durations shrink together to fit.
 */
export function titleTimingOf(title: Title): TitleTiming {
	const span = Math.max(0, title.end - title.start);
	const animationIn = title.animationIn ?? title.animation;
	const animationOut = title.animationOut ?? "none";
	const legacyIn = title.animationIn === undefined;
	let inDuration =
		animationIn === "none"
			? 0
			: (title.animationInDuration ??
				(legacyIn ? title.fadeIn : DEFAULT_MOTION_DURATION));
	let outDuration =
		animationOut === "none"
			? 0
			: (title.animationOutDuration ?? DEFAULT_MOTION_DURATION);
	if (inDuration + outDuration > span) {
		const shrink = span / (inDuration + outDuration);
		inDuration *= shrink;
		outDuration *= shrink;
	}
	return {
		animationIn,
		animationLoop: title.animationLoop ?? "none",
		animationOut,
		end: title.end,
		fadeIn: title.fadeIn,
		fadeOut: title.fadeOut,
		inEnd: title.start + inDuration,
		outStart: title.end - outDuration,
		start: title.start,
	};
}

const inProgress = (timing: TitleTiming, t: number) =>
	timing.inEnd > timing.start
		? clamp01((t - timing.start) / (timing.inEnd - timing.start))
		: 1;
const outProgress = (timing: TitleTiming, t: number) =>
	timing.end > timing.outStart
		? clamp01((t - timing.outStart) / (timing.end - timing.outStart))
		: 0;

/** Seconds into the loop phase, or null outside it. */
function loopTime(timing: TitleTiming, t: number): number | null {
	if (
		timing.animationLoop === "none" ||
		t < timing.inEnd ||
		t > timing.outStart
	) {
		return null;
	}
	return t - timing.inEnd;
}

const wave = (seconds: number, period: number) =>
	Math.sin((2 * Math.PI * seconds) / period);

/** Progress through an easing curve; `hold` stays at 0 until the next key. */
export function easeProgress(
	interpolation: KeyframeInterpolation | undefined,
	p: number,
	bezier?: KeyframeBezier
): number {
	switch (interpolation) {
		case "hold":
			return 0;
		case "ease-in":
			return cubicBezier(0.42, 0, 1, 1, p);
		case "ease-out":
			return cubicBezier(0, 0, 0.58, 1, p);
		case "ease-in-out":
			return cubicBezier(0.42, 0, 0.58, 1, p);
		case "bezier":
			return bezier
				? cubicBezier(bezier[0], bezier[1], bezier[2], bezier[3], p)
				: p;
		default:
			return p;
	}
}

/** CSS `cubic-bezier(x1, y1, x2, y2)` at input progress `p`. */
export function cubicBezier(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	p: number
): number {
	if (p <= 0) {
		return 0;
	}
	if (p >= 1) {
		return 1;
	}
	const axis = (a: number, b: number, s: number) =>
		3 * a * s * (1 - s) ** 2 + 3 * b * s ** 2 * (1 - s) + s ** 3;
	let low = 0;
	let high = 1;
	let s = p;
	for (let step = 0; step < 40; step++) {
		s = (low + high) / 2;
		if (axis(x1, x2, s) < p) {
			low = s;
		} else {
			high = s;
		}
	}
	return axis(y1, y2, s);
}

type TitleKeyProperty = "opacity" | "rotation" | "scale" | "x" | "y";
const TITLE_KEY_PROPERTIES: readonly TitleKeyProperty[] = [
	"x",
	"y",
	"scale",
	"rotation",
	"opacity",
];

function keyBase(title: Title, property: TitleKeyProperty): number {
	switch (property) {
		case "x":
			return title.x;
		case "y":
			return title.y;
		case "rotation":
			return titleStyleOf(title).rotation;
		default:
			return 1;
	}
}

/** Keyframes of one property in time order, starting from the base at 0. */
function keyTrack(title: Title, property: TitleKeyProperty) {
	const keys = (title.keyframes ?? [])
		.filter((key) => key.property === property && !key.target)
		.sort((a, b) => a.time - b.time);
	if (keys.length === 0 || keys[0]?.time === 0) {
		return keys;
	}
	return [
		{
			id: "base",
			property,
			time: 0,
			value: keyBase(title, property),
		} as (typeof keys)[number],
		...keys,
	];
}

/**
 * A title property at title-relative `local` seconds. Title keyframes hold
 * absolute values: `x`/`y` are canvas fractions, `scale` and `opacity` are
 * multipliers, and `rotation` is clockwise degrees.
 */
export function titleKeyValue(
	title: Title,
	property: TitleKeyProperty,
	local: number
): number {
	const track = keyTrack(title, property);
	let previous = track[0];
	if (!previous) {
		return keyBase(title, property);
	}
	for (const next of track.slice(1)) {
		if (local < next.time) {
			const span = next.time - previous.time;
			const p = span > 0 ? clamp01((local - previous.time) / span) : 1;
			const eased = easeProgress(previous.interpolation, p, previous.bezier);
			return previous.value + (next.value - previous.value) * eased;
		}
		previous = next;
	}
	return previous.value;
}

export type TitleStyleKeyProperty =
	(typeof titleStyleKeyframeProperties)[number];
export type TitleColorKeyProperty =
	(typeof titleColorKeyframeProperties)[number];

function styleBase(title: Title, property: TitleStyleKeyProperty): number {
	switch (property) {
		case "fontSize":
			return title.fontSize;
		default:
			return titleStyleOf(title)[property];
	}
}

/** One channel's keyframes in time order (untargeted only). */
function channelKeys(title: Title, property: Keyframe["property"]) {
	return (title.keyframes ?? [])
		.filter((key) => key.property === property && !key.target)
		.sort((a, b) => a.time - b.time);
}

/** Whether a title animates any text-style or color channel. */
export function hasTitleStyleKeyframes(title: Title): boolean {
	const styled: ReadonlySet<string> = new Set([
		...titleStyleKeyframeProperties,
		...titleColorKeyframeProperties,
	]);
	return (title.keyframes ?? []).some((key) => styled.has(key.property));
}

/** Interpolation progress between the key pair around `local`. */
function between<
	Key extends Pick<Keyframe, "bezier" | "interpolation" | "time">,
>(
	keys: readonly Key[],
	local: number
): { a: Key; b: Key; p: number } | { a: Key; b?: undefined; p: 0 } | null {
	const first = keys[0];
	if (!first) {
		return null;
	}
	if (local <= first.time) {
		return { a: first, p: 0 };
	}
	for (let index = 0; index + 1 < keys.length; index++) {
		const a = keys[index] as Key;
		const b = keys[index + 1] as Key;
		if (local < b.time) {
			const span = b.time - a.time;
			const p = span > 0 ? clamp01((local - a.time) / span) : 1;
			return { a, b, p: easeProgress(a.interpolation, p, a.bezier) };
		}
	}
	return { a: keys.at(-1) as Key, p: 0 };
}

/**
 * A title text-style value at title-relative `local` seconds: the static
 * field before the first keyframe when it is after zero (as for motion
 * keyframes), then the eased curve, then the last keyframe held.
 */
export function titleStyleKeyValue(
	title: Title,
	property: TitleStyleKeyProperty,
	local: number
): number {
	const keys = channelKeys(title, property);
	const base = styleBase(title, property);
	const track =
		keys.length === 0 || keys[0]?.time === 0
			? keys
			: [{ time: 0, value: base } as Keyframe, ...keys];
	const at = between(track, local);
	if (!at) {
		return base;
	}
	return at.b ? at.a.value + (at.b.value - at.a.value) * at.p : at.a.value;
}

/**
 * The eased progress (0..1) of a title style or color channel between the
 * keyframes around `local`: what the channel's value interpolates by. Holds
 * outside its keys read 0. The ASS renderer fits each event's `\\t`
 * acceleration to it without the rounding of resolved colors.
 */
export function titleChannelProgress(
	title: Title,
	property: TitleColorKeyProperty | TitleStyleKeyProperty,
	local: number
): number {
	const keys = channelKeys(title, property);
	const first = keys[0];
	if (!first) {
		return 0;
	}
	const track =
		first.time === 0
			? keys
			: [{ ...first, interpolation: undefined, time: 0 }, ...keys];
	const at = between(track, local);
	return at?.b ? at.p : 0;
}

/**
 * A title color at `local`, interpolated per RGB channel. Before a first
 * keyframe after zero the static color holds (a title without a background
 * color starts from its first background keyframe).
 */
export function titleColorKeyValue(
	title: Title,
	property: TitleColorKeyProperty,
	local: number
): string | undefined {
	const keys = channelKeys(title, property).filter((key) => key.color);
	const base =
		property === "color" ? title.color : (title.backgroundColor ?? undefined);
	const first = keys[0];
	if (!first) {
		return base;
	}
	const track =
		first.time === 0
			? keys
			: [
					{
						...first,
						color: base ?? first.color,
						interpolation: undefined,
						time: 0,
					},
					...keys,
				];
	const at = between(track, local);
	if (!at) {
		return base;
	}
	const from = at.a.color as string;
	return at.b ? mixKeyframeColor(from, at.b.color as string, at.p) : from;
}

const roundTo = (value: number, digits: number) =>
	Number(value.toFixed(digits));

/**
 * The title with its keyframed text-style and color channels resolved at
 * title-relative `local` seconds (font size, letter spacing, line height,
 * background padding and radius, text and background color). Position,
 * scale, rotation and opacity stay keyframes (`titleMotionAt`). A title with
 * no style keyframes is returned as is.
 */
export function titleAtLocal(title: Title, local: number): Title {
	if (!hasTitleStyleKeyframes(title)) {
		return title;
	}
	const next: Title = { ...title };
	for (const property of titleStyleKeyframeProperties) {
		if (channelKeys(title, property).length > 0) {
			next[property] = roundTo(titleStyleKeyValue(title, property, local), 6);
		}
	}
	for (const property of titleColorKeyframeProperties) {
		if (channelKeys(title, property).length > 0) {
			const color = titleColorKeyValue(title, property, local);
			if (color) {
				next[property] = color;
			}
		}
	}
	return next;
}

/** `titleAtLocal` at absolute timeline time `t`. */
export const titleAt = (title: Title, t: number): Title =>
	titleAtLocal(title, t - title.start);

/** Whole-title transform and look at one instant. */
export interface TitleMotion {
	/** Blur as a fraction of the canvas height. */
	blur: number;
	opacity: number;
	/** Clockwise degrees. */
	rotation: number;
	scale: number;
	/** Anchor position as canvas fractions. */
	x: number;
	y: number;
}

function slideOffset(
	animation: TitleAnimationIn | TitleAnimationOut,
	amount: number,
	entering: boolean
): [number, number] {
	// Entering slides start `amount` away and travel toward the anchor; exits
	// continue past it in the direction their name gives.
	const sign = entering ? 1 : -1;
	switch (animation) {
		case "slide-up":
			return [0, sign * amount];
		case "slide-down":
			return [0, -sign * amount];
		case "slide-left":
			return [sign * amount, 0];
		case "slide-right":
			return [-sign * amount, 0];
		default:
			return [0, 0];
	}
}

/** Fade factor of a title from its required `fadeIn`/`fadeOut` seconds. */
export function titleFade(timing: TitleTiming, t: number): number {
	const fadeIn = timing.fadeIn > 0 ? (t - timing.start) / timing.fadeIn : 1;
	const fadeOut = timing.fadeOut > 0 ? (timing.end - t) / timing.fadeOut : 1;
	return clamp01(Math.min(1, fadeIn, fadeOut));
}

/** Transform, opacity, and blur of the whole title at absolute time `t`. */
export function titleMotionAt(
	title: Title,
	t: number,
	timing: TitleTiming = titleTimingOf(title)
): TitleMotion {
	const local = t - title.start;
	const pIn = inProgress(timing, t);
	const pOut = outProgress(timing, t);
	const [inX, inY] = slideOffset(
		timing.animationIn,
		(1 - pIn) * SLIDE_TRAVEL,
		true
	);
	const [outX, outY] = slideOffset(
		timing.animationOut,
		pOut * SLIDE_TRAVEL,
		false
	);
	const bounce =
		timing.animationIn === "bounce" ? piecewise(BOUNCE_IN, pIn) : 0;
	let scale =
		titleKeyValue(title, "scale", local) *
		piecewise(SCALE_IN[timing.animationIn] ?? [[0, 1]], pIn) *
		piecewise(SCALE_OUT[timing.animationOut] ?? [[0, 1]], pOut);
	let rotation = titleKeyValue(title, "rotation", local);
	let floatY = 0;
	const loop = loopTime(timing, t);
	if (loop !== null) {
		if (timing.animationLoop === "pulse") {
			scale *= 1 + PULSE_AMPLITUDE * wave(loop, PULSE_PERIOD);
		} else if (timing.animationLoop === "wobble") {
			rotation += WOBBLE_DEGREES * wave(loop, WOBBLE_PERIOD);
		} else if (timing.animationLoop === "float") {
			floatY = -FLOAT_AMPLITUDE * wave(loop, FLOAT_PERIOD);
		}
	}
	const blur =
		(timing.animationIn === "blur-in" ? (1 - pIn) * BLUR_PEAK : 0) +
		(timing.animationOut === "blur-out" ? pOut * BLUR_PEAK : 0);
	return {
		blur,
		opacity:
			clamp01(titleKeyValue(title, "opacity", local)) * titleFade(timing, t),
		rotation,
		scale: Math.max(0, scale),
		x: titleKeyValue(title, "x", local) + inX + outX,
		y: titleKeyValue(title, "y", local) + inY + outY + bounce + floatY,
	};
}

/** One visible character of a title. */
export interface TitleGlyph {
	char: string;
	/** Index among all glyphs (newlines excluded). */
	index: number;
	row: number;
	/** Word index, or -1 for whitespace. */
	word: number;
}

/** A title's text split into rows of glyphs with word indexes. */
export interface TitleLayout {
	count: number;
	rows: TitleGlyph[][];
	words: number;
}

/** Split title text into rows, glyphs, and words. */
export function titleLayout(text: string): TitleLayout {
	let index = 0;
	let word = -1;
	let inWord = false;
	const rows = text.split(/\r?\n/).map((line, row) => {
		inWord = false;
		return Array.from(line).map((char) => {
			const space = /\s/.test(char);
			if (!(space || inWord)) {
				word++;
			}
			inWord = !space;
			return { char, index: index++, row, word: space ? -1 : word };
		});
	});
	return { count: index, rows, words: word + 1 };
}

/** Whether glyph `glyph` has been revealed by typewriter or word-reveal at `t`. */
export function glyphVisibleAt(
	timing: TitleTiming,
	layout: TitleLayout,
	glyph: TitleGlyph,
	t: number
): boolean {
	const span = timing.inEnd - timing.start;
	if (timing.animationIn === "typewriter" && span > 0) {
		return t >= timing.start + (span * glyph.index) / layout.count;
	}
	if (
		(timing.animationIn === "word-reveal" ||
			timing.animationIn === "word-slide") &&
		span > 0 &&
		glyph.word >= 0
	) {
		return t >= timing.start + (span * glyph.word) / layout.words;
	}
	return true;
}

/** How far (canvas-height fraction) a word-slide word starts below its place. */
export const WORD_SLIDE_RISE = 0.04;

/**
 * Word slide: each word appears in turn (like word reveal) and rises into
 * place over twice its share of the intro, easing out. The offset of word
 * `word` at `t`, as a canvas-height fraction (positive is down).
 */
export function wordSlideOffset(
	timing: TitleTiming,
	layout: TitleLayout,
	word: number,
	t: number
): number {
	const span = timing.inEnd - timing.start;
	if (timing.animationIn !== "word-slide" || span <= 0 || word < 0) {
		return 0;
	}
	const share = span / Math.max(1, layout.words);
	const begin = timing.start + share * word;
	const duration = Math.min(span, share * 2);
	const p = clamp01((t - begin) / Math.max(1e-6, duration));
	const eased = 1 - (1 - p) ** 3;
	return WORD_SLIDE_RISE * (1 - eased);
}

/** The highlighted word index for word-highlight, or null. */
export function activeWordAt(
	timing: TitleTiming,
	layout: TitleLayout,
	t: number
): number | null {
	const span = timing.outStart - timing.start;
	if (
		(timing.animationIn !== "word-highlight" &&
			timing.animationIn !== "word-highlight-block") ||
		layout.words === 0 ||
		span <= 0 ||
		t < timing.start ||
		t >= timing.outStart
	) {
		return null;
	}
	return Math.min(
		layout.words - 1,
		Math.floor(((t - timing.start) / span) * layout.words)
	);
}

/** Whether a title needs one event per glyph (per-character vertical motion). */
export function usesGlyphMotion(timing: TitleTiming): boolean {
	return (
		timing.animationIn === "wave" ||
		timing.animationIn === "word-slide" ||
		timing.animationLoop === "wave"
	);
}

/** Vertical offset of one glyph (canvas-height fraction; negative is up). */
export function glyphOffsetAt(
	timing: TitleTiming,
	layout: TitleLayout,
	glyph: TitleGlyph,
	t: number
): number {
	let offset = 0;
	if (timing.animationIn === "wave" && timing.inEnd > timing.start) {
		const stagger = 0.6;
		const p = inProgress(timing, t);
		const local = clamp01(
			(p - (stagger * glyph.index) / Math.max(1, layout.count)) / (1 - stagger)
		);
		offset -= WAVE_IN_HOP * Math.sin(Math.PI * local);
	}
	offset += wordSlideOffset(timing, layout, glyph.word, t);
	const loop = loopTime(timing, t);
	if (timing.animationLoop === "wave" && loop !== null) {
		offset -=
			WAVE_LOOP_AMPLITUDE *
			wave(loop - glyph.index * WAVE_LOOP_PHASE, WAVE_LOOP_PERIOD);
	}
	return offset;
}

function loopPeriod(loop: TitleAnimationLoop): number {
	switch (loop) {
		case "pulse":
			return PULSE_PERIOD;
		case "wobble":
			return WOBBLE_PERIOD;
		case "float":
			return FLOAT_PERIOD;
		case "wave":
			return WAVE_LOOP_PERIOD;
		default:
			return 0;
	}
}

function pushRange(
	times: number[],
	from: number,
	to: number,
	step: number
): void {
	if (!(step > 0 && to > from)) {
		return;
	}
	for (let time = from + step; time < to - step / 4; time += step) {
		times.push(time);
	}
}

/** Whether an interpolation is a curve (not linear and not a hold). */
const easedInterpolation = (interpolation: KeyframeInterpolation | undefined) =>
	interpolation !== undefined &&
	interpolation !== "linear" &&
	interpolation !== "hold";

/** Box geometry channels a rounded `\\p1` drawing cannot animate. */
const ROUNDED_BOX_GEOMETRY: ReadonlySet<string> = new Set([
	"fontSize",
	"letterSpacing",
	"lineHeight",
	"backgroundPadding",
	"backgroundRadius",
]);

/**
 * Style channels that stay sampled in smooth steps: the geometry of a
 * rounded background box, drawn as one path whose shape `\\t` cannot
 * change. Every other style channel animates per frame inside an event.
 */
export function sampledStyleChannels(title: Title): ReadonlySet<string> {
	const keys = title.keyframes ?? [];
	const hasBox =
		Boolean(title.backgroundColor) ||
		keys.some((key) => key.property === "backgroundColor");
	const rounded =
		titleStyleOf(title).backgroundRadius > 0 ||
		keys.some((key) => key.property === "backgroundRadius" && key.value > 0);
	return hasBox && rounded ? ROUNDED_BOX_GEOMETRY : new Set();
}

/**
 * The libass `\\t` acceleration whose power curve `u^accel` best follows a
 * value's normalized progress `[u, progress]` samples inside one event (the
 * smallest worst-case error, by a golden-section search over `log accel`).
 * 1 for linear progress, no samples, or no gain over linear.
 */
export function fitStyleAccel(
	samples: readonly (readonly [number, number])[]
): number {
	if (samples.length === 0) {
		return 1;
	}
	const error = (accel: number) => {
		let worst = 0;
		for (const [u, value] of samples) {
			worst = Math.max(worst, Math.abs(value - u ** accel));
		}
		return worst;
	};
	const linear = error(1);
	if (linear < 1e-4) {
		return 1;
	}
	let low = Math.log(0.05);
	let high = Math.log(20);
	const ratio = (Math.sqrt(5) - 1) / 2;
	for (let step = 0; step < 48; step++) {
		const a = high - (high - low) * ratio;
		const b = low + (high - low) * ratio;
		if (error(Math.exp(a)) < error(Math.exp(b))) {
			high = b;
		} else {
			low = a;
		}
	}
	const accel = Number(Math.exp((low + high) / 2).toFixed(4));
	return error(accel) < linear ? accel : 1;
}

/**
 * Event boundaries for the ASS renderer: every instant where a motion curve,
 * reveal, or highlight changes slope or value, plus sub-steps (2 frames, or
 * 1/12 of a loop period) for eased motion keyframes and curved loops, and
 * `STYLE_EASE_PIECES` pieces for eased style keyframes. Rounded to
 * centiseconds, deduplicated, sorted, and bounded by `MAX_TITLE_EVENT_TIMES`.
 */
export function titleEventTimes(
	title: Title,
	fps: number,
	timing: TitleTiming = titleTimingOf(title)
): number[] {
	const { start, end, inEnd, outStart } = timing;
	const span = end - start;
	const frameStep = 2 / Math.max(1, fps);
	const smoothStep = Math.max(frameStep, span / (MAX_TITLE_EVENT_TIMES / 2));
	const times = [
		start,
		end,
		inEnd,
		outStart,
		start + timing.fadeIn,
		end - timing.fadeOut,
	];
	const inSpan = inEnd - start;
	const outSpan = end - outStart;
	const curveIn =
		timing.animationIn === "bounce"
			? BOUNCE_IN
			: (SCALE_IN[timing.animationIn] ?? LINEAR);
	for (const [p] of curveIn) {
		times.push(start + p * inSpan);
	}
	for (const [p] of SCALE_OUT[timing.animationOut] ?? LINEAR) {
		times.push(outStart + p * outSpan);
	}
	const layout = titleLayout(title.text);
	if (timing.animationIn === "typewriter") {
		for (let index = 1; index < layout.count; index++) {
			times.push(start + (inSpan * index) / layout.count);
		}
	}
	if (
		timing.animationIn === "word-reveal" ||
		timing.animationIn === "word-slide"
	) {
		for (let word = 1; word < layout.words; word++) {
			times.push(start + (inSpan * word) / layout.words);
		}
	}
	if (timing.animationIn === "word-slide") {
		pushRange(times, start, inEnd, Math.max(frameStep, inSpan / 24));
	}
	if (
		timing.animationIn === "word-highlight" ||
		timing.animationIn === "word-highlight-block"
	) {
		for (let word = 1; word < layout.words; word++) {
			times.push(start + ((outStart - start) * word) / layout.words);
		}
	}
	if (timing.animationIn === "wave") {
		pushRange(times, start, inEnd, Math.max(frameStep, inSpan / 24));
	}
	const period = loopPeriod(timing.animationLoop);
	if (period > 0) {
		pushRange(
			times,
			inEnd,
			outStart,
			Math.max(period / LOOP_SAMPLES, smoothStep)
		);
	}
	for (const property of TITLE_KEY_PROPERTIES) {
		const track = keyTrack(title, property);
		track.forEach((key, index) => {
			times.push(start + key.time);
			const next = track[index + 1];
			const curved =
				key.interpolation !== undefined &&
				key.interpolation !== "linear" &&
				key.interpolation !== "hold";
			if (next && curved) {
				pushRange(times, start + key.time, start + next.time, smoothStep);
			}
		});
	}
	// Style channels animate inside each ASS event with `\\t` (libass
	// interpolates every frame), so a linear interval needs only its keys and
	// an eased one `STYLE_EASE_PIECES` pieces, each fitted with its own
	// acceleration. Only box geometry a drawing cannot animate (a rounded
	// box) is still cut into smooth steps.
	const sampled = sampledStyleChannels(title);
	for (const property of [
		...titleStyleKeyframeProperties,
		...titleColorKeyframeProperties,
	]) {
		const keys = channelKeys(title, property);
		const geometry = sampled.has(property);
		keys.forEach((key, index) => {
			times.push(start + key.time);
			const next = keys[index + 1];
			if (geometry && index === 0 && key.time > 0) {
				// The static value eases linearly into the first keyframe.
				pushRange(times, start, start + key.time, smoothStep);
			}
			if (!next || key.interpolation === "hold") {
				return;
			}
			const span = next.time - key.time;
			if (geometry) {
				pushRange(times, start + key.time, start + next.time, smoothStep);
			} else if (easedInterpolation(key.interpolation)) {
				pushRange(
					times,
					start + key.time,
					start + next.time,
					Math.max(frameStep / 2, span / STYLE_EASE_PIECES)
				);
			}
		});
	}
	const rounded = [
		...new Set(
			times
				.filter((time) => Number.isFinite(time))
				.map((time) => Math.round(Math.min(end, Math.max(start, time)) * 100))
		),
	].sort((a, b) => a - b);
	return thin(rounded, MAX_TITLE_EVENT_TIMES).map((cs) => cs / 100);
}

/** Keep at most `limit` boundaries, always keeping the first and last. */
export function thin(values: number[], limit: number): number[] {
	if (values.length <= limit) {
		return values;
	}
	const stride = (values.length - 1) / (limit - 1);
	return [
		...new Set(
			Array.from(
				{ length: limit },
				(_, index) => values[Math.round(index * stride)] as number
			)
		),
	];
}

/** What one event interval of a title costs in ASS output. */
export interface TitleEventCost {
	/** Extra dialogue lines per interval (background boxes). */
	boxChars: number;
	boxLines: number;
	/** Text passes per interval: 1, or 2 with a soft shadow. */
	passes: number;
}

/** How a title's events are cut: glyphs per moving group, and boundaries. */
export interface TitleEventPlan {
	/**
	 * Adjacent non-space glyphs that move together as one event. 1 is exact
	 * per-glyph motion; long titles group glyphs to stay inside the budget.
	 */
	glyphGroup: number;
	times: number[];
}

const isSpace = (glyph: TitleGlyph) => /\s/.test(glyph.char);

/**
 * `row` partitioned into consecutive groups of `size` non-space glyphs. Spaces
 * join the group before them (leading spaces join the first group), so
 * underlines and strikes stay continuous; a blank row has no groups.
 */
export function glyphGroups(
	row: readonly TitleGlyph[],
	size: number
): TitleGlyph[][] {
	const step = Math.max(1, Math.floor(size));
	const groups: TitleGlyph[][] = [];
	let pending: TitleGlyph[] = [];
	let moving = 0;
	for (const glyph of row) {
		if (!isSpace(glyph) && moving === step) {
			groups.push(pending);
			pending = [];
			moving = 0;
		}
		pending.push(glyph);
		if (!isSpace(glyph)) {
			moving++;
		}
	}
	if (moving > 0) {
		groups.push(pending);
	} else if (groups.length > 0) {
		groups.at(-1)?.push(...pending);
	}
	return groups;
}

/** The glyph a group moves with: its middle non-space glyph. */
export function groupLead(group: readonly TitleGlyph[]): TitleGlyph | null {
	const moving = group.filter((glyph) => !isSpace(glyph));
	return moving[Math.floor((moving.length - 1) / 2)] ?? null;
}

/** Override-tag characters one moving group adds to its row text. */
const GROUP_TAG_CHARS = 64;

function intervalCost(
	layout: TitleLayout,
	glyphMotion: boolean,
	group: number,
	cost: TitleEventCost
): { chars: number; lines: number } {
	let lines = cost.boxLines;
	let chars = cost.boxChars;
	for (const row of layout.rows) {
		if (row.length === 0) {
			continue;
		}
		const units = glyphMotion ? glyphGroups(row, group).length : 1;
		lines += units * cost.passes;
		chars += units * (row.length + GROUP_TAG_CHARS) * cost.passes;
	}
	return { chars, lines };
}

/**
 * Bound a title's ASS output to `MAX_TITLE_EVENTS` lines and
 * `MAX_TITLE_EVENT_CHARS` characters. Per-glyph motion first groups adjacent
 * glyphs (smallest group that fits); if even whole rows do not fit, the event
 * boundaries are thinned evenly. Deterministic for the same inputs.
 */
export function planTitleEvents(
	layout: TitleLayout,
	times: readonly number[],
	glyphMotion: boolean,
	cost: TitleEventCost
): TitleEventPlan {
	const intervals = Math.max(1, times.length - 1);
	const fits = (group: number) => {
		const each = intervalCost(layout, glyphMotion, group, cost);
		return (
			each.lines * intervals <= MAX_TITLE_EVENTS &&
			each.chars * intervals <= MAX_TITLE_EVENT_CHARS
		);
	};
	const widest = Math.max(1, ...layout.rows.map((row) => row.length));
	let glyphGroup = 1;
	if (glyphMotion && !fits(1)) {
		let low = 2;
		let high = widest;
		glyphGroup = widest;
		while (low <= high) {
			const middle = Math.floor((low + high) / 2);
			if (fits(middle)) {
				glyphGroup = middle;
				high = middle - 1;
			} else {
				low = middle + 1;
			}
		}
	}
	if (fits(glyphGroup)) {
		return { glyphGroup, times: [...times] };
	}
	const each = intervalCost(layout, glyphMotion, glyphGroup, cost);
	const allowed = Math.max(
		1,
		Math.min(
			Math.floor(MAX_TITLE_EVENTS / Math.max(1, each.lines)),
			Math.floor(MAX_TITLE_EVENT_CHARS / Math.max(1, each.chars))
		)
	);
	return { glyphGroup, times: thin([...times], allowed + 1) };
}
