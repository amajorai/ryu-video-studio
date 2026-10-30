import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	type Asset,
	newProject,
	newSegment,
	projectSchema,
} from "../../../shared/project.ts";
import { createStudioServer, openapi } from "../server.ts";
import { StudioStore } from "../store.ts";
import { routes, summarizeHistory } from "./history.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});

function asset(): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration: 10,
		hasAudio: true,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video",
		name: "Footage",
		width: 640,
	};
}

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-history-"));
	const store = new StudioStore(directory);
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, routes, store, token });
	cleanup.push(async () => {
		app.server.stop(true);
		store.close();
		await rm(directory, { force: true, recursive: true });
	});
	const media = asset();
	store.putAsset(media);
	const created = store.create("History");
	const first = store.save({ ...created, segments: [newSegment(media)] });
	const second = store.save({ ...first, title: "History v2" });
	const call = (method: "GET" | "POST", query = "", body?: unknown) =>
		fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${created.id}/history${query}`,
			{
				body: body === undefined ? undefined : JSON.stringify(body),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method,
			}
		);
	return { call, second, store };
}

const summarySchema = z
	.object({
		current: z.object({ revision: z.number(), updatedAt: z.string() }).strict(),
		revisions: z.array(
			z
				.object({
					duration: z.number(),
					revision: z.number(),
					segmentCount: z.number(),
					title: z.string(),
					updatedAt: z.string(),
				})
				.strict()
		),
	})
	.strict();

test("summary lists restorable revisions newest first without timelines", async () => {
	const { call, second } = await setup();
	const response = await call("GET", "?summary=1");
	expect(response.status).toBe(200);
	const summary = summarySchema.parse(await response.json());
	expect(summary.current).toEqual({
		revision: second.revision,
		updatedAt: second.updatedAt,
	});
	expect(summary.revisions.map((item) => item.revision)).toEqual([1, 0]);
	expect(summary.revisions[0]).toMatchObject({
		duration: 10,
		segmentCount: 1,
		title: "History",
	});
	expect(summary.revisions[1]).toMatchObject({ duration: 0, segmentCount: 0 });
});

test("without summary the full revisions are returned unchanged", async () => {
	const { call } = await setup();
	const body = z
		.object({ history: z.array(projectSchema) })
		.parse(await (await call("GET")).json());
	expect(body.history.map((project) => project.revision)).toEqual([1, 0]);
	const off = z
		.object({ history: z.array(projectSchema) })
		.parse(await (await call("GET", "?summary=0")).json());
	expect(off.history).toHaveLength(2);
});

test("an invalid summary flag is a bad request", async () => {
	const { call } = await setup();
	expect((await call("GET", "?summary=yes")).status).toBe(400);
});

test("a summarised revision restores, and a stale restore conflicts", async () => {
	const { call, second } = await setup();
	const summary = summarySchema.parse(
		await (await call("GET", "?summary=1")).json()
	);
	const target = summary.revisions.at(-1)?.revision ?? -1;
	const restored = await call("POST", "", {
		historyRevision: target,
		revision: second.revision,
	});
	expect(restored.status).toBe(200);
	expect(projectSchema.parse(await restored.json())).toMatchObject({
		revision: second.revision + 1,
		segments: [],
	});
	const stale = await call("POST", "", {
		historyRevision: target,
		revision: second.revision,
	});
	expect(stale.status).toBe(409);
});

test("summarizeHistory sorts by revision and keeps the current stamp", () => {
	const base = newProject("Older");
	const older = { ...base, revision: 2 };
	const newer = { ...base, revision: 5, title: "Newer" };
	const result = summarizeHistory({ revision: 6, updatedAt: "now" }, [
		older,
		newer,
	]);
	expect(result.current).toEqual({ revision: 6, updatedAt: "now" });
	expect(result.revisions.map((item) => item.title)).toEqual([
		"Newer",
		base.title,
	]);
});

test("OpenAPI documents the summary query", () => {
	const parameters =
		openapi(routes).paths["/api/video-studio/projects/{id}/history"]?.get
			?.parameters ?? [];
	expect(parameters.map((parameter) => parameter.name)).toContain("summary");
});
