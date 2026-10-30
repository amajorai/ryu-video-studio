import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	type Asset,
	newSegment,
	projectSchema,
} from "../../../shared/project.ts";
import { createStudioServer } from "../server.ts";
import { StudioStore } from "../store.ts";
import { routes } from "./title-narration.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});

function asset(kind: Asset["kind"], duration: number): Asset {
	return {
		id: crypto.randomUUID(),
		name: `${kind}.media`,
		kind,
		duration,
		width: kind === "audio" ? 0 : 640,
		height: kind === "audio" ? 0 : 360,
		hasAudio: kind !== "image",
		createdAt: new Date().toISOString(),
	};
}

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-narrate-"));
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
	return { app, post, store, token };
}

const titleId = "22222222-2222-4222-8222-222222222222";

test("title-narration places the spoken title at its start in one revision", async () => {
	const { post, store } = await setup();
	const footage = asset("video", 12);
	const narration = asset("audio", 1.75);
	store.putAsset(footage);
	store.putAsset(narration);
	const created = store.create("Narrated titles");
	const project = store.save({
		...created,
		segments: [newSegment(footage, 0, 0)],
		titles: [
			{
				id: titleId,
				start: 2.5,
				end: 5,
				text: "Welcome",
				x: 0.5,
				y: 0.5,
				fontSize: 0.08,
				color: "#ffffff",
				fadeIn: 0.2,
				fadeOut: 0.2,
				animation: "fade",
			},
		],
	});
	const response = await post(`/projects/${project.id}/title-narration`, {
		assetId: narration.id,
		revision: project.revision,
		titleId,
	});
	expect(response.status).toBe(200);
	const saved = projectSchema.parse(await response.json());
	expect(saved.revision).toBe(project.revision + 1);
	const clip = saved.segments.find(
		(segment) => segment.assetId === narration.id
	);
	expect(clip).toMatchObject({ start: 2.5, track: 1 });

	const stale = await post(`/projects/${project.id}/title-narration`, {
		assetId: narration.id,
		revision: project.revision,
		titleId,
	});
	expect(stale.status).toBe(409);

	const wrongKind = await post(`/projects/${project.id}/title-narration`, {
		assetId: footage.id,
		revision: saved.revision,
		titleId,
	});
	expect(wrongKind.status).toBe(400);
	expect(JSON.stringify(await wrongKind.json())).toContain(
		"must be an audio asset"
	);

	const unknownTitle = await post(`/projects/${project.id}/title-narration`, {
		assetId: narration.id,
		revision: saved.revision,
		titleId: crypto.randomUUID(),
	});
	expect(unknownTitle.status).toBe(400);
});

test("title narration is published in OpenAPI", async () => {
	const { app, token } = await setup();
	const document = await fetch(
		`http://127.0.0.1:${app.server.port}/openapi.json`,
		{ headers: { authorization: `Bearer ${token}` } }
	);
	const paths = z
		.record(z.string(), z.record(z.string(), z.json()))
		.parse((await document.json()).paths);
	expect(
		paths["/api/video-studio/projects/{id}/title-narration"]?.post
	).toBeDefined();
});
