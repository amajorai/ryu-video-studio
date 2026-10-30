/**
 * Real-FFmpeg proof for speed-curve audio rendered along the curve
 * (`varispeed.ts`).
 *
 * A 4 s stereo source holds a steady 1 kHz tone on the left and short 2 kHz
 * bursts on the right at known source moments. A clip plays it on a
 * 0.5x → 2x → 0.75x curve:
 *
 * 1. Tape-style (`speedCurve.preservePitch: false`): the derivative WAV is
 *    exactly `round(duration × 48000)` samples, the tone's pitch follows the
 *    curve's speed at every 20 ms window (within 1.5%), and every click lands
 *    within 2 samples of `clipTimeAtSourceOffset × 48000`.
 * 2. Pitch kept (the default): the same length, the tone stays at 1 kHz
 *    (within 1.5%), and every click lands within the WSOLA tolerance.
 * 3. A full audio export through `buildRender` with the derivative is the
 *    timeline length to the sample and starts the clip on its exact sample
 *    (`adelay …S`).
 *
 * Run: `bun src/verify-varispeed.ts`
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
	segmentDuration,
} from "../../shared/project.ts";
import {
	CURVE_SAMPLE_RATE,
	clipTimeAtSourceOffset,
	naturalCurveSpeed,
	sourceSpeedAt,
} from "../../shared/speed-curve.ts";
import { probe, runMedia } from "./media.ts";
import { buildRender } from "./render.ts";
import {
	CURVE_AUDIO_CHANNELS,
	curveAudioSamples,
	renderCurveAudio,
	WSOLA_TOLERANCE,
} from "./varispeed.ts";

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const RATE = CURVE_SAMPLE_RATE;
const SECONDS = 4;
const TONE = 1000;
const CLICKS = [0.61, 1.37, 2.05, 2.93, 3.48];
const CLICK_SECONDS = 0.006;
const BURST = 2000;
const BURST_LEVEL = 0.8;
const ONSET_LEVEL = 0.1;
const POINTS = [
	{ speed: 0.5, t: 0 },
	{ speed: 2, t: 0.5 },
	{ speed: 0.75, t: 1 },
];
/** Pitch error allowed per window, as a fraction of the expected frequency. */
const PITCH_TOLERANCE = 0.015;
const LEAD_SECONDS = 0.7;

/** Interleaved float samples of a 32-bit float WAV written by this module or FFmpeg. */
async function wavSamples(path: string): Promise<Float32Array> {
	const bytes = await readFile(path);
	let offset = 12;
	while (offset + 8 <= bytes.length) {
		const id = bytes.toString("ascii", offset, offset + 4);
		const size = bytes.readUInt32LE(offset + 4);
		if (id === "data") {
			const start = offset + 8;
			const end = Math.min(bytes.length, start + size);
			return new Float32Array(
				bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + end)
			);
		}
		offset += 8 + size + (size % 2);
	}
	throw new Error(`${path} has no data chunk`);
}

/** One channel of interleaved stereo. */
const channel = (samples: Float32Array, index: 0 | 1) =>
	Float32Array.from(
		{ length: samples.length / CURVE_AUDIO_CHANNELS },
		(_, frame) => samples[frame * CURVE_AUDIO_CHANNELS + index] ?? 0
	);
const left = (samples: Float32Array) => channel(samples, 0);
const right = (samples: Float32Array) => channel(samples, 1);

/** Source seconds into a burst where it first reaches `ONSET_LEVEL`. */
const ONSET_DELAY =
	Math.asin(ONSET_LEVEL / BURST_LEVEL) / (2 * Math.PI * BURST);

/**
 * The tone's frequency in `[from, to)` from interpolated upward zero
 * crossings.
 */
function toneFrequency(mono: Float32Array, from: number, to: number) {
	const crossings: number[] = [];
	for (
		let index = Math.max(1, from);
		index < Math.min(mono.length, to);
		index++
	) {
		const a = mono[index - 1] ?? 0;
		const b = mono[index] ?? 0;
		if (a < 0 && b >= 0) {
			crossings.push(index - 1 + a / (a - b));
		}
	}
	const first = crossings[0];
	const last = crossings.at(-1);
	if (!(first !== undefined && last !== undefined && crossings.length > 3)) {
		return Number.NaN;
	}
	return ((crossings.length - 1) * RATE) / (last - first);
}

