/**
 * Pure timeline zoom and ruler math: the zoom range and its logarithmic
 * slider mapping, wheel and keyboard zoom steps, the scroll position that
 * keeps a time fixed under the pointer, zoom-to-fit, and adaptive ruler
 * ticks. Nothing here touches the DOM.
 */

/** Narrowest timeline zoom, in pixels per second. */
export const MIN_ZOOM_PX_PER_SEC = 5;
/** Widest timeline zoom, in pixels per second. */
export const MAX_ZOOM_PX_PER_SEC = 600;
/** One keyboard zoom step (`+`/`-`) multiplies or divides by this. */
export const ZOOM_STEP_FACTOR = 1.25;
/** Wheel zoom sensitivity: zoom scales by `exp(-deltaPx * this)`. */
const WHEEL_ZOOM_SENSITIVITY = 0.002;
/** Line-mode wheel deltas are converted at this many pixels per line. */
const WHEEL_LINE_PX = 16;
/** Page-mode wheel deltas are converted at this many pixels per page. */
const WHEEL_PAGE_PX = 800;
/** A single wheel event never zooms by more than this factor either way. */
const MAX_WHEEL_FACTOR = 2;

export function clampZoom(zoom: number): number {
	if (!Number.isFinite(zoom)) {
		return MIN_ZOOM_PX_PER_SEC;
	}
	return Math.min(MAX_ZOOM_PX_PER_SEC, Math.max(MIN_ZOOM_PX_PER_SEC, zoom));
}

const LOG_MIN = Math.log(MIN_ZOOM_PX_PER_SEC);
const LOG_SPAN = Math.log(MAX_ZOOM_PX_PER_SEC) - LOG_MIN;

/** Slider position in 0..1 for a zoom (logarithmic, so each step feels even). */
export function zoomToSlider(zoom: number): number {
	return (Math.log(clampZoom(zoom)) - LOG_MIN) / LOG_SPAN;
}

/** Zoom for a slider position in 0..1, rounded to 0.01 px/s. */
export function sliderToZoom(position: number): number {
	const clamped = Math.min(
		1,
		Math.max(0, Number.isFinite(position) ? position : 0)
	);
	return clampZoom(
		Math.round(Math.exp(LOG_MIN + clamped * LOG_SPAN) * 100) / 100
	);
}

/** One keyboard zoom step in (`1`) or out (`-1`). */
export function stepZoom(zoom: number, direction: 1 | -1): number {
	const next =
		direction > 0 ? zoom * ZOOM_STEP_FACTOR : zoom / ZOOM_STEP_FACTOR;
	return clampZoom(Math.round(next * 100) / 100);
}

/** `WheelEvent.deltaMode` values. */
export const WHEEL_DELTA_PIXEL = 0;
export const WHEEL_DELTA_LINE = 1;
export const WHEEL_DELTA_PAGE = 2;

/** A wheel delta converted to pixels. */
export function wheelDeltaPx(delta: number, deltaMode: number): number {
	if (deltaMode === WHEEL_DELTA_LINE) {
		return delta * WHEEL_LINE_PX;
	}
	if (deltaMode === WHEEL_DELTA_PAGE) {
		return delta * WHEEL_PAGE_PX;
	}
	return delta;
}

/**
 * Zoom after one wheel or trackpad-pinch event. Scrolling up (negative
 * `deltaY`) zooms in. Pinch arrives as a `ctrlKey` wheel with small deltas,
 * so the same exponential curve handles both smoothly.
 */
export function wheelZoom(
	zoom: number,
	deltaY: number,
	deltaMode = WHEEL_DELTA_PIXEL
): number {
	const raw = Math.exp(
		-wheelDeltaPx(deltaY, deltaMode) * WHEEL_ZOOM_SENSITIVITY
	);
	const factor = Math.min(
		MAX_WHEEL_FACTOR,
		Math.max(1 / MAX_WHEEL_FACTOR, raw)
	);
	return clampZoom(Math.round(zoom * factor * 100) / 100);
}

/**
 * The horizontal scroll offset that shows timeline time `anchorTime` at
 * `viewportX` pixels from the scroll viewport's left edge, at `zoom`.
 * `lanesOffset` is where time 0 sits inside the scrolled content (track
 * header gutter plus padding). Never negative.
 */
export function anchoredScrollLeft({
	anchorTime,
	lanesOffset,
	viewportX,
	zoom,
}: {
	anchorTime: number;
	lanesOffset: number;
	viewportX: number;
	zoom: number;
}): number {
	return Math.max(0, anchorTime * zoom + lanesOffset - viewportX);
}

/** Timeline time at `viewportX` pixels into the scroll viewport. */
export function timeAtViewportX({
	lanesOffset,
	scrollLeft,
	viewportX,
	zoom,
}: {
	lanesOffset: number;
	scrollLeft: number;
	viewportX: number;
	zoom: number;
}): number {
	return Math.max(0, (viewportX + scrollLeft - lanesOffset) / zoom);
}

