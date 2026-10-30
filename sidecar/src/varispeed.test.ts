import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newProject, newSegment, type Segment } from "../../shared/project.ts";
import {
	CURVE_SAMPLE_RATE,
	clipTimeAtSourceOffset,
	naturalCurveSpeed,
} from "../../shared/speed-curve.ts";
import { runMedia } from "./media.ts";
import {
	CURVE_AUDIO_CHANNELS,
	CURVE_AUDIO_TIMEOUT_MESSAGE,
	curveAudioBytes,
	curveAudioSamples,
	curveMapping,
	floatWavHeader,
	memorySource,
	prepareCurveAudio,
	renderCurveAudio,
	renderStretchedAudio,
	renderTapeAudio,
	SILENT_CURVE_AUDIO,
	WSOLA_TOLERANCE,
} from "./varispeed.ts";

const RATE = CURVE_SAMPLE_RATE;
const asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 2,
	hasAudio: true,
	height: 0,
	id: "00000000-0000-4000-8000-0000000000d1",
	kind: "audio" as const,
	name: "Tone",
	width: 0,
};

function curved(points: { speed: number; t: number }[]): Segment {
	return {
		...newSegment(asset),
		sourceOut: 2,
		speed: naturalCurveSpeed(points),
		speedCurve: { points },
	};
}

/** Two seconds of stereo: a ramp on the left, an impulse at 0.5 s on the right. */
function source(): Float32Array {
	const frames = 2 * RATE;
	const data = new Float32Array(frames * CURVE_AUDIO_CHANNELS);
	for (let frame = 0; frame < frames; frame++) {
		data[frame * 2] = Math.sin((2 * Math.PI * 440 * frame) / RATE) * 0.5;
	}
	data[RATE * 0.5 * 2 + 1] = 1;
	return data;
}

async function collect(
	render: typeof renderTapeAudio,
	segment: Segment
): Promise<Float32Array> {
	const blocks: Float32Array[] = [];
	await render(
		memorySource(source()),
		curveMapping(segment, 0),
		curveAudioSamples(segment),
		(block) => {
			blocks.push(block);
		}
	);
	const out = new Float32Array(
		blocks.reduce((total, block) => total + block.length, 0)
	);
	let offset = 0;
	for (const block of blocks) {
		out.set(block, offset);
		offset += block.length;
	}
	return out;
}

describe("speed-curve audio", () => {
	test("is exactly as many samples as the clip", async () => {
		const segment = curved([
			{ speed: 0.5, t: 0 },
			{ speed: 3, t: 1 },
		]);
		for (const render of [renderTapeAudio, renderStretchedAudio]) {
			const out = await collect(render, segment);
			expect(out.length / CURVE_AUDIO_CHANNELS).toBe(
				curveAudioSamples(segment)
			);
		}
	});

	test("a flat 1x curve passes the source through unchanged", async () => {
		const segment = curved([
			{ speed: 1, t: 0 },
			{ speed: 1, t: 1 },
		]);
		const input = source();
		for (const render of [renderTapeAudio, renderStretchedAudio]) {
			const out = await collect(render, segment);
			let worst = 0;
			// Away from the edges, where the source window ends.
			for (let index = 2048; index < out.length - 2048; index++) {
				worst = Math.max(
					worst,
					Math.abs((out[index] ?? 0) - (input[index] ?? 0))
				);
			}
			expect(worst).toBeLessThan(1e-4);
		}
	});

	test("tape-style places the impulse on the curve's sample", async () => {
		const segment = curved([
			{ speed: 0.5, t: 0 },
			{ speed: 2, t: 1 },
		]);
		const out = await collect(renderTapeAudio, segment);
		let peak = 0;
		let at = 0;
		for (let frame = 0; frame < out.length / 2; frame++) {
			const value = Math.abs(out[frame * 2 + 1] ?? 0);
			if (value > peak) {
				peak = value;
				at = frame;
			}
		}
		expect(
			Math.abs(at - clipTimeAtSourceOffset(segment, 0.5) * RATE)
		).toBeLessThanOrEqual(1);
	});

	test("pitch-kept grains stay within the tolerance of the curve", async () => {
		const segment = curved([
			{ speed: 0.5, t: 0 },
			{ speed: 2, t: 1 },
		]);
		const out = await collect(renderStretchedAudio, segment);
		let first = -1;
		for (let frame = 0; frame < out.length / 2; frame++) {
			if (Math.abs(out[frame * 2 + 1] ?? 0) > 0.05) {
				first = frame;
				break;
			}
		}
		const expected = clipTimeAtSourceOffset(segment, 0.5) * RATE;
		expect(first).toBeGreaterThan(0);
		expect(Math.abs(first - expected)).toBeLessThanOrEqual(
			WSOLA_TOLERANCE + 512
		);
	});

	test("writes a float stereo WAV header for the exact length", () => {
		const header = new DataView(floatWavHeader(1000).buffer);
		expect(header.getUint16(20, true)).toBe(3);
		expect(header.getUint16(22, true)).toBe(2);
		expect(header.getUint32(24, true)).toBe(RATE);
		expect(header.getUint32(40, true)).toBe(1000 * 2 * 4);
	});
});

