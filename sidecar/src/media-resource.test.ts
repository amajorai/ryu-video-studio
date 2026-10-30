import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Asset, newSegment, type Project } from "../../shared/project.ts";
import * as media from "./media.ts";
import { acquireMediaOperation, MediaBusyError } from "./media-operation.ts";
import { RenderQueue } from "./render.ts";
import { refreshSequenceAssets } from "./sequence.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

const stores: StudioStore[] = [];
const servers: ReturnType<typeof createStudioServer>[] = [];
const pending: Promise<unknown>[] = [];
const held: {
	signal?: AbortSignal;
	done: ReturnType<typeof Promise.withResolvers<string>>;
}[] = [];
afterEach(async () => {
	for (const app of servers.splice(0)) {
		app.stop();
	}
	for (const call of held.splice(0)) {
		call.done.reject(new Error("fixture child closed"));
	}
	await Promise.allSettled(pending.splice(0));
	mock.restore();
	for (const store of stores.splice(0)) {
		store.close();
		await rm(store.directory, { recursive: true, force: true });
	}
});
async function storeFixture() {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-media-resource-"))
	);
	stores.push(store);
	return store;
}
function asset(sequenceProjectId?: string): Asset {
	const result: Asset = {
		id: crypto.randomUUID(),
		name: "Fixture media",
		kind: "video",
		duration: 1,
		width: 640,
		height: 360,
		hasAudio: false,
		createdAt: new Date().toISOString(),
	};
	if (sequenceProjectId) {
		result.sequenceProjectId = sequenceProjectId;
	}
	return result;
}
function spies(hold = false) {
	const runner = spyOn(media, "runMedia").mockImplementation(
		async (args, options) => {
			const output = options?.outputPath ?? args.at(-1)!;
			await Bun.write(
				output,
				options?.cwd?.includes("sequence")
					? "rendered project"
					: "lavfi.signalstats.YAVG=120\n"
			);
			if (!hold) {
				return "";
			}
			const done = Promise.withResolvers<string>();
			held.push({ signal: options?.signal, done });
			return await done.promise;
		}
	);
	spyOn(media, "probe").mockResolvedValue({
		kind: "video",
		duration: 1,
		width: 640,
		height: 360,
		hasAudio: false,
	});
	spyOn(media, "thumbnail").mockResolvedValue();
	return runner;
}
/**
 * Nested renders the runner encoded: the steps that write a sequence's
 * `sequence.mp4` (long nested timelines also run chunk steps before it).
 */
function sequenceRenders(runner: ReturnType<typeof spies>): number {
	return runner.mock.calls.filter(([args]) =>
		args.at(-1)?.endsWith("sequence.mp4")
	).length;
}
async function until(predicate: () => boolean) {
	for (let i = 0; i < 400 && !predicate(); i++) {
		await Bun.sleep(5);
	}
	if (!predicate()) {
		throw new Error("Fixture media stage was not reached.");
	}
}

test("authenticated upscales/scopes share admission across server factories and hold it until canceled work closes", async () => {
	const runner = spies(true);
	const first = await storeFixture();
	const second = await storeFixture();
	const a = asset();
	const b = asset();
	first.putAsset(a);
	second.putAsset(b);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store: first, token, port: 0 });
	const other = createStudioServer({ store: second, token, port: 0 });
	servers.push(app, other);
	const request = (
		target: typeof app,
		id: string,
		action: "upscale" | "scopes",
		secret: string = token
	) =>
		fetch(
			`http://127.0.0.1:${target.server.port}/api/video-studio/assets/${id}/${action}`,
			{
				method: action === "scopes" ? "GET" : "POST",
				headers: {
					authorization: `Bearer ${secret}`,
					"content-type": "application/json",
				},
				body: action === "scopes" ? undefined : JSON.stringify({ factor: 2 }),
			}
		);
	const running = [
		request(app, a.id, "upscale"),
		request(other, b.id, "scopes"),
	];
	pending.push(...running);
	await until(() => held.length === 2);
	for (const action of ["upscale", "scopes"] as const) {
		const busy = await request(other, b.id, action);
		expect(busy.status).toBe(429);
		expect(await busy.json()).toMatchObject({ code: "MEDIA_BUSY" });
	}
	expect((await request(other, b.id, "scopes", "wrong")).status).toBe(401);
	expect(runner).toHaveBeenCalledTimes(2);
	app.stop();
	other.stop();
	expect(held.every((call) => call.signal?.aborted)).toBe(true);
	expect(() => acquireMediaOperation(1000)).toThrow(MediaBusyError);
	for (const call of held) {
		call.done.reject(new Error("canceled child reaped"));
	}
	await Promise.allSettled(running);
	const available = acquireMediaOperation(1000);
	available.release();
	expect(
		(await readdir(join(first.directory, "media"))).some((name) =>
			name.startsWith(".upscale-")
		)
	).toBe(false);
	expect(
		(await readdir(second.directory)).some((name) =>
			name.startsWith(".ryu-scopes-")
		)
	).toBe(false);
});

