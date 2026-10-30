import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Asset,
	newSegment,
	type Project,
} from "../../../shared/project.ts";
import {
	type ExportJobOutput,
	exportJobOutputSchema,
} from "../../../shared/render-options.ts";
import { probe, runMedia } from "../media.ts";
import { createStudioServer } from "../server.ts";
import { type RenderJob, StudioStore } from "../store.ts";

const stores: StudioStore[] = [];
const servers: ReturnType<typeof createStudioServer>[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.stop();
	}
	for (const store of stores.splice(0)) {
		store.close();
		await rm(store.directory, { recursive: true, force: true });
	}
});

type ExportJob = RenderJob & { export?: ExportJobOutput };

async function studio() {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-render-route-"))
	);
	stores.push(store);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	servers.push(app);
	const call = async (path: string, body?: unknown) => {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio${path}`,
			{
				method: body === undefined ? "GET" : "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}
		);
		return { status: response.status, body: await response.json() };
	};
	return { call, store };
}

async function clipProject(store: StudioStore): Promise<Project> {
	const file = join(store.directory, "source.mp4");
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=s=320x180:r=30:d=2",
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
		file,
	]);
	const asset: Asset = {
		...(await probe(file)),
		id: crypto.randomUUID(),
		name: "source",
		createdAt: new Date().toISOString(),
	};
	await Bun.write(store.mediaPath(asset.id), Bun.file(file));
	store.putAsset(asset);
	return store.save({
		...store.create("Route export"),
		fps: 30,
		width: 320,
		height: 180,
		brief: "Route export test.",
		markers: [{ id: crypto.randomUUID(), label: "Middle", time: 1 }],
		segments: [{ ...newSegment(asset, 0, 0), sourceOut: 2 }],
	});
}

async function finished(store: StudioStore, id: string): Promise<ExportJob> {
	for (let attempt = 0; attempt < 600; attempt++) {
		const job = store.jobs().find((value) => value.id === id);
		if (job && ["completed", "failed", "canceled"].includes(job.status)) {
			return job;
		}
		await Bun.sleep(50);
	}
	throw new Error("The export timed out.");
}

test("invalid export requests are refused before a job is queued", async () => {
	const { call, store } = await studio();
	const project = store.create("Empty");
	const unknown = await call(`/projects/${project.id}/render`, {
		format: "mp4",
	});
	expect(unknown.status).toBe(400);
	const stale = await call(`/projects/${project.id}/render`, {
		revision: project.revision + 1,
	});
	expect(stale.status).toBe(409);
	expect(store.jobs()).toEqual([]);
	const clipped = await clipProject(store);
	const combo = await call(`/projects/${clipped.id}/render`, {
		codec: "h264",
		overrides: { container: "webm" },
	});
	expect(combo).toMatchObject({
		status: 400,
		body: { message: "WebM exports are encoded with VP9." },
	});
	const gifAsset = await call(`/projects/${clipped.id}/render`, {
		saveAsAsset: true,
		overrides: { container: "gif" },
	});
	expect(gifAsset.body.message).toContain("Only video and audio exports");
	expect(store.jobs()).toEqual([]);
});

test("an audio-only range export renders, publishes metadata and saves to the library", async () => {
	const { call, store } = await studio();
	const project = await clipProject(store);
	const queued = await call(`/projects/${project.id}/render`, {
		revision: project.revision,
		range: { start: 0.5, end: 1.5 },
		saveAsAsset: true,
		overrides: { platformPreset: "podcast-audio" },
	});
	expect(queued.status).toBe(202);
	expect(queued.body.codec).toBeUndefined();
	const job = await finished(store, queued.body.id);
	expect(job.error).toBeUndefined();
	expect(job.status).toBe("completed");
	const output = exportJobOutputSchema.parse(job.export);
	expect(output).toMatchObject({
		container: "mp3",
		extension: "mp3",
		kind: "audio",
		platformPreset: "podcast-audio",
		range: { start: 0.5, end: 1.5 },
	});
	expect(output.metadata).toContain("Title: Route export");
	expect(output.metadata).toContain("Chapters:\n00:00 Middle\n");
	const info = await probe(store.renderPath(job.id, job.codec));
	expect(info.kind).toBe("audio");
	expect(Math.abs(info.duration - 1)).toBeLessThan(0.2);
	expect(
		await Bun.file(
			join(store.directory, "renders", `${job.id}.metadata.txt`)
		).text()
	).toBe(output.metadata ?? "");
	const saved = store.assets().find((asset) => asset.id === output.assetId);
	expect(saved).toMatchObject({ derivation: "render", kind: "audio" });
});

test("an empty body keeps the legacy job shape", async () => {
	const { call, store } = await studio();
	const project = await clipProject(store);
	const queued = await call(`/projects/${project.id}/render`, {});
	expect(queued.status).toBe(202);
	expect(queued.body.codec).toBe("h264");
	expect(queued.body.export).toBeUndefined();
	const job = await finished(store, queued.body.id);
	expect(job.status).toBe("completed");
	expect(job.review?.passed).toBe(true);
	expect(store.renderPath(job.id, job.codec).endsWith(".mp4")).toBe(true);
});

test("a body-less render of stored non-video settings records its export", async () => {
	const { call, store } = await studio();
	const clipped = await clipProject(store);
	const project = store.save({
		...clipped,
		exportSettings: { container: "wav", platformPreset: "podcast-audio" },
	});
	const queued = await call(`/projects/${project.id}/render`, {});
	expect(queued.status).toBe(202);
	expect(queued.body.codec).toBeUndefined();
	const job = await finished(store, queued.body.id);
	expect(job.error).toBeUndefined();
	const output = exportJobOutputSchema.parse(job.export);
	expect(output).toMatchObject({
		container: "wav",
		extension: "wav",
		kind: "audio",
		mime: "audio/wav",
		platformPreset: "podcast-audio",
	});
	expect(output.request).toBeUndefined();
	expect(output.metadata).toContain("Title: Route export");
	expect(
		await Bun.file(
			join(store.directory, "renders", `${job.id}.metadata.txt`)
		).exists()
	).toBe(true);
});
