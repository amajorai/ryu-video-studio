import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStudioServer, openapi } from "../server.ts";
import { StudioStore } from "../store.ts";
import { routes } from "./adjustment.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const task of cleanup.splice(0).reverse()) {
		await task();
	}
});

async function harness() {
	const directory = await mkdtemp(
		join(tmpdir(), "ryu-video-studio-adjustment-api-")
	);
	const store = new StudioStore(directory);
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, routes, store, token });
	cleanup.push(async () => {
		app.stop();
		store.close();
		await rm(directory, { force: true, recursive: true });
	});
	const project = store.create("Adjustment API");
	const call = async (body: unknown, path = "adjustment-layers") => {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/${path}`,
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
	return { call, project, store };
}

test("creates, updates, duplicates and deletes layers revision by revision", async () => {
	const { call, project, store } = await harness();
	const created = await call({
		action: "create",
		layer: { end: 2, saturation: 0, start: 1 },
		revision: project.revision,
	});
	expect(created.status).toBe(200);
	expect(created.body.layer).toMatchObject({
		end: 2,
		label: "Adjustment 1",
		opacity: 1,
		saturation: 0,
		start: 1,
		track: 0,
	});
	expect(created.body.project.adjustmentLayers).toHaveLength(1);
	const layerId = created.body.layer.id;
	const updated = await call({
		action: "update",
		layer: { blendMode: "screen", label: "Night", saturation: null },
		layerId,
		revision: created.body.project.revision,
	});
	expect(updated.status).toBe(200);
	expect(updated.body.layer.label).toBe("Night");
	expect(updated.body.layer).not.toHaveProperty("saturation");
	expect(updated.body.layer.blendMode).toBe("screen");
	const duplicated = await call({
		action: "duplicate",
		layerId,
		revision: updated.body.project.revision,
	});
	expect(duplicated.body.layer).toMatchObject({ end: 3, start: 2 });
	expect(duplicated.body.project.adjustmentLayers).toHaveLength(2);
	const deleted = await call({
		action: "delete",
		layerId,
		revision: duplicated.body.project.revision,
	});
	expect(deleted.status).toBe(200);
	expect(deleted.body).not.toHaveProperty("layer");
	expect(deleted.body.project.adjustmentLayers).toHaveLength(1);
	expect(store.project(project.id).adjustmentLayers).toHaveLength(1);
});

test("a stale revision is a conflict and invalid edits are refused", async () => {
	const { call, project } = await harness();
	const stale = await call({
		action: "create",
		layer: { end: 2, start: 1 },
		revision: project.revision + 5,
	});
	expect(stale.status).toBe(409);
	expect(stale.body.code).toBe("CONFLICT");
	const backwards = await call({
		action: "create",
		layer: { end: 1, start: 2 },
		revision: project.revision,
	});
	expect(backwards.status).toBe(400);
	const unknown = await call({
		action: "update",
		layer: { opacity: 0.5 },
		layerId: crypto.randomUUID(),
		revision: project.revision,
	});
	expect(unknown.status).toBe(400);
	expect(unknown.body.message).toContain("not in this project");
	const malformed = await call({
		action: "create",
		layer: { end: 2, start: 1, strength: 3 },
		revision: project.revision,
	});
	expect(malformed.status).toBe(400);
});

test("the operation is published in OpenAPI", () => {
	const paths = openapi(routes).paths as Record<
		string,
		Record<string, { operationId?: string }>
	>;
	const entry = Object.entries(paths).find(([path]) =>
		path.endsWith("/projects/{id}/adjustment-layers")
	);
	expect(entry?.[1].post?.operationId).toBe(
		"video_studio_edit_adjustment_layers"
	);
});
