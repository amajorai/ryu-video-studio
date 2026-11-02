import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	type Asset,
	activeCaptions,
	type Project,
	projectSchema,
} from "../../../shared/project.ts";
import { createStudioServer, openapi } from "../server.ts";
import { StudioStore } from "../store.ts";
import { routes } from "./script-to-video.ts";

const stores: StudioStore[] = [];
const servers: ReturnType<typeof createStudioServer>[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.stop();
	}
	for (const store of stores.splice(0)) {
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
	const store = new StudioStore(await mkdtemp(join(tmpdir(), "ryu-script-")));
	stores.push(store);
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, store, token });
	servers.push(app);
	const call = async (path: string, body?: unknown) => {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio${path}`,
			{
				body: body === undefined ? undefined : JSON.stringify(body),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: body === undefined ? "GET" : "POST",
			}
		);
		return {
			body: (await response.json()) as Record<string, unknown>,
			status: response.status,
		};
	};
	return { call, store };
}

function register(
	store: StudioStore,
	kind: Asset["kind"],
	duration: number
): Asset {
	const asset: Asset = {
		createdAt: new Date().toISOString(),
		duration,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : 720,
		id: crypto.randomUUID(),
		kind,
		name: `${kind}-${duration}`,
		width: kind === "audio" ? 0 : 1280,
	};
	store.putAsset(asset);
	return asset;
}

test("the route module registers one documented project route", () => {
	expect(routes).toHaveLength(1);
	const [route] = routes;
	expect(route?.scope).toBe("project");
	expect(route?.method).toBe("POST");
	expect(route?.operation.id).toBe("video_studio_script_assemble");
});

test("script-assemble places narration and visuals and times captions to the transcript", async () => {
	const { call, store } = await studio();
	const voice = register(store, "audio", 3);
	const still = register(store, "image", 0);
	const video = register(store, "video", 8);
	const begun = store.beginTranscript(voice);
	const word = (start: number, end: number, text: string) => ({
		end,
		id: crypto.randomUUID(),
		start,
		text,
	});
	store.appendTranscript(
		voice.id,
		begun.revision,
		0,
		[{ ...word(0.1, 2.9, "hello brave new world"), id: crypto.randomUUID() }],
		"windows",
		[
			word(0.1, 0.5, "hello"),
			word(0.6, 1.2, "brave"),
			word(1.3, 1.9, "new"),
			word(2.0, 2.9, "world"),
		]
	);
	const project = store.create("Script");
	const body = {
		captionChunking: { maxWords: 2, mode: "words" },
		gap: 0.25,
		revision: project.revision,
		scenes: [
			{
				narrationAssetId: voice.id,
				text: "Hello, brave new world.",
				visualAssetId: still.id,
			},
			{
				narrationAssetId: voice.id,
				text: "Hello again.",
				visualAssetId: video.id,
			},
		],
	};
	const stale = await call(`/projects/${project.id}/script-assemble`, {
		...body,
		revision: project.revision + 1,
	});
	expect(stale.status).toBe(409);

	const result = await call(`/projects/${project.id}/script-assemble`, body);
	expect(result.status).toBe(200);
	const saved: Project = projectSchema.parse(result.body.project);
	expect(saved.revision).toBe(project.revision + 1);
	expect(result.body.duration).toBeCloseTo(6.25, 9);
	expect(result.body.visualTrack).toBe(0);
	expect(result.body.narrationTrack).toBe(1);
	const narration = saved.segments
		.filter((segment) => segment.assetId === voice.id)
		.map((segment) => [segment.start, segment.track]);
	expect(narration).toEqual([
		[0, 1],
		[3.25, 1],
	]);
	const captions = activeCaptions(saved);
	expect(captions[0]).toMatchObject({
		end: 1.2,
		sourceAssetId: voice.id,
		start: 0.1,
		text: "Hello, brave",
	});
	expect(captions[0]?.words?.map((item) => item.text)).toEqual([
		"Hello,",
		"brave",
	]);
	expect(captions[1]).toMatchObject({
		end: 2.9,
		start: 1.3,
		text: "new world.",
	});
	// The second scene reuses the narration; its transcript has no "again".
	expect(captions[2]?.start).toBeCloseTo(3.35, 9);
	expect(captions[2]?.text).toBe("Hello again.");
	expect(store.project(project.id).revision).toBe(saved.revision);
});

test("script-assemble rejects visuals that are audio", async () => {
	const { call, store } = await studio();
	const voice = register(store, "audio", 2);
	const project = store.create("Bad");
	const result = await call(`/projects/${project.id}/script-assemble`, {
		revision: project.revision,
		scenes: [
			{
				narrationAssetId: voice.id,
				text: "Words.",
				visualAssetId: voice.id,
			},
		],
	});
	expect(result.status).toBe(400);
	expect(String(result.body.message)).toContain("must be a video or image");
	expect(store.project(project.id).revision).toBe(project.revision);
});

test("script-assemble adds a presenter avatar per scene without lip-sync", async () => {
	const { call, store } = await studio();
	const voice = register(store, "audio", 2);
	const still = register(store, "image", 0);
	const project = store.create("Presenter");
	const result = await call(`/projects/${project.id}/script-assemble`, {
		avatar: { lipSync: false, preset: "corner" },
		captions: false,
		gap: 0.5,
		revision: project.revision,
		scenes: [
			{ narrationAssetId: voice.id, text: "One.", visualAssetId: still.id },
			{ narrationAssetId: voice.id, text: "Two.", visualAssetId: still.id },
		],
	});
	expect(result.status).toBe(200);
	const saved = projectSchema.parse(result.body.project);
	expect(saved.avatars.map((avatar) => [avatar.start, avatar.end])).toEqual([
		[0, 2],
		[2.5, 4.5],
	]);
	expect(saved.avatars[0]).toMatchObject({ width: 0.16, x: 0.8 });
	const avatars = z
		.array(z.object({ keyframes: z.number() }))
		.parse(result.body.avatars);
	expect(avatars.map((avatar) => avatar.keyframes)).toEqual([0, 0]);
	expect(result.body.music).toBeUndefined();
});

test("script-assemble scores a ducked music bed over the assembly", async () => {
	const { call, store } = await studio();
	const voice = register(store, "audio", 1.5);
	const still = register(store, "image", 0);
	const project = store.create("Music bed");
	const result = await call(`/projects/${project.id}/script-assemble`, {
		captions: false,
		music: { description: "calm and atmospheric", volume: 0.3 },
		revision: project.revision,
		scenes: [
			{ narrationAssetId: voice.id, text: "One.", visualAssetId: still.id },
			{ narrationAssetId: voice.id, text: "Two.", visualAssetId: still.id },
		],
	});
	expect(result.status).toBe(200);
	const music = z
		.object({
			assetId: z.string(),
			clipId: z.string(),
			mood: z.string(),
			status: z.string(),
			track: z.number(),
		})
		.parse(result.body.music);
	expect(music).toMatchObject({ mood: "ambient", status: "placed", track: 2 });
	const saved = projectSchema.parse(result.body.project);
	const bed = saved.segments.find((segment) => segment.id === music.clipId);
	expect(bed).toMatchObject({
		assetId: music.assetId,
		duckUnderVoice: true,
		start: 0,
		track: 2,
		volume: 0.3,
	});
	expect((bed?.sourceOut ?? 0) - (bed?.sourceIn ?? 0)).toBeCloseTo(3, 2);
	expect(store.assets().find((asset) => asset.id === music.assetId)?.kind).toBe(
		"audio"
	);
});

test("the operation is published in OpenAPI", () => {
	const operation =
		openapi().paths["/api/video-studio/projects/{id}/script-assemble"]?.post;
	expect(operation?.operationId).toBe("video_studio_script_assemble");
	expect(operation?.requestBody?.required).toBe(true);
});
