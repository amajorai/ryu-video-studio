/**
 * Speed-curve audio rendered sample by sample (the varispeed derivative).
 *
 * A curved clip's audio is decoded once to 48 kHz stereo `f32le` PCM through
 * FFmpeg and remapped in this process along the exact curve mapping from
 * `shared/speed-curve.ts`: output sample `j` (clip time `j / 48000`) reads
 * the source at `clipSourceOffset(segment, j / 48000)`. The result is a WAV
 * exactly `round(duration × 48000)` samples long that the export reads in
 * place of the clip's own audio, so placement is sample-exact and the
 * render graph needs no time-varying FFmpeg filter.
 *
 * - Tape-style (`speedCurve.preservePitch: false`): a windowed-sinc
 *   resample at the curve's position. Pitch follows speed; the kernel's
 *   cutoff drops with the local speed so fast stretches do not alias.
 * - Pitch kept (the default): a WSOLA time stretch. Each 21 ms Hann grain
 *   is taken from the source near the curve's position for its output
 *   moment (within `WSOLA_TOLERANCE` samples, chosen by waveform
 *   similarity), so the tempo follows the curve every 10.7 ms hop and the
 *   placement error never accumulates.
 *
 * The source is streamed: only a sliding window of decoded PCM is held, and
 * output is written in blocks.
 */
import { spawn } from "node:child_process";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Asset, Project, Segment } from "../../shared/project.ts";
import { segmentDuration } from "../../shared/project.ts";
import { curvePreservesPitch } from "../../shared/schema/speed-curve.ts";
import {
	CURVE_SAMPLE_RATE,
	clipSourceOffset,
	hasSpeedCurve,
	sourceSpeedAt,
} from "../../shared/speed-curve.ts";
import { MEDIA_FORMATS, mediaBinary, mediaFailureMessage } from "./media.ts";
import { segmentAudible } from "./render-stages/visibility.ts";

/** Channels of a curve-audio derivative. */
export const CURVE_AUDIO_CHANNELS = 2;
/** Source seconds decoded on either side of the clip's source range. */
const DECODE_MARGIN_SECONDS = 0.25;
/** Longest clip (timeline seconds) whose curve audio is rendered. */
export const MAX_CURVE_AUDIO_SECONDS = 2 * 60 * 60;
/** Zero crossings on each side of the tape-style sinc kernel at full band. */
const SINC_ZERO_CROSSINGS = 8;
/** Widest tape-style kernel half-width, in source samples. */
const MAX_SINC_HALF_WIDTH = 512;
/** WSOLA grain length (samples) and hop (half a grain, 50% overlap). */
export const WSOLA_GRAIN = 1024;
export const WSOLA_HOP = WSOLA_GRAIN / 2;
/** Furthest a WSOLA grain may sit from the curve's position, in samples. */
export const WSOLA_TOLERANCE = 256;
/** Output samples written per block. */
const BLOCK = 8192;

/** The clip fields the mapping reads. */
type CurveClip = Pick<
	Segment,
	"sourceIn" | "sourceOut" | "speed" | "speedCurve"
>;

/** Samples of a clip's curve audio: its exact length at 48 kHz. */
export function curveAudioSamples(segment: Segment): number {
	return Math.round(segmentDuration(segment) * CURVE_SAMPLE_RATE);
}

/**
 * Decoded source PCM around the clip, read on demand. Indices are source
 * samples from the decode start; samples outside what the source holds read
 * as silence.
 */
export interface PcmSource {
	/** Source sample index of `data[0]`. */
	readonly base: number;
	/** Interleaved stereo samples from `base`. */
	readonly data: Float32Array;
	/** Make frames up to `end` (exclusive) available, or reach end of stream. */
	ensure(end: number): Promise<void>;
	/** Valid frames in `data`. */
	readonly frames: number;
	/** Frames before `index` are no longer needed. */
	release(index: number): void;
}

/** A source over PCM already in memory (tests and short sources). */
export function memorySource(interleaved: Float32Array): PcmSource {
	return {
		base: 0,
		data: interleaved,
		ensure: async () => {
			// Everything is already decoded.
		},
		frames: interleaved.length / CURVE_AUDIO_CHANNELS,
		release: () => {
			// Nothing to free: the caller owns the array.
		},
	};
}

