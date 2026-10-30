/**
 * Clip speed, pitch and high-speed muting. The render tempo stage
 * (`sidecar/src/render-stages/audio-tempo.ts`), the preview tempo
 * (`ui/src/audio-preview/tempo.ts`) and the inspector speed controls all read
 * the same rules from here.
 */
import { audioTempoFilters, MAX_CLIP_SPEED, MIN_CLIP_SPEED } from "./audio.ts";
import type { Project, Segment } from "./project.ts";
import { preservePitchOf } from "./schema/defaults.ts";
import { hasSpeedCurve } from "./speed-curve.ts";

/** Above this speed a clip's audio is muted unless the clip opts back in. */
export const HIGH_SPEED_MUTE_ABOVE = 16;
/** Working rate for tape-style (pitch-shifting) speed changes. */
export const TAPE_SAMPLE_RATE = 48_000;

/** Quick choices offered by the inspector, in ascending order. */
export const SPEED_PRESETS = [0.1, 0.25, 0.5, 1, 1.5, 2, 4, 8, 16, 50, 100];

/** Shortest clip the project schema accepts, in timeline seconds. */
export const MIN_CLIP_DURATION = 0.04;

/** Clamp a requested speed to the schema range, rounded to 0.01x. */
export function clampClipSpeed(speed: number): number {
	if (!Number.isFinite(speed)) {
		return 1;
	}
	const bounded = Math.min(MAX_CLIP_SPEED, Math.max(MIN_CLIP_SPEED, speed));
	return Math.round(bounded * 100) / 100;
}

/**
 * Whether the clip's audio is silenced for speed. Clips faster than
 * `HIGH_SPEED_MUTE_ABOVE` are muted by default; `muted: false` keeps their
 * audio. `muted: false` only means "keep audio above 16x":
 * `withClipSpeed` clears it whenever a speed change crosses the threshold, so
 * a stale unmute from a slower speed never opts a clip out of the default.
 */
export function highSpeedMutedOf(
	segment: Pick<Segment, "muted" | "speed">
): boolean {
	return segment.speed > HIGH_SPEED_MUTE_ABOVE && segment.muted !== false;
}

/**
 * Whether the clip contributes no audio of its own: an explicit clip mute
 * (`muted: true`, at any speed) or the default high-speed mute.
 */
export function clipAudioMutedOf(
	segment: Pick<Segment, "muted" | "speed">
): boolean {
	return segment.muted === true || highSpeedMutedOf(segment);
}

/**
 * Tape-style speed: resample at a scaled rate so pitch follows speed.
 * `aresample` first pins the input rate, so the scaled rate is exact for any
 * source.
 */
export function tapeSpeedFilters(speed: number): string[] {
	if (
		!Number.isFinite(speed) ||
		speed < MIN_CLIP_SPEED ||
		speed > MAX_CLIP_SPEED
	) {
		throw new Error("Invalid audio speed.");
	}
	if (speed === 1) {
		return ["anull"];
	}
	return [
		`aresample=${TAPE_SAMPLE_RATE}`,
		`asetrate=${Math.round(TAPE_SAMPLE_RATE * speed)}`,
		`aresample=${TAPE_SAMPLE_RATE}`,
	];
}

/**
 * The clip's speed filters: `atempo` (pitch kept) by default, tape-style when
 * `preservePitch` is false, followed by `volume=0` when the clip is muted
 * (explicitly or for speed). A clip at 1x with default settings stays `anull`.
 */
export function clipTempoFilters(
	segment: Pick<Segment, "muted" | "preservePitch" | "speed"> &
		Partial<Pick<Segment, "speedCurve">>
): string[] {
	// A curve's tempo runs before this chain: its audio is rendered ahead
	// along the curve (`sidecar/src/varispeed.ts`, pitch kept or tape-style
	// by `speedCurve.preservePitch`), or kept-pitch `atempo` pieces
	// (`speedCurveAudioGraph`) when no rendered audio is supplied.
	if (hasSpeedCurve(segment)) {
		return clipAudioMutedOf(segment) ? ["anull", "volume=0"] : ["anull"];
	}
	const filters = preservePitchOf(segment)
		? audioTempoFilters(segment.speed)
		: tapeSpeedFilters(segment.speed);
	return clipAudioMutedOf(segment) ? [...filters, "volume=0"] : filters;
}

