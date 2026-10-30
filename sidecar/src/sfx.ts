import type { z } from "zod";
import type { Asset } from "../../shared/project.ts";
import {
	SFX_LABELS,
	type SfxParameters,
	sfxParameters,
	type sfxRequestSchema,
} from "../../shared/sfx.ts";
import { synthesisTimeoutMs, synthesizeAudioAsset } from "./soundtrack.ts";
import type { StudioStore } from "./store.ts";

const SAMPLE_RATE = 48_000;
/** `aevalsrc` variable slots for the noise state and the band-pass filter. */
const NOISE = 0;
const OUT_1 = 1;
const OUT_2 = 2;
const IN_1 = 3;
const IN_2 = 4;
const INPUT = 5;
const OUTPUT = 6;
/** Attack in seconds so percussive kinds start without a click. */
const ATTACK_SECONDS = 0.002;

function formatNumber(value: number): string {
	return Number(value.toFixed(6)).toString();
}

function envelopeExpression(parameters: SfxParameters): string {
	const duration = formatNumber(parameters.duration);
	if (parameters.decay > 0) {
		return `min(1,t/${ATTACK_SECONDS})*exp(-${formatNumber(parameters.decay)}*t)`;
	}
	// Swell: rises to its peak, then falls back to silence at the end.
	const peak = formatNumber(parameters.peak);
	const rest = formatNumber(1 - parameters.peak);
	return `if(lt(t/${duration},${peak}),pow(t/${duration}/${peak},2),pow((1-t/${duration})/${rest},2))`;
}

function toneExpression(parameters: SfxParameters): string {
	const { decay, duration, kind, toneEndHz, toneHz } = parameters;
	if (toneHz <= 0) {
		return "0";
	}
	if (kind === "ding") {
		const rate = formatNumber(decay);
		return `(sin(2*PI*${formatNumber(toneHz)}*t)+0.45*sin(2*PI*${formatNumber(toneHz * 2.756)}*t)*exp(-${rate}*t)+0.2*sin(2*PI*${formatNumber(toneHz * 5.404)}*t)*exp(-2*${rate}*t))/1.65`;
	}
	if (toneEndHz === toneHz) {
		return `sin(2*PI*${formatNumber(toneHz)}*t)`;
	}
	if (decay > 0) {
		// Pitch falls exponentially toward its end value: f(t) = f1 + (f0 - f1)e^(-gt).
		const glide = decay * 2;
		return `sin(2*PI*(${formatNumber(toneEndHz)}*t+${formatNumber((toneHz - toneEndHz) / glide)}*(1-exp(-${formatNumber(glide)}*t))))`;
	}
	// Pitch rises exponentially across the whole effect.
	const ratio = toneEndHz / toneHz;
	return `sin(2*PI*${formatNumber((toneHz * duration) / Math.log(ratio))}*(pow(${formatNumber(ratio)},t/${formatNumber(duration)})-1))`;
}

/**
 * `aevalsrc` expression for an effect: seeded white noise through a
 * two-pole band-pass whose centre sweeps exponentially from `startHz` to
 * `endHz` (unit gain at the centre), mixed with a tonal part and shaped by
 * the envelope. Statements run once per sample in order, so the filter
 * state carries from one sample to the next.
 */
export function sfxExpression(parameters: SfxParameters): string {
	const duration = formatNumber(parameters.duration);
	const radius = parameters.resonance;
	const centre = `${formatNumber(parameters.startHz)}*pow(${formatNumber(parameters.endHz / parameters.startHz)},t/${duration})`;
	const angle = `2*PI*${centre}/${SAMPLE_RATE}`;
	const noise = parameters.noise;
	const mix: string[] = [];
	if (noise > 0) {
		mix.push(`${formatNumber(noise)}*ld(${OUTPUT})`);
	}
	if (noise < 1) {
		mix.push(`${formatNumber(1 - noise)}*${toneExpression(parameters)}`);
	}
	const statements = [
		`if(eq(n,0),st(${NOISE},${parameters.seed}),0)`,
		`st(${INPUT},2*random(${NOISE})-1)`,
		`st(${OUTPUT},${formatNumber((1 - radius * radius) / 2)}*(ld(${INPUT})-ld(${IN_2}))+${formatNumber(2 * radius)}*cos(${angle})*ld(${OUT_1})-${formatNumber(radius * radius)}*ld(${OUT_2}))`,
		`st(${IN_2},ld(${IN_1}))`,
		`st(${IN_1},ld(${INPUT}))`,
		`st(${OUT_2},ld(${OUT_1}))`,
		`st(${OUT_1},ld(${OUTPUT}))`,
		`${formatNumber(parameters.gain)}*${envelopeExpression(parameters)}*(${mix.join("+")})`,
	];
	return statements.join(";");
}

/** Build the ffmpeg argument list for a sound effect. */
export function sfxMediaArgs(
	parameters: SfxParameters,
	output: string
): string[] {
	const duration = parameters.duration;
	const fadeOut = Math.min(0.02, duration / 4);
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-y",
		"-f",
		"lavfi",
		"-i",
		`aevalsrc=exprs='${sfxExpression(parameters)}':s=${SAMPLE_RATE}:d=${duration}`,
		"-filter_complex",
		`[0:a]alimiter=limit=0.89:attack=1:release=20:level=false:latency=true,afade=t=out:st=${formatNumber(Math.max(0, duration - fadeOut))}:d=${formatNumber(fadeOut)}`,
		"-t",
		String(duration),
		"-ar",
		String(SAMPLE_RATE),
		"-ac",
		"2",
		output,
	];
}

/** Synthesize a procedural sound effect and save it as an app-owned audio asset. */
export async function generateSfx(
	store: StudioStore,
	input: z.input<typeof sfxRequestSchema>,
	options: { signal?: AbortSignal } = {}
): Promise<Asset> {
	const parameters = sfxParameters(input);
	return await synthesizeAudioAsset(
		store,
		{
			args: (output) => sfxMediaArgs(parameters, output),
			folder: "sfx",
			name: `${SFX_LABELS[parameters.kind]} SFX seed ${parameters.seed}.wav`,
			timeoutMs: synthesisTimeoutMs(parameters.duration),
		},
		options
	);
}