/** Streams interleaved `f32le` stereo from a byte stream into a sliding window. */
class StreamSource implements PcmSource {
	data = new Float32Array(0);
	base = 0;
	frames = 0;
	private readonly reader: AsyncIterator<Uint8Array>;
	private done = false;
	private carry = new Uint8Array(0);

	constructor(stream: AsyncIterable<Uint8Array>) {
		this.reader = stream[Symbol.asyncIterator]();
	}

	async ensure(end: number) {
		while (!this.done && this.base + this.frames < end) {
			const next = await this.reader.next();
			if (next.done) {
				this.done = true;
				return;
			}
			this.append(next.value);
		}
	}

	private append(chunk: Uint8Array) {
		const bytes = new Uint8Array(this.carry.length + chunk.length);
		bytes.set(this.carry, 0);
		bytes.set(chunk, this.carry.length);
		const frameBytes = 4 * CURVE_AUDIO_CHANNELS;
		const whole = Math.floor(bytes.length / frameBytes) * frameBytes;
		this.carry = bytes.slice(whole);
		if (whole === 0) {
			return;
		}
		const incoming = new Float32Array(bytes.buffer.slice(0, whole));
		const needed = (this.frames * CURVE_AUDIO_CHANNELS + incoming.length) | 0;
		if (needed > this.data.length) {
			const grown = new Float32Array(Math.max(needed, this.data.length * 2));
			grown.set(this.data.subarray(0, this.frames * CURVE_AUDIO_CHANNELS));
			this.data = grown;
		}
		this.data.set(incoming, this.frames * CURVE_AUDIO_CHANNELS);
		this.frames += incoming.length / CURVE_AUDIO_CHANNELS;
	}

	release(index: number) {
		const drop = Math.floor(index - this.base);
		// Compact only when a good share of the window is stale.
		if (drop <= 0 || drop < this.frames / 2) {
			return;
		}
		const kept = Math.max(0, this.frames - drop);
		this.data.copyWithin(
			0,
			drop * CURVE_AUDIO_CHANNELS,
			this.frames * CURVE_AUDIO_CHANNELS
		);
		this.frames = kept;
		this.base += drop;
	}
}

/** Sample `channel` of source frame `index`, silence outside the window. */
function at(source: PcmSource, channel: number, index: number): number {
	const local = index - source.base;
	if (local < 0 || local >= source.frames) {
		return 0;
	}
	return source.data[local * CURVE_AUDIO_CHANNELS + channel] ?? 0;
}

/**
 * The source position mapping of a curved clip: source sample (from the
 * decode start) and local speed for output sample `j`. Past either end of
 * the clip the edge speed continues, for the grains and kernels that read
 * across them.
 */
export interface CurveMapping {
	position(j: number): number;
	speed(j: number): number;
}

export function curveMapping(
	segment: CurveClip,
	decodeOffset: number,
	rate = CURVE_SAMPLE_RATE
): CurveMapping {
	const duration = (segment.sourceOut - segment.sourceIn) / segment.speed;
	const source = segment.sourceOut - segment.sourceIn;
	const startSpeed = sourceSpeedAt(segment, 0);
	const endSpeed = sourceSpeedAt(segment, source);
	return {
		position(j) {
			const time = j / rate;
			if (time < 0) {
				return (decodeOffset + time * startSpeed) * rate;
			}
			if (time > duration) {
				return (decodeOffset + source + (time - duration) * endSpeed) * rate;
			}
			return (decodeOffset + clipSourceOffset(segment, time)) * rate;
		},
		speed(j) {
			const time = j / rate;
			if (time <= 0) {
				return startSpeed;
			}
			if (time >= duration) {
				return endSpeed;
			}
			return sourceSpeedAt(segment, clipSourceOffset(segment, time));
		},
	};
}

/** Receives finished interleaved output blocks in order. */
export type BlockSink = (block: Float32Array) => Promise<void> | void;

const sinc = (x: number) => {
	if (Math.abs(x) < 1e-9) {
		return 1;
	}
	const px = Math.PI * x;
	return Math.sin(px) / px;
};

/**
 * Tape-style varispeed: output sample `j` is the band-limited source value
 * at `mapping.position(j)`, so pitch follows speed. A Blackman-windowed sinc
 * whose cutoff is `min(1, 1 / speed)` of the source band keeps fast
 * stretches from aliasing; weights are normalized so the DC gain is one.
 */
