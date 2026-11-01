import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Asset,
	newSegment,
	type Project,
} from "../../../shared/project.ts";
import { createStudioServer, openapi } from "../server.ts";
import { StudioStore } from "../store.ts";
import { routes } from "./transitions.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});

const footage: Asset = {
	createdAt: new Date(0).toISOString(),
	duration: 20,
	hasAudio: false,
	height: 360,
	id: crypto.randomUUID(),
	kind: "video",
	name: "footage",
	width: 640,
};

/** Clip A at 0–4 s (source 0–4) and B at 4 s (source 3–7) on track 0. */
async function setup() {
	const directory = await mkdtemp(
		join(tmpdir(), "ryu-video-studio-transition-")
	);
	const store = new StudioStore(directory);
	store.putAsset(footage);
	const a = { ...newSegment(footage, 0, 0), sourceIn: 0, sourceOut: 4 };
	const b = { ...newSegment(footage, 4, 0), sourceIn: 3, sourceOut: 7 };
	const project = store.save({
		...store.create("Transition route"),
		segments: [a, b],
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, routes, store, token });
	cleanup.push(async () => {
		app.stop();
		store.close();
		await rm(directory, {
			force: true,
			recursive: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	});
	const call = (body: Record<string, unknown>) =>
		fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/transition`,
			{
				body: JSON.stringify(body),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
	return { a, b, call, project };
}

const wipe = { duration: 1, softness: 0, type: "wipe-left" } as const;

test("adds a reveal transition on an ordinary cut, creating its overlap", async () => {
	const { b, call, project } = await setup();
	const response = await call({
		clipId: b.id,
		revision: project.revision,
		transition: wipe,
	});
	expect(response.status).toBe(200);
	const saved = (await response.json()) as Project;
	expect(saved.revision).toBe(project.revision + 1);
	const incoming = saved.segments.find((segment) => segment.id === b.id);
	expect(incoming?.start).toBe(3);
	expect(incoming?.sourceIn).toBe(2);
	expect(incoming?.transitionIn).toEqual(wipe);
});

test("a push gives the outgoing clip its exit, and null removes both", async () => {
	const { a, b, call, project } = await setup();
	const added = await call({
		clipId: b.id,
		revision: project.revision,
		transition: { duration: 1, softness: 0, type: "push-left" },
	});
	expect(added.status).toBe(200);
	const pushed = (await added.json()) as Project;
	expect(
		pushed.segments.find((segment) => segment.id === a.id)?.exitTransition
	).toBeDefined();
	const removed = await call({
		clipId: b.id,
		revision: pushed.revision,
		transition: null,
	});
	expect(removed.status).toBe(200);
	const bare = (await removed.json()) as Project;
	expect(
		bare.segments.find((segment) => segment.id === b.id)?.transitionIn
	).toBeUndefined();
	expect(
		bare.segments.find((segment) => segment.id === a.id)?.exitTransition
	).toBeUndefined();
});

test("refuses a stale revision, a bad body, and a clip without a predecessor", async () => {
	const { a, b, call, project } = await setup();
	expect(
		(
			await call({
				clipId: b.id,
				revision: project.revision + 3,
				transition: wipe,
			})
		).status
	).toBe(409);
	expect(
		(await call({ clipId: b.id, revision: project.revision })).status
	).toBe(400);
	const orphan = await call({
		clipId: a.id,
		revision: project.revision,
		transition: wipe,
	});
	expect(orphan.status).toBeGreaterThanOrEqual(400);
});

test("publishes an OpenAPI operation with the id path parameter", () => {
	const operation = (
		openapi(routes).paths as Record<
			string,
			Record<string, { operationId: string; parameters?: { name: string }[] }>
		>
	)["/api/video-studio/projects/{id}/transition"]?.post;
	expect(operation?.operationId).toBe("video_studio_set_transition");
	expect(operation?.parameters?.map((parameter) => parameter.name)).toEqual([
		"id",
	]);
});
