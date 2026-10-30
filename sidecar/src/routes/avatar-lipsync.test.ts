import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { avatarPoseAtTime } from "../../../shared/avatar.ts";
import {
	type Avatar,
	newSegment,
	type Project,
} from "../../../shared/project.ts";
import { createStudioServer, openapi } from "../server.ts";
import { StudioStore } from "../store.ts";
import { clearVoiceActivityCache } from "../vad.ts";
import { speechFixtureAsset, VAD_FIXTURE_SPEECH } from "../vad-fixture.ts";

const stores: StudioStore[] = [];
const servers: ReturnType<typeof createStudioServer>[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.stop();
	}
	for (const store of stores.splice(0)) {
		clearVoiceActivityCache(store);
		store.close();
		await rm(store.directory, {
			force: true,
			recursive: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

async function studio() {
	const store = new StudioStore(await mkdtemp(join(tmpdir(), "ryu-lipsync-")));
	stores.push(store);
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, store, token });
	servers.push(app);
	const post = async (path: string, body: unknown) => {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio${path}`,
			{
				body: JSON.stringify(body),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		return { body: await response.json(), status: response.status };
	};
	return { post, store };
}

function avatar(extra: Partial<Avatar> = {}): Avatar {
	return {
		accent: "#f97316",
		animation: "none",
		depth: 0.45,
		end: 7,
		entryDuration: 0,
		height: 0.6,
		id: crypto.randomUUID(),
		outfit: "#4f46e5",
		pose: "neutral",
		skin: "#f4c7a1",
		start: 0,
		width: 0.3,
		x: 0.5,
		y: 0.2,
		...extra,
	};
}

test("lip-sync follows a clip's speech and pauses", async () => {
	const { post, store } = await studio();
	const audio = await speechFixtureAsset(store, { name: "Voice" });
	const clip = newSegment(audio, 0);
	const character = avatar();
	const project = store.save({
		...store.create("Lip-sync"),
		avatars: [character],
		segments: [clip],
	});
	const response = await post(`/projects/${project.id}/avatars/lip-sync`, {
		avatarId: character.id,
		revision: project.revision,
		segmentId: clip.id,
		smoothing: 0.2,
	});
	expect(response.status).toBe(200);
	expect(response.body.envelope).toBe("audio");
	expect(response.body.keyframes).toBeGreaterThan(4);
	expect(response.body.keyframes).toBeLessThanOrEqual(100);
	const saved: Project = response.body.project;
	expect(saved.revision).toBe(project.revision + 1);
	const updated = saved.avatars[0];
	if (!updated) {
		throw new Error("The avatar was dropped.");
	}
	// No source reference is persisted: the keyframes are self-contained.
	expect(updated.lipSync).toBeUndefined();
	for (const [start, end] of VAD_FIXTURE_SPEECH) {
		const middle = (start + end) / 2;
		const peak = Math.max(
			...[-0.1, -0.05, 0, 0.05, 0.1].map(
				(offset) => avatarPoseAtTime(updated, middle + offset).mouth
			)
		);
		expect(peak).toBeGreaterThan(0.3);
	}
	// Pauses: 1.2-1.7, 2.6-3.4, 4.9-6.1 (smoothing spills a little at the edges).
	for (const pause of [1.45, 3, 5.5]) {
		expect(avatarPoseAtTime(updated, pause).mouth).toBeLessThan(0.05);
	}

	// Re-running replaces the mouth keyframes.
	const rerun = await post(`/projects/${project.id}/avatars/lip-sync`, {
		avatarId: character.id,
		revision: saved.revision,
		segmentId: clip.id,
		sensitivity: 1,
	});
	expect(rerun.status).toBe(200);
	const again: Avatar = rerun.body.project.avatars[0];
	expect(again.lipSync).toBeUndefined();
	expect(again.rigKeyframes?.length).toBe(rerun.body.keyframes);

	// Regression: the source clip can be removed afterwards, and the mouth
	// animation stays.
	const removed = await post(`/projects/${project.id}/remove`, {
		clipIds: [clip.id],
		revision: rerun.body.project.revision,
	});
	expect(removed.status).toBe(200);
	const afterRemove = store.project(project.id);
	expect(afterRemove.segments).toEqual([]);
	expect(afterRemove.avatars[0]?.rigKeyframes?.length).toBe(
		rerun.body.keyframes
	);
	expect(
		store.save({ ...store.project(project.id), title: "Renamed" }).title
	).toBe("Renamed");
});

test("deleting lip-sync source media keeps the project saveable", async () => {
	const { post, store } = await studio();
	const audio = await speechFixtureAsset(store, { duration: 2, name: "Voice" });
	const character = avatar({ end: 2 });
	const project = store.save({
		...store.create("Lip-sync"),
		avatars: [character],
	});
	const response = await post(`/projects/${project.id}/avatars/lip-sync`, {
		assetId: audio.id,
		avatarId: character.id,
		revision: project.revision,
	});
	expect(response.status).toBe(200);
	expect(store.organizeAsset(audio.id, { delete: true }).deleted).toBe(true);
	const renamed = store.save({
		...store.project(project.id),
		title: "Renamed",
	});
	expect(renamed.title).toBe("Renamed");
	expect(renamed.avatars[0]?.rigKeyframes?.length).toBe(
		response.body.keyframes
	);
});

test("lip-sync refuses a muted clip", async () => {
	const { post, store } = await studio();
	const audio = await speechFixtureAsset(store, { duration: 2, name: "Voice" });
	const clip = { ...newSegment(audio, 0), muted: true, volume: 0 };
	const character = avatar({ end: 2 });
	const project = store.save({
		...store.create("Lip-sync"),
		avatars: [character],
		segments: [clip],
	});
	const response = await post(`/projects/${project.id}/avatars/lip-sync`, {
		avatarId: character.id,
		revision: project.revision,
		segmentId: clip.id,
	});
	expect(response.status).toBe(400);
	expect(response.body.message).toContain("muted or silent");
});

test("lip-sync refuses stale revisions, silent sources and missing analysis", async () => {
	const { post, store } = await studio();
	const audio = await speechFixtureAsset(store, { duration: 2, name: "Voice" });
	const character = avatar({ end: 2 });
	const project = store.save({
		...store.create("Lip-sync"),
		avatars: [character],
	});
	const path = `/projects/${project.id}/avatars/lip-sync`;
	const stale = await post(path, {
		assetId: audio.id,
		avatarId: character.id,
		revision: project.revision + 5,
	});
	expect(stale.status).toBe(409);
	const missing = await post(path, {
		avatarId: crypto.randomUUID(),
		assetId: audio.id,
		revision: project.revision,
	});
	expect(missing.status).toBe(400);
	expect(missing.body.message).toContain("avatar");
	const noSource = await post(path, {
		avatarId: character.id,
		revision: project.revision,
	});
	expect(noSource.status).toBe(400);
	const analysis = await post(path, {
		assetId: audio.id,
		avatarId: character.id,
		envelope: "analysis",
		revision: project.revision,
	});
	expect(analysis.status).toBe(400);
	expect(analysis.body.message).toContain("Analyze");
});

test("the analysis envelope lip-syncs without FFmpeg extraction", async () => {
	const { post, store } = await studio();
	const audio = await speechFixtureAsset(store, { duration: 2, name: "Voice" });
	store.putAnalysis({
		assetId: audio.id,
		createdAt: new Date().toISOString(),
		duration: 2,
		sceneCuts: [],
		status: "completed",
		waveform: Array.from({ length: 20 }, (_, index) =>
			index >= 5 && index < 15 ? 0.3 : 0
		),
	});
	const character = avatar({ end: 2 });
	const project = store.save({
		...store.create("Lip-sync"),
		avatars: [character],
	});
	const response = await post(`/projects/${project.id}/avatars/lip-sync`, {
		assetId: audio.id,
		avatarId: character.id,
		envelope: "analysis",
		revision: project.revision,
		smoothing: 0,
	});
	expect(response.status).toBe(200);
	const updated: Avatar = response.body.project.avatars[0];
	expect(avatarPoseAtTime(updated, 0.2).mouth).toBe(0);
	expect(avatarPoseAtTime(updated, 1).mouth).toBeGreaterThan(0.5);
	expect(avatarPoseAtTime(updated, 1.8).mouth).toBe(0);
	expect(updated.lipSync?.segmentId).toBeUndefined();
});

test("openapi documents the lip-sync route", () => {
	const document = openapi() as {
		paths: Record<string, { post?: { operationId?: string } }>;
	};
	expect(
		document.paths["/api/video-studio/projects/{id}/avatars/lip-sync"]?.post
			?.operationId
	).toBe("video_studio_avatar_lip_sync");
});
