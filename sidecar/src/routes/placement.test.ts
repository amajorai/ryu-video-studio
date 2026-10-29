import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	type Asset,
	newSegment,
	projectSchema,
	segmentDuration,
} from "../../../shared/project.ts";
import { createStudioServer } from "../server.ts";
import { StudioStore } from "../store.ts";
import { routes } from "./placement.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});

function asset(duration: number): Asset {
	return {
		id: crypto.randomUUID(),
		name: "Footage",
		kind: "video",
		duration,
		width: 640,
		height: 360,
		hasAudio: true,
		createdAt: new Date().toISOString(),
	};
}

async function setup() {
	const directory = await mkdtemp(
		join(tmpdir(), "ryu-video-studio-placement-")
	);
	const store = new StudioStore(directory);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0, routes });
	cleanup.push(async () => {
		app.server.stop(true);
		store.close();
		await rm(directory, { recursive: true, force: true });
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
	return { app, base, post, store, token };
}

const spans = (segments: z.infer<typeof projectSchema>["segments"]) =>
	segments.map((segment) => [
		segment.track,
		Number(segment.start.toFixed(6)),
		Number((segment.start + segmentDuration(segment)).toFixed(6)),
	]);

test("overwrite drops an asset at 3 s over an existing clip in one revision", async () => {
	const { post, store } = await setup();
	const existing = asset(10);
	const dropped = asset(2);
	store.putAsset(existing);
	store.putAsset(dropped);
	const created = store.create("Placement");
	const project = store.save({
		...created,
		segments: [newSegment(existing, 0, 1)],
	});
	const response = await post(`/projects/${project.id}/overwrite`, {
		at: 3,
		entries: [{ assetId: dropped.id }],
		revision: project.revision,
		track: 1,
	});
	expect(response.status).toBe(200);
	const saved = projectSchema.parse(await response.json());
	expect(saved.revision).toBe(project.revision + 1);
	expect(spans(saved.segments)).toEqual([
		[1, 0, 3],
		[1, 3, 5],
		[1, 5, 10],
	]);
	expect(saved.segments[1]?.assetId).toBe(dropped.id);

	const stale = await post(`/projects/${project.id}/overwrite`, {
		at: 3,
		entries: [{ assetId: dropped.id }],
		revision: project.revision,
		track: 1,
	});
	expect(stale.status).toBe(409);

	const invalid = await post(`/projects/${project.id}/overwrite`, {
		at: 3,
		entries: [],
		revision: saved.revision,
		track: 1,
	});
	expect(invalid.status).toBe(400);
});

test("move-to-new-track moves or duplicates clips in one revision", async () => {
	const { post, store } = await setup();
	const footage = asset(4);
	store.putAsset(footage);
	const created = store.create("Tracks");
	const clip = newSegment(footage, 0, 0);
	const project = store.save({ ...created, segments: [clip] });

	const duplicated = await post(`/projects/${project.id}/move-to-new-track`, {
		clipIds: [clip.id],
		duplicate: true,
		revision: project.revision,
	});
	expect(duplicated.status).toBe(200);
	const copied = projectSchema.parse(await duplicated.json());
	expect(spans(copied.segments)).toEqual([
		[0, 0, 4],
		[1, 0, 4],
	]);

	const moved = await post(`/projects/${project.id}/move-to-new-track`, {
		clipIds: [clip.id],
		revision: copied.revision,
	});
	expect(moved.status).toBe(200);
	const next = projectSchema.parse(await moved.json());
	expect(next.revision).toBe(copied.revision + 1);
	expect(next.segments.find((segment) => segment.id === clip.id)?.track).toBe(
		2
	);

	const unknown = await post(`/projects/${project.id}/move-to-new-track`, {
		clipIds: [crypto.randomUUID()],
		revision: next.revision,
	});
	expect(unknown.status).toBe(400);
	expect(await unknown.json()).toMatchObject({
		message: "Clip not found on this timeline.",
	});
});

test("placement operations are published in OpenAPI", async () => {
	const { app, token } = await setup();
	const document = await fetch(
		`http://127.0.0.1:${app.server.port}/openapi.json`,
		{ headers: { authorization: `Bearer ${token}` } }
	);
	const paths = z
		.record(z.string(), z.record(z.string(), z.json()))
		.parse((await document.json()).paths);
	expect(
		paths["/api/video-studio/projects/{id}/overwrite"]?.post
	).toBeDefined();
	expect(
		paths["/api/video-studio/projects/{id}/move-to-new-track"]?.post
	).toBeDefined();
});
