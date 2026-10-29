import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultMask, type Mask } from "../../../shared/masks.ts";
import {
	type Graphic,
	graphicSchema,
	projectSchema,
} from "../../../shared/project.ts";
import { createStudioServer } from "../server.ts";
import { StudioStore } from "../store.ts";
import { routes } from "./graphic-masks.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});

const MASK_ID = "00000000-0000-4000-8000-000000000001";

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-gmask-"));
	const store = new StudioStore(directory);
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, routes, store, token });
	cleanup.push(async () => {
		app.server.stop(true);
		store.close();
		await rm(directory, { force: true, recursive: true });
	});
	const graphic: Graphic = graphicSchema.parse({
		end: 3,
		fill: "#ff0000",
		height: 0.3,
		id: crypto.randomUUID(),
		opacity: 1,
		shape: "star",
		start: 0,
		width: 0.3,
		x: 0.1,
		y: 0.1,
	});
	const project = store.save({
		...store.create("Graphic masks"),
		graphics: [graphic],
	});
	const post = (body: unknown) =>
		fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/graphic-masks`,
			{
				body: JSON.stringify(body),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
	return { graphic, post, project };
}

test("an agent masks a graphic and clears the masks again", async () => {
	const { graphic, post, project } = await setup();
	const mask: Mask = {
		...defaultMask("ellipse", MASK_ID),
		strokeAlign: "outside",
		strokeColor: "#00ff00",
		strokeWidth: 0.05,
	};
	const response = await post({
		graphicId: graphic.id,
		masks: [mask],
		revision: project.revision,
	});
	expect(response.status).toBe(200);
	const saved = projectSchema.parse(await response.json());
	expect(saved.revision).toBe(project.revision + 1);
	expect(saved.graphics[0]?.masks).toEqual([mask]);
	const cleared = await post({
		graphicId: graphic.id,
		masks: null,
		revision: saved.revision,
	});
	expect(cleared.status).toBe(200);
	const after = projectSchema.parse(await cleared.json());
	expect(after.graphics[0]?.masks).toBeUndefined();
});

test("stale revisions, text masks and unknown graphics are refused", async () => {
	const { graphic, post, project } = await setup();
	const stale = await post({
		graphicId: graphic.id,
		masks: [defaultMask("ellipse", MASK_ID)],
		revision: project.revision + 5,
	});
	expect(stale.status).toBe(409);
	const text = await post({
		graphicId: graphic.id,
		masks: [defaultMask("text", MASK_ID)],
		revision: project.revision,
	});
	expect(text.status).toBe(400);
	const missing = await post({
		graphicId: crypto.randomUUID(),
		masks: [],
		revision: project.revision,
	});
	expect(missing.status).toBeGreaterThanOrEqual(400);
});