type SpeedLimitedClip = Pick<
	Segment,
	"exitDuration" | "fadeIn" | "fadeOut" | "keyframes" | "sourceIn" | "sourceOut"
>;

/**
 * Shortest timeline duration the clip can shrink to and still validate: the
 * schema minimum, its fades, its exit transition and its last keyframe.
 */
export function minimumClipDuration(segment: SpeedLimitedClip): number {
	let minimum = Math.max(
		MIN_CLIP_DURATION,
		segment.fadeIn + segment.fadeOut,
		segment.exitDuration ?? 0
	);
	for (const frame of segment.keyframes) {
		minimum = Math.max(minimum, frame.time);
	}
	return minimum;
}

/**
 * Fastest speed (0.01x steps, rounded down) that keeps the clip valid; never
 * below `MIN_CLIP_SPEED`.
 */
export function maxClipSpeedFor(segment: SpeedLimitedClip): number {
	const span = segment.sourceOut - segment.sourceIn;
	const limit = span / minimumClipDuration(segment);
	if (!Number.isFinite(limit)) {
		return MIN_CLIP_SPEED;
	}
	// Floor to 0.01x (with a guard against float error) so the clip stays valid.
	const floored = Math.floor(limit * 100 + 1e-9) / 100;
	return Math.min(MAX_CLIP_SPEED, Math.max(MIN_CLIP_SPEED, floored));
}

/** The clip and its link-group partners, which share one speed. */
export function speedGroupOf(
	project: Pick<Project, "segments">,
	segmentId: string
): Segment[] {
	const segment = project.segments.find((item) => item.id === segmentId);
	if (!segment) {
		return [];
	}
	if (!segment.linkGroupId) {
		return [segment];
	}
	return project.segments.filter(
		(item) => item.linkGroupId === segment.linkGroupId
	);
}

/** Fastest speed every member of the clip's link group accepts. */
export function maxGroupSpeedFor(
	project: Pick<Project, "segments">,
	segmentId: string
): number {
	let limit = MAX_CLIP_SPEED;
	for (const member of speedGroupOf(project, segmentId)) {
		limit = Math.min(limit, maxClipSpeedFor(member));
	}
	return limit;
}

export interface ClipSpeedChange<P> {
	/** True when the request was lowered to keep the clips valid. */
	limited: boolean;
	/** Link-group partners that followed the change. */
	partners: number;
	project: P;
	/** The speed actually applied. */
	speed: number;
}

/**
 * The clip's own fields after a speed change. A `muted: false` opt-in only
 * survives while the clip stays above the high-speed threshold.
 */
function withSpeed(curved: Segment, speed: number): Segment {
	// A constant speed replaces any speed curve.
	const { speedCurve: _curve, ...segment } = curved;
	const keepsOptIn =
		segment.speed > HIGH_SPEED_MUTE_ABOVE && speed > HIGH_SPEED_MUTE_ABOVE;
	if (segment.muted === false && !keepsOptIn) {
		const { muted: _staleOptIn, ...rest } = segment;
		return { ...rest, speed };
	}
	return { ...segment, speed };
}

/**
 * Set a clip's speed, clamped to the schema range and to what keeps the clip
 * and its link-group partners valid; partners follow so linked audio and
 * video stay in sync. Returns null when the clip does not exist or nothing
 * would change.
 */
export function withClipSpeed<P extends Pick<Project, "segments">>(
	project: P,
	segmentId: string,
	requested: number
): ClipSpeedChange<P> | null {
	const group = speedGroupOf(project, segmentId);
	if (group.length === 0) {
		return null;
	}
	const wanted = clampClipSpeed(requested);
	const speed = Math.min(wanted, maxGroupSpeedFor(project, segmentId));
	if (group.every((member) => member.speed === speed && !member.speedCurve)) {
		return null;
	}
	const ids = new Set(group.map((member) => member.id));
	return {
		limited: speed < wanted,
		partners: group.length - 1,
		project: {
			...project,
			segments: project.segments.map((segment) =>
				ids.has(segment.id) ? withSpeed(segment, speed) : segment
			),
		},
		speed,
	};
}