export async function renderTapeAudio(
	source: PcmSource,
	mapping: CurveMapping,
	samples: number,
	sink: BlockSink
): Promise<void> {
	for (let start = 0; start < samples; start += BLOCK) {
		const count = Math.min(BLOCK, samples - start);
		const block = new Float32Array(count * CURVE_AUDIO_CHANNELS);
		const last = mapping.position(start + count - 1);
		await source.ensure(Math.ceil(last) + MAX_SINC_HALF_WIDTH + 2);
		for (let offset = 0; offset < count; offset++) {
			const j = start + offset;
			const x = mapping.position(j);
			const cutoff = Math.min(1, 1 / Math.max(1e-6, mapping.speed(j)));
			const half = Math.min(
				MAX_SINC_HALF_WIDTH,
				Math.ceil(SINC_ZERO_CROSSINGS / cutoff)
			);
			const center = Math.floor(x);
			let left = 0;
			let right = 0;
			let weights = 0;
			for (let i = center - half + 1; i <= center + half; i++) {
				const d = x - i;
				const ratio = d / half;
				if (Math.abs(ratio) >= 1) {
					continue;
				}
				const window =
					0.42 +
					0.5 * Math.cos(Math.PI * ratio) +
					0.08 * Math.cos(2 * Math.PI * ratio);
				const weight = sinc(cutoff * d) * window;
				left += weight * at(source, 0, i);
				right += weight * at(source, 1, i);
				weights += weight;
			}
			const scale = weights > 1e-9 ? 1 / weights : 0;
			block[offset * 2] = left * scale;
			block[offset * 2 + 1] = right * scale;
		}
		source.release(
			Math.floor(mapping.position(start + count)) - MAX_SINC_HALF_WIDTH - 2
		);
		await sink(block);
	}
}

/** Periodic Hann window: 50% overlapped grains sum to exactly one. */
const HANN = Float32Array.from(
	{ length: WSOLA_GRAIN },
	(_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / WSOLA_GRAIN)
);

/** Mono sum of `length` source frames from `from`, silence outside the window. */
function monoRange(
	source: PcmSource,
	from: number,
	length: number
): Float32Array {
	const mono = new Float32Array(length);
	for (let n = 0; n < length; n++) {
		mono[n] = at(source, 0, from + n) + at(source, 1, from + n);
	}
	return mono;
}

/**
 * How well the candidate starting `offset` samples into `region` continues
 * `template` (the source right after the previous grain's centre):
 * correlation over the overlapping half, normalized by the candidate's
 * energy, every `stride` samples.
 */
function similarity(
	template: Float32Array,
	region: Float32Array,
	offset: number,
	stride: number
): number {
	let product = 0;
	let energy = 0;
	for (let n = 0; n < WSOLA_HOP; n += stride) {
		const b = region[offset + n] ?? 0;
		product += (template[n] ?? 0) * b;
		energy += b * b;
	}
	return energy > 1e-12 ? product / Math.sqrt(energy) : 0;
}

/**
 * The grain offset within the tolerance that best continues the previous
 * grain: a coarse search on every other lag, refined around the winner. Ties
 * keep the offset nearest the curve, so silence stays exactly on it.
 */
function bestOffset(
	source: PcmSource,
	template: number,
	ideal: number
): number {
	const pattern = monoRange(source, template, WSOLA_HOP);
	const region = monoRange(
		source,
		ideal - WSOLA_TOLERANCE,
		2 * WSOLA_TOLERANCE + WSOLA_HOP + 1
	);
	const score = (delta: number, stride: number) =>
		similarity(pattern, region, delta + WSOLA_TOLERANCE, stride);
	const better = (candidate: number, current: number) =>
		candidate > current + Math.abs(current) * 1e-6 + 1e-12;
	let best = 0;
	let bestScore = score(0, 2);
	for (let delta = 2; delta <= WSOLA_TOLERANCE; delta += 2) {
		for (const signed of [delta, -delta]) {
			const value = score(signed, 2);
			if (better(value, bestScore)) {
				bestScore = value;
				best = signed;
			}
		}
	}
	let refined = best;
	let refinedScore = score(best, 1);
	for (const signed of [best - 1, best + 1]) {
		if (Math.abs(signed) <= WSOLA_TOLERANCE) {
			const value = score(signed, 1);
			if (better(value, refinedScore)) {
				refinedScore = value;
				refined = signed;
			}
		}
	}
	return refined;
}

