import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Asset,
	newSegment,
	type Project,
	trackSettingFor,
} from "../../../shared/project.ts";
import { createStudioServer, openapi } from "../server.ts";
import { StudioStore } from "../store.ts";
import { routes, trackSettingPatch } from "./tracks.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});

function asset(): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration: 10,
		hasAudio: true,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video",
		name: "Footage",
		width: 640,
	};
}

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-tracks-"));
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
	const base = `http://127.0.0.1:${app.server.port}/api/video-studio`;
	const post = (path: string, body: unknown) =>
		fetch(`${base}${path}`, {
			body: JSON.stringify(body),
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			method: "POST",
		});
	const media = asset();
	store.putAsset(media);
	const created = store.create("Tracks");
	const saved = store.save({
		...created,
		segments: [newSegment(media, 0, 0), newSegment(media, 0, 1)],
	});
	return { post, project: saved, store };
}

test("updates hidden, sync lock, height, gain, and pan in one revision", async () => {
	const { post, project, store } = await setup();
	const response = await post(`/projects/${project.id}/tracks`, {
		gainDb: -6,
		height: "large",
		hidden: true,
		pan: -0.5,
		revision: project.revision,
		syncLocked: false,
		track: 1,
	});
	expect(response.status).toBe(200);
	const saved = (await response.json()) as Project;
	expect(saved.revision).toBe(project.revision + 1);
	expect(trackSettingFor(store.project(project.id), 1)).toMatchObject({
		gainDb: -6,
		height: "large",
		hidden: true,
		pan: -0.5,
		syncLocked: false,
	});
});

test("rejects out-of-range track fields and unknown keys", async () => {
	const { post, project } = await setup();
	for (const body of [
		{ gainDb: 20, revision: project.revision, track: 0 },
		{ pan: 2, revision: project.revision, track: 0 },
		{ height: "huge", revision: project.revision, track: 0 },
		{ revision: project.revision, track: 0, visible: true },
	]) {
		const response = await post(`/projects/${project.id}/tracks`, body);
		expect(response.status).toBe(400);
	}
});

test("adds and removes tracks with revision checks", async () => {
	const { post, project, store } = await setup();
	const added = await post(`/projects/${project.id}/tracks/add`, {
		at: 1,
		revision: project.revision,
	});
	expect(added.status).toBe(200);
	const afterAdd = store.project(project.id);
	expect(afterAdd.segments.map((segment) => segment.track).sort()).toEqual([
		0, 2,
	]);
	const stale = await post(`/projects/${project.id}/tracks/remove`, {
		revision: project.revision,
		track: 1,
	});
	expect(stale.status).toBe(409);
	const refused = await post(`/projects/${project.id}/tracks/remove`, {
		revision: afterAdd.revision,
		track: 2,
	});
	expect(refused.status).toBe(400);
	const removed = await post(`/projects/${project.id}/tracks/remove`, {
		force: true,
		revision: afterAdd.revision,
		track: 2,
	});
	expect(removed.status).toBe(200);
	expect(
		store.project(project.id).segments.map((segment) => segment.track)
	).toEqual([0]);
});

test("publishes the new operations in OpenAPI", () => {
	const { paths } = openapi(routes) as {
		paths: Record<string, Record<string, { operationId: string }>>;
	};
	const operation = (path: string) =>
		paths[`/api/video-studio/projects/{id}/${path}`]?.post?.operationId;
	expect(operation("tracks/add")).toBe("video_studio_add_track");
	expect(operation("tracks/remove")).toBe("video_studio_remove_track");
	expect(operation("tracks")).toBe("video_studio_update_track");
});

test("trackSettingPatch carries only the fields a request sets", () => {
	expect(trackSettingPatch({ hidden: false, revision: 3, track: 1 })).toEqual({
		hidden: false,
	});
	expect(trackSettingPatch({ revision: 3, track: 1 })).toEqual({});
});