interface GraphResult {
	bindings: Asset[];
	root: Project;
}

function graph(store: StudioStore, depth: number): GraphResult {
	const base = asset();
	store.putAsset(base);
	// The leaf clip needs media on disk, or the render gate refuses the
	// root export as offline before any nested encode starts.
	writeFileSync(store.mediaPath(base.id), "leaf media");
	let project = store.save({
		...store.create("Leaf"),
		segments: [newSegment(base)],
	});
	const bindings: Asset[] = [];
	for (let index = 1; index < depth; index++) {
		const left = asset(project.id);
		const right = asset(project.id);
		store.putAsset(left);
		store.putAsset(right);
		bindings.push(left, right);
		project = store.save({
			...store.create(`Level ${index}`),
			segments: [newSegment(left), { ...newSegment(right), start: 1 }],
		});
	}
	return { root: project, bindings };
}
test("13-project binary DAG renders each completed revision once and preserves distinct sequence bindings", async () => {
	const store = await storeFixture();
	const { root, bindings } = graph(store, 13);
	const runner = spies();
	await refreshSequenceAssets(store, root);
	expect(runner).toHaveBeenCalledTimes(12); // Root export consumes its twelve distinct dependency revisions.
	for (const binding of bindings) {
		expect(await Bun.file(store.mediaPath(binding.id)).text()).toBe(
			"rendered project"
		);
	}
	expect(
		(await readdir(join(store.directory, "renders"))).filter((name) =>
			name.startsWith(".sequence-")
		)
	).toEqual([]);
	const sameSource = bindings.slice(0, 2);
	expect((await stat(store.mediaPath(sameSource[0]!.id))).ino).toBe(
		(await stat(store.mediaPath(sameSource[1]!.id))).ino
	);
});
test("cycles and project-work budgets terminate without exponential encoding", async () => {
	const store = await storeFixture();
	const { root } = graph(store, 3);
	const loop = asset(root.id);
	store.putAsset(loop);
	const leaf = store.projects().find((project) => project.title === "Leaf")!;
	store.save({ ...leaf, segments: [newSegment(loop)] });
	const runner = spies();
	await expect(refreshSequenceAssets(store, root)).rejects.toThrow("cycles");
	expect(runner).not.toHaveBeenCalled();
	const second = await storeFixture();
	const big = graph(second, 66);
	await expect(refreshSequenceAssets(second, big.root)).rejects.toThrow(
		"64-project"
	);
});
test("whole traversal deadline and export cancellation propagate to held nested encoding before release", async () => {
	const store = await storeFixture();
	const { root } = graph(store, 3);
	spies(true);
	const operation = acquireMediaOperation(500);
	const deadline = refreshSequenceAssets(store, root, { operation });
	pending.push(deadline);
	await until(() => held.length === 1);
	await Bun.sleep(550);
	expect(held[0]!.signal?.aborted).toBe(true);
	const occupied = acquireMediaOperation(1000);
	expect(() => acquireMediaOperation(1000)).toThrow(MediaBusyError);
	occupied.release();
	held[0]!.done.reject(new Error("deadline child closed"));
	await expect(deadline).rejects.toBeDefined();
	operation.release();
	const queue = new RenderQueue(store);
	const job = queue.start(root);
	await until(() => held.length === 2);
	queue.cancel(job.id);
	expect(held[1]!.signal?.aborted).toBe(true);
	const second = acquireMediaOperation(1000);
	expect(() => acquireMediaOperation(1000)).toThrow(MediaBusyError);
	second.release();
	held[1]!.done.reject(new Error("canceled nested child closed"));
	await until(
		() =>
			store.jobs().find((candidate) => candidate.id === job.id)?.status ===
			"canceled"
	);
	await until(
		() =>
			!(
				store.jobs().find((candidate) => candidate.id === job.id)?.status ===
				"running"
			)
	);
	const free = acquireMediaOperation(1000);
	free.release();
});

