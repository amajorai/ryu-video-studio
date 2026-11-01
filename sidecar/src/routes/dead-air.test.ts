import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { type Asset, newSegment } from "../../../shared/project.ts";
import { createStudioServer } from "../server.ts";
import { StudioStore } from "../store.ts";
import { clearVoiceActivityCache } from "../vad.ts";
import { speechFixtureAsset } from "../vad-fixture.ts";

type StudioRequestBody = z.infer<ReturnType<typeof z.json>>;

const stores: StudioStore[] = [];
const servers: ReturnType<typeof createStudioServer>[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.stop();
	}
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

async function studio() {
	const store = new StudioStore(await mkdtemp(join(tmpdir(), "ryu-dead-air-")));
	stores.push(store);
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, store, token });
	servers.push(app);
	const call = async (path: string, body: StudioRequestBody) => {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio${path}`,
			{
				body: JSON.stringify(body),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		return { body: await response.json(), status: response.status };
	};
	return { call, store };
}

/** Words cover every fixture burst except 1.7-2.6 s, which VAD still hears. */
function transcribe(store: StudioStore, asset: Asset) {
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
	const running = store.beginTranscript(asset);
	store.appendTranscript(
		asset.id,
		running.revision,
		0,
		words,
		"segments",
		words.map((word) => ({ ...word, id: crypto.randomUUID() }))
	);
}

test("dead-air-plan with vad keeps only pauses voice activity agrees with", async () => {
	const { call, store } = await studio();
	const asset = await speechFixtureAsset(store);
	transcribe(store, asset);
	const project = store.save({
		...store.create("Dead air"),
		segments: [newSegment(asset, 0, 0)],
	});
	const base = { keepPause: 0, padding: 0 };
	const plain = await call(`/projects/${project.id}/dead-air-plan`, base);
	expect(plain.status).toBe(200);
	expect(plain.body.vad).toBeUndefined();
	expect(plain.body.ranges).toEqual([
		{ end: 6.15, start: 4.85 },
		{ end: 3.45, start: 1.15 },
	]);
	const confirmed = await call(`/projects/${project.id}/dead-air-plan`, {
		...base,
		vad: true,
	});
	expect(confirmed.status).toBe(200);
	expect(confirmed.body.revision).toBe(project.revision);
	expect(confirmed.body.vad).toEqual({ analyzed: 1, skipped: 0 });
	expect(confirmed.body.ranges).toHaveLength(3);
	const [late, middle, early] = confirmed.body.ranges;
	expect(late.start).toBeCloseTo(4.9, 1);
	expect(middle.start).toBeCloseTo(2.6, 1);
	expect(middle.end).toBeCloseTo(3.4, 1);
	expect(early.end).toBeCloseTo(1.7, 1);
	expect(confirmed.body.removedSeconds).toBeLessThan(plain.body.removedSeconds);
	expect(store.project(project.id).revision).toBe(project.revision);
});

test("muted clips never contribute speech and sources without audio are skipped", async () => {
	const { call, store } = await studio();
	const asset = await speechFixtureAsset(store);
	transcribe(store, asset);
	const music = await speechFixtureAsset(store, {
		name: "Constant voice",
		speech: [[0, 7]],
	});
	const project = store.save({
		...store.create("Muted"),
		segments: [
			newSegment(asset, 0, 0),
			{ ...newSegment(music, 0, 1), muted: true },
		],
	});
	const confirmed = await call(`/projects/${project.id}/dead-air-plan`, {
		keepPause: 0,
		padding: 0,
		vad: true,
	});
	expect(confirmed.status).toBe(200);
	expect(confirmed.body.vad).toEqual({ analyzed: 1, skipped: 0 });
	expect(confirmed.body.ranges).toHaveLength(3);

	const silent: Asset = { ...asset, hasAudio: false, id: crypto.randomUUID() };
	store.putAsset(silent);
	const withSilent = store.save({
		...store.project(project.id),
		segments: [newSegment(asset, 0, 0), newSegment(silent, 0, 2)],
	});
	const skipped = await call(`/projects/${withSilent.id}/dead-air-plan`, {
		vad: true,
	});
	expect(skipped.status).toBe(200);
	expect(skipped.body.vad).toEqual({ analyzed: 1, skipped: 1 });
});

test("speech on muted or solo-silenced tracks never cancels a pause", async () => {
	const { call, store } = await studio();
	const asset = await speechFixtureAsset(store);
	transcribe(store, asset);
	const voice = await speechFixtureAsset(store, {
		name: "Constant voice",
		speech: [[0, 7]],
	});
	const track = { locked: false, muted: false, name: "Track", solo: false };
	const segments = [newSegment(asset, 0, 0), newSegment(voice, 0, 1)];
	const body = { keepPause: 0, padding: 0, vad: true };

	const mutedTrack = store.save({
		...store.create("Muted track"),
		segments,
		trackSettings: [{ ...track, muted: true, track: 1 }],
	});
	const muted = await call(`/projects/${mutedTrack.id}/dead-air-plan`, body);
	expect(muted.status).toBe(200);
	expect(muted.body.vad).toEqual({ analyzed: 1, skipped: 0 });
	expect(muted.body.ranges).toHaveLength(3);

	const soloTrack = store.save({
		...store.create("Solo"),
		segments,
		trackSettings: [{ ...track, solo: true, track: 0 }],
	});
	const solo = await call(`/projects/${soloTrack.id}/dead-air-plan`, body);
	expect(solo.status).toBe(200);
	expect(solo.body.vad).toEqual({ analyzed: 1, skipped: 0 });
	expect(solo.body.ranges).toHaveLength(3);

	const audible = store.save({
		...store.create("Both audible"),
		segments,
	});
	const both = await call(`/projects/${audible.id}/dead-air-plan`, body);
	expect(both.body.vad).toEqual({ analyzed: 2, skipped: 0 });
	expect(both.body.ranges).toEqual([]);
});

test("dead-air-plan rejects invalid VAD settings", async () => {
	const { call, store } = await studio();
	const project = store.save(store.create("Bad"));
	const response = await call(`/projects/${project.id}/dead-air-plan`, {
		threshold: 100,
		vad: true,
	});
	expect(response.status).toBe(400);
});
