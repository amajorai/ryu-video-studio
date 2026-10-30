import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Asset, newSegment } from "../../../shared/project.ts";
import { projectSummariesResponseSchema } from "../../../shared/project-summary.ts";
import { createStudioServer, openapi } from "../server.ts";
import { ConflictError, type RenderJob, StudioStore } from "../store.ts";
import { routes } from "./projects-ext.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});

function video(overrides: Partial<Asset> = {}): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration: 10,
		hasAudio: true,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video",
		name: "Footage",
		width: 640,
		...overrides,
	};
}

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-projects-"));
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
	const call = (method: "GET" | "DELETE", path: string) =>
		fetch(`http://127.0.0.1:${app.server.port}/api/video-studio${path}`, {
			headers: { authorization: `Bearer ${token}` },
			method,
		});
	return { call, directory, store };
}

const errorSchema = z.object({ code: z.string(), message: z.string() });

function job(projectId: string, status: RenderJob["status"]): RenderJob {
	return {
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		progress: status === "completed" ? 1 : 0.2,
		projectId,
		revision: 0,
		status,
	};
}

describe("GET /project-summaries", () => {
	test("returns the summary shape for every project", async () => {
		const { call, store } = await setup();
		const media = video();
		store.putAsset(media);
		const created = store.create("Summary");
		const saved = store.save({
			...created,
			segments: [newSegment(media, 0), newSegment(media, 10)],
		});
		store.create("Empty");
		const response = await call("GET", "/project-summaries");
		expect(response.status).toBe(200);
		const body = projectSummariesResponseSchema.parse(await response.json());
		expect(body.projects).toHaveLength(2);
		const summary = body.projects.find((item) => item.id === saved.id);
		expect(summary).toEqual({
			createdAt: created.updatedAt,
			duration: 20,
			height: saved.height,
			id: saved.id,
			posterUrl: `/projects/${saved.id}/poster`,
			revision: 1,
			segmentCount: 2,
			title: "Summary",
			updatedAt: saved.updatedAt,
			width: saved.width,
		});
	});

	test("legacy projects fall back to their oldest history revision", async () => {
		const { store } = await setup();
		const created = store.create("Legacy");
		store.save({ ...created, title: "Legacy v2" });
		store.db.query("DELETE FROM project_meta").run();
		expect(store.projectCreatedTimes().get(created.id)).toBe(created.updatedAt);
	});

	test("is published in OpenAPI", () => {
		const document = openapi(routes);
		expect(
			document.paths["/api/video-studio/project-summaries"]?.get?.operationId
		).toBe("video_studio_project_summaries");
		expect(
			document.paths["/api/video-studio/projects/{id}/delete"]?.delete
				?.operationId
		).toBe("video_studio_delete_project");
		expect(
			document.paths["/api/video-studio/projects/{id}/poster"]?.get?.operationId
		).toBe("video_studio_project_poster");
	});
});

