import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Asset,
	newSegment,
	type Project,
	segmentDuration,
} from "../../../shared/project.ts";
import { createStudioServer, openapi } from "../server.ts";
import { StudioStore } from "../store.ts";
import { routes as cutOpsRoutes } from "./cut-ops.ts";
import { routes as splitRemoveRoutes } from "./split-remove.ts";

const routes = [...splitRemoveRoutes, ...cutOpsRoutes];

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

/**
 * Track 0: a linked picture (0..4) then b-roll (6..8).
 * Track 1: the linked sound (0..4). Track 2: music (0..4).
 */
async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-cut-ops-"));
	const store = new StudioStore(directory);
	const video = media("video");
	const audio = media("audio");
	store.putAsset(video);
	store.putAsset(audio);
	const linkGroupId = crypto.randomUUID();
	const picture = { ...newSegment(video, 0, 0), linkGroupId, sourceOut: 4 };
	const sound = { ...newSegment(audio, 0, 1), linkGroupId, sourceOut: 4 };
	const music = { ...newSegment(audio, 0, 2), sourceOut: 4 };
	const broll = { ...newSegment(video, 6, 0), sourceOut: 2 };
	const project = store.save({
		...store.create("Cut routes"),
		segments: [picture, sound, music, broll],
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
	return { broll, call, music, picture, project, sound };
}

const track = (project: Project, index: number) =>
	project.segments
		.filter((segment) => segment.track === index)
		.sort((a, b) => a.start - b.start);

test("split cuts every clip under each time in one revision", async () => {
	const { call, project } = await setup();
	const response = await call("split", {
		revision: project.revision,
		times: [1, 2],
	});
	expect(response.status).toBe(200);
	const saved = (await response.json()) as Project;
	expect(saved.revision).toBe(project.revision + 1);
	// Three clips under 1 s and 2 s, each cut twice; b-roll is untouched.
	expect(saved.segments).toHaveLength(4 + 6);
	const right = track(saved, 0).find((segment) => segment.start === 2);
	const rightSound = track(saved, 1).find((segment) => segment.start === 2);
	expect(right?.linkGroupId).toBeDefined();
	expect(right?.linkGroupId).toBe(rightSound?.linkGroupId ?? "");
});

test("the legacy split body cuts the clip and its linked partner", async () => {
	const { call, picture, project } = await setup();
	const response = await call("split", {
		clipId: picture.id,
		revision: project.revision,
		time: 2,
	});
	expect(response.status).toBe(200);
	const saved = (await response.json()) as Project;
	expect(track(saved, 0)).toHaveLength(3);
	expect(track(saved, 1)).toHaveLength(2);
	expect(track(saved, 2)).toHaveLength(1);
});

test("split validates its body and the revision", async () => {
	const { call, project } = await setup();
	const invalid = await call("split", {
		revision: project.revision,
		time: 1,
		times: [1],
	});
	expect(invalid.status).toBe(400);
	const stale = await call("split", {
		revision: project.revision + 5,
		times: [1],
	});
	expect(stale.status).toBe(409);
});

test("remove with ripple closes spans no other clip covers", async () => {
	const { broll, call, music, picture, project } = await setup();
	const blocked = await call("remove", {
		clipIds: [picture.id],
		revision: project.revision,
		ripple: true,
	});
	expect(blocked.status).toBe(200);
	const kept = (await blocked.json()) as Project;
	// The music still covers 0..4, so closing the span would cut it.
	expect(kept.segments.find((segment) => segment.id === broll.id)?.start).toBe(
		6
	);
	const response = await call("remove", {
		clipIds: [music.id],
		revision: kept.revision,
		ripple: true,
	});
	const saved = (await response.json()) as Project;
	expect(saved.segments.find((segment) => segment.id === broll.id)?.start).toBe(
		2
	);
	const plain = await call("remove", {
		clipIds: [broll.id],
		revision: saved.revision,
	});
	expect(plain.status).toBe(200);
});

test("trim-to-playhead ripples or leaves a gap", async () => {
	const { broll, call, project } = await setup();
	const rippled = await call("trim-to-playhead", {
		edge: "end",
		revision: project.revision,
		ripple: true,
		time: 3,
	});
	expect(rippled.status).toBe(200);
	const saved = (await rippled.json()) as Project;
	for (const index of [0, 1, 2]) {
		const first = track(saved, index)[0];
		expect(first && first.start + segmentDuration(first)).toBeCloseTo(3, 9);
	}
	expect(
		saved.segments.find((segment) => segment.id === broll.id)?.start
	).toBeCloseTo(5, 9);
	const gap = await call("trim-to-playhead", {
		edge: "start",
		revision: saved.revision,
		ripple: false,
		time: 1,
	});
	const gapped = (await gap.json()) as Project;
	expect(track(gapped, 0)[0]?.start).toBe(1);
	expect(
		gapped.segments.find((segment) => segment.id === broll.id)?.start
	).toBeCloseTo(5, 9);
});

test("trim-to-playhead reports a time with nothing under it", async () => {
	const { call, project } = await setup();
	const response = await call("trim-to-playhead", {
		edge: "start",
		revision: project.revision,
		ripple: true,
		time: 5,
	});
	expect(response.status).toBe(400);
});

test("ripple-delete-gap closes the gap before the b-roll", async () => {
	const { broll, call, project } = await setup();
	const response = await call("ripple-delete-gap", {
		revision: project.revision,
		time: 5,
		track: 0,
	});
	expect(response.status).toBe(200);
	const saved = (await response.json()) as Project;
	expect(saved.segments.find((segment) => segment.id === broll.id)?.start).toBe(
		4
	);
	const none = await call("ripple-delete-gap", {
		revision: saved.revision,
		time: 1,
		track: 0,
	});
	expect(none.status).toBe(400);
});

test("cut routes are documented in OpenAPI", () => {
	const document = openapi(routes) as {
		paths: Record<string, Record<string, { operationId: string }>>;
	};
	const ids = Object.values(document.paths).flatMap((operations) =>
		Object.values(operations).map((operation) => operation.operationId)
	);
	expect(ids).toEqual(
		expect.arrayContaining([
			"video_studio_split_clip",
			"video_studio_remove_clips",
			"video_studio_trim_to_playhead",
			"video_studio_ripple_delete_gap",
		])
	);
});
