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
import { routes } from "./clipboard.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});

function media(kind: Asset["kind"]): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration: 20,
		hasAudio: true,
		height: kind === "audio" ? 0 : 360,
		id: crypto.randomUUID(),
		kind,
		name: `${kind} source`,
		width: kind === "audio" ? 0 : 640,
	};
}

async function setup() {
	const directory = await mkdtemp(
		join(tmpdir(), "ryu-video-studio-clipboard-")
	);
	const store = new StudioStore(directory);
	const video = media("video");
	const audio = media("audio");
	store.putAsset(video);
	store.putAsset(audio);
	const created = store.create("Clipboard routes");
	const linkGroupId = crypto.randomUUID();
	const picture = {
		...newSegment(video, 0, 0),
		brightness: 0.25,
		linkGroupId,
		sourceOut: 4,
	};
	const sound = { ...newSegment(audio, 0, 1), linkGroupId, sourceOut: 4 };
	const other = { ...newSegment(video, 6, 0), sourceOut: 2 };
	const project = store.save({
		...created,
		segments: [picture, sound, other],
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
	return { call, other, picture, project, sound };
}

test("paste-clips duplicates a linked pair to a time in one revision", async () => {
	const { call, picture, project } = await setup();
	const response = await call("paste-clips", {
		at: 10,
		clipIds: [picture.id],
		revision: project.revision,
	});
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		newIds: string[];
		project: Project;
	};
	expect(body.project.revision).toBe(project.revision + 1);
	expect(body.newIds).toHaveLength(2);
	const pasted = body.project.segments.filter((segment) =>
		body.newIds.includes(segment.id)
	);
	expect(pasted.map((segment) => segment.start)).toEqual([10, 10]);
	expect(new Set(pasted.map((segment) => segment.linkGroupId)).size).toBe(1);
	expect(pasted[0]?.linkGroupId).not.toBe(picture.linkGroupId);

	const stale = await call("paste-clips", {
		at: 10,
		clipIds: [picture.id],
		revision: project.revision,
	});
	expect(stale.status).toBe(409);
});

test("paste-clips insert mode ripples later clips", async () => {
	const { call, other, picture, project } = await setup();
	const response = await call("paste-clips", {
		at: 6,
		clipIds: [other.id],
		mode: "insert",
		revision: project.revision,
		track: 0,
	});
	const body = (await response.json()) as { project: Project };
	expect(
		body.project.segments.find((segment) => segment.id === other.id)?.start
	).toBe(8);
	expect(
		body.project.segments.find((segment) => segment.id === picture.id)?.start
	).toBe(0);
});

test("paste-settings copies the chosen groups and validates its body", async () => {
	const { call, other, picture, project } = await setup();
	const response = await call("paste-settings", {
		groups: ["color"],
		revision: project.revision,
		sourceClipId: picture.id,
		targetClipIds: [other.id],
	});
	expect(response.status).toBe(200);
	const saved = (await response.json()) as Project;
	expect(
		saved.segments.find((segment) => segment.id === other.id)?.brightness
	).toBe(0.25);

	const invalid = await call("paste-settings", {
		groups: ["sparkles"],
		revision: saved.revision,
		sourceClipId: picture.id,
		targetClipIds: [other.id],
	});
	expect(invalid.status).toBe(400);
});

test("both routes are documented in OpenAPI", () => {
	const document = openapi(routes) as {
		paths: Record<string, Record<string, { operationId: string }>>;
	};
	const ids = Object.values(document.paths).flatMap((operations) =>
		Object.values(operations).map((operation) => operation.operationId)
	);
	expect(ids).toContain("video_studio_paste_clips");
	expect(ids).toContain("video_studio_paste_clip_settings");
});