describe("DELETE /projects/:id/delete", () => {
	test("refuses a stale revision and keeps the project", async () => {
		const { call, store } = await setup();
		const created = store.create("Keep");
		const saved = store.save({ ...created, title: "Keep v2" });
		const response = await call(
			"DELETE",
			`/projects/${saved.id}/delete?revision=0`
		);
		expect(response.status).toBe(409);
		expect(errorSchema.parse(await response.json()).code).toBe("CONFLICT");
		expect(store.project(saved.id).title).toBe("Keep v2");
		expect(() => store.deleteProject(saved.id, 0)).toThrow(ConflictError);
	});

	test("refuses while an export is pending or running", async () => {
		const { call, store } = await setup();
		const created = store.create("Rendering");
		for (const status of ["pending", "running"] as const) {
			const active = job(created.id, status);
			store.putJob(active);
			const response = await call(
				"DELETE",
				`/projects/${created.id}/delete?revision=0`
			);
			expect(response.status).toBe(409);
			expect(errorSchema.parse(await response.json()).code).toBe(
				"RENDER_ACTIVE"
			);
			expect(store.project(created.id).id).toBe(created.id);
			store.putJob({ ...active, status: "canceled" });
		}
	});

	test("refuses while another project nests it as a sequence", async () => {
		const { call, store } = await setup();
		const child = store.create("Child");
		const sequence = video({ name: "Child", sequenceProjectId: child.id });
		store.putAsset(sequence);
		const parent = store.create("Parent");
		store.save({ ...parent, segments: [newSegment(sequence, 0)] });
		const response = await call(
			"DELETE",
			`/projects/${child.id}/delete?revision=0`
		);
		expect(response.status).toBe(409);
		const body = errorSchema.parse(await response.json());
		expect(body.code).toBe("PROJECT_IN_USE");
		expect(body.message).toContain("Parent");
	});

	test("removes the project, history, jobs, render outputs, and posters", async () => {
		const { call, directory, store } = await setup();
		const media = video();
		store.putAsset(media);
		const other = store.create("Other");
		const otherJob = job(other.id, "completed");
		store.putJob(otherJob);
		const created = store.create("Doomed");
		const saved = store.save({ ...created, segments: [newSegment(media, 0)] });
		const unusedSequence = video({ sequenceProjectId: saved.id });
		store.putAsset(unusedSequence);
		const sequenceMedia = store.mediaPath(unusedSequence.id);
		const sequenceThumb = `${sequenceMedia}.jpg`;
		await writeFile(sequenceMedia, "rendered sequence");
		await writeFile(sequenceThumb, "thumb");
		const finished = job(saved.id, "completed");
		const failed = { ...job(saved.id, "failed"), codec: "prores" as const };
		store.putJob(finished);
		store.putJob(failed);
		const files = [
			store.renderPath(finished.id),
			join(directory, "renders", `${finished.id}.jpg`),
			store.renderPath(failed.id, "prores"),
			store.posterPath(saved.id, 0),
			store.posterPath(saved.id, saved.revision),
		];
		for (const file of files) {
			await writeFile(file, "x");
		}
		await mkdir(join(directory, "renders", failed.id));
		const otherOutput = store.renderPath(otherJob.id);
		await writeFile(otherOutput, "x");

		const response = await call(
			"DELETE",
			`/projects/${saved.id}/delete?revision=${saved.revision}`
		);
		expect(response.status).toBe(200);
		const body = z
			.object({
				deleted: z.object({
					id: z.string(),
					jobIds: z.array(z.string()),
					sequenceAssetIds: z.array(z.string()),
					title: z.string(),
				}),
			})
			.parse(await response.json());
		expect(body.deleted.id).toBe(saved.id);
		expect(body.deleted.title).toBe("Doomed");
		expect(new Set(body.deleted.jobIds)).toEqual(
			new Set([finished.id, failed.id])
		);
		expect(body.deleted.sequenceAssetIds).toEqual([unusedSequence.id]);
		expect(() => store.project(saved.id)).toThrow("Project not found.");
		expect(store.history(saved.id)).toEqual([]);
		expect(store.jobs().map((item) => item.id)).toEqual([otherJob.id]);
		expect(store.projectCreatedTimes().has(saved.id)).toBe(false);
		// The nested-sequence render stays as ordinary library media.
		expect(new Set(store.assets().map((asset) => asset.id))).toEqual(
			new Set([media.id, unusedSequence.id])
		);
		const kept = store.assets().find((asset) => asset.id === unusedSequence.id);
		expect(kept?.sequenceProjectId).toBeUndefined();
		expect(kept?.name).toBe(unusedSequence.name);
		expect(existsSync(sequenceMedia)).toBe(true);
		expect(existsSync(sequenceThumb)).toBe(true);
		for (const file of files) {
			expect(existsSync(file)).toBe(false);
		}
		expect(existsSync(join(directory, "renders", failed.id))).toBe(false);
		expect(existsSync(otherOutput)).toBe(true);
		expect(store.project(other.id).title).toBe("Other");

		const again = await call(
			"DELETE",
			`/projects/${saved.id}/delete?revision=${saved.revision}`
		);
		expect(again.status).toBe(400);
	});

	test("requires a revision", async () => {
		const { call, store } = await setup();
		const created = store.create("No revision");
		const response = await call("DELETE", `/projects/${created.id}/delete`);
		expect(response.status).toBe(400);
		expect(store.project(created.id).id).toBe(created.id);
		for (const value of ["", "%20", "-1", "1.5", "0x0", "abc"]) {
			const invalid = await call(
				"DELETE",
				`/projects/${created.id}/delete?revision=${value}`
			);
			expect(invalid.status).toBe(400);
		}
		expect(store.project(created.id).id).toBe(created.id);
	});
});

describe("GET /projects/:id/poster", () => {
	test("answers NO_POSTER when nothing is visual", async () => {
		const { call, store } = await setup();
		const audio = video({ kind: "audio", width: 0, height: 0 });
		store.putAsset(audio);
		const created = store.create("Silent");
		const saved = store.save({ ...created, segments: [newSegment(audio, 0)] });
		const response = await call("GET", `/projects/${saved.id}/poster`);
		expect(response.status).toBe(404);
		expect(errorSchema.parse(await response.json()).code).toBe("NO_POSTER");
	});

	test("serves the cached poster for the current revision", async () => {
		const { call, store } = await setup();
		const media = video();
		store.putAsset(media);
		const created = store.create("Cached");
		const saved = store.save({ ...created, segments: [newSegment(media, 2)] });
		const bytes = new Uint8Array([137, 80, 78, 71]);
		await writeFile(store.posterPath(saved.id, saved.revision), bytes);
		const response = await call("GET", `/projects/${saved.id}/poster`);
		expect(response.status).toBe(200);
		const body = z
			.object({
				cached: z.boolean(),
				data: z.string(),
				mimeType: z.literal("image/png"),
				revision: z.number(),
				time: z.number(),
			})
			.parse(await response.json());
		expect(body.cached).toBe(true);
		expect(body.revision).toBe(saved.revision);
		expect(body.time).toBe(2);
		expect([...Buffer.from(body.data, "base64")]).toEqual([...bytes]);
	});

	test("prunes posters of older revisions only", async () => {
		const { store } = await setup();
		const created = store.create("Prune");
		const keep = store.posterPath(created.id, 3);
		const old = store.posterPath(created.id, 2);
		const other = store.create("Other");
		const otherPoster = store.posterPath(other.id, 0);
		for (const file of [keep, old, otherPoster]) {
			await writeFile(file, "x");
		}
		store.prunePosters(created.id, 3);
		expect(existsSync(keep)).toBe(true);
		expect(existsSync(old)).toBe(false);
		expect(existsSync(otherPoster)).toBe(true);
	});
});