test("snapshot changes reject publication and duplicate bindings are capped before repeated encoding", async () => {
	const store = await storeFixture();
	const { root } = graph(store, 3);
	const runner = spies();
	const original = runner.getMockImplementation()!;
	let mutated = false;
	runner.mockImplementation(async (args, options) => {
		if (!mutated) {
			mutated = true;
			const leaf = store
				.projects()
				.find((project) => project.title === "Leaf")!;
			store.save({ ...leaf, title: "Concurrent revision" });
		}
		return await original(args, options);
	});
	await expect(refreshSequenceAssets(store, root)).rejects.toThrow(
		"changed during rendering"
	);
	const other = await storeFixture();
	const base = graph(other, 1).root;
	const groups: Asset[] = [];
	for (let group = 0; group < 4; group++) {
		const aliases = Array.from({ length: 128 }, () => asset(base.id));
		for (const alias of aliases) {
			other.putAsset(alias);
		}
		const child = other.save({
			...other.create(`Alias group ${group}`),
			segments: aliases.map((alias, index) => ({
				...newSegment(alias),
				start: index,
			})),
		});
		const binding = asset(child.id);
		other.putAsset(binding);
		groups.push(binding);
	}
	const many = other.save({
		...other.create("Many aliases"),
		segments: groups.map((alias, index) => ({
			...newSegment(alias),
			start: index,
		})),
	});
	runner.mockImplementation(original);
	runner.mockClear();
	await expect(refreshSequenceAssets(other, many)).rejects.toThrow(
		"512-binding"
	);
	expect(sequenceRenders(runner)).toBeLessThanOrEqual(5);
});

// Heavy by design (512 bindings); give it room under parallel CI load.
test("512 valid distinct bindings share completed outputs and refresh their root metadata", async () => {
	const store = await storeFixture();
	const base = graph(store, 1).root;
	const roots: Asset[] = [];
	const runner = spies();
	spyOn(media, "probe").mockResolvedValue({
		kind: "video",
		duration: 2,
		width: 1280,
		height: 720,
		hasAudio: false,
	});
	for (let group = 0; group < 4; group++) {
		const aliases = Array.from({ length: 127 }, () => asset(base.id));
		for (const alias of aliases) {
			store.putAsset(alias);
		}
		const child = store.save({
			...store.create(`Valid group ${group}`),
			segments: aliases.map((alias, index) => ({
				...newSegment(alias),
				start: index,
			})),
		});
		const binding = asset(child.id);
		store.putAsset(binding);
		roots.push(binding);
	}
	const parent = store.save({
		...store.create("512 valid bindings"),
		segments: roots.map((binding, index) => ({
			...newSegment(binding),
			start: index,
		})),
	});
	const snapshot = await refreshSequenceAssets(store, parent);
	expect(sequenceRenders(runner)).toBe(5);
	for (const root of roots) {
		expect(
			store.assets().find((candidate) => candidate.id === root.id)
		).toMatchObject({
			duration: 2,
			width: 1280,
			height: 720,
			sequenceProjectId: root.sequenceProjectId,
		});
		expect(
			snapshot.assets.find((candidate) => candidate.id === root.id)?.width
		).toBe(1280);
	}
}, 30_000);
