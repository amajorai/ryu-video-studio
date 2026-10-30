import {
	DUCK_DEFAULTS,
	duckFilterChain,
	type ResolvedDuck,
} from "../../shared/ducking.ts";
import { ffmpegFrameRate } from "../../shared/frame-rate.ts";
import {
	animationExpression,
	type Project,
	type Segment,
} from "../../shared/project.ts";
import { cleanupFilters } from "./render-stages/audio-cleanup.ts";
import { audioEffectFilters } from "./render-stages/audio-effects.ts";
import { trackMixFilters } from "./render-stages/audio-mix.ts";
import { clipPanFilters } from "./render-stages/audio-pan.ts";
import { curveTempoGraph, tempoFilters } from "./render-stages/audio-tempo.ts";

/**
 * Per-clip audio chains and the final mix.
 *
 * Clip order (fixed): `asetpts → tempo → cleanup → audio effects → volume →
 * clip pan → afade → track mix → aresample → adelay` (in samples, see
 * `sampleDelay`); a speed curve's remap (`curveTempoGraph`) runs before the
 * chain unless its audio was rendered ahead (`curveInput`). Stages that return no filters leave
 * the chain byte-identical.
 */

/** Working rate of every clip chain before the mix (and of curve audio). */
export const MIX_SAMPLE_RATE = 48_000;

/**
 * Place audio `seconds` into the timeline on an exact sample: resample to
 * the mix rate, then `adelay` in samples (`…S`). Millisecond delays are
 * scaled in single precision inside FFmpeg and drift by a sample on long
 * timelines.
 */
export function sampleDelay(seconds: number): string {
	return `aresample=${MIX_SAMPLE_RATE},adelay=${Math.max(0, Math.round(seconds * MIX_SAMPLE_RATE))}S:all=1`;
}

const optional = (filters: string[]) =>
	filters.length ? `,${filters.join(",")}` : "";

export interface WaveformInput {
	/** Whether the clip is also mixed, so its audio must be split. */
	audible: boolean;
	/**
	 * A speed-curve clip's pre-rendered audio (`varispeed.ts`), already on the
	 * clip's timing; read instead of `[n:a]` and its curve remap.
	 */
	curveInput?: string;
	n: number;
	p: Project;
	s: Segment;
}

/**
 * The waveform visualization source for an audio clip: optional `asplit`, then
 * tempo and cleanup, then `showwaves` into `[waveVideo<n>]`.
 */
export function waveformFilters({
	audible,
	curveInput,
	n,
	p,
	s,
}: WaveformInput): string[] {
	const filters: string[] = [];
	const samplesPerFrame = p.width * p.fps;
	// NTSC rates give a fractional product; aresample needs whole samples.
	const waveformSampleRate = Math.round(
		Math.ceil(48_000 / samplesPerFrame) * samplesPerFrame
	);
	const input = curveInput ?? `[${n}:a]`;
	if (audible) {
		filters.push(`${input}asplit=2[waveAudio${n}][mixAudio${n}]`);
	}
	const curve = curveTempoGraph(
		s,
		audible ? `[waveAudio${n}]` : input,
		`curveWave${n}`,
		curveInput !== undefined
	);
	filters.push(...curve.statements);
	const source = curve.label;
	const height = Math.max(2, Math.round((p.height * s.waveformHeight) / 2) * 2);
	filters.push(
		`${source}asetpts=PTS-STARTPTS,${tempoFilters(s).join(",")},${cleanupFilters(s).join(",")},aformat=channel_layouts=mono,aresample=${waveformSampleRate},apad=pad_dur=1,showwaves=s=${p.width}x${height}:mode=p2p:rate=${ffmpegFrameRate(p.fps)}:colors=${s.waveformColor.replace("#", "0x")}:draw=full:scale=lin,format=rgba[waveVideo${n}]`
	);
	return filters;
}

export interface SegmentAudioInput {
	/** A speed-curve clip's pre-rendered audio, as for `WaveformInput`. */
	curveInput?: string;
	length: number;
	n: number;
	p: Project;
	s: Segment;
	/** Whether the clip is a waveform visualization reading `[mixAudio<n>]`. */
	visualize: boolean;
}

