import {
	fpsRational,
	nominalFrameRate,
	rationalFrameTime,
	timeToFrames,
} from "./frame-rate.ts";
import {
	type Asset,
	type Project,
	type Segment,
	segmentDuration,
} from "./project.ts";
import {
	clipSourceOffset,
	clipTimeAtSourceOffset,
	hasSpeedCurve,
	normalizedCurvePoints,
} from "./speed-curve.ts";

export const xml = (value: string | number | undefined): string =>
	String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");

export const decimal = (value: number) => Number(value.toFixed(6)).toString();
export const frameCount = (seconds: number, fps: number) =>
	timeToFrames(seconds, fps);

/** Frames the media covers; a partial last frame still counts as a frame. */
export const assetFrames = (asset: Asset, fps: number) =>
	timeToFrames(asset.duration, fps, "ceil");

export interface ClipFrames {
	/** Timeline frames: `end - start`, so adjacent clips never gap or overlap. */
	duration: number;
	/** Timeline frame the clip ends on (exclusive). */
	end: number;
	/**
	 * Clip-local frames trimmed off the head when a reveal transition butts
	 * the clip at its cut (0 otherwise). A speed curve keeps its own clock, so
	 * clip frame `t` plays curve frame `t + headShift`.
	 */
	headShift: number;
	/** First source frame. */
	in: number;
	/** Source frame (fractional) the clip's speed curve starts from. */
	origin: number;
	/** Source frame after the last one used (exclusive). */
	out: number;
	/** Timeline frame the clip starts on. */
	start: number;
}

/**
 * Snap a clip to the frame grid by its absolute boundaries and derive every
 * duration from them, so `start + duration` is the next clip's `start` and
 * `out - in` matches the clip duration (times speed). A source range that
 * would run past the media's last frame is slid back inside it.
 */
export function clipFrames(
	segment: Segment,
	asset: Asset,
	fps: number
): ClipFrames {
	const start = frameCount(segment.start, fps);
	const end = Math.max(
		start,
		frameCount(segment.start + segmentDuration(segment), fps)
	);
	const duration = end - start;
	const span = Math.round(duration * segment.speed);
	let sourceIn = frameCount(segment.sourceIn, fps);
	let sourceOut = sourceIn + span;
	if (asset.kind !== "image") {
		const limit = assetFrames(asset, fps);
		if (sourceOut > limit) {
			sourceIn = Math.max(0, limit - span);
			sourceOut = Math.min(limit, sourceIn + span);
		}
	}
	return {
		duration,
		end,
		headShift: 0,
		in: sourceIn,
		origin: sourceIn,
		out: sourceOut,
		start,
	};
}
/** Clip frames between sampled time-remap points of a speed-curved clip. */
export const CURVE_SAMPLE_FRAMES = 4;
/** Most time-remap points one curved clip writes. */
export const MAX_CURVE_REMAP_POINTS = 240;

/** One point of a clip's time remap: clip-local frames to source frames. */
export interface RemapPoint {
	/** Whether the point is a curve knot (otherwise an in-between sample). */
	knot: boolean;
	/** Source frame (fractional), on the asset's clock. */
	source: number;
	/** Clip-local timeline frame. */
	time: number;
}

/**
 * A curved clip's time remap on the export's frame grid: one point per curve
 * knot (at its nearest frame) plus samples every `CURVE_SAMPLE_FRAMES` frames between them (fewer
 * on long clips, at most `MAX_CURVE_REMAP_POINTS`), from the clip's first to
 * its last frame. Source frames follow the exact curve mapping from the
 * curve's origin, offset by any head trim (a reveal-transition cut), so knots
 * keep their source moments; the last point is the clip's exported out point.
 */
export function curveRemapPoints(
	segment: Segment,
	frames: Pick<ClipFrames, "duration" | "in" | "out"> &
		Partial<Pick<ClipFrames, "headShift" | "origin">>,
	fps: number
): RemapPoint[] {
	if (!hasSpeedCurve(segment) || frames.duration <= 0) {
		return [];
	}
	const headShift = frames.headShift ?? 0;
	const origin = frames.origin ?? frames.in;
	const sourceSeconds = segment.sourceOut - segment.sourceIn;
	// Exact curve mapping on the curve's own clock: clip frame `t` is curve
	// frame `t + headShift`. The last point lands on the exported out point
	// (the clip snaps to whole frames).
	const sourceAt = (clipFrame: number) =>
		Math.min(
			frames.out,
			origin + clipSourceOffset(segment, (clipFrame + headShift) / fps) * fps
		);
	const knots = normalizedCurvePoints(segment.speedCurve.points)
		.map(
			(point) =>
				clipTimeAtSourceOffset(segment, point.t * sourceSeconds) * fps -
				headShift
		)
		// Knots a cut trimmed away are not part of this clip's remap.
		.filter((knot) => knot >= -0.5 && knot <= frames.duration + 0.5)
		.map((knot) => Math.min(frames.duration, Math.max(0, knot)));
	const step = Math.max(
		CURVE_SAMPLE_FRAMES,
		Math.ceil(frames.duration / (MAX_CURVE_REMAP_POINTS - knots.length))
	);
	const times = new Map<number, boolean>();
	for (let frame = 0; frame < frames.duration; frame += step) {
		times.set(frame, false);
	}
	times.set(frames.duration, false);
	// Knots snap to the frame grid, like every other interchange time.
	for (const knot of knots) {
		times.set(Math.round(knot), true);
	}
	return [...times.entries()]
		.sort(([a], [b]) => a - b)
		.map(([time, knot]) => ({
			knot,
			source: time >= frames.duration ? frames.out : sourceAt(time),
			time,
		}));
}

