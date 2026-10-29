import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Asset } from "../../../shared/project.ts";
import { assetBeats } from "../beats.ts";
import { runMedia } from "../media.ts";
import { createStudioServer } from "../server.ts";
import { StudioStore } from "../store.ts";
import { BEAT_SOURCE_HEADER, routes } from "./beats.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-beats-"));
	const store = new StudioStore(directory);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0, routes });
	cleanup.push(async () => {
		app.stop();
		store.close();
		await rm(directory, { force: true, recursive: true });
	});
	const get = (path: string) =>
		fetch(`http://127.0.0.1:${app.server.port}/api/video-studio${path}`, {
			headers: { authorization: `Bearer ${token}` },
		});
	return { get, store };
}

function audioAsset(duration: number): Asset {
	return {
		createdAt: new Date().toISOString(),
		duration,
		hasAudio: true,
		height: 0,
		id: crypto.randomUUID(),
		kind: "audio",
		name: "Kick loop",
		width: 0,
	};
}

/** A 128 BPM kick (60 Hz thump plus a 2 kHz tick), accented on each bar start. */
const kick128 = (seconds: number, rate: number) =>
	`aevalsrc=(1+lt(mod(t\\,1.875)\\,0.46875))*(0.45*exp(-30*mod(t\\,0.46875))*sin(2*PI*60*mod(t\\,0.46875))+0.25*exp(-200*mod(t\\,0.46875))*sin(2*PI*2000*t)):s=${rate}:d=${seconds}`;

async function kickFixture(store: StudioStore, seconds = 16, rate = 44_100) {
	const asset = audioAsset(seconds);
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-y",
		"-f",
		"lavfi",
		"-i",
		kick128(seconds, rate),
		"-c:a",
		"pcm_s16le",
		"-f",
		"wav",
		store.mediaPath(asset.id),
	]);
	store.putAsset(asset);
	return asset;
}

function completedAnalysis(asset: Asset) {
	return {
		assetId: asset.id,
		createdAt: new Date().toISOString(),
		duration: asset.duration,
		sceneCuts: [],
		status: "completed" as const,
		waveform: Array.from({ length: 20 }, (_, index) =>
			[1, 5, 9, 13, 17].includes(index) ? 0.9 : 0.08
		),
	};
}

const detectedSchema = z
	.object({
		analyzedDuration: z.number(),
		analyzedFrom: z.number().optional(),
		assetId: z.string(),
		beats: z.array(z.number()),
		bpm: z.number(),
		confidence: z.number(),
		downbeats: z.array(z.number()),
		method: z.literal("spectral-flux"),
		times: z.array(z.number()),
	})
	.strict();

test("detects 128 BPM in a generated kick loop and caches it", async () => {
	const { get, store } = await setup();
	const asset = await kickFixture(store);
	store.putAnalysis(completedAnalysis(asset));
	const response = await get(`/assets/${asset.id}/beats`);
	expect(response.status).toBe(200);
	expect(response.headers.get(BEAT_SOURCE_HEADER)).toBe("detected");
	const body = detectedSchema.parse(await response.json());
	expect(Math.abs(body.bpm - 128)).toBeLessThanOrEqual(1);
	expect(body.times).toEqual(body.beats);
	expect(body.beats.length).toBeGreaterThanOrEqual(30);
	// Bars start at 0, 1.875, 3.75, ...: every downbeat sits on one.
	for (const downbeat of body.downbeats) {
		const bar = downbeat / 1.875;
		expect(Math.abs(bar - Math.round(bar)) * 1.875).toBeLessThan(0.035);
	}
	expect(store.analysis(asset.id)?.beats?.bpm).toBe(body.bpm);

	const cached = await get(`/assets/${asset.id}/beats`);
	expect(cached.headers.get(BEAT_SOURCE_HEADER)).toBe("cache");
	expect(await cached.json()).toEqual(body);

	const refreshed = await get(`/assets/${asset.id}/beats?refresh=1`);
	expect(refreshed.headers.get(BEAT_SOURCE_HEADER)).toBe("detected");
	expect(await refreshed.json()).toEqual(body);
});

test("falls back to the envelope estimate when the media cannot be decoded", async () => {
	const { get, store } = await setup();
	const asset = audioAsset(10);
	store.putAsset(asset);
	store.putAnalysis(completedAnalysis(asset));
	const response = await get(`/assets/${asset.id}/beats`);
	expect(response.status).toBe(200);
	expect(response.headers.get(BEAT_SOURCE_HEADER)).toBe("estimate");
	expect(response.headers.get(`${BEAT_SOURCE_HEADER}-reason`)).toBe(
		"detection-failed"
	);
	expect(await response.json()).toEqual({
		assetId: asset.id,
		times: [0.75, 2.75, 4.75, 6.75, 8.75],
	});
	expect(store.analysis(asset.id)?.beats).toBeUndefined();
});

