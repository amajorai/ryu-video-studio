import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Asset,
	assetSchema,
	newSegment,
	type Project,
	projectSchema,
	type Segment,
} from "../../../shared/project.ts";
import { probe, runMedia } from "../media.ts";
import { createStudioServer } from "../server.ts";
import { StudioStore } from "../store.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) {
		await step();
	}
});

async function studio() {
	const store = new StudioStore(await mkdtemp(join(tmpdir(), "ryu-nest-")));
	cleanup.push(async () => {
		store.close();
		await rm(store.directory, { force: true, recursive: true });
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, store, token });
	cleanup.push(() => app.stop());
	const post = (project: Pick<Project, "id">, action: string, body: object) =>
		fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/${action}`,
			{
				body: JSON.stringify(body),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
	return { post, store };
}

async function source(store: StudioStore): Promise<Asset> {
	const path = join(store.directory, "source.mp4");
	await runMedia([
		"-f",
		"lavfi",
		"-i",
		"color=c=red:s=64x36:r=10:d=3",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:duration=3",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-shortest",
		path,
	]);
	const asset = assetSchema.parse({
		...(await probe(path)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name: "Red",
	});
	await Bun.write(store.mediaPath(asset.id), Bun.file(path));
	store.putAsset(asset);
	return asset;
}

const shape = (segments: readonly Segment[]) =>
	[...segments]
		.sort((a, b) => a.track - b.track || a.start - b.start)
		.map(({ id: _id, ...rest }) => rest);

test("nest renders a child sequence and decompose restores the clips", async () => {
	const { post, store } = await studio();
	const red = await source(store);
	const first = { ...newSegment(red, 0.5, 0), sourceOut: 1 };
	const second = { ...newSegment(red, 1.5, 1), sourceIn: 1, sourceOut: 2 };
	const keep = { ...newSegment(red, 4, 0), sourceOut: 1 };
	const parent = store.save({
		...store.create("Nest parent"),
		segments: [first, second, keep],
	});

	const stale = await post(parent, "nest", {
		clipIds: [first.id],
		revision: parent.revision + 1,
	});
	expect(stale.status).toBe(409);
	expect(store.projects()).toHaveLength(1);

	const response = await post(parent, "nest", {
		clipIds: [first.id, second.id],
		revision: parent.revision,
		title: "Intro nest",
	});
	expect(response.status).toBe(201);
	const body = (await response.json()) as {
		asset: unknown;
		clipId: string;
		project: unknown;
		sequenceProject: unknown;
	};
	const asset = assetSchema.parse(body.asset);
	const nested = projectSchema.parse(body.project);
	const child = projectSchema.parse(body.sequenceProject);
	expect(child.title).toBe("Intro nest");
	expect(asset.sequenceProjectId).toBe(child.id);
	expect(await Bun.file(store.mediaPath(asset.id)).exists()).toBe(true);
	expect(child.segments.map((segment) => segment.start)).toEqual([0, 1]);
	expect(nested.segments).toHaveLength(2);
	const clip = nested.segments.find((segment) => segment.id === body.clipId);
	expect(clip).toMatchObject({ assetId: asset.id, start: 0.5, track: 0 });
	expect(clip?.sourceOut).toBeCloseTo(2, 1);

	const decomposed = await post(nested, "decompose", {
		clipId: body.clipId,
		revision: nested.revision,
	});
	expect(decomposed.status).toBe(200);
	const result = (await decomposed.json()) as {
		clipIds: string[];
		project: unknown;
	};
	const restored = projectSchema.parse(result.project);
	expect(result.clipIds).toHaveLength(2);
	expect(shape(restored.segments)).toEqual(shape(parent.segments));
	// The child project stays in the library after decomposing.
	expect(store.project(child.id).segments).toHaveLength(2);
}, 60_000);

test("nest and decompose refuse invalid clips without side effects", async () => {
	const { post, store } = await studio();
	const red = await source(store);
	const clip = newSegment(red, 0, 0);
	const parent = store.save({
		...store.create("Refusals"),
		segments: [clip],
	});
	const missing = await post(parent, "nest", {
		clipIds: [crypto.randomUUID()],
		revision: parent.revision,
	});
	expect(missing.status).toBe(400);
	expect(store.projects()).toHaveLength(1);
	expect(store.assets()).toHaveLength(1);
	const plain = await post(parent, "decompose", {
		clipId: clip.id,
		revision: parent.revision,
	});
	expect(plain.status).toBe(400);
	const extra = await post(parent, "decompose", {
		clipId: clip.id,
		revision: parent.revision,
		title: "no",
	});
	expect(extra.status).toBe(400);
}, 30_000);

test("a failed nest render deletes the child project", async () => {
	const { post, store } = await studio();
	const red = await source(store);
	const clip = { ...newSegment(red, 0, 0), sourceOut: 1 };
	const parent = store.save({
		...store.create("Offline parent"),
		segments: [clip],
	});
	await rm(store.mediaPath(red.id), { force: true });
	const response = await post(parent, "nest", {
		clipIds: [clip.id],
		revision: parent.revision,
	});
	expect(response.status).toBeGreaterThanOrEqual(400);
	expect(store.projects().map((project) => project.id)).toEqual([parent.id]);
	expect(store.assets().map((asset) => asset.id)).toEqual([red.id]);
	expect(store.project(parent.id).revision).toBe(parent.revision);
}, 30_000);
