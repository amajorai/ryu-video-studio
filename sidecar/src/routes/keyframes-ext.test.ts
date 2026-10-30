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
import { routes } from "./keyframes-ext.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});

const video: Asset = {
	createdAt: new Date(0).toISOString(),
	duration: 20,
	hasAudio: true,
	height: 360,
	id: crypto.randomUUID(),
	kind: "video",
	name: "Video source",
	width: 640,
};

async function setup() {
	const directory = await mkdtemp(
		join(tmpdir(), "ryu-video-studio-keyframes-")
	);
	const store = new StudioStore(directory);
	store.putAsset(video);
	const created = store.create("Keyframe routes");
	const source = {
		...newSegment(video, 0, 0),
		keyframes: [
			{
				id: crypto.randomUUID(),
				interpolation: "ease-in-out" as const,
				property: "opacity" as const,
				time: 0.5,
				value: 0.2,
			},
			{
				id: crypto.randomUUID(),
				property: "opacity" as const,
				time: 1.5,
				value: 1,
			},
		],
		sourceOut: 4,
	};
	const target = { ...newSegment(video, 6, 0), sourceOut: 3 };
	const project = store.save({ ...created, segments: [source, target] });
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
	const base = `http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}`;
	const call = (action: string, body: Record<string, unknown>) =>
		fetch(`${base}/${action}`, {
			body: JSON.stringify(body),
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			method: "POST",
		});
	return { call, project, source, target };
}

test("paste-keyframes copies eased keyframes onto another clip", async () => {
	const { call, project, source, target } = await setup();
	const response = await call("paste-keyframes", {
		at: 1,
		revision: project.revision,
		sourceClipId: source.id,
		targetClipIds: [target.id],
	});
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		pasted: number;
		project: Project;
		skipped: number;
	};
	expect(body.pasted).toBe(2);
	expect(body.skipped).toBe(0);
	expect(body.project.revision).toBe(project.revision + 1);
	expect(
		body.project.segments.find((segment) => segment.id === target.id)?.keyframes
	).toMatchObject([
		{ interpolation: "ease-in-out", property: "opacity", time: 1, value: 0.2 },
		{ property: "opacity", time: 2, value: 1 },
	]);
});

test("paste-keyframes rejects stale revisions and bad bodies", async () => {
	const { call, project, source, target } = await setup();
	const stale = await call("paste-keyframes", {
		at: 0,
		revision: project.revision + 5,
		sourceClipId: source.id,
		targetClipIds: [target.id],
	});
	expect(stale.status).toBe(409);
	const invalid = await call("paste-keyframes", {
		at: 0,
		revision: project.revision,
		sourceClipId: source.id,
		targetClipIds: [],
	});
	expect(invalid.status).toBe(400);
});

test("the keyframes route accepts interpolation and new properties", async () => {
	const { call, project, target } = await setup();
	const response = await call("keyframes", {
		clipId: target.id,
		keyframes: [
			{
				bezier: [0.25, 0.1, 0.25, 1],
				interpolation: "bezier",
				time: 0,
				value: 0.1,
			},
			{ time: 2, value: 0.5 },
		],
		property: "cropLeft",
		revision: project.revision,
	});
	expect(response.status).toBe(200);
	const saved = (await response.json()) as Project;
	expect(
		saved.segments.find((segment) => segment.id === target.id)?.keyframes
	).toMatchObject([
		{
			bezier: [0.25, 0.1, 0.25, 1],
			interpolation: "bezier",
			property: "cropLeft",
		},
		{ property: "cropLeft", time: 2 },
	]);
});

test("paste-keyframes is documented in OpenAPI", () => {
	const document = openapi(routes) as {
		paths: Record<string, Record<string, { operationId: string }>>;
	};
	expect(
		document.paths["/api/video-studio/projects/{id}/paste-keyframes"]?.post
			?.operationId
	).toBe("video_studio_paste_keyframes");
});