test("falls back without decoding when the media has no audio", async () => {
	const { get, store } = await setup();
	const asset = { ...audioAsset(10), hasAudio: false };
	store.putAsset(asset);
	store.putAnalysis(completedAnalysis(asset));
	const response = await get(`/assets/${asset.id}/beats`);
	expect(response.headers.get(`${BEAT_SOURCE_HEADER}-reason`)).toBe("no-audio");
});

test("requires completed analysis", async () => {
	const { get, store } = await setup();
	const asset = audioAsset(10);
	store.putAsset(asset);
	const response = await get(`/assets/${asset.id}/beats`);
	expect(response.status).toBe(400);
	expect(await response.text()).toContain("Complete source analysis");
});

test("detects over the source span a late clip plays", async () => {
	const { get, store } = await setup();
	// 11 minutes: longer than one detection window.
	const asset = await kickFixture(store, 660, 11_025);
	store.putAnalysis(completedAnalysis(asset));
	const response = await get(`/assets/${asset.id}/beats?from=620&to=650`);
	expect(response.headers.get(BEAT_SOURCE_HEADER)).toBe("detected");
	const body = detectedSchema.parse(await response.json());
	expect(body.analyzedFrom).toBe(60);
	expect(Math.abs(body.bpm - 128)).toBeLessThanOrEqual(1);
	const late = body.beats.filter((beat) => beat >= 620 && beat <= 650);
	expect(late.length).toBeGreaterThanOrEqual(60);
	for (const beat of late) {
		const step = beat / 0.468_75;
		expect(Math.abs(step - Math.round(step)) * 0.468_75).toBeLessThan(0.035);
	}
	const again = await get(`/assets/${asset.id}/beats?from=630&to=640`);
	expect(again.headers.get(BEAT_SOURCE_HEADER)).toBe("cache");
	// The first minute lies outside the cached window, so it is detected anew.
	const early = await get(`/assets/${asset.id}/beats?from=0&to=30`);
	expect(early.headers.get(BEAT_SOURCE_HEADER)).toBe("detected");
	expect(detectedSchema.parse(await early.json()).analyzedFrom).toBeUndefined();
}, 30_000);

test("estimates spans longer than a detection window and rejects bad ranges", async () => {
	const { get, store } = await setup();
	const asset = audioAsset(1200);
	store.putAsset(asset);
	store.putAnalysis(completedAnalysis(asset));
	const long = await get(`/assets/${asset.id}/beats?from=0&to=900`);
	expect(long.headers.get(`${BEAT_SOURCE_HEADER}-reason`)).toBe(
		"range-too-long"
	);
	const backwards = await get(`/assets/${asset.id}/beats?from=50&to=10`);
	expect(backwards.status).toBe(400);
	const invalid = await get(`/assets/${asset.id}/beats?from=abc`);
	expect(invalid.status).toBe(400);
});

test("one caller canceling does not cancel a detection others share", async () => {
	const { store } = await setup();
	const asset = await kickFixture(store);
	store.putAnalysis(completedAnalysis(asset));
	const first = new AbortController();
	const second = new AbortController();
	const canceled = assetBeats(store, asset, { signal: first.signal });
	const kept = assetBeats(store, asset, { signal: second.signal });
	first.abort();
	const [outcome, result] = await Promise.all([
		canceled.then(
			() => "resolved",
			(error: unknown) => (error instanceof Error ? error.message : "")
		),
		kept,
	]);
	expect(outcome).toBe("Media operation canceled.");
	expect(result.source).toBe("detected");
	expect(result.fallbackReason).toBeUndefined();
	expect(store.analysis(asset.id)?.beats?.bpm).toBeCloseTo(128, 0);
});

test("a detection everyone abandons stops, and the next request starts afresh", async () => {
	const { store } = await setup();
	const asset = await kickFixture(store);
	store.putAnalysis(completedAnalysis(asset));
	const first = new AbortController();
	const second = new AbortController();
	const one = assetBeats(store, asset, { signal: first.signal });
	const two = assetBeats(store, asset, { signal: second.signal });
	first.abort();
	second.abort();
	const settled = await Promise.allSettled([one, two]);
	expect(settled.map((outcome) => outcome.status)).toEqual([
		"rejected",
		"rejected",
	]);
	const fresh = await assetBeats(store, asset);
	expect(fresh.source).toBe("detected");
});