/** The mixed audio chain of one clip, ending in `[a<n>]`. */
export function segmentAudioFilters({
	curveInput,
	length,
	n,
	p,
	s,
	visualize,
}: SegmentAudioInput): string[] {
	const fades = [
		s.fadeIn ? `afade=t=in:st=0:d=${s.fadeIn}` : "",
		s.fadeOut ? `afade=t=out:st=${length - s.fadeOut}:d=${s.fadeOut}` : "",
	].filter(Boolean);
	const curve = curveTempoGraph(
		s,
		visualize ? `[mixAudio${n}]` : (curveInput ?? `[${n}:a]`),
		`curveMix${n}`,
		curveInput !== undefined
	);
	const source = curve.label;
	const volume = animationExpression(s, "volume", "if(isnan(t),0,t)");
	return [
		...curve.statements,
		`${source}asetpts=PTS-STARTPTS,${tempoFilters(s).join(",")},${cleanupFilters(s).join(",")}${optional(audioEffectFilters(s))},volume='${volume}':eval=frame${optional(clipPanFilters(s))}${optional(fades)}${optional(trackMixFilters(p, s.track))},${sampleDelay(s.start)}[a${n}]`,
	];
}

export interface AudioMixInput {
	/** Every clip label, in clip order. */
	all: string[];
	/** Labels of clips that duck under the other audio. */
	ducked: string[];
	/**
	 * Ducking for each `ducked` label, by index; a missing entry uses
	 * `DUCK_DEFAULTS`.
	 */
	duckSettings?: readonly (ResolvedDuck | undefined)[];
	/** Labels of clips that drive the ducking. */
	sidechain: string[];
	/**
	 * Timeline seconds every clip has ended by (the timeline length). Both
	 * inputs of each ducking gate are held with silence to a second past it
	 * (`DUCK_HOLD_MARGIN`).
	 */
	until: number;
}

/**
 * Seconds of silence past the timeline end that both inputs of a ducking
 * gate are padded to. FFmpeg's two-input dynamics filters end their output
 * when either input ends and drop what the other has queued, so a ducked
 * clip used to lose its tail (by however far the sidechain lagged in
 * FFmpeg's scheduling, about 35 ms in a 260-clip video export) and a ducked
 * bed longer than the voice stopped where the voice did. With equal padded
 * lengths only padding past the export span can be dropped.
 */
export const DUCK_HOLD_MARGIN = 1;

/**
 * Mixes every clip into `[mix]`. When some clips duck and others do not, each
 * ducking clip is gated against a mix of the rest first (`duckFilterChain`),
 * both held to the same length past `until`.
 */
export function audioMixFilters({
	all,
	ducked,
	duckSettings = [],
	sidechain,
	until,
}: AudioMixInput): string[] {
	if (!all.length) {
		return [];
	}
	const filters: string[] = [];
	let mixInputs = all;
	if (ducked.length && sidechain.length) {
		const hold = `apad=whole_dur=${Number((until + DUCK_HOLD_MARGIN).toFixed(6))}`;
		filters.push(
			`${sidechain.join("")}amix=inputs=${sidechain.length}:normalize=0,${hold}[sidechainMix]`
		);
		const sidechainLabels = ducked.map((_, index) => `[sidechain${index}]`);
		filters.push(
			`[sidechainMix]asplit=${ducked.length + 1}[sidechainMain]${sidechainLabels.join("")}`
		);
		const compressed = ducked.map((source, index) => {
			const output = `[ducked${index}]`;
			const held = `[duckHeld${index}]`;
			filters.push(
				`${source}${hold}${held}`,
				...duckFilterChain({
					duck: duckSettings[index] ?? DUCK_DEFAULTS,
					key: sidechainLabels[index] ?? "",
					output,
					prefix: `duck${index}`,
					source: held,
				})
			);
			return output;
		});
		mixInputs = ["[sidechainMain]", ...compressed];
	}
	// `latency=1` compensates the limiter's 5 ms lookahead, which otherwise
	// delays the whole mix by 240 samples at 48 kHz.
	filters.push(
		`${mixInputs.join("")}amix=inputs=${mixInputs.length}:normalize=0,alimiter=limit=0.95:level=0:latency=1[mix]`
	);
	return filters;
}
