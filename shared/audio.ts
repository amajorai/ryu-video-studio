import { z } from "zod";

/** Clip speed bounds shared by the segment schema and the tempo chain. */
export const MIN_CLIP_SPEED = 0.1;
export const MAX_CLIP_SPEED = 100;

/**
 * Browsers accept `HTMLMediaElement.playbackRate` only within this range
 * (Chromium throws NotSupportedError outside it). Faster or slower clips
 * preview at the nearest supported rate while the caller keeps
 * `currentTime` in sync with the timeline.
 */
export const MIN_PREVIEW_PLAYBACK_RATE = 0.0625;
export const MAX_PREVIEW_PLAYBACK_RATE = 16;

/** Clamp a clip speed to a rate every media element accepts. */
export function previewPlaybackRate(speed: number): number {
	if (!Number.isFinite(speed)) {
		return 1;
	}
	return Math.min(
		MAX_PREVIEW_PLAYBACK_RATE,
		Math.max(MIN_PREVIEW_PLAYBACK_RATE, speed)
	);
}

export const audioPlaybackSchema = z
	.object({
		sourceOut: z.number().finite().min(0).max(7200),
		speed: z.number().finite().min(MIN_CLIP_SPEED).max(MAX_CLIP_SPEED),
		offset: z.number().finite().min(0).max(7200),
	})
	.strict();
export type AudioPlayback = z.infer<typeof audioPlaybackSchema>;

export const audioProcessingSchema = z.enum([
	"denoise",
	"none",
	"normalize",
	"voice-enhance",
]);
export type AudioProcessing = z.infer<typeof audioProcessingSchema>;

export function audioProcessingFilters(processing: AudioProcessing): string[] {
	switch (processing) {
		case "denoise":
			return ["highpass=f=70", "lowpass=f=16000", "afftdn=nr=18:nf=-35"];
		case "normalize":
			return ["loudnorm=I=-16:TP=-1.5:LRA=11"];
		case "voice-enhance":
			return [
				"highpass=f=80",
				"lowpass=f=14000",
				"afftdn=nr=12",
				"acompressor=threshold=-18dB:ratio=3:attack=20:release=250",
			];
		default:
			return ["anull"];
	}
}

/**
 * atempo changes samples even at 1x, so normal playback must bypass it.
 * Each stage stays within 0.5..2, so any speed in 0.1..100 chains stages.
 */
export function audioTempoFilters(speed: number): string[] {
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
	const filters: string[] = [];
	let remaining = speed;
	while (remaining > 2) {
		filters.push("atempo=2");
		remaining /= 2;
	}
	while (remaining < 0.5) {
		filters.push("atempo=0.5");
		remaining /= 0.5;
	}
	filters.push(`atempo=${remaining}`);
	return filters;
}

