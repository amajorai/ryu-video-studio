import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Asset,
	newSegment,
	projectSchema,
	segmentDuration,
} from "../../../shared/project.ts";
import { createStudioServer, openapi } from "../server.ts";
import { StudioStore } from "../store.ts";
import { routes } from "./gap-fill.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});

function media(kind: Asset["kind"], extra: Partial<Asset> = {}): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration: kind === "image" ? 0 : 10,
		hasAudio: kind === "video",
		height: 360,
		id: crypto.randomUUID(),
		kind,
		name: kind,
		width: 640,
		...extra,
	};
}

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-gap-fill-"));
	const store = new StudioStore(directory);
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, routes, store, token });
	cleanup.push(async () => {
		app.server.stop(true);
		store.close();
		await rm(directory, {
			force: true,
			recursive: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	});
	const video = media("video");
	const still = media("image", {
		generation: { kind: "image", prompt: "a bridge" },
	});
	store.putAsset(video);
	store.putAsset(still);
	const a = { ...newSegment(video, 0), sourceOut: 4 };
	const b = { ...newSegment(video, 5), sourceIn: 4, sourceOut: 8 };
	const project = store.save({
		...store.create("Gap fill"),
		segments: [a, b],
	});
	const call = (body: unknown) =>
		fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/gap-fill`,
			{
				body: JSON.stringify(body),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
	return { a, b, call, project, still, store, video };
}

test("POST gap-fill places the bridge, sets dissolves, and stamps the still", async () => {
	const { a, b, call, project, still, store } = await setup();
	const response = await call({
		afterClipId: a.id,
		assetId: still.id,
		revision: project.revision,
	});
	expect(response.status).toBe(200);
	const body = (await response.json()) as { clipId: string; project: unknown };
	const saved = projectSchema.parse(body.project);
	expect(saved.revision).toBe(project.revision + 1);
	const bridge = saved.segments.find((segment) => segment.id === body.clipId);
	expect(bridge?.assetId).toBe(still.id);
	expect(bridge?.start).toBe(3.5);
	expect(bridge ? segmentDuration(bridge) : 0).toBe(2);
	expect(bridge?.transitionIn?.type).toBe("dissolve");
	expect(bridge?.keyframes.map((frame) => frame.property)).toEqual([
		"scale",
		"scale",
	]);
	const next = saved.segments.find((segment) => segment.id === b.id);
	expect(next?.transitionIn).toEqual({
		duration: 0.5,
		softness: 0.1,
		type: "dissolve",
	});
	expect(next?.start).toBe(5);
	expect(
		store.assets().find((asset) => asset.id === still.id)?.derivation
	).toBe("gap-fill");
});

test("POST gap-fill refuses stale revisions and bad input", async () => {
	const { a, call, project, still, store } = await setup();
	const audio = media("audio");
	store.putAsset(audio);
	const stale = await call({
		afterClipId: a.id,
		assetId: still.id,
		revision: project.revision + 3,
	});
	expect(stale.status).toBe(409);
	const notPicture = await call({
		afterClipId: a.id,
		assetId: audio.id,
		revision: project.revision,
	});
	expect(notPicture.status).toBe(400);
	const unknownField = await call({
		afterClipId: a.id,
		assetId: still.id,
		revision: project.revision,
		track: 2,
	});
	expect(unknownField.status).toBe(400);
});

test("POST gap-fill with a video fills the gap exactly as a motion bridge", async () => {
	const { a, b, call, project, store } = await setup();
	const motion = media("video", {
		duration: 3,
		generation: { kind: "video", prompt: "motion", task: "flf" },
	});
	store.putAsset(motion);
	const response = await call({
		afterClipId: a.id,
		assetId: motion.id,
		revision: project.revision,
	});
	expect(response.status).toBe(200);
	const body = (await response.json()) as { clipId: string; project: unknown };
	const saved = projectSchema.parse(body.project);
	const bridge = saved.segments.find((segment) => segment.id === body.clipId);
	expect(bridge?.start).toBe(4);
	expect(bridge?.sourceIn).toBe(0);
	expect(bridge?.sourceOut).toBe(1);
	expect(bridge?.transitionIn).toBeUndefined();
	expect(
		saved.segments.find((segment) => segment.id === b.id)?.transitionIn
	).toBeUndefined();
	expect(
		store.assets().find((asset) => asset.id === motion.id)?.derivation
	).toBe("gap-fill");
});

test("POST gap-fill-frames refuses a cut, where only the still bridge applies", async () => {
	const directory = await mkdtemp(
		join(tmpdir(), "ryu-video-studio-gap-frames-")
	);
	const store = new StudioStore(directory);
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, routes, store, token });
	cleanup.push(async () => {
		app.server.stop(true);
		store.close();
		await rm(directory, {
			force: true,
			recursive: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	});
	const video = media("video");
	store.putAsset(video);
	const a = { ...newSegment(video, 0), sourceOut: 4 };
	const b = { ...newSegment(video, 4), sourceIn: 4, sourceOut: 8 };
	const project = store.save({ ...store.create("Cut"), segments: [a, b] });
	const response = await fetch(
		`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/gap-fill-frames`,
		{
			body: JSON.stringify({ afterClipId: a.id, revision: project.revision }),
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			method: "POST",
		}
	);
	expect(response.status).toBe(400);
	expect(((await response.json()) as { message: string }).message).toContain(
		"still bridge"
	);
});

test("openapi documents the gap-fill operation", () => {
	const document = openapi(routes);
	expect(
		document.paths["/api/video-studio/projects/{id}/gap-fill"]?.post
			?.operationId
	).toBe("video_studio_gap_fill");
});