describe("curve-audio export limits", () => {
	const work = mkdtempSync(join(tmpdir(), "ryu-varispeed-test-"));
	afterAll(() =>
		rmSync(work, {
			force: true,
			recursive: true,
			maxRetries: 10,
			retryDelay: 100,
		})
	);
	const tone = join(work, "tone.wav");
	const long = join(work, "long.wav");
	const media = async () => {
		if (!existsSync(tone)) {
			await runMedia(["-y", "-f", "lavfi", "-i", "sine=f=440:d=2", tone]);
			await runMedia(["-y", "-f", "lavfi", "-i", "sine=f=440:d=120", long]);
		}
	};
	const points = [
		{ speed: 0.5, t: 0 },
		{ speed: 2, t: 1 },
	];
	const clip = (id: string, start: number): Segment => ({
		...curved(points),
		id,
		start,
	});

	test("only clips the export range can hear are rendered", async () => {
		await media();
		const heard = clip("00000000-0000-4000-8000-0000000000e1", 0);
		const later = clip("00000000-0000-4000-8000-0000000000e2", 100);
		const project = { ...newProject("Curves"), segments: [heard, later] };
		const directory = join(work, "range");
		const prepared = await prepareCurveAudio(
			project,
			[asset],
			() => tone,
			directory,
			{ range: { end: 10, start: 0 } }
		);
		expect(prepared.get(later.id)).toBe(SILENT_CURVE_AUDIO);
		expect(prepared.get(heard.id)).toBe(
			join(directory, `curve-audio-${heard.id}.wav`)
		);
		expect(readdirSync(directory)).toEqual([`curve-audio-${heard.id}.wav`]);
	});

	test("the budget is checked before any file is written", async () => {
		await media();
		const segment = clip("00000000-0000-4000-8000-0000000000e3", 0);
		const project = { ...newProject("Curves"), segments: [segment] };
		const directory = join(work, "budget");
		await expect(
			prepareCurveAudio(project, [asset], () => tone, directory, {
				budgetBytes: curveAudioBytes(segment) - 1,
			})
		).rejects.toThrow("Speed-curve audio needs");
		expect(existsSync(directory)).toBe(false);
	});

	test("FFmpeg is stopped at the operation's deadline", async () => {
		await media();
		const segment = {
			...clip("00000000-0000-4000-8000-0000000000e4", 0),
			sourceOut: 120,
		};
		const output = join(work, "deadline.wav");
		await expect(
			renderCurveAudio(segment, long, output, { remainingMs: () => 0 })
		).rejects.toThrow(CURVE_AUDIO_TIMEOUT_MESSAGE);
		const started = performance.now();
		await expect(
			renderCurveAudio(segment, long, output, { remainingMs: () => 20 })
		).rejects.toThrow(CURVE_AUDIO_TIMEOUT_MESSAGE);
		expect(performance.now() - started).toBeLessThan(5000);
		expect(existsSync(output)).toBe(false);
	});
});