/** Samples where the burst channel first reaches `ONSET_LEVEL` after 50 ms of quiet. */
function clickOnsets(mono: Float32Array): number[] {
	const found: number[] = [];
	let quiet = Number.POSITIVE_INFINITY;
	for (let index = 1; index < mono.length; index++) {
		const value = Math.abs(mono[index] ?? 0);
		if (value >= ONSET_LEVEL) {
			if (quiet > RATE * 0.05) {
				// Interpolate the crossing between the two samples.
				const previous = Math.abs(mono[index - 1] ?? 0);
				found.push(index - 1 + (ONSET_LEVEL - previous) / (value - previous));
			}
			quiet = 0;
		} else {
			quiet++;
		}
	}
	return found;
}

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-varispeed-"));
try {
	const sourceFile = join(directory, "tone.wav");
	const clicks = CLICKS.map(
		(at) =>
			`between(t\\,${at}\\,${at + CLICK_SECONDS})*${BURST_LEVEL}*sin(2*PI*${BURST}*(t-${at}))`
	).join("+");
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		`aevalsrc=0.3*sin(2*PI*${TONE}*t)|${clicks}:s=${RATE}:d=${SECONDS}`,
		"-c:a",
		"pcm_f32le",
		sourceFile,
	]);
	const asset: Asset = {
		...(await probe(sourceFile)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name: "Tone",
	};
	const clip = (preservePitch: boolean): Segment => ({
		...newSegment(asset, LEAD_SECONDS, 0),
		sourceOut: SECONDS,
		speed: naturalCurveSpeed(POINTS),
		speedCurve: preservePitch
			? { points: POINTS }
			: { points: POINTS, preservePitch: false },
	});
	const report: Record<string, unknown> = {};

	for (const preservePitch of [false, true]) {
		const name = preservePitch ? "pitch-kept" : "tape";
		const segment = clip(preservePitch);
		const output = join(directory, `${name}.wav`);
		await renderCurveAudio(segment, sourceFile, output);
		const samples = await wavSamples(output);
		const frames = samples.length / CURVE_AUDIO_CHANNELS;
		ensure(
			frames === curveAudioSamples(segment),
			`${name}: ${frames} samples, expected ${curveAudioSamples(segment)}`
		);
		const mono = left(samples);
		// Pitch of the left channel over 20 ms windows.
		const window = Math.round(RATE * 0.02);
		let worstPitch = 0;
		let windows = 0;
		for (
			let start = window;
			start + window < frames - window;
			start += window
		) {
			const middle = (start + window / 2) / RATE;
			const sourceMoment = CLICKS.map((at) =>
				clipTimeAtSourceOffset(segment, at)
			);
			if (sourceMoment.some((at) => Math.abs(at - middle) < 0.03)) {
				continue;
			}
			const offset = (() => {
				let low = 0;
				let high = SECONDS;
				for (let step = 0; step < 50; step++) {
					const mid = (low + high) / 2;
					if (clipTimeAtSourceOffset(segment, mid) < middle) {
						low = mid;
					} else {
						high = mid;
					}
				}
				return low;
			})();
			const expected = preservePitch
				? TONE
				: TONE * sourceSpeedAt(segment, offset);
			const measured = toneFrequency(mono, start, start + window);
			const error = Math.abs(measured - expected) / expected;
			ensure(
				Number.isFinite(measured) && error <= PITCH_TOLERANCE,
				`${name}: at ${middle.toFixed(3)}s the tone is ${measured.toFixed(1)} Hz, expected ${expected.toFixed(1)} Hz`
			);
			worstPitch = Math.max(worstPitch, error);
			windows++;
		}
		const onsets = clickOnsets(right(samples));
		ensure(
			onsets.length === CLICKS.length,
			`${name}: found ${onsets.length} clicks (${onsets.join(", ")}), expected ${CLICKS.length}`
		);
		const errors = CLICKS.map((at, index) => {
			const expected = clipTimeAtSourceOffset(segment, at + ONSET_DELAY) * RATE;
			return Math.abs((onsets[index] ?? 0) - expected);
		});
		const allowed = preservePitch ? WSOLA_TOLERANCE + 8 : 2;
		const worstClick = Math.max(...errors);
		ensure(
			worstClick <= allowed,
			`${name}: a click lands ${worstClick.toFixed(1)} samples off its curve position (allowed ${allowed})`
		);
		report[name] = {
			clickErrorSamples: errors.map((error) => Number(error.toFixed(1))),
			pitchWindows: windows,
			samples: frames,
			worstPitchErrorPercent: Number((worstPitch * 100).toFixed(3)),
		};
	}

	// The whole audio export with the tape-style derivative.
	const segment = clip(false);
	const project: Project = {
		...newProject("Varispeed proof"),
		segments: [segment],
	};
	const curveFile = join(directory, "tape.wav");
	const exported = join(directory, "export.wav");
	const args = buildRender(
		project,
		[asset],
		() => sourceFile,
		undefined,
		[],
		undefined,
		{
			audioOnly: true,
			curveAudio: new Map([[segment.id, curveFile]]),
			overrides: { container: "wav" },
		}
	).map((arg) => (arg === "pcm_s16le" ? "pcm_f32le" : arg));
	await runMedia([...args, exported], { cwd: directory });
	const mix = await wavSamples(exported);
	const exportFrames = mix.length / CURVE_AUDIO_CHANNELS;
	const timeline = Math.round((LEAD_SECONDS + segmentDuration(segment)) * RATE);
	ensure(
		Math.abs(exportFrames - timeline) <= 1,
		`the export holds ${exportFrames} samples, the timeline ${timeline}`
	);
	const exportOnsets = clickOnsets(right(mix));
	const lead = Math.round(LEAD_SECONDS * RATE);
	const tape = clickOnsets(right(await wavSamples(curveFile)));
	const shifted = exportOnsets.map(
		(onset, index) => onset - lead - (tape[index] ?? 0)
	);
	ensure(
		shifted.length === tape.length &&
			shifted.every((delta) => Math.abs(delta) < 0.05),
		`clicks in the export are offset from the derivative by ${shifted.join(", ")} samples`
	);
	report.export = { samples: exportFrames, timelineSamples: timeline };
	console.info(JSON.stringify(report, null, 2));
	console.info("verify-varispeed: ok");
} finally {
	await rm(directory, { force: true, recursive: true });
}
