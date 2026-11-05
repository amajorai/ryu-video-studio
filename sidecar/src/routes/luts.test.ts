import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identityCubeLut, serializeCubeLut } from "../../../shared/cube-lut.ts";
import { newSegment } from "../../../shared/project.ts";
import { createStudioServer } from "../server.ts";
import { StudioStore } from "../store.ts";
import { routes } from "./luts.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const task of cleanup.splice(0).reverse()) {
		await task();
	}
});

async function harness() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-lut-api-"));
	const store = new StudioStore(directory);
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
	const call = async (path: string, init: RequestInit = {}) => {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio${path}`,
			{
				...init,
				headers: { authorization: `Bearer ${token}`, ...init.headers },
			}
		);
		return { body: await response.json(), status: response.status };
	};
	return { call, store };
}

const cube = serializeCubeLut(identityCubeLut(3));

test("imports JSON and multipart LUTs, then lists and reads them", async () => {
	const { call } = await harness();
	const json = await call("/luts", {
		body: JSON.stringify({ cube, name: "Identity" }),
		headers: { "content-type": "application/json" },
		method: "POST",
	});
	expect(json.status).toBe(201);
	expect(json.body).toMatchObject({ name: "Identity", size: 3 });
	const form = new FormData();
	form.set("file", new File([cube], "Film Print.cube"));
	const multipart = await call("/luts", { body: form, method: "POST" });
	expect(multipart.status).toBe(201);
	expect(multipart.body.name).toBe("Film Print");
	const listed = await call("/luts");
	expect(listed.body.luts).toHaveLength(2);
	const read = await call(`/luts?id=${json.body.id}`);
	expect(read.status).toBe(200);
	expect(read.body).toEqual({ cube, lut: json.body });
	const missing = await call(`/luts?id=${crypto.randomUUID()}`);
	expect(missing.status).toBe(404);
});

test("invalid LUTs are refused with the parser's reason", async () => {
	const { call } = await harness();
	const response = await call("/luts", {
		body: JSON.stringify({ cube: "LUT_3D_SIZE 99\n", name: "Too big" }),
		headers: { "content-type": "application/json" },
		method: "POST",
	});
	expect(response.status).toBe(400);
	expect(response.body.code).toBe("INVALID_LUT");
	expect(response.body.message).toContain("LUT_3D_SIZE");
});

test("deleting a LUT is refused while a project uses it", async () => {
	const { call, store } = await harness();
	const imported = await call("/luts", {
		body: JSON.stringify({ cube, name: "Used" }),
		headers: { "content-type": "application/json" },
		method: "POST",
	});
	const lutId = imported.body.id;
	const asset = {
		createdAt: "2026-01-01T00:00:00.000Z",
		duration: 4,
		hasAudio: false,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video" as const,
		name: "Clip",
		width: 640,
	};
	store.putAsset(asset);
	const project = store.create("Graded");
	const segment = newSegment(asset);
	segment.colorGrade = {
		...segment.colorGrade,
		lut: { intensity: 0.5, lutId },
	};
	const saved = store.save({ ...project, segments: [segment] });
	const refused = await call(`/luts?id=${lutId}`, { method: "DELETE" });
	expect(refused.status).toBe(409);
	expect(refused.body.code).toBe("LUT_IN_USE");
	expect(refused.body.message).toContain("Graded");
	// Removing the LUT from the clip leaves it in the undo history: the
	// delete succeeds, but the file is kept so undo still renders.
	store.save({ ...saved, segments: [] });
	const deleted = await call(`/luts?id=${lutId}`, { method: "DELETE" });
	expect(deleted).toEqual({
		body: { deleted: lutId, keptForHistory: true },
		status: 200,
	});
	expect((await call("/luts")).body.luts).toEqual([]);
	expect((await call(`/luts?id=${lutId}`)).status).toBe(200);
	// Undo brings the reference back; the LUT is listed and readable again.
	const current = store.project(project.id);
	const restored = store.restoreHistory(
		project.id,
		current.revision,
		saved.revision
	);
	expect(restored.segments[0]?.colorGrade.lut?.lutId).toBe(lutId);
	expect(
		(await call("/luts")).body.luts.map((lut: { id: string }) => lut.id)
	).toEqual([lutId]);
	expect((await call(`/luts?id=${lutId}`)).body.cube).toBe(cube);
});

test("an unused LUT is deleted with its file", async () => {
	const { call } = await harness();
	const imported = await call("/luts", {
		body: JSON.stringify({ cube, name: "Unused" }),
		headers: { "content-type": "application/json" },
		method: "POST",
	});
	const deleted = await call(`/luts?id=${imported.body.id}`, {
		method: "DELETE",
	});
	expect(deleted).toEqual({
		body: { deleted: imported.body.id, keptForHistory: false },
		status: 200,
	});
	expect((await call(`/luts?id=${imported.body.id}`)).status).toBe(404);
});

test("the LUT routes are published in OpenAPI", async () => {
	const { call } = await harness();
	const { body } = await call("/../../openapi.json");
	const paths = body.paths?.["/api/video-studio/luts"];
	expect(Object.keys(paths ?? {}).sort()).toEqual(["delete", "get", "post"]);
});
