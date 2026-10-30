import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vadSilenceQuery } from "../../../shared/vad.ts";
import { createStudioServer, openapi } from "../server.ts";
import { StudioStore } from "../store.ts";
import { clearVoiceActivityCache } from "../vad.ts";
import { speechFixtureAsset, VAD_FIXTURE_PAUSES } from "../vad-fixture.ts";
import { parseSilenceQuery } from "./silence.ts";

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
	const store = new StudioStore(await mkdtemp(join(tmpdir(), "ryu-silence-")));
	stores.push(store);
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, store, token });
	servers.push(app);
	const get = async (path: string) => {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio${path}`,
			{ headers: { authorization: `Bearer ${token}` } }
		);
		return { body: await response.json(), status: response.status };
	};
	return { get, store };
}

test("the query selects VAD when any VAD parameter is present", () => {
	expect(parseSilenceQuery(new URLSearchParams()).method).toBe("rms");
	expect(parseSilenceQuery(new URLSearchParams("padding=0")).method).toBe(
		"vad"
	);
	expect(
		parseSilenceQuery(new URLSearchParams("method=rms&threshold=20")).method
	).toBe("rms");
	expect(
		parseSilenceQuery(new URLSearchParams("threshold=20&minPause=1")).params
	).toEqual({ minPause: 1, minSpeech: 0.1, padding: 0.05, threshold: 20 });
	expect(() => parseSilenceQuery(new URLSearchParams("threshold=0"))).toThrow();
	expect(() => parseSilenceQuery(new URLSearchParams("padding=x"))).toThrow();
	expect(() => parseSilenceQuery(new URLSearchParams("other=1"))).toThrow();
});

test("GET silence returns VAD spans for three known pauses within 50 ms", async () => {
	const { get, store } = await studio();
	const asset = await speechFixtureAsset(store);
	const response = await get(
		`/assets/${asset.id}/silence?${vadSilenceQuery({ padding: 0 })}`
	);
	expect(response.status).toBe(200);
	expect(response.body.assetId).toBe(asset.id);
	expect(response.body.method).toBe("vad");
	expect(response.body.params.padding).toBe(0);
	expect(typeof response.body.noiseFloorDb).toBe("number");
	expect(response.body.ranges).toHaveLength(3);
	for (const [index, [start, end]] of VAD_FIXTURE_PAUSES.entries()) {
		const [spanStart, spanEnd] = response.body.ranges[index];
		expect(Math.abs(spanStart - start)).toBeLessThanOrEqual(0.05);
		expect(Math.abs(spanEnd - end)).toBeLessThanOrEqual(0.05);
	}
	const strict = await get(
		`/assets/${asset.id}/silence?minPause=0.6&padding=0`
	);
	expect(strict.body.ranges).toHaveLength(2);
});

test("GET silence refuses media without audio and bad parameters", async () => {
	const { get, store } = await studio();
	const source = await speechFixtureAsset(store);
	const asset = { ...source, hasAudio: false, id: crypto.randomUUID() };
	store.putAsset(asset);
	await Bun.write(
		store.mediaPath(asset.id),
		Bun.file(store.mediaPath(source.id))
	);
	const silent = await get(`/assets/${asset.id}/silence?method=vad`);
	expect(silent.status).toBe(400);
	expect(silent.body.message).toMatch(/no audio/);
	const bad = await get(`/assets/${asset.id}/silence?threshold=99`);
	expect(bad.status).toBe(400);
	const legacy = await get(`/assets/${asset.id}/silence`);
	expect(legacy.status).toBe(400);
	expect(legacy.body.message).toMatch(/Complete source analysis/);
});

test("the silence operation documents its VAD query parameters", () => {
	const operation =
		openapi().paths["/api/video-studio/assets/{id}/silence"]?.get;
	const names = operation?.parameters?.map((parameter) => parameter.name);
	expect(names).toEqual([
		"id",
		"method",
		"threshold",
		"minPause",
		"padding",
		"minSpeech",
	]);
});