/** Zoom that fits `duration` seconds into `laneWidth` pixels (with a 5% margin). */
export function fitZoom(duration: number, laneWidth: number): number {
	if (!(duration > 0 && laneWidth > 0)) {
		return clampZoom(laneWidth > 0 ? laneWidth / 10 : MIN_ZOOM_PX_PER_SEC);
	}
	return clampZoom(Math.floor((laneWidth / (duration * 1.05)) * 100) / 100);
}

/** Tick intervals in whole seconds, used once a frame is too narrow to label. */
const SECOND_INTERVALS = [
	1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
] as const;
/** Frame-count intervals used while frames are wide enough to label. */
const FRAME_INTERVALS = [1, 2, 5, 10] as const;
/** Labels need at least this much room between them. */
export const MIN_LABEL_SPACING_PX = 72;
/** Minor ticks closer than this are dropped. */
const MIN_MINOR_SPACING_PX = 6;
/** Most ticks one ruler pass generates, however wide the window. */
export const MAX_RULER_TICKS = 4000;

export interface RulerScale {
	/** Seconds between labelled major ticks. */
	major: number;
	/** Seconds between minor ticks (equals `major` when there are none). */
	minor: number;
	/** Minor ticks per major tick. */
	subdivisions: number;
	/** Major ticks below one second are labelled with frames. */
	unit: "frames" | "seconds";
}

/** Minor subdivisions tried for each major interval, finest first. */
const SUBDIVISIONS = [10, 5, 4, 2] as const;

function withMinor(
	major: number,
	zoom: number,
	unit: RulerScale["unit"],
	frameCount?: number
): RulerScale {
	for (const subdivisions of SUBDIVISIONS) {
		// Frame majors only subdivide into whole frames.
		if (frameCount !== undefined && frameCount % subdivisions !== 0) {
			continue;
		}
		if ((major / subdivisions) * zoom >= MIN_MINOR_SPACING_PX) {
			return { major, minor: major / subdivisions, subdivisions, unit };
		}
	}
	return { major, minor: major, subdivisions: 1, unit };
}

/**
 * The ruler's tick spacing at `zoom` px/s: the finest interval whose labels
 * stay at least `MIN_LABEL_SPACING_PX` apart, preferring frame intervals
 * while a frame is wide, then whole seconds.
 */
export function rulerScale(zoom: number, fps: number): RulerScale {
	const safeZoom = clampZoom(zoom);
	const frame = fps > 0 ? 1 / fps : 1 / 30;
	for (const frames of FRAME_INTERVALS) {
		const major = frames * frame;
		if (major < 1 && major * safeZoom >= MIN_LABEL_SPACING_PX) {
			return withMinor(major, safeZoom, "frames", frames);
		}
	}
	for (const seconds of SECOND_INTERVALS) {
		if (seconds * safeZoom >= MIN_LABEL_SPACING_PX) {
			return withMinor(seconds, safeZoom, "seconds");
		}
	}
	return withMinor(3600, safeZoom, "seconds");
}

export interface RulerTick {
	label?: string;
	major: boolean;
	/** Seconds from the timeline start. */
	time: number;
	/** Pixels from the timeline start (`time * zoom`). */
	x: number;
}

/** `m:ss`, `h:mm:ss`, or `m:ss:ff` (frames) ruler label. */
export function rulerLabel(
	time: number,
	unit: RulerScale["unit"],
	fps: number
): string {
	const nominal = Math.max(1, Math.round(fps));
	const totalFrames = Math.round(time * fps);
	const wholeSeconds =
		unit === "frames" ? Math.floor(totalFrames / nominal) : Math.round(time);
	const hours = Math.floor(wholeSeconds / 3600);
	const minutes = Math.floor((wholeSeconds % 3600) / 60);
	const seconds = wholeSeconds % 60;
	const pad = (value: number) => String(value).padStart(2, "0");
	const base = hours
		? `${hours}:${pad(minutes)}:${pad(seconds)}`
		: `${minutes}:${pad(seconds)}`;
	return unit === "frames" ? `${base}:${pad(totalFrames % nominal)}` : base;
}

/**
 * Ticks for the visible window `[startTime, endTime]` seconds. Ticks are
 * generated from integer indices, so they never drift, and the count is
 * capped at `MAX_RULER_TICKS`.
 */
export function rulerTicks({
	endTime,
	fps,
	startTime,
	zoom,
}: {
	endTime: number;
	fps: number;
	startTime: number;
	zoom: number;
}): { scale: RulerScale; ticks: RulerTick[] } {
	const scale = rulerScale(zoom, fps);
	const ticks: RulerTick[] = [];
	if (!(endTime > startTime)) {
		return { scale, ticks };
	}
	const first = Math.max(0, Math.floor(startTime / scale.minor));
	const last = Math.ceil(endTime / scale.minor);
	const end = Math.min(last, first + MAX_RULER_TICKS - 1);
	for (let index = first; index <= end; index += 1) {
		const time = index * scale.minor;
		const major = index % scale.subdivisions === 0;
		ticks.push({
			label: major ? rulerLabel(time, scale.unit, fps) : undefined,
			major,
			time,
			x: time * zoom,
		});
	}
	return { scale, ticks };
}