/**
 * Pitch-kept time stretch (WSOLA) along the curve. Output grain `k` is
 * centred on output sample `k × WSOLA_HOP` and taken from the source near
 * `mapping.position(k × WSOLA_HOP)`: within `WSOLA_TOLERANCE` samples, where
 * it best continues the previous grain. Hann grains at 50% overlap sum to
 * one, so steady material passes at unity gain.
 */
export async function renderStretchedAudio(
	source: PcmSource,
	mapping: CurveMapping,
	samples: number,
	sink: BlockSink
): Promise<void> {
	const half = WSOLA_GRAIN / 2;
	// Output accumulator from `written`, long enough for one grain past a block.
	let pending = new Float32Array(
		(BLOCK + WSOLA_GRAIN * 2) * CURVE_AUDIO_CHANNELS
	);
	let written = 0;
	let previousCenter = Math.round(mapping.position(0));
	const grains = Math.ceil(samples / WSOLA_HOP) + 1;
	for (let k = 0; k <= grains; k++) {
		const outputCenter = k * WSOLA_HOP;
		const ideal = Math.round(mapping.position(outputCenter));
		await source.ensure(ideal + WSOLA_TOLERANCE + WSOLA_GRAIN + 2);
		const center =
			k === 0
				? ideal
				: ideal + bestOffset(source, previousCenter, ideal - half);
		const outputStart = outputCenter - half;
		const needed = (outputStart + WSOLA_GRAIN - written) * CURVE_AUDIO_CHANNELS;
		if (needed > pending.length) {
			const grown = new Float32Array(needed * 2);
			grown.set(pending);
			pending = grown;
		}
		for (let n = 0; n < WSOLA_GRAIN; n++) {
			const target = outputStart + n - written;
			if (target < 0) {
				continue;
			}
			const weight = HANN[n] ?? 0;
			const read = center - half + n;
			pending[target * 2] =
				(pending[target * 2] ?? 0) + weight * at(source, 0, read);
			pending[target * 2 + 1] =
				(pending[target * 2 + 1] ?? 0) + weight * at(source, 1, read);
		}
		previousCenter = center;
		// Output before the next grain's start is final.
		const complete = Math.min(samples, outputCenter + WSOLA_HOP - half);
		if (complete - written >= BLOCK || (k === grains && complete > written)) {
			const count = Math.min(samples, complete) - written;
			if (count > 0) {
				await sink(pending.slice(0, count * CURVE_AUDIO_CHANNELS));
				pending.copyWithin(0, count * CURVE_AUDIO_CHANNELS);
				pending.fill(0, pending.length - count * CURVE_AUDIO_CHANNELS);
				written += count;
			}
		}
		source.release(
			Math.min(previousCenter, ideal) - WSOLA_TOLERANCE - WSOLA_GRAIN - 2
		);
	}
	if (written < samples) {
		await sink(pending.slice(0, (samples - written) * CURVE_AUDIO_CHANNELS));
	}
}

