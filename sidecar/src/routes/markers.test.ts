import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	type Asset,
	markerSchema,
	newSegment,
	projectSchema,
} from "../../../shared/project.ts";
import { createStudioServer, openapi } from "../server.ts";
import { StudioStore } from "../store.ts";
import { routes } from "./markers.ts";

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
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-markers-"));
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
	const media = asset();
	store.putAsset(media);
	const project = store.save({
		...store.create("Markers"),
		segments: [newSegment(media)],
	});
	const post = (body: unknown) =>
		fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/markers`,
			{
				body: JSON.stringify(body),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
	return { post, project };
}

const result = z
	.object({
		marker: markerSchema.optional(),
		project: projectSchema,
		removed: markerSchema.optional(),
	})
	.strict();

test("an agent update edits a marker's status and comment", async () => {
	const { post, project } = await setup();
	const created = result.parse(
		await (
			await post({
				action: "fromRange",
				end: 3,
				revision: project.revision,
				start: 1,
			})
		).json()
	);
	expect(created.marker).toMatchObject({
		duration: 2,
		label: "Range 1",
		time: 1,
	});
	const response = await post({
		action: "update",
		comment: "Swap for the wide take.",
		markerId: created.marker?.id,
		revision: created.project.revision,
		status: "review",
	});
	expect(response.status).toBe(200);
	const updated = result.parse(await response.json());
	expect(updated.marker).toMatchObject({
		comment: "Swap for the wide take.",
		status: "review",
	});
	expect(updated.project.markers).toHaveLength(1);
});

test("toggle, move, and ripple round-trip through the route", async () => {
	const { post, project } = await setup();
	const added = result.parse(
		await (
			await post({ action: "toggle", revision: project.revision, time: 2 })
		).json()
	);
	const moved = result.parse(
		await (
			await post({
				action: "move",
				markerId: added.marker?.id,
				revision: added.project.revision,
				time: -4,
			})
		).json()
	);
	expect(moved.marker?.time).toBe(0);
	const removed = result.parse(
		await (
			await post({
				action: "toggle",
				revision: moved.project.revision,
				time: 0.01,
			})
		).json()
	);
	expect(removed.removed?.id).toBe(added.marker?.id);
	expect(removed.project.markers).toEqual([]);
	const ripple = result.parse(
		await (
			await post({
				action: "ripple",
				revision: removed.project.revision,
				rippleMarkers: false,
			})
		).json()
	);
	expect(ripple.project.rippleMarkers).toBe(false);
});

test("stale revisions conflict and bad bodies are rejected", async () => {
	const { post, project } = await setup();
	const stale = await post({
		action: "toggle",
		revision: project.revision + 5,
		time: 1,
	});
	expect(stale.status).toBe(409);
	const invalid = await post({ action: "move", revision: project.revision });
	expect(invalid.status).toBe(400);
});

test("the markers operation is published in the OpenAPI document", () => {
	const document = JSON.stringify(openapi(routes));
	expect(document).toContain("video_studio_manage_markers");
	expect(document).toContain("fromRange");
});
