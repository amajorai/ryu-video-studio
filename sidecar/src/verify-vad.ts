/**
 * Real-FFmpeg proof for voice-activity detection.
 *
 * 1. A speech-like fixture with three known pauses yields exactly three VAD
 *    spans whose edges are within 50 ms of the truth (padding 0), and padding
 *    shrinks each span by the requested margin.
 * 2. The same audio muxed into a video container gives the same spans.
 * 3. `GET /assets/:id/silence` serves the spans; `dead-air-plan` with
 *    `vad: true` keeps only pauses VAD agrees with.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSegment } from "../../shared/project.ts";
import { vadSilence, vadSilenceQuery } from "../../shared/vad.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";
import { voiceActivityFeatures } from "./vad.ts";
import { speechFixtureAsset, VAD_FIXTURE_PAUSES } from "./vad-fixture.ts";

const TOLERANCE = 0.05;

/** Why `ranges` miss `expected` by more than 50 ms, or undefined when they match. */
function spanMismatch(
	ranges: readonly [number, number][],
	expected: readonly (readonly [number, number])[],
	label: string
): string | undefined {
	if (ranges.length !== expected.length) {
		return `${label}: ${ranges.length} spans, expected ${expected.length}`;
	}
	for (const [index, [start, end]] of expected.entries()) {
		const span = ranges[index];
		if (
			!span ||
			Math.abs(span[0] - start) > TOLERANCE ||
			Math.abs(span[1] - end) > TOLERANCE
		) {
			return `${label}: span ${index} ${JSON.stringify(span)} vs ${JSON.stringify([start, end])}`;
		}
	}
	return undefined;
}

async function test(_name: string, run: () => Promise<void>) {
	await run();
}

interface DeadAirResponse {
	ranges: { end: number; start: number }[];
	vad?: { analyzed: number; skipped: number };
}

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-vad-"));
const store = new StudioStore(directory);
const token = crypto.randomUUID();
const app = createStudioServer({ port: 0, store, token });
const base = `http://127.0.0.1:${app.server.port}/api/video-studio`;
const headers = { authorization: `Bearer ${token}` };
try {
	const audio = await speechFixtureAsset(store, { name: "Voice" });

	await test("three known pauses yield three spans within 50 ms", async () => {
		const features = await voiceActivityFeatures(store, audio);
		const bare = vadSilence(features, { padding: 0 });
		console.log(
			`audio: floor ${bare.noiseFloorDb} dB, spans ${JSON.stringify(bare.ranges)}`
		);
		assert.equal(
			spanMismatch(bare.ranges, VAD_FIXTURE_PAUSES, "audio"),
			undefined
		);
		const padded = vadSilence(features, { padding: 0.08 }).ranges;
		const shrunk = VAD_FIXTURE_PAUSES.map(
			([start, end]) => [start + 0.08, end - 0.08] as const
		);
		assert.equal(spanMismatch(padded, shrunk, "padded"), undefined);
	});

	await test("video containers give the same spans", async () => {
		const video = await speechFixtureAsset(store, {
			name: "Camera",
			video: true,
		});
		const ranges = vadSilence(await voiceActivityFeatures(store, video), {
			padding: 0,
		}).ranges;
		console.log(`video: spans ${JSON.stringify(ranges)}`);
		assert.equal(spanMismatch(ranges, VAD_FIXTURE_PAUSES, "video"), undefined);
	});

	await test("the silence route serves VAD spans", async () => {
		const response = await fetch(
			`${base}/assets/${audio.id}/silence?${vadSilenceQuery({ padding: 0 })}`,
			{ headers }
		);
		assert.equal(response.status, 200);
		const body = (await response.json()) as { ranges: [number, number][] };
		assert.equal(
			spanMismatch(body.ranges, VAD_FIXTURE_PAUSES, "route"),
			undefined
		);
	});

	await test("dead-air-plan with vad splits a pause around unlabeled speech", async () => {
		// Words cover every burst except 1.7-2.6 s, so the transcript alone sees
		// one long pause from 1.15 s to 3.45 s; VAD hears the second burst.
		const project = store.save({
			...store.create("VAD dead air"),
			segments: [newSegment(audio, 0, 0)],
		});
		const words = [
			[0.1, 1.15],
			[3.45, 4.85],
			[6.15, 6.95],
		].map(([start = 0, end = 0], index) => ({
			end,
			id: crypto.randomUUID(),
			start,
			text: `w${index}`,
		}));
		const running = store.beginTranscript(audio);
		store.appendTranscript(
			audio.id,
			running.revision,
			0,
			words,
			"segments",
			words.map((word) => ({ ...word, id: crypto.randomUUID() }))
		);
		const plan = async (vad: boolean): Promise<DeadAirResponse> => {
			const response = await fetch(
				`${base}/projects/${project.id}/dead-air-plan`,
				{
					body: JSON.stringify({ keepPause: 0, padding: 0, vad }),
					headers: { ...headers, "content-type": "application/json" },
					method: "POST",
				}
			);
			assert.equal(response.status, 200);
			return (await response.json()) as DeadAirResponse;
		};
		const transcriptOnly = await plan(false);
		const confirmed = await plan(true);
		console.log(
			`dead air: transcript ${JSON.stringify(transcriptOnly.ranges)}, vad ${JSON.stringify(confirmed.ranges)}`
		);
		assert.ok(
			transcriptOnly.ranges.some((range) => range.end - range.start > 2),
			"the transcript-only plan sees the merged pause"
		);
		assert.deepEqual(confirmed.vad, { analyzed: 1, skipped: 0 });
		const asSpans = confirmed.ranges
			.map((range) => [range.start, range.end] as [number, number])
			.reverse();
		assert.equal(
			spanMismatch(asSpans, VAD_FIXTURE_PAUSES, "dead air"),
			undefined
		);
	});
	console.log("verify-vad: ok");
} finally {
	app.stop();
	store.close();
	await rm(directory, { force: true, recursive: true });
}
