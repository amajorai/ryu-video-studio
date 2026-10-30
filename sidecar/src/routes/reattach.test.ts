import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detachClipAudio } from "../../../shared/detach-audio.ts";
import {
	type Asset,
	newSegment,
	projectSchema,
} from "../../../shared/project.ts";
import { createStudioServer, openapi } from "../server.ts";
import { StudioStore } from "../store.ts";
import { routes } from "./reattach.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});

function cameraAsset(): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration: 10,
		hasAudio: true,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video",
		name: "Camera",
		width: 640,
	};
}

function extractedAudio(video: Asset): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		derivation: "audio",
		derivedFromAssetId: video.id,
		duration: video.duration,
		hasAudio: true,
		height: 0,
		id: crypto.randomUUID(),
		kind: "audio",
		name: "Camera audio",
		width: 0,
	};
}

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-reattach-"));
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
	const video = cameraAsset();
	const audio = extractedAudio(video);
	store.putAsset(video);
	store.putAsset(audio);
	const clip = {
		...newSegment(video, 1),
		volume: 0.7,
		keyframes: [
			{
				id: crypto.randomUUID(),
				property: "volume" as const,
				time: 2,
				value: 0.2,
			},
		],
	};
	const base = store.save({ ...store.create("Reattach"), segments: [clip] });
	const detached = store.save(
		detachClipAudio(
			base,
			[video, audio],
			{ clipIds: [clip.id], revision: base.revision },
			() => audio
		)
	);
	const post = (body: unknown) =>
		fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${detached.id}/reattach-audio`,
			{
				body: JSON.stringify(body),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
	return { clip, detached, post };
}

test("recovers detached audio onto the camera clip", async () => {
	const { clip, detached, post } = await setup();
	expect(detached.segments).toHaveLength(2);
	const response = await post({
		clipIds: [clip.id],
		revision: detached.revision,
	});
	expect(response.status).toBe(200);
	const project = projectSchema.parse(await response.json());
	expect(project.revision).toBe(detached.revision + 1);
	expect(project.segments).toHaveLength(1);
	expect(project.segments[0]).toMatchObject({ id: clip.id, volume: 0.7 });
	expect(project.segments[0]?.linkGroupId).toBeUndefined();
	expect(project.segments[0]?.keyframes).toMatchObject([
		{ property: "volume", time: 2, value: 0.2 },
	]);
});

test("rejects a stale revision and a clip without detached audio", async () => {
	const { clip, detached, post } = await setup();
	const stale = await post({
		clipIds: [clip.id],
		revision: detached.revision - 1,
	});
	expect(stale.status).toBe(409);
	const recovered = await post({
		clipIds: [clip.id],
		revision: detached.revision,
	});
	const project = projectSchema.parse(await recovered.json());
	const again = await post({ clipIds: [clip.id], revision: project.revision });
	expect(again.status).toBe(400);
	const unknownField = await post({
		clipIds: [clip.id],
		extra: true,
		revision: project.revision,
	});
	expect(unknownField.status).toBe(400);
});

test("publishes the reattach operation in OpenAPI", () => {
	const document = openapi(routes);
	const operation =
		document.paths["/api/video-studio/projects/{id}/reattach-audio"]?.post;
	expect(operation?.operationId).toBe("video_studio_reattach_audio");
});
