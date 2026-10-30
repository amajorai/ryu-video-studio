/**
 * Continuous speed curves (time remapping). A curved clip stays one clip: its
 * `speed` is the average speed, so `segmentDuration` is unchanged, and its
 * `speedCurve` shapes how that duration is spread over the source. The render
 * (`setpts` for video, a commanded `atempo` chain for audio), the preview and
 * every edit that maps clip time to source time read the mapping from here.
 */
import type { Segment } from "./project.ts";
import {
	MAX_CURVE_SPEED,
	MIN_CURVE_SPEED,
	type SpeedCurve,
	type SpeedCurvePoint,
} from "./schema/speed-curve.ts";

const EPSILON = 1e-9;

type CurvedClip = Pick<
	Segment,
	"sourceIn" | "sourceOut" | "speed" | "speedCurve"
>;

/** One linear stretch of a curve over source fractions `[from, to]`. */
interface CurveSpan {
	from: number;
	to: number;
	v0: number;
	v1: number;
}

const clampCurveSpeed = (speed: number) =>
	Math.max(MIN_CURVE_SPEED, Math.min(MAX_CURVE_SPEED, speed));

/** Sorted points with holds added so the curve covers the whole source range. */
export function normalizedCurvePoints(
	points: readonly SpeedCurvePoint[]
): SpeedCurvePoint[] {
	const sorted = [...points]
		.map((point) => ({ speed: clampCurveSpeed(point.speed), t: point.t }))
		.sort((a, b) => a.t - b.t);
	const first = sorted[0];
	const last = sorted.at(-1);
	if (!(first && last && sorted.length >= 2)) {
		throw new Error("A speed curve needs at least two points.");
	}
	if (first.t > 0) {
		sorted.unshift({ speed: first.speed, t: 0 });
	}
	if (last.t < 1) {
		sorted.push({ speed: last.speed, t: 1 });
	}
	return sorted;
}

function spans(points: readonly SpeedCurvePoint[]): CurveSpan[] {
	const normalized = normalizedCurvePoints(points);
	const result: CurveSpan[] = [];
	for (let index = 1; index < normalized.length; index++) {
		const previous = normalized[index - 1];
		const next = normalized[index];
		if (previous && next && next.t - previous.t > EPSILON) {
			result.push({
				from: previous.t,
				to: next.t,
				v0: previous.speed,
				v1: next.speed,
			});
		}
	}
	return result;
}

/** Curve speed at source fraction `t` (linear between points, held outside). */
export function curveSpeedAt(
	points: readonly SpeedCurvePoint[],
	t: number
): number {
	for (const span of spans(points)) {
		if (t <= span.to + EPSILON) {
			const fraction = Math.max(0, (t - span.from) / (span.to - span.from));
			return span.v0 + (span.v1 - span.v0) * Math.min(1, fraction);
		}
	}
	return normalizedCurvePoints(points).at(-1)?.speed ?? 1;
}

/** `∫ du / v(u)` over `[span.from, u]`: the exact integral of a linear speed. */
function spanTime(span: CurveSpan, u: number): number {
	const width = span.to - span.from;
	const along = Math.min(width, Math.max(0, u - span.from));
	const slope = (span.v1 - span.v0) / width;
	if (Math.abs(slope) < EPSILON) {
		return along / span.v0;
	}
	return Math.log((span.v0 + slope * along) / span.v0) / slope;
}

/** Inverse of `spanTime`: the source fraction reached `time` into the span. */
function spanFraction(span: CurveSpan, time: number): number {
	const width = span.to - span.from;
	const slope = (span.v1 - span.v0) / width;
	if (Math.abs(slope) < EPSILON) {
		return span.from + Math.min(width, time * span.v0);
	}
	const speed = span.v0 * Math.exp(time * slope);
	return span.from + Math.min(width, Math.max(0, (speed - span.v0) / slope));
}

/**
 * Timeline seconds per source second when the curve plays at its own speeds:
 * `∫₀¹ du / v(u)`. A clip honours the curve's speeds exactly when its average
 * speed is `1 / curveUnitDuration`.
 */
export function curveUnitDuration(points: readonly SpeedCurvePoint[]): number {
	return spans(points).reduce(
		(total, span) => total + spanTime(span, span.to),
		0
	);
}

/** The average clip speed at which every curve point plays at its own speed. */
export function naturalCurveSpeed(points: readonly SpeedCurvePoint[]): number {
	return 1 / curveUnitDuration(points);
}

const sourceSeconds = (segment: CurvedClip) =>
	segment.sourceOut - segment.sourceIn;
