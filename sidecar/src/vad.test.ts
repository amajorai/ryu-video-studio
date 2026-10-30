import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vadSilence } from "../../shared/vad.ts";
import { StudioStore } from "./store.ts";
import {
	clearVoiceActivityCache,
	MAX_VAD_SOURCE_SECONDS,
	SPEECH_BAND_FILTERS,
	vadAudioFilters,
	vadExtractionArgs,
	vadRefusal,
	voiceActivityFeatures,
} from "./vad.ts";
import { speechFixtureAsset, VAD_FIXTURE_PAUSES } from "./vad-fixture.ts";

const stores: StudioStore[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) {
		clearVoiceActivityCache(store);
		store.close();
		await rm(store.directory, {
			force: true,
			recursive: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

async function makeStore() {
	const store = new StudioStore(await mkdtemp(join(tmpdir(), "ryu-vad-")));
	stores.push(store);
	return store;
}

test("extraction band-limits to 16 kHz mono and only adds RNNoise for plain paths", () => {
	expect(vadAudioFilters()).toBe(SPEECH_BAND_FILTERS);
	expect(vadAudioFilters("/models/std.rnnn")).toBe(
		`aresample=48000,arnndn=m=/models/std.rnnn,${SPEECH_BAND_FILTERS}`
	);
	expect(vadAudioFilters("/models/it's:bad.rnnn")).toBe(SPEECH_BAND_FILTERS);
	const args = vadExtractionArgs("/in.mov", "/out.pcm", 12.5);
	expect(args.slice(args.indexOf("-af"), args.indexOf("-af") + 2)).toEqual([
		"-af",
		"highpass=f=120,lowpass=f=4000",
	]);
	expect(args).toContain("16000");
	expect(args.at(-1)).toBe("/out.pcm");
	expect(args[args.indexOf("-map") + 1]).toBe("0:a:0");
});

test("sources without audio or over the length limit are refused", async () => {
	const store = await makeStore();
	const asset = await speechFixtureAsset(store);
	expect(vadRefusal(asset)).toBeUndefined();
	expect(vadRefusal({ ...asset, hasAudio: false })).toMatch(/no audio/);
	expect(
		vadRefusal({ ...asset, duration: MAX_VAD_SOURCE_SECONDS + 1 })
	).toMatch(/six hours/);
	await expect(
		voiceActivityFeatures(store, { ...asset, hasAudio: false })
	).rejects.toThrow(/no audio/);
});

test("features come from real FFmpeg, are cached, and refresh when media changes", async () => {
	const store = await makeStore();
	const asset = await speechFixtureAsset(store);
	const [first, concurrent] = await Promise.all([
		voiceActivityFeatures(store, asset),
		voiceActivityFeatures(store, asset),
	]);
	expect(concurrent).toBe(first);
	expect(first.duration).toBeCloseTo(asset.duration, 1);
	expect(vadSilence(first, { padding: 0 }).ranges).toHaveLength(
		VAD_FIXTURE_PAUSES.length
	);
	expect(await voiceActivityFeatures(store, asset)).toBe(first);
	const replacement = await speechFixtureAsset(store, {
		speech: [[0, asset.duration]],
	});
	await Bun.sleep(5);
	await Bun.write(
		store.mediaPath(asset.id),
		Bun.file(store.mediaPath(replacement.id))
	);
	const refreshed = await voiceActivityFeatures(store, asset);
	expect(refreshed).not.toBe(first);
	expect(vadSilence(refreshed, { padding: 0 }).ranges).toHaveLength(0);
});
