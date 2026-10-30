import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { projectSchema, type Title } from "../../../shared/project.ts";
import { createStudioServer, openapi } from "../server.ts";
import { StudioStore } from "../store.ts";
import { routes } from "./overlay-edits.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});

function title(start: number, end: number): Title {
	return {
		animation: "fade",
		color: "#ffffff",
		end,
		fadeIn: 0,
		fadeOut: 0,
		fontSize: 0.06,
		id: crypto.randomUUID(),
		start,
		text: "Lower third",
		x: 0.5,
		y: 0.8,
	};
}

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-overlay-"));
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
	const item = title(1, 3);
	const project = store.save({ ...store.create("Overlays"), titles: [item] });
	const post = (body: unknown) =>
		fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/overlay-edit`,
			{
				body: JSON.stringify(body),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
	return { item, post, project, store };
}

const result = z
	.object({ id: z.uuid().nullable(), project: projectSchema })
	.strict();

test("an agent moves a title onto another lane", async () => {
	const { item, post, project } = await setup();
	const response = await post({
		id: item.id,
		kind: "titles",
		lane: 2,
		op: "move",
		revision: project.revision,
		start: 4,
	});
	expect(response.status).toBe(200);
	const body = result.parse(await response.json());
	expect(body.id).toBe(item.id);
	expect(body.project.revision).toBe(project.revision + 1);
	expect(body.project.titles[0]).toMatchObject({ end: 6, lane: 2, start: 4 });
});

test("trim, duplicate, and delete chain on fresh revisions", async () => {
	const { item, post, project, store } = await setup();
	const trimmed = result.parse(
		await (
			await post({
				edge: "end",
				id: item.id,
				kind: "titles",
				op: "trim",
				revision: project.revision,
				snap: { pxPerSec: 100, time: 2 },
				time: 2.03,
			})
		).json()
	);
	expect(trimmed.project.titles[0]?.end).toBe(2);
	const copied = result.parse(
		await (
			await post({
				id: item.id,
				kind: "titles",
				op: "duplicate",
				revision: trimmed.project.revision,
			})
		).json()
	);
	expect(copied.id).not.toBe(item.id);
	expect(
		copied.project.titles.find((candidate) => candidate.id === copied.id)
	).toMatchObject({ end: 3, start: 2 });
	const removed = result.parse(
		await (
			await post({
				id: item.id,
				kind: "titles",
				op: "delete",
				revision: copied.project.revision,
			})
		).json()
	);
	expect(removed.id).toBeNull();
	expect(removed.project.titles.map((candidate) => candidate.id)).toEqual([
		copied.id ?? "",
	]);
	expect(store.project(project.id).titles).toHaveLength(1);
});

test("stale revisions conflict and bad bodies are refused", async () => {
	const { item, post, project } = await setup();
	const stale = await post({
		id: item.id,
		kind: "titles",
		op: "delete",
		revision: project.revision + 5,
	});
	expect(stale.status).toBe(409);
	const invalid = await post({
		id: item.id,
		kind: "titles",
		op: "warp",
		revision: project.revision,
	});
	expect(invalid.status).toBe(400);
	const missing = await post({
		id: crypto.randomUUID(),
		kind: "graphics",
		op: "delete",
		revision: project.revision,
	});
	expect(missing.status).toBe(400);
});

test("the route is published in OpenAPI", () => {
	const document = openapi(routes) as {
		paths: Record<string, Record<string, { operationId?: string }>>;
	};
	expect(
		document.paths["/api/video-studio/projects/{id}/overlay-edit"]?.post
			?.operationId
	).toBe("video_studio_overlay_edit");
});
