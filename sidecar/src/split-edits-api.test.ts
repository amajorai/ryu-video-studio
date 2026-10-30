import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import {
	type Asset,
	newSegment,
	type Project,
	projectSchema,
	type Segment,
	updateTrackSetting,
} from "../../shared/project.ts";
import { probe, runMedia } from "./media.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

type StudioRequestBody = z.infer<ReturnType<typeof z.json>>;

const stores: StudioStore[] = [];
const servers: ReturnType<typeof createStudioServer>[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.stop();
	}
	for (const store of stores.splice(0)) {
		store.close();
		await rm(store.directory, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

async function studio() {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-split-edits-api-"))
	);
	stores.push(store);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	servers.push(app);
	const call = async (path: string, body?: StudioRequestBody) => {
		const init: RequestInit = {
			method: body === undefined ? "GET" : "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
		};
		if (body !== undefined) {
			init.body = JSON.stringify(body);
		}
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio${path}`,
			init
		);
		return { status: response.status, body: await response.json() };
	};
	return { call, store };
}

function media(kind: Asset["kind"], duration: number, name: string): Asset {
	return {
		id: crypto.randomUUID(),
		name,
		kind,
		duration,
		width: kind === "audio" ? 0 : 1920,
		height: kind === "audio" ? 0 : 1080,
		hasAudio: kind !== "image",
		createdAt: new Date().toISOString(),
	};
}

/**
 * Two linked picture/sound groups butted at t = 4. Each audio clip has 0.5 s
 * of source beyond the cut on its own side, so offsets clamp to 0.5.
 */
async function cutFixture() {
	const { call, store } = await studio();
	const outVideo = { ...media("video", 10, "Wide"), hasAudio: false };
	const inVideo = { ...media("video", 10, "Close"), hasAudio: false };
	const outAudio = media("audio", 4.5, "Wide sound");
	const inAudio = media("audio", 10, "Close sound");
	for (const asset of [outVideo, inVideo, outAudio, inAudio]) {
		store.putAsset(asset);
	}
	const outGroup = crypto.randomUUID();
	const inGroup = crypto.randomUUID();
	const segments: Segment[] = [
		{ ...newSegment(outVideo, 0, 0), sourceOut: 4, linkGroupId: outGroup },
		{ ...newSegment(outAudio, 0, 1), sourceOut: 4, linkGroupId: outGroup },
		{
			...newSegment(inVideo, 4, 0),
			sourceIn: 0.5,
			sourceOut: 4.5,
			linkGroupId: inGroup,
		},
		{
			...newSegment(inAudio, 4, 1),
			sourceIn: 0.5,
			sourceOut: 4.5,
			linkGroupId: inGroup,
		},
	];
	const project = store.save({
		...store.create("Split edits"),
		fps: 30,
		segments,
	});
	return {
		call,
		inAudio,
		key: `${outGroup}>${inGroup}`,
		outAudio,
		project,
		store,
	};
}

const audioClip = (project: Project, assetId: string) =>
	project.segments.find((segment) => segment.assetId === assetId);

test("split-edit rejects a stale revision with 409 and leaves the project", async () => {
	const { call, key, project, store } = await cutFixture();
	const stale = await call(`/projects/${project.id}/split-edit`, {
		cutKey: key,
		kind: "j",
		offset: 0.25,
		revision: project.revision + 1,
	});
	expect(stale.status).toBe(409);
	expect(stale.body.code).toBe("CONFLICT");
	const batch = await call(`/projects/${project.id}/split-edits`, {
		proposals: [{ key, offset: 0.25 }],
		revision: project.revision - 1,
	});
	expect(batch.status).toBe(409);
	expect(store.project(project.id).revision).toBe(project.revision);
});

test("split-edit-plan is read-only and reports the current revision", async () => {
	const { call, key, project, store } = await cutFixture();
	const plan = await call(`/projects/${project.id}/split-edit-plan`, {});
	expect(plan.status).toBe(200);
	expect(plan.body.revision).toBe(project.revision);
	expect(plan.body.proposals.map((p: { key: string }) => p.key)).toEqual([key]);
	expect(Array.isArray(plan.body.skipped)).toBe(true);
	const empty = await call(`/projects/${project.id}/split-edit-plan`, {
		options: { maxOffset: 1 },
	});
	expect(empty.status).toBe(200);
	expect(store.project(project.id).revision).toBe(project.revision);
	const invalid = await call(`/projects/${project.id}/split-edit-plan`, {
		options: { minOffset: 2, maxOffset: 1 },
	});
	expect(invalid.status).toBe(400);
});

test("manual split-edit clamps the offset to the source handle", async () => {
	const { call, inAudio, key, project } = await cutFixture();
	const response = await call(`/projects/${project.id}/split-edit`, {
		cutKey: key,
		crossfade: 0,
		kind: "j",
		offset: 2,
		revision: project.revision,
	});
	expect(response.status).toBe(200);
	expect(response.body.key).toBe(key);
	expect(response.body.appliedOffset).toBeCloseTo(-0.5, 6);
	const saved = projectSchema.parse(response.body.project);
	expect(saved.revision).toBe(project.revision + 1);
	expect(audioClip(saved, inAudio.id)?.start).toBeCloseTo(3.5, 6);
	expect(audioClip(saved, inAudio.id)?.sourceIn).toBeCloseTo(0, 6);
	const byClip = await call(`/projects/${project.id}/split-edit`, {
		clipId: saved.segments[0]?.id ?? "",
		crossfade: 0,
		kind: "none",
		nearTime: 4,
		revision: saved.revision,
	});
	expect(byClip.status).toBe(200);
	expect(byClip.body.appliedOffset).toBe(0);
	expect(audioClip(byClip.body.project, inAudio.id)?.start).toBeCloseTo(4, 6);
});

test("batch split-edits return the clamped offsets they applied", async () => {
	const { call, key, outAudio, project } = await cutFixture();
	const missing = `${crypto.randomUUID()}>${crypto.randomUUID()}`;
	const response = await call(`/projects/${project.id}/split-edits`, {
		crossfade: 0,
		proposals: [
			{ key, offset: 2 },
			{ key: missing, offset: -1 },
		],
		revision: project.revision,
	});
	expect(response.status).toBe(200);
	expect(response.body.applied).toEqual([{ key, offset: 0.5 }]);
	expect(response.body.skipped).toEqual([
		{ key: missing, reason: "missing-cut" },
	]);
	const saved = projectSchema.parse(response.body.project);
	const outgoing = audioClip(saved, outAudio.id);
	expect(outgoing?.sourceOut).toBeCloseTo(4.5, 6);
	expect(saved.revision).toBe(project.revision + 1);
});

test("plan routes for fillers, dead air and highlights never bump the revision", async () => {
	const { call, inAudio, project, store } = await cutFixture();
	store.importTranscript(inAudio, null, [
		{ id: crypto.randomUUID(), start: 0.6, end: 1.4, text: "Um, so." },
		{
			id: crypto.randomUUID(),
			start: 3.6,
			end: 4.4,
			text: "What a great day!",
		},
	]);
	for (const action of ["filler-plan", "dead-air-plan"]) {
		const response = await call(`/projects/${project.id}/${action}`, {});
		expect(response.status).toBe(200);
		expect(response.body.revision).toBe(project.revision);
		expect(Array.isArray(response.body.ranges)).toBe(true);
	}
	const highlights = await call(`/projects/${project.id}/highlights`, {
		count: 2,
		target: { min: 1, max: 4 },
	});
	expect(highlights.status).toBe(200);
	expect(highlights.body.revision).toBe(project.revision);
	expect(Array.isArray(highlights.body.candidates)).toBe(true);
	const trim = await call(`/projects/${project.id}/trim-edit`, {
		mode: "roll",
		outClipId: project.segments[0]?.id ?? "",
		inClipId: project.segments[2]?.id ?? "",
		delta: 0,
		revision: project.revision,
	});
	expect(trim.status).toBe(200);
	expect(trim.body.applied).toBe(0);
	expect(store.project(project.id).revision).toBe(project.revision);
	const staleTrim = await call(`/projects/${project.id}/trim-edit`, {
		mode: "slip",
		clipId: project.segments[0]?.id ?? "",
		delta: 0.5,
		revision: project.revision + 3,
	});
	expect(staleTrim.status).toBe(409);
});

async function cameraFixture() {
	const { call, store } = await studio();
	const file = join(store.directory, "camera.mp4");
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=s=160x90:r=30:d=2",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:duration=2",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-shortest",
		"-f",
		"mp4",
		file,
	]);
	const camera: Asset = {
		...(await probe(file)),
		id: crypto.randomUUID(),
		name: "Camera",
		createdAt: new Date().toISOString(),
	};
	await Bun.write(store.mediaPath(camera.id), Bun.file(file));
	await rm(file, { force: true });
	store.putAsset(camera);
	const project = store.save({
		...store.create("Camera"),
		segments: [{ ...newSegment(camera), sourceOut: 1.5 }],
	});
	return { call, camera, project, store };
}

const derivedOf = (store: StudioStore, assetId: string) =>
	store.assets().filter((asset) => asset.derivedFromAssetId === assetId);

test("extract-audio and detach-audio are idempotent", async () => {
	const { call, camera, project, store } = await cameraFixture();
	const first = await call(`/assets/${camera.id}/extract-audio`, {});
	expect(first.status).toBe(201);
	expect(first.body).toMatchObject({
		derivation: "audio",
		derivedFromAssetId: camera.id,
		hasAudio: true,
		kind: "audio",
	});
	expect(Math.abs(first.body.duration - camera.duration)).toBeLessThan(0.1);
	const again = await call(`/assets/${camera.id}/extract-audio`, {});
	expect(again.status).toBe(200);
	expect(again.body.id).toBe(first.body.id);
	expect(derivedOf(store, camera.id)).toHaveLength(1);

	const clipId = project.segments[0]?.id ?? "";
	const stale = await call(`/projects/${project.id}/detach-audio`, {
		clipIds: [clipId],
		revision: project.revision + 1,
	});
	expect(stale.status).toBe(409);
	const detached = await call(`/projects/${project.id}/detach-audio`, {
		clipIds: [clipId],
		revision: project.revision,
	});
	expect(detached.status).toBe(200);
	const saved = projectSchema.parse(detached.body);
	const audio = saved.segments.find(
		(segment) => segment.assetId === first.body.id
	);
	const video = saved.segments.find((segment) => segment.id === clipId);
	expect(audio?.linkGroupId).toBeDefined();
	expect(audio?.linkGroupId).toBe(video?.linkGroupId);
	expect(video?.volume).toBe(0);
	expect(audio?.sourceOut).toBeCloseTo(1.5, 6);
	const repeat = await call(`/projects/${project.id}/detach-audio`, {
		clipIds: [clipId],
		revision: saved.revision,
	});
	expect(repeat.status).toBe(200);
	expect(projectSchema.parse(repeat.body).segments).toHaveLength(2);
	expect(derivedOf(store, camera.id)).toHaveLength(1);
});

test("freeze-frame captures a source still and reverse reuses its derivative", async () => {
	const { call, camera, project, store } = await cameraFixture();
	const clipId = project.segments[0]?.id ?? "";
	const frozen = await call(`/projects/${project.id}/freeze-frame`, {
		at: 0.5,
		clipId,
		duration: 1,
		revision: project.revision,
	});
	expect(frozen.status).toBe(200);
	const withFreeze = projectSchema.parse(frozen.body);
	const still = store
		.assets()
		.find((asset) => asset.kind === "image" && asset.name.includes("freeze"));
	expect(still).toBeDefined();
	expect(
		withFreeze.segments.some((segment) => segment.assetId === still?.id)
	).toBe(true);
	expect(Bun.file(store.mediaPath(still?.id ?? "")).size).toBeGreaterThan(0);

	const reversed = await call(`/projects/${project.id}/reverse`, {
		clipIds: [clipId],
		revision: withFreeze.revision,
	});
	expect(reversed.status).toBe(200);
	const derivative = derivedOf(store, camera.id).find(
		(asset) => asset.derivation === "reverse"
	);
	expect(derivative?.kind).toBe("video");
	expect(Math.abs((derivative?.duration ?? 0) - camera.duration)).toBeLessThan(
		0.05
	);
	const once = projectSchema.parse(reversed.body);
	expect(once.segments.find((segment) => segment.id === clipId)?.assetId).toBe(
		derivative?.id
	);
	const restored = await call(`/projects/${project.id}/reverse`, {
		clipIds: [clipId],
		revision: once.revision,
	});
	expect(restored.status).toBe(200);
	const twice = projectSchema.parse(restored.body);
	expect(twice.segments.find((segment) => segment.id === clipId)?.assetId).toBe(
		camera.id
	);
	const again = await call(`/projects/${project.id}/reverse`, {
		clipIds: [clipId],
		revision: twice.revision,
	});
	expect(again.status).toBe(200);
	expect(
		derivedOf(store, camera.id).filter(
			(asset) => asset.derivation === "reverse"
		)
	).toHaveLength(1);
});

test("a freeze frame refused by a concurrent edit leaves no orphaned still", async () => {
	const { call, project, store } = await cameraFixture();
	const clipId = project.segments[0]?.id ?? "";
	const before = store.assets().length;
	const mediaBefore = (await readdir(join(store.directory, "media"))).length;
	const pending = call(`/projects/${project.id}/freeze-frame`, {
		at: 0.5,
		clipId,
		duration: 1,
		revision: project.revision,
	});
	await Bun.sleep(5);
	store.save(store.project(project.id));
	const response = await pending;
	expect(response.status).toBe(409);
	expect(store.assets()).toHaveLength(before);
	expect(await readdir(join(store.directory, "media"))).toHaveLength(
		mediaBefore
	);
});

test("reverse validates the whole request before rendering any media", async () => {
	const { call, camera, project, store } = await cameraFixture();
	const other = await call(`/assets/${camera.id}/extract-audio`, {});
	expect(other.status).toBe(201);
	const locked = store.save(
		updateTrackSetting(
			{
				...project,
				segments: [
					...project.segments,
					{ ...newSegment(other.body), start: 0, track: 1 },
				],
			},
			1,
			{ locked: true }
		)
	);
	const response = await call(`/projects/${project.id}/reverse`, {
		clipIds: locked.segments.map((segment) => segment.id),
		revision: locked.revision,
	});
	expect(response.status).toBe(400);
	expect(response.body.error ?? response.body.message).toContain("Unlock");
	expect(
		store.assets().filter((asset) => asset.derivation === "reverse")
	).toHaveLength(0);
});

test("a reversed camera clip does not block detaching or batch split edits", async () => {
	const { call, project, store } = await cameraFixture();
	const clipId = project.segments[0]?.id ?? "";
	const reversed = await call(`/projects/${project.id}/reverse`, {
		clipIds: [clipId],
		revision: project.revision,
	});
	expect(reversed.status).toBe(200);
	const after = projectSchema.parse(reversed.body);
	const batch = await call(`/projects/${project.id}/split-edits`, {
		detachAudio: true,
		proposals: [],
		revision: after.revision,
	});
	expect(batch.status).toBe(200);
	const explicit = await call(`/projects/${project.id}/detach-audio`, {
		clipIds: [clipId],
		revision: store.project(project.id).revision,
	});
	expect(explicit.status).toBe(400);
	expect(JSON.stringify(explicit.body)).toContain(
		"Reversed clips keep their audio embedded"
	);
});

test("extract-audio refuses nested sequences, which re-render in place", async () => {
	const { call, store } = await studio();
	const sequence: Asset = {
		...media("video", 4, "Sequence"),
		sequenceProjectId: crypto.randomUUID(),
	};
	store.putAsset(sequence);
	const response = await call(`/assets/${sequence.id}/extract-audio`, {});
	expect(response.status).toBe(400);
	expect(JSON.stringify(response.body)).toContain("Nested sequences");
	expect(derivedOf(store, sequence.id)).toHaveLength(0);
});

test("reversing a low-sample-rate MP3 keeps the source duration", async () => {
	const { call, store } = await studio();
	const file = join(store.directory, "voice.mp3");
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=330:duration=13.33:sample_rate=22050",
		"-c:a",
		"libmp3lame",
		"-f",
		"mp3",
		file,
	]);
	const voice: Asset = {
		...(await probe(file)),
		id: crypto.randomUUID(),
		name: "Voice",
		createdAt: new Date().toISOString(),
	};
	await Bun.write(store.mediaPath(voice.id), Bun.file(file));
	await rm(file, { force: true });
	store.putAsset(voice);
	const project = store.save({
		...store.create("Voice"),
		segments: [newSegment(voice)],
	});
	const response = await call(`/projects/${project.id}/reverse`, {
		clipIds: [project.segments[0]?.id ?? ""],
		revision: project.revision,
	});
	expect(response.status).toBe(200);
	const derivative = derivedOf(store, voice.id).find(
		(asset) => asset.derivation === "reverse"
	);
	expect(
		Math.abs((derivative?.duration ?? 0) - voice.duration)
	).toBeLessThanOrEqual(0.05);
});
