import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSegment } from "../../../shared/project.ts";
import { createStudioServer } from "../server.ts";
import { StudioStore } from "../store.ts";
import { routes } from "./background.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const task of cleanup.splice(0).reverse()) {
		await task();
	}
});

async function harness() {
	const directory = await mkdtemp(
		join(tmpdir(), "ryu-video-studio-background-api-")
	);
	const store = new StudioStore(directory);
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, routes, store, token });
	cleanup.push(async () => {
		app.stop();
		store.close();
		await rm(directory, { force: true, recursive: true });
	});
	const call = async (path: string, body?: unknown) => {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio${path}`,
			{
				...(body === undefined
					? {}
					: { body: JSON.stringify(body), method: "POST" }),
				headers: {
					authorization: `Bearer ${token}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
			}
		);
		return { body: await response.json(), status: response.status };
	};
	return { call, store };
}

const asset = (kind: "audio" | "image" | "video") => ({
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 4,
	hasAudio: kind !== "image",
	height: 360,
	id: crypto.randomUUID(),
	kind,
	name: `${kind} asset`,
	width: 640,
});

test("sets, replaces, and clears the project background with revisions", async () => {
	const { call, store } = await harness();
	const project = store.create("Backdrop");
	const gradient = {
		angle: 45,
		color: "#102030",
		color2: "#405060",
		type: "gradient" as const,
	};
	const set = await call(`/projects/${project.id}/background`, {
		background: gradient,
		revision: project.revision,
	});
	expect(set.status).toBe(200);
	expect(set.body.background).toEqual(gradient);
	expect(set.body.revision).toBe(project.revision + 1);

	const stale = await call(`/projects/${project.id}/background`, {
		background: { amount: 0.5, dim: 0.2, type: "blur" },
		revision: project.revision,
	});
	expect(stale.status).toBe(409);
	expect(store.project(project.id).background).toEqual(gradient);

	const cleared = await call(`/projects/${project.id}/background`, {
		background: null,
		revision: set.body.revision,
	});
	expect(cleared.status).toBe(200);
	expect("background" in cleared.body).toBe(false);
});

test("image backgrounds must reference visual library media", async () => {
	const { call, store } = await harness();
	const image = asset("image");
	const audio = asset("audio");
	store.putAsset(image);
	store.putAsset(audio);
	const project = store.save({
		...store.create("Images"),
		segments: [newSegment(image)],
	});
	const refused = await call(`/projects/${project.id}/background`, {
		background: { assetId: audio.id, type: "image" },
		revision: project.revision,
	});
	expect(refused.status).toBe(400);
	expect(refused.body.message).toContain("image or video");
	const accepted = await call(`/projects/${project.id}/background`, {
		background: { assetId: image.id, type: "image" },
		revision: project.revision,
	});
	expect(accepted.status).toBe(200);
	expect(accepted.body.background).toEqual({
		assetId: image.id,
		type: "image",
	});
});

test("clipId sets and clears one clip's own fill", async () => {
	const { call, store } = await harness();
	const video = asset("video");
	store.putAsset(video);
	const clip = newSegment(video);
	const project = store.save({
		...store.create("Clip fills"),
		segments: [clip],
	});
	const fill = { color: "#c02090", type: "color" as const };
	const set = await call(`/projects/${project.id}/background`, {
		background: fill,
		clipId: clip.id,
		revision: project.revision,
	});
	expect(set.status).toBe(200);
	expect(set.body.segments[0].background).toEqual(fill);
	expect("background" in set.body).toBe(false);

	const cleared = await call(`/projects/${project.id}/background`, {
		background: null,
		clipId: clip.id,
		revision: set.body.revision,
	});
	expect(cleared.status).toBe(200);
	expect("background" in cleared.body.segments[0]).toBe(false);

	const refused = await call(`/projects/${project.id}/background`, {
		background: fill,
		clipId: "missing",
		revision: cleared.body.revision,
	});
	expect(refused.status).toBe(400);
	// A clip can show a library picture (a video's first frame) behind it.
	const pictured = await call(`/projects/${project.id}/background`, {
		background: { assetId: video.id, type: "image" },
		clipId: clip.id,
		revision: cleared.body.revision,
	});
	expect(pictured.status).toBe(200);
	expect(pictured.body.segments[0].background).toEqual({
		assetId: video.id,
		type: "image",
	});
	const missing = await call(`/projects/${project.id}/background`, {
		background: { assetId: crypto.randomUUID(), type: "image" },
		clipId: clip.id,
		revision: pictured.body.revision,
	});
	expect(missing.status).toBe(400);
});

test("malformed backgrounds and extra fields are refused", async () => {
	const { call, store } = await harness();
	const project = store.create("Strict");
	for (const body of [
		{ background: { color: "red", type: "color" }, revision: project.revision },
		{
			background: { amount: 2, dim: 0, type: "blur" },
			revision: project.revision,
		},
		{
			background: { color: "#000000", type: "color" },
			extra: true,
			revision: project.revision,
		},
		{ background: { color: "#000000", type: "color" } },
	]) {
		const response = await call(`/projects/${project.id}/background`, body);
		expect(response.status).toBe(400);
	}
});

test("the background route is published in OpenAPI", async () => {
	const { call } = await harness();
	const { body } = await call("/../../openapi.json");
	const path = body.paths?.["/api/video-studio/projects/{id}/background"];
	expect(path?.post?.operationId).toBe("video_studio_set_background");
});