/** Deterministic, compact number text for filter arguments. */
export function filterNumber(value: number): string {
	const rounded = Number(value.toFixed(4));
	return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** Graded cleanup controls with every field resolved (see `audioCleanupOf`). */
export interface GradedAudioCleanup {
	denoise: number;
	enhance: number;
	normalize: boolean;
	voiceIsolation: number;
}

export interface CleanupFilterOptions {
	/**
	 * Single-level-escaped `arnndn` model path, or `null` when `arnndn` (or its
	 * bundled model) is unavailable; voice isolation is then skipped.
	 */
	rnnoiseModel: string | null;
}

const clamp01 = (value: number) =>
	Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/**
 * The graded cleanup chain, in a fixed order: denoise, enhance, voice
 * isolation (dry/wet through `arnndn` mix), loudness normalization. Returns
 * `anull` when every control is off so the clip chain stays well formed.
 */
export function audioCleanupFilters(
	cleanup: GradedAudioCleanup,
	options: CleanupFilterOptions
): string[] {
	const filters: string[] = [];
	const denoise = clamp01(cleanup.denoise);
	if (denoise > 0) {
		filters.push(
			`afftdn=nr=${filterNumber(6 + denoise * 24)}:nf=${filterNumber(-50 + denoise * 20)}`
		);
	}
	const enhance = clamp01(cleanup.enhance);
	if (enhance > 0) {
		filters.push(
			"highpass=f=80",
			"lowpass=f=14000",
			`acompressor=threshold=-18dB:ratio=${filterNumber(1 + enhance * 3)}:attack=20:release=250`,
			`equalizer=f=3000:t=q:w=1:g=${filterNumber(3 * enhance)}`
		);
	}
	const isolation = clamp01(cleanup.voiceIsolation);
	if (isolation > 0 && options.rnnoiseModel) {
		filters.push(
			`arnndn=m=${options.rnnoiseModel}:mix=${filterNumber(isolation)}`
		);
	}
	if (cleanup.normalize) {
		filters.push("loudnorm=I=-16:TP=-1.5:LRA=11");
	}
	return filters.length ? filters : ["anull"];
}

/** Whether a graded cleanup needs `arnndn` to render as configured. */
export function cleanupNeedsIsolation(cleanup: GradedAudioCleanup): boolean {
	return clamp01(cleanup.voiceIsolation) > 0;
}

/** Output channel mode of a clip; mirrors `channelModeSchema`. */
export type ClipChannelMode = "stereo" | "mono" | "left" | "right" | "swap";

/** `[[L←L, L←R], [R←L, R←R]]` routing for each channel mode. */
export type ChannelMatrix = readonly [
	readonly [number, number],
	readonly [number, number],
];

export function channelModeMatrix(mode: ClipChannelMode): ChannelMatrix {
	switch (mode) {
		case "mono":
			return [
				[0.5, 0.5],
				[0.5, 0.5],
			];
		case "left":
			return [
				[1, 0],
				[1, 0],
			];
		case "right":
			return [
				[0, 1],
				[0, 1],
			];
		case "swap":
			return [
				[0, 1],
				[1, 0],
			];
		default:
			return [
				[1, 0],
				[0, 1],
			];
	}
}

/**
 * Constant-power balance: centre is unity on both sides, and full left or
 * right carries √2 on one side and silence on the other, so a centred mono
 * source keeps its total power anywhere on the arc.
 */
export function panGains(pan: number): { left: number; right: number } {
	const position = Number.isFinite(pan) ? Math.min(1, Math.max(-1, pan)) : 0;
	const angle = ((position + 1) * Math.PI) / 4;
	const left = Math.SQRT2 * Math.cos(angle);
	const right = Math.SQRT2 * Math.sin(angle);
	// Snap float noise so centre is exactly unity and the extremes exactly silent.
	const snap = (value: number) =>
		Math.abs(value - 1) < 1e-12 || Math.abs(value) < 1e-12
			? Math.round(value)
			: value;
	return { left: snap(left), right: snap(right) };
}

/** Channel routing followed by the balance gains, as one 2×2 matrix. */
export function panMatrix(mode: ClipChannelMode, pan: number): ChannelMatrix {
	const [toLeft, toRight] = channelModeMatrix(mode);
	const { left, right } = panGains(pan);
	return [
		[toLeft[0] * left, toLeft[1] * left],
		[toRight[0] * right, toRight[1] * right],
	];
}

function matrixTerm(row: readonly [number, number]): string {
	const terms = row
		.map((gain, channel) =>
			gain === 0 ? "" : `${filterNumber(gain)}*c${channel}`
		)
		.filter(Boolean);
	return terms.length ? terms.join("+") : "0*c0";
}

export interface ClipPanInput {
	channelMode: ClipChannelMode;
	/** Static balance in -1..1. */
	pan: number;
	/**
	 * FFmpeg expression for an animated balance in terms of `t`, or undefined
	 * for a static one. Animated balance renders through `aeval`.
	 */
	panExpression?: string;
}

/**
 * Pan and channel filters. Identity routing at centre adds nothing, so clips
 * without pan settings keep their chain byte-identical. Every source is first
 * shaped to stereo, which duplicates a mono source onto both sides.
 */
export function clipPanFilterChain({
	channelMode,
	pan,
	panExpression,
}: ClipPanInput): string[] {
	const [toLeft, toRight] = channelModeMatrix(channelMode);
	if (panExpression !== undefined) {
		const position = `(${panExpression})`;
		const side = (fn: "cos" | "sin", row: readonly [number, number]) =>
			`sqrt(2)*${fn}((min(1,max(-1,${position}))+1)*PI/4)*(${filterNumber(row[0])}*val(0)+${filterNumber(row[1])}*val(1))`;
		return [
			"aformat=channel_layouts=stereo",
			`aeval=exprs='${side("cos", toLeft)}|${side("sin", toRight)}':channel_layout=same`,
		];
	}
	const matrix = panMatrix(channelMode, pan);
	const identity =
		matrix[0][0] === 1 &&
		matrix[0][1] === 0 &&
		matrix[1][0] === 0 &&
		matrix[1][1] === 1;
	if (identity) {
		return [];
	}
	return [
		"aformat=channel_layouts=stereo",
		`pan=stereo|c0=${matrixTerm(matrix[0])}|c1=${matrixTerm(matrix[1])}`,
	];
}

/**
 * Escape a file path for an FFmpeg filter option inside a filtergraph: first
 * the option level (`\`, `'`, `:`), then the graph level (`\`, `'`, `[`, `]`,
 * `,`, `;`).
 */
export function escapeFilterPath(path: string): string {
	const optionLevel = path.replace(/[\\':]/g, (character) => `\\${character}`);
	return optionLevel.replace(/[\\'[\],;]/g, (character) => `\\${character}`);
}
