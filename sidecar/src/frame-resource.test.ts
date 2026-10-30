import type { z } from "zod";

type StudioRequestBody = z.infer<ReturnType<typeof z.json>>;

import { expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Asset, meshSchema, newSegment } from "../../shared/project.ts";
import { captureTimelineFrame, renderTimelineFrame } from "./capture.ts";
import * as media from "./media.ts";
import { acquireMediaOperation } from "./media-operation.ts";
import * as meshes from "./mesh-render-runner.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

test("mesh frame cancellation holds the same media admission until worker close and cleanup", async () => {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-frame-mesh-close-"))
	);
	const meshFixture = meshSchema.parse({
		id: crypto.randomUUID(),
		start: 0,
		end: 1,
		fill: "#ffff00",
		vertices: [
			[-0.1, -0.1, 0],
			[0.1, -0.1, 0],
			[0, 0.1, 0],
		],
		faces: [[0, 1, 2]],
	});
	const project = store.save({
		...store.create("Held mesh frame"),
		width: 128,
		height: 128,
		meshes: [meshFixture],
	});
	const closed = Promise.withResolvers<Uint8Array>();
	let signal: AbortSignal | undefined;
	let entered = false;
	spyOn(meshes, "renderMeshPngAsync").mockImplementation(
		async (_project, _mesh, _width, _height, _time, operationSignal) => {
			entered = true;
			signal = operationSignal;
			return await closed.promise;
		}
	);
	const controller = new AbortController();
	const pending = captureTimelineFrame(store, project, 0.5, "Canceled mesh", {
		signal: controller.signal,
	}).catch((error) => error);
	let other: ReturnType<typeof acquireMediaOperation> | undefined;
	try {
		while (!entered) {
			await Bun.sleep(5);
		}
		other = acquireMediaOperation(1000);
		controller.abort();
		expect(signal?.aborted).toBe(true);
		expect(() => acquireMediaOperation(1000)).toThrow("Two media operations");
		closed.reject(new Error("Mesh worker closed"));
		expect((await pending).message).toContain("worker closed");
		const recovered = acquireMediaOperation(1000);
		recovered.release();
		expect(await readdir(join(store.directory, "renders"))).toEqual([]);
		expect(await readdir(join(store.directory, "media"))).toEqual([]);
		expect(store.assets()).toEqual([]);
	} finally {
		closed.reject(new Error("Fixture cleanup"));
		await pending;
		other?.release();
		mock.restore();
		store.close();
		await rm(store.directory, { recursive: true, force: true });
	}
});

test("capture reserves storage before rendering and releases it after nested source changes during thumbnail generation", async () => {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-frame-quota-"))
	);
	const source: Asset = {
		id: crypto.randomUUID(),
		name: "Source",
		kind: "video",
		width: 320,
		height: 180,
		duration: 10,
		hasAudio: false,
		createdAt: new Date().toISOString(),
	};
	store.putAsset(source);
	const child = store.save({
		...store.create("Child"),
		width: 320,
		height: 180,
		segments: [newSegment(source)],
	});
	const alias = {
		...source,
		id: crypto.randomUUID(),
		sequenceProjectId: child.id,
	};
	store.putAsset(alias);
	const parent = store.save({
		...store.create("Parent"),
		width: 320,
		height: 180,
		segments: [newSegment(alias)],
	});
	const runner = spyOn(media, "runMedia").mockImplementation(
		async (_args, options) => {
			await Bun.write(options!.outputPath!, "bounded frame fixture");
			return "";
		}
	);
	const admission = spyOn(store, "reserveMediaStorage");
	const thumbnail = spyOn(media, "thumbnail").mockImplementation(async () => {
		store.save({ ...child, title: "Concurrent nested edit" });
	});
	try {
		admission.mockImplementationOnce(() => {
			throw new Error("Media storage quota reached.");
		});
		await expect(
			captureTimelineFrame(store, parent, 1, "Quota frame")
		).rejects.toThrow("storage quota");
		expect(runner).not.toHaveBeenCalled();
		await expect(
			captureTimelineFrame(store, parent, 1, "Stale frame")
		).rejects.toThrow("source timeline changed");
		expect(thumbnail).toHaveBeenCalledTimes(1);
		expect(store.assets()).toHaveLength(2);
		expect(await readdir(join(store.directory, "media"))).toEqual([]);
		expect(await readdir(join(store.directory, "renders"))).toEqual([]);
		// A successful capture after rejection proves both operation and storage admission recover.
		thumbnail.mockResolvedValue();
		await captureTimelineFrame(store, parent, 1, "Saved frame");
		expect(store.assets()).toHaveLength(3);
	} finally {
		mock.restore();
		store.close();
		await rm(store.directory, { recursive: true, force: true });
	}
});