const clipSeconds = (segment: CurvedClip) =>
	sourceSeconds(segment) / segment.speed;

/** Whether the clip plays a continuous speed curve. */
export function hasSpeedCurve(
	segment: Pick<Segment, "speedCurve">
): segment is Pick<Segment, "speedCurve"> & { speedCurve: SpeedCurve } {
	return (segment.speedCurve?.points.length ?? 0) >= 2;
}

/** Source fraction reached at curve-normalized time `tau` (0..unit duration). */
function fractionAtUnitTime(
	points: readonly SpeedCurvePoint[],
	tau: number
): number {
	let elapsed = 0;
	for (const span of spans(points)) {
		const length = spanTime(span, span.to);
		if (tau <= elapsed + length + EPSILON) {
			return spanFraction(span, Math.max(0, tau - elapsed));
		}
		elapsed += length;
	}
	return 1;
}

/** Curve-normalized time at source fraction `u`. */
function unitTimeAtFraction(
	points: readonly SpeedCurvePoint[],
	u: number
): number {
	let elapsed = 0;
	for (const span of spans(points)) {
		if (u <= span.to + EPSILON) {
			return elapsed + spanTime(span, u);
		}
		elapsed += spanTime(span, span.to);
	}
	return elapsed;
}

/**
 * Source seconds past `sourceIn` played by `clipTime` timeline seconds into
 * the clip. Constant-speed clips give `clipTime × speed`; curved clips follow
 * the curve, scaled so the clip keeps its length.
 */
export function clipSourceOffset(
	segment: CurvedClip,
	clipTime: number
): number {
	const source = sourceSeconds(segment);
	const duration = clipSeconds(segment);
	const time = Math.max(0, Math.min(duration, clipTime));
	if (!hasSpeedCurve(segment)) {
		return Math.min(source, time * segment.speed);
	}
	const points = segment.speedCurve.points;
	const unit = curveUnitDuration(points);
	const fraction = fractionAtUnitTime(points, (time / duration) * unit);
	return Math.min(source, Math.max(0, fraction * source));
}

/** Clip seconds at which the clip reaches `sourceOffset` seconds past `sourceIn`. */
export function clipTimeAtSourceOffset(
	segment: CurvedClip,
	sourceOffset: number
): number {
	const source = sourceSeconds(segment);
	const offset = Math.max(0, Math.min(source, sourceOffset));
	if (!hasSpeedCurve(segment)) {
		return offset / segment.speed;
	}
	const points = segment.speedCurve.points;
	const unit = curveUnitDuration(points);
	return (
		(unitTimeAtFraction(points, source > 0 ? offset / source : 0) / unit) *
		clipSeconds(segment)
	);
}

/** Effective source speed `clipTime` seconds into the clip. */
export function clipSpeedAt(segment: CurvedClip, clipTime: number): number {
	if (!hasSpeedCurve(segment)) {
		return segment.speed;
	}
	const points = segment.speedCurve.points;
	const source = sourceSeconds(segment);
	const fraction =
		source > 0 ? clipSourceOffset(segment, clipTime) / source : 0;
	return (
		segment.speed * curveUnitDuration(points) * curveSpeedAt(points, fraction)
	);
}

/**
 * Effective source speed at `offset` source seconds past `sourceIn` (the
 * curve's speed there, scaled to the clip's average), clamped to the source.
 */
export function sourceSpeedAt(segment: CurvedClip, offset: number): number {
	if (!hasSpeedCurve(segment)) {
		return segment.speed;
	}
	const points = segment.speedCurve.points;
	const source = sourceSeconds(segment);
	const fraction = source > 0 ? Math.max(0, Math.min(1, offset / source)) : 0;
	return (
		segment.speed * curveUnitDuration(points) * curveSpeedAt(points, fraction)
	);
}

/** One linear stretch of a clip's curve in source and clip seconds. */
export interface CurveTimelinePiece {
	/** Source seconds past `sourceIn`. */
	sourceFrom: number;
	sourceTo: number;
	/** Effective speed at the piece's start and end. */
	speedFrom: number;
	speedTo: number;
	/** Clip seconds. */
	timeFrom: number;
	timeTo: number;
}