/** A 32-bit float stereo WAV header for `samples` frames. */
export function floatWavHeader(samples: number, rate = CURVE_SAMPLE_RATE) {
	const header = new DataView(new ArrayBuffer(44));
	const data = samples * CURVE_AUDIO_CHANNELS * 4;
	const ascii = (offset: number, text: string) => {
		for (let index = 0; index < text.length; index++) {
			header.setUint8(offset + index, text.charCodeAt(index));
		}
	};
	ascii(0, "RIFF");
	header.setUint32(4, 36 + data, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	header.setUint32(16, 16, true);
	header.setUint16(20, 3, true);
	header.setUint16(22, CURVE_AUDIO_CHANNELS, true);
	header.setUint32(24, rate, true);
	header.setUint32(28, rate * CURVE_AUDIO_CHANNELS * 4, true);
	header.setUint16(32, CURVE_AUDIO_CHANNELS * 4, true);
	header.setUint16(34, 32, true);
	ascii(36, "data");
	header.setUint32(40, data, true);
	return new Uint8Array(header.buffer);
}

export interface CurveAudioOptions {
	/**
	 * Bytes the curve-audio files may take in the work folder (the export's
	 * remaining work budget). Checked before anything is written.
	 */
	budgetBytes?: number;
	/**
	 * Timeline seconds the export covers. A curved clip that ends before it
	 * (less `CURVE_AUDIO_TAIL_SECONDS` for echo tails) or starts after it is
	 * not rendered: it reads `SILENT_CURVE_AUDIO` instead.
	 */
	range?: { end: number; start: number };
	/**
	 * Milliseconds left before the operation's deadline. FFmpeg is stopped
	 * when it runs out.
	 */
	remainingMs?: () => number;
	signal?: AbortSignal;
}

/**
 * The `curveAudio` entry of a curved clip outside the export range: the
 * render feeds it silence of the clip's length instead of a rendered file.
 */
export const SILENT_CURVE_AUDIO = "lavfi:anullsrc";
/** Seconds of echo or reverb tail a clip may carry past its end. */
export const CURVE_AUDIO_TAIL_SECONDS = 15;

/** Bytes of a clip's curve-audio WAV (header plus float stereo samples). */
export function curveAudioBytes(segment: Segment): number {
	return 44 + curveAudioSamples(segment) * CURVE_AUDIO_CHANNELS * 4;
}

/** Message of curve audio that would outgrow the export's work budget. */
export function curveAudioBudgetMessage(needed: number, budget: number) {
	const gigabytes = (bytes: number) =>
		Math.max(0.1, Math.ceil((bytes / 1024 ** 3) * 10) / 10);
	return `Speed-curve audio needs ${gigabytes(needed)} GB of working files, more than the ${Math.max(0, Math.floor((budget / 1024 ** 3) * 10) / 10)} GB this export has left (free disk space also caps it). Export a shorter range, or free disk space.`;
}

/** Message of curve audio that ran past the operation's deadline. */
export const CURVE_AUDIO_TIMEOUT_MESSAGE =
	"Speed-curve audio ran past the export's time limit.";

/**
 * Render one curved clip's audio to `output` (a float WAV of exactly
 * `curveAudioSamples(segment)` frames), decoding the source through FFmpeg
 * and remapping it here. Tape-style or pitch kept follows the curve's
 * `preservePitch`.
 */
export async function renderCurveAudio(
	segment: Segment,
	mediaPath: string,
	output: string,
	options: CurveAudioOptions = {}
): Promise<void> {
	if (!hasSpeedCurve(segment)) {
		throw new Error("Only clips with a speed curve have curve audio.");
	}
	const duration = segmentDuration(segment);
	if (!(duration > 0) || duration > MAX_CURVE_AUDIO_SECONDS) {
		throw new Error(
			`Speed-curve audio supports clips up to ${MAX_CURVE_AUDIO_SECONDS / 3600} hours long.`
		);
	}
	if (options.signal?.aborted) {
		throw new Error("Operation canceled.");
	}
	const timeoutMs = options.remainingMs?.();
	if (timeoutMs !== undefined && !(timeoutMs > 0)) {
		throw new Error(CURVE_AUDIO_TIMEOUT_MESSAGE);
	}
	const decodeStart = Math.max(0, segment.sourceIn - DECODE_MARGIN_SECONDS);
	const decodeLength = segment.sourceOut - decodeStart + DECODE_MARGIN_SECONDS;
	const child = spawn(
		mediaBinary("ffmpeg"),
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-nostdin",
			"-protocol_whitelist",
			"file,pipe",
			"-format_whitelist",
			MEDIA_FORMATS,
			"-ss",
			String(decodeStart),
			"-t",
			String(decodeLength),
			"-i",
			mediaPath,
			"-map",
			"0:a:0",
			"-vn",
			"-ac",
			String(CURVE_AUDIO_CHANNELS),
			"-ar",
			String(CURVE_SAMPLE_RATE),
			"-f",
			"f32le",
			"-c:a",
			"pcm_f32le",
			"pipe:1",
		],
		{ stdio: ["ignore", "pipe", "pipe"] }
	);
	let stderr = "";
	child.stderr.on("data", (bytes: Buffer) => {
		stderr = (stderr + bytes.toString()).slice(-4000);
	});
	const exited = new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? 1));
	});
	const abort = () => child.kill("SIGKILL");
	options.signal?.addEventListener("abort", abort, { once: true });
	let timedOut = false;
	const timer =
		timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					timedOut = true;
					abort();
				}, timeoutMs);
	const stopped = () => {
		if (timedOut) {
			throw new Error(CURVE_AUDIO_TIMEOUT_MESSAGE);
		}
		if (options.signal?.aborted) {
			throw new Error("Operation canceled.");
		}
	};
	const samples = curveAudioSamples(segment);
	const file = await open(output, "w", 0o600);
	try {
		await file.write(floatWavHeader(samples));
		const source = new StreamSource(child.stdout);
		const mapping = curveMapping(segment, segment.sourceIn - decodeStart);
		const sink: BlockSink = async (block) => {
			stopped();
			await file.write(
				new Uint8Array(block.buffer, block.byteOffset, block.byteLength)
			);
		};
		const render = curvePreservesPitch(segment.speedCurve)
			? renderStretchedAudio
			: renderTapeAudio;
		await render(source, mapping, samples, sink);
		// Drain whatever the decoder still writes past the clip.
		child.stdout.resume();
		const code = await exited;
		stopped();
		if (code !== 0) {
			throw new Error(
				`Speed-curve audio could not be decoded: ${mediaFailureMessage(stderr)}`
			);
		}
	} catch (error) {
		abort();
		await file.close().catch(() => undefined);
		await rm(output, { force: true });
		// A stream error after the deadline kill reports as the timeout.
		if (timedOut) {
			throw new Error(CURVE_AUDIO_TIMEOUT_MESSAGE);
		}
		throw error;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
	}
	await file.close();
}