test("authenticated captures and both inspections share admission and retain it through canceled child close", async () => {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-frame-limit-"))
	);
	const asset: Asset = {
		id: crypto.randomUUID(),
		name: "Source",
		kind: "video",
		width: 320,
		height: 180,
		duration: 7200,
		hasAudio: false,
		createdAt: new Date().toISOString(),
	};
	store.putAsset(asset);
	const project = store.save({
		...store.create("Frame limit"),
		width: 320,
		height: 180,
		segments: [newSegment(asset)],
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	const held: Array<{
		signal?: AbortSignal;
		done: ReturnType<typeof Promise.withResolvers<string>>;
	}> = [];
	const runner = spyOn(media, "runMedia").mockImplementation(
		async (_args, options) => {
			const done = Promise.withResolvers<string>();
			held.push({ signal: options?.signal, done });
			return await done.promise;
		}
	);
	const headers = {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	};
	const call = (path: string, body?: StudioRequestBody, signal?: AbortSignal) =>
		fetch(`http://127.0.0.1:${app.server.port}/api/video-studio${path}`, {
			headers,
			method: body === undefined ? "GET" : "POST",
			body: body === undefined ? undefined : JSON.stringify(body),
			signal,
		});
	const controller = new AbortController();
	const first = call(
		`/projects/${project.id}/capture-frame`,
		{ revision: project.revision, time: 0 },
		controller.signal
	).catch((error) => error);
	const second = call(`/projects/${project.id}/inspect-frame?time=0`).catch(
		(error) => error
	);
	try {
		while (held.length !== 2) {
			await Bun.sleep(5);
		}
		expect((await call(`/assets/${asset.id}/inspect?samples=4`)).status).toBe(
			429
		);
		expect(
			(
				await call(`/projects/${project.id}/capture-frame`, {
					revision: project.revision,
					time: 0,
				})
			).status
		).toBe(429);
		expect(runner).toHaveBeenCalledTimes(2);
		for (const [args, options] of runner.mock.calls) {
			expect(args).toContain("-frames:v");
			expect(args).not.toContain("libx264");
			expect(options?.timeoutMs).toBeLessThanOrEqual(60_000);
			expect(options?.signal).toBeDefined();
		}
		controller.abort();
		await first;
		for (let n = 0; n < 100 && !held[0]?.signal?.aborted; n++) {
			await Bun.sleep(5);
		}
		expect(held[0]?.signal?.aborted).toBe(true);
		expect(() => acquireMediaOperation(1000)).toThrow("Two media operations");
		app.stop();
		expect(held.every((call) => call.signal?.aborted)).toBe(true);
		for (const call of held) {
			call.done.reject(new Error("fixture process closed"));
		}
		await Promise.all([first, second]);
		const recovered = acquireMediaOperation(1000);
		recovered.release();
		expect(await readdir(join(store.directory, "renders"))).toEqual([]);
	} finally {
		app.stop();
		for (const call of held) {
			call.done.reject(new Error("fixture cleanup"));
		}
		await Promise.all([first, second]);
		mock.restore();
		store.close();
		await rm(store.directory, { recursive: true, force: true });
	}
});

test("nested frames memoize revision/time while distinct clip bindings retain their own source times and reject cycles", async () => {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-frame-nesting-"))
	);
	const source: Asset = {
		id: crypto.randomUUID(),
		name: "Source",
		kind: "video",
		width: 320,
		height: 180,
		duration: 10,
		hasAudio: false,
		createdAt: new Date().toISOString(),
	};
	store.putAsset(source);
	const child = store.save({
		...store.create("Child"),
		width: 320,
		height: 180,
		segments: [newSegment(source)],
	});
	const alias = {
		...source,
		id: crypto.randomUUID(),
		name: "Child binding",
		sequenceProjectId: child.id,
	};
	store.putAsset(alias);
	const first = { ...newSegment(alias), sourceIn: 1, sourceOut: 4 };
	const second = { ...newSegment(alias, 0, 1), sourceIn: 2, sourceOut: 5 };
	const duplicate = { ...newSegment(alias, 0, 2), sourceIn: 1, sourceOut: 4 };
	const parent = store.save({
		...store.create("Parent"),
		width: 320,
		height: 180,
		segments: [first, second, duplicate],
	});
	const listing = spyOn(store, "projects").mockImplementation(() => {
		throw new Error(
			"A truncated project listing must not control source snapshots."
		);
	});
	const runner = spyOn(media, "runMedia").mockImplementation(
		async (_args, options) => {
			await Bun.write(options!.outputPath!, "bounded frame fixture");
			return "";
		}
	);
	try {
		expect(
			(await renderTimelineFrame(store, parent, 1)).byteLength
		).toBeGreaterThan(0);
		expect(runner).toHaveBeenCalledTimes(3);
		expect(listing).not.toHaveBeenCalled();
		const rootArgs = runner.mock.calls.at(-1)![0];
		const paths = rootArgs.filter((arg) => arg.endsWith("frame.png"));
		expect(paths[0]).toBe(paths[2]);
		expect(paths[0]).not.toBe(paths[1]);
		expect(runner.mock.calls[0]![0]).toContain("2");
		expect(runner.mock.calls[1]![0]).toContain("3");
		expect(await readdir(join(store.directory, "renders"))).toEqual([]);
		const recursive = {
			...source,
			id: crypto.randomUUID(),
			sequenceProjectId: parent.id,
		};
		store.putAsset(recursive);
		store.save({ ...child, segments: [newSegment(recursive)] });
		runner.mockClear();
		await expect(renderTimelineFrame(store, parent, 1)).rejects.toThrow(
			"cannot contain itself"
		);
		expect(runner).not.toHaveBeenCalled();
	} finally {
		mock.restore();
		store.close();
		await rm(store.directory, { recursive: true, force: true });
	}
});