/** The clip's curve as pieces of exact source and clip time. */
export function curveTimeline(segment: CurvedClip): CurveTimelinePiece[] {
	if (!hasSpeedCurve(segment)) {
		const duration = clipSeconds(segment);
		return [
			{
				sourceFrom: 0,
				sourceTo: sourceSeconds(segment),
				speedFrom: segment.speed,
				speedTo: segment.speed,
				timeFrom: 0,
				timeTo: duration,
			},
		];
	}
	const points = segment.speedCurve.points;
	const unit = curveUnitDuration(points);
	const scale = segment.speed * unit;
	const source = sourceSeconds(segment);
	const duration = clipSeconds(segment);
	const pieces: CurveTimelinePiece[] = [];
	let elapsed = 0;
	for (const span of spans(points)) {
		const length = spanTime(span, span.to);
		pieces.push({
			sourceFrom: span.from * source,
			sourceTo: span.to * source,
			speedFrom: span.v0 * scale,
			speedTo: span.v1 * scale,
			timeFrom: (elapsed / unit) * duration,
			timeTo: ((elapsed + length) / unit) * duration,
		});
		elapsed += length;
	}
	return pieces;
}

const formatNumber = (value: number) => Number(value.toFixed(9)).toString();

/**
 * FFmpeg `setpts` expression (seconds in, timebase ticks out) mapping each
 * source frame, relative to the clip's first decoded frame, to its clip time
 * on the curve. Each piece uses the exact logarithmic integral of its linear
 * speed, so the video lands frame-accurately on the preview's mapping.
 */
export function speedCurveSetpts(segment: CurvedClip): string {
	const x = "ld(0)";
	const pieces = curveTimeline(segment);
	const last = pieces.at(-1);
	if (!last) {
		throw new Error("A speed curve needs at least two points.");
	}
	const pieceExpression = (piece: CurveTimelinePiece) => {
		const width = piece.sourceTo - piece.sourceFrom;
		const delta = piece.speedTo - piece.speedFrom;
		const start = formatNumber(piece.timeFrom);
		const from = formatNumber(piece.sourceFrom);
		if (Math.abs(delta) < EPSILON * Math.max(1, piece.speedFrom)) {
			return `${start}+(${x}-${from})/${formatNumber(piece.speedFrom)}`;
		}
		return `${start}+${formatNumber(width / delta)}*log(1+${formatNumber(delta / (width * piece.speedFrom))}*(${x}-${from}))`;
	};
	let expression = `${formatNumber(last.timeTo)}+(${x}-${formatNumber(last.sourceTo)})/${formatNumber(last.speedTo)}`;
	for (const piece of [...pieces].reverse()) {
		expression = `if(lt(${x},${formatNumber(piece.sourceTo)}),${pieceExpression(piece)},${expression})`;
	}
	return `setpts='st(0,(PTS-STARTPTS)*TB);(${expression})/TB'`;
}

/** Source seconds per audio tempo piece of a curved clip. */
export const CURVE_TEMPO_STEP_SECONDS = 0.25;
/** Most tempo pieces one clip's audio uses; longer clips take longer pieces. */
export const MAX_CURVE_TEMPO_STEPS = 64;
/** Working sample rate of a curved clip's audio, so pieces trim to exact samples. */
export const CURVE_SAMPLE_RATE = 48_000;
/** Source seconds each audio piece reads past its edges, trimmed after `atempo`. */
const CURVE_TEMPO_PREROLL = 0.1;

/** One audio tempo piece: source seconds past `sourceIn`, clip seconds and its exact average speed. */
export interface CurveTempoStep {
	at: number;
	/** Source seconds past `sourceIn` where the piece ends. */
	end: number;
	speed: number;
	/** Clip seconds where the piece starts and ends. */
	timeFrom: number;
	timeTo: number;
}

/**
 * The audio tempo plan of a curved clip: short source pieces, each played at
 * the exact average speed of its stretch of the curve (source length over the
 * clip time the video gives it), so audio and video meet at every boundary.
 */
export function curveTempoSteps(segment: CurvedClip): CurveTempoStep[] {
	const source = sourceSeconds(segment);
	const count = Math.max(
		1,
		Math.min(
			MAX_CURVE_TEMPO_STEPS,
			Math.ceil(source / CURVE_TEMPO_STEP_SECONDS)
		)
	);
	const steps: CurveTempoStep[] = [];
	let previousTime = 0;
	for (let index = 0; index < count; index++) {
		const from = (source * index) / count;
		const to = (source * (index + 1)) / count;
		const time = clipTimeAtSourceOffset(segment, to);
		const speed = (to - from) / Math.max(EPSILON, time - previousTime);
		steps.push({
			at: from,
			end: to,
			speed,
			timeFrom: previousTime,
			timeTo: time,
		});
		previousTime = time;
	}
	return steps;
}