/** File name of a clip's curve audio inside a render's work folder. */
export const curveAudioFileName = (clipId: string) =>
	`curve-audio-${clipId}.wav`;

/** Whether a clip's audio (with its echo tail) can reach `range`. */
function reachesRange(
	segment: Segment,
	range: { end: number; start: number } | undefined
): boolean {
	if (!range) {
		return true;
	}
	const end = segment.start + segmentDuration(segment);
	return (
		segment.start <= range.end && end + CURVE_AUDIO_TAIL_SECONDS >= range.start
	);
}

/**
 * Render the curve audio of every curved clip in `project` whose audio the
 * export mixes or draws as a waveform, into `directory`. Returns the paths
 * by clip id for `BuildRenderOptions.curveAudio`; clips outside
 * `options.range` map to `SILENT_CURVE_AUDIO` and write nothing. The files'
 * total size is checked against `options.budgetBytes` before any is written.
 */
export async function prepareCurveAudio(
	project: Project,
	assets: readonly Asset[],
	mediaPath: (assetId: string, clipId?: string) => string,
	directory: string,
	options: CurveAudioOptions = {}
): Promise<Map<string, string>> {
	const prepared = new Map<string, string>();
	const curved = project.segments.filter((segment) => {
		if (!hasSpeedCurve(segment)) {
			return false;
		}
		const asset = assets.find((candidate) => candidate.id === segment.assetId);
		const waveform =
			asset?.kind === "audio" && segment.visualization === "waveform";
		return (
			Boolean(asset?.hasAudio) &&
			(waveform || segmentAudible(project, segment, asset))
		);
	});
	const rendered: Segment[] = [];
	for (const segment of curved) {
		if (reachesRange(segment, options.range)) {
			rendered.push(segment);
		} else {
			prepared.set(segment.id, SILENT_CURVE_AUDIO);
		}
	}
	if (rendered.length === 0) {
		return prepared;
	}
	const needed = rendered.reduce(
		(sum, segment) => sum + curveAudioBytes(segment),
		0
	);
	if (options.budgetBytes !== undefined && needed > options.budgetBytes) {
		throw new Error(curveAudioBudgetMessage(needed, options.budgetBytes));
	}
	await mkdir(directory, { recursive: true, mode: 0o700 });
	for (const segment of rendered) {
		const output = join(directory, curveAudioFileName(segment.id));
		await renderCurveAudio(
			segment,
			mediaPath(segment.assetId, segment.id),
			output,
			options
		);
		prepared.set(segment.id, output);
	}
	return prepared;
}
