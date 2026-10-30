import { expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Asset, newProject, newSegment } from "../../shared/project.ts";
import { syncRequestSchema } from "../../shared/sync.ts";
import { acquireMediaOperation } from "./media-operation.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";
import * as syncing from "./sync-runner.ts";

test("sync cancellation holds admission until its worker exits", async () => {
	class FixtureWorker extends EventTarget {
		terminating = false;
		terminate() {
			this.terminating = true;
		}
		postMessage() {}
	}
	const worker = new FixtureWorker();
	const controller = new AbortController();
	const project = newProject("Canceled sync");
	const input = syncRequestSchema.parse({
		revision: 0,
		referenceClipId: crypto.randomUUID(),
		targetClipIds: [crypto.randomUUID()],
		mode: "audio",
	});
	const pending = syncing
		.runSync(project, [], new Map(), input, controller.signal, {
			createWorker: () => worker,
		})
		.catch((error) => error);
	const other = acquireMediaOperation(1000);
	try {
		controller.abort();
		await Bun.sleep(5);
		expect(worker.terminating).toBe(true);
		expect(() => acquireMediaOperation(1000)).toThrow("Two media operations");
		worker.dispatchEvent(new Event("close"));
		expect((await pending).message).toContain("canceled");
		const recovered = acquireMediaOperation(1000);
		recovered.release();
	} finally {
		worker.dispatchEvent(new Event("close"));
		await pending;
		other.release();
		mock.restore();
	}
});

test("HTTP stays responsive during admitted sync and refuses to save over a newer revision", async () => {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-sync-revision-"))
	);
	const asset: Asset = {
		id: crypto.randomUUID(),
		name: "Audio",
		kind: "audio",
		width: 0,
		height: 0,
		duration: 8,
		hasAudio: true,
		createdAt: new Date().toISOString(),
	};
	store.putAsset(asset);
	const reference = newSegment(asset);
	const target = newSegment(asset, 0, 1);
	const project = store.save({
		...store.create("Sync responsiveness"),
		segments: [reference, target],
	});
	const done =
		Promise.withResolvers<Awaited<ReturnType<typeof syncing.runSync>>>();
	let entered = false;
	spyOn(syncing, "runSync").mockImplementation(async () => {
		entered = true;
		return await done.promise;
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	const base = `http://127.0.0.1:${app.server.port}/api/video-studio`;
	const headers = {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	};
	const response = fetch(`${base}/projects/${project.id}/sync`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			revision: project.revision,
			referenceClipId: reference.id,
			targetClipIds: [target.id],
			mode: "audio",
		}),
	});
	try {
		while (!entered) {
			await Bun.sleep(5);
		}
		const started = performance.now();
		expect((await fetch(`${base}/projects`, { headers })).status).toBe(200);
		expect(performance.now() - started).toBeLessThan(1000);
		const current = store.save({ ...project, title: "Newer user edit" });
		done.resolve({ project, matches: [], shiftedFrames: 0 });
		expect((await response).status).toBe(409);
		expect(store.project(project.id).revision).toBe(current.revision);
		expect(store.project(project.id).title).toBe("Newer user edit");
	} finally {
		done.resolve({ project, matches: [], shiftedFrames: 0 });
		await response;
		app.stop();
		mock.restore();
		store.close();
		await rm(store.directory, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("audio sync refines the anchor and corrects drift from decoded windows", async () => {
	let seed = 11;
	const random = () => {
		seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
		return seed / 2_147_483_648;
	};
	const hits: { at: number; level: number }[] = [];
	for (let at = 0.2; at < 110; at += 0.15 + random() * 1.2) {
		hits.push({ at, level: 0.1 + random() });
	}
	const envelope = (second: number) => {
		let value = 0.01;
		for (const hit of hits) {
			const age = second - hit.at;
			if (age >= 0 && age < 0.3) {
				value += hit.level * Math.exp(-age / 0.03);
			}
		}
		return value;
	};
	const drift = 0.002;
	const offset = 2.25;
	const atTarget = (second: number) =>
		envelope((second - offset) / (1 + drift));
	const reference: Asset = {
		createdAt: new Date().toISOString(),
		duration: 100,
		hasAudio: true,
		height: 0,
		id: crypto.randomUUID(),
		kind: "audio",
		name: "Camera",
		width: 0,
	};
	const target: Asset = {
		...reference,
		duration: 104,
		id: crypto.randomUUID(),
	};
	const coarse = (asset: Asset, read: (second: number) => number) => ({
		assetId: asset.id,
		createdAt: new Date().toISOString(),
		duration: asset.duration,
		sceneCuts: [],
		status: "completed" as const,
		waveform: Array.from({ length: 500 }, (_, index) => {
			let peak = 0;
			for (let step = 0; step < 10; step += 1) {
				peak = Math.max(
					peak,
					read(((index + step / 10) * asset.duration) / 500)
				);
			}
			return peak;
		}),
	});
	const referenceClip = newSegment(reference, 0, 0);
	const targetClip = newSegment(target, 0, 1);
	const project = {
		...newProject("Drift sync"),
		segments: [referenceClip, targetClip],
	};
	const decoded: [string, number, number][] = [];
	const result = await syncing.runSync(
		project,
		[reference, target],
		new Map([
			[reference.id, coarse(reference, envelope)],
			[target.id, coarse(target, atTarget)],
		]),
		syncRequestSchema.parse({
			minConfidence: 0.3,
			mode: "audio",
			referenceClipId: referenceClip.id,
			revision: project.revision,
			searchWindowSeconds: 5,
			targetClipIds: [targetClip.id],
		}),
		undefined,
		{
			decodeWindow: (asset, start, duration) => {
				decoded.push([asset.name, start, duration]);
				const read = asset.id === reference.id ? envelope : atTarget;
				// Each envelope block holds 8 PCM samples of the same level.
				return Promise.resolve(
					Float32Array.from(
						{ length: Math.round(duration * 1000) * 8 },
						(_, index) => read(start + Math.floor(index / 8) / 1000)
					)
				);
			},
		}
	);
	expect(decoded).toHaveLength(4);
	const match = result.matches[0];
	expect(match?.drift).toMatchObject({ status: "corrected" });
	expect(match?.drift?.driftPercent).toBeCloseTo(0.2, 2);
	const placedReference = result.project.segments.find(
		(segment) => segment.id === referenceClip.id
	)!;
	const placedTarget = result.project.segments.find(
		(segment) => segment.id === targetClip.id
	)!;
	expect(placedTarget.speed).toBeCloseTo(1.002, 4);
	for (const second of [3, 50, 97]) {
		const referenceTime =
			placedReference.start + (second - placedReference.sourceIn);
		const targetTime =
			placedTarget.start +
			(second * (1 + drift) + offset - placedTarget.sourceIn) /
				placedTarget.speed;
		expect(Math.abs(referenceTime - targetTime)).toBeLessThan(1 / 30);
	}
});