/** `atempo` stages (each kept within 0.5x to 2x) for a constant `speed`. */
function tempoStages(speed: number): string[] {
	if (Math.abs(speed - 1) < 1e-6) {
		return [];
	}
	const stages = Math.max(1, Math.ceil(Math.abs(Math.log2(speed)) - EPSILON));
	const factor = formatNumber(speed ** (1 / stages));
	return Array.from({ length: stages }, () => `atempo=${factor}`);
}

/**
 * The FFmpeg statements that play a curved clip's audio on its curve, pitch
 * kept, from `input` into `output` (labels with brackets). The source is
 * split into pieces; each reads a little past its edges, runs `atempo` at
 * its exact average speed and is trimmed to the exact samples the curve
 * gives it, so every piece starts on the sample the video's remap puts its
 * source moment at, and the clip's audio is exactly as long as the clip.
 * `prefix` keeps the inner labels unique.
 */
export function speedCurveAudioGraph(
	segment: CurvedClip,
	input: string,
	output: string,
	prefix: string
): string[] {
	const steps = curveTempoSteps(segment);
	const rate = CURVE_SAMPLE_RATE;
	const labels = steps.map((_, index) => `[${prefix}p${index}]`);
	const statements = [
		`${input}asetpts=PTS-STARTPTS,aresample=${rate},asplit=${steps.length}${steps.map((_, index) => `[${prefix}s${index}]`).join("")}`,
	];
	for (const [index, step] of steps.entries()) {
		const readFrom = Math.max(0, step.at - CURVE_TEMPO_PREROLL);
		const lead = Math.round(((step.at - readFrom) / step.speed) * rate);
		const samples =
			Math.round(step.timeTo * rate) - Math.round(step.timeFrom * rate);
		statements.push(
			`[${prefix}s${index}]atrim=start=${formatNumber(readFrom)}:end=${formatNumber(step.end + CURVE_TEMPO_PREROLL)},asetpts=PTS-STARTPTS,${[...tempoStages(step.speed), "apad"].join(",")},atrim=start_sample=${lead}:end_sample=${lead + samples},asetpts=PTS-STARTPTS${labels[index]}`
		);
	}
	statements.push(
		`${labels.join("")}concat=n=${steps.length}:v=0:a=1${output}`
	);
	return statements;
}

/**
 * The points of `points` over source fractions `[from, to]`, rescaled to
 * 0..1 with boundary points interpolated, so a piece of a curved clip plays
 * exactly as that part of the original did.
 */
export function subCurvePoints(
	points: readonly SpeedCurvePoint[],
	from: number,
	to: number
): SpeedCurvePoint[] {
	const width = to - from;
	if (!(width > EPSILON)) {
		throw new Error("A speed curve piece needs a source range.");
	}
	const round = (value: number) => Number(value.toFixed(6));
	const inner = normalizedCurvePoints(points)
		.filter((point) => point.t > from + 1e-6 && point.t < to - 1e-6)
		.map((point) => ({
			speed: point.speed,
			t: round((point.t - from) / width),
		}));
	return [
		{ speed: round(curveSpeedAt(points, from)), t: 0 },
		...inner,
		{ speed: round(curveSpeedAt(points, to)), t: 1 },
	].map((point) => ({ ...point, speed: clampCurveSpeed(point.speed) }));
}

/**
 * The left and right halves of a curved clip cut `offset` clip seconds in:
 * each keeps its part of the curve and the average speed that gives it the
 * same clip time, so the halves play exactly as the whole clip did.
 */
export function splitSpeedCurve(
	segment: CurvedClip,
	offset: number
): {
	cut: number;
	left: Pick<Segment, "speed" | "speedCurve">;
	right: Pick<Segment, "speed" | "speedCurve">;
} {
	const source = sourceSeconds(segment);
	const duration = clipSeconds(segment);
	const cutOffset = clipSourceOffset(segment, offset);
	if (!hasSpeedCurve(segment)) {
		return {
			cut: segment.sourceIn + cutOffset,
			left: { speed: segment.speed },
			right: { speed: segment.speed },
		};
	}
	const fraction = cutOffset / source;
	const points = segment.speedCurve.points;
	const pitch =
		segment.speedCurve.preservePitch === false ? { preservePitch: false } : {};
	return {
		cut: segment.sourceIn + cutOffset,
		left: {
			speed: cutOffset / offset,
			speedCurve: { points: subCurvePoints(points, 0, fraction), ...pitch },
		},
		right: {
			speed: (source - cutOffset) / (duration - offset),
			speedCurve: { points: subCurvePoints(points, fraction, 1), ...pitch },
		},
	};
}