/**
 * XMEML `<rate>`: the whole-number timebase plus the NTSC flag, so 29.97 is
 * `<timebase>30</timebase><ntsc>TRUE</ntsc>`.
 */
export const xmemlRate = (fps: number) =>
	`<rate><timebase>${nominalFrameRate(fps)}</timebase><ntsc>${fpsRational(fps).ntsc ? "TRUE" : "FALSE"}</ntsc></rate>`;
/**
 * FCPXML time. Integer rates keep decimal seconds; NTSC rates use
 * frame-aligned rationals (`3003/30000s`) because their frame boundaries are
 * not representable as short decimals.
 */
export const fcpxmlTime = (seconds: number, fps: number) =>
	fpsRational(fps).ntsc
		? rationalFrameTime(frameCount(seconds, fps), fps)
		: `${decimal(seconds)}s`;
export const fcpxmlFrameDuration = (fps: number) => {
	const { den, num } = fpsRational(fps);
	return `${den}/${num}s`;
};
export const assetSource = (asset: Asset) =>
	`ryu://video-studio/assets/${encodeURIComponent(asset.id)}`;

export function referencedAssets(
	project: Project,
	assets: readonly Asset[]
): Asset[] {
	const available = new Map(assets.map((asset) => [asset.id, asset]));
	const seen = new Set<string>();
	const result: Asset[] = [];
	for (const segment of project.segments) {
		if (seen.has(segment.assetId)) {
			continue;
		}
		const asset = available.get(segment.assetId);
		if (asset) {
			seen.add(asset.id);
			result.push(asset);
		}
	}
	return result;
}

/** One reveal transition between a predecessor and the clip it reveals, on one track. */
export interface CutTransition {
	/** Timeline frame of the edit point (the middle of the overlap). */
	cut: number;
	/** Frames of the transition, centred on `cut`. */
	frames: number;
	/** The incoming clip. */
	incoming: Segment;
	/** The predecessor the incoming clip plays over. */
	outgoing: Segment;
}

/**
 * Reveal transitions (`transitionIn`) as centred dissolves at a cut. Video
 * Studio overlaps the incoming clip with its predecessor for the whole
 * transition; interchange formats want butted clips with handles, so the
 * cut sits in the middle of the overlap and each clip keeps half the
 * overlap as its handle.
 */
export function cutTransitions(project: Project): Map<string, CutTransition> {
	const result = new Map<string, CutTransition>();
	for (const segment of project.segments) {
		const reveal = segment.transitionIn;
		if (!reveal) {
			continue;
		}
		const outgoing = project.segments
			.filter(
				(other) =>
					other.id !== segment.id &&
					other.track === segment.track &&
					other.start < segment.start &&
					other.start + segmentDuration(other) >=
						segment.start + reveal.duration - 1e-6
			)
			.sort((a, b) => b.start - a.start)[0];
		if (!outgoing) {
			continue;
		}
		const frames = Math.max(1, frameCount(reveal.duration, project.fps));
		result.set(segment.id, {
			cut: frameCount(segment.start + reveal.duration / 2, project.fps),
			frames,
			incoming: segment,
			outgoing,
		});
	}
	return result;
}

/**
 * Clip frames after butting reveal-transition overlaps at their cut: the
 * outgoing clip ends at the cut and the incoming one starts there, with its
 * source in point moved by the same amount.
 */
export function buttedFrames(
	segment: Segment,
	asset: Asset,
	fps: number,
	cuts: Map<string, CutTransition>
): ClipFrames {
	const frames = clipFrames(segment, asset, fps);
	const incoming = cuts.get(segment.id);
	const outgoing = [...cuts.values()].find(
		(cut) => cut.outgoing.id === segment.id
	);
	const curved = hasSpeedCurve(segment);
	// Source frames `clipFrame` frames into the untrimmed clip: the curve's
	// exact mapping for a curved clip, the constant speed otherwise.
	const sourceAfter = (clipFrame: number) =>
		curved
			? Math.round(
					frames.origin + clipSourceOffset(segment, clipFrame / fps) * fps
				)
			: null;
	let { end, headShift, in: sourceIn, out, start } = frames;
	if (incoming && incoming.cut > start) {
		const shift = incoming.cut - start;
		start = incoming.cut;
		headShift = shift;
		sourceIn =
			sourceAfter(shift) ?? sourceIn + Math.round(shift * segment.speed);
	}
	if (outgoing && outgoing.cut < end) {
		const trim = end - outgoing.cut;
		end = outgoing.cut;
		out =
			sourceAfter(outgoing.cut - frames.start) ??
			out - Math.round(trim * segment.speed);
	}
	return {
		duration: end - start,
		end,
		headShift,
		in: sourceIn,
		origin: frames.origin,
		out,
		start,
	};
}
