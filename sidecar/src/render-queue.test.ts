import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
} from "../../shared/project.ts";
import { resolveRenderPlan } from "../../shared/render-options.ts";
import { naturalCurveSpeed } from "../../shared/speed-curve.ts";
import { runMedia } from "./media.ts";
import type { RenderStep } from "./render.ts";
import {
	isLegacyExport,
	RenderQueue,
	renderWorkBudget,
	watchDirectoryBytes,
	workBudgetMessage,
} from "./render-queue.ts";
import { StudioStore } from "./store.ts";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await rm(directory, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

const project = (patch: Partial<Project> = {}): Project => ({
	...newProject("Queue"),
	width: 1280,
	height: 720,
	fps: 30,
	...patch,
});
const plan = (p: Project, options = {}) =>
	resolveRenderPlan(p, options, { timelineDuration: 4 });

test("only plain MP4/MOV video plans keep the legacy job shape", () => {
	expect(isLegacyExport(plan(project()))).toBe(true);
	expect(isLegacyExport(plan(project({ exportCodec: "h265" })))).toBe(true);
	expect(isLegacyExport(plan(project({ exportCodec: "prores" })))).toBe(true);
	for (const exportSettings of [
		{ container: "wav" as const, platformPreset: "podcast-audio" },
		{ container: "wav" as const },
		{ container: "gif" as const },
		{ container: "png-sequence" as const },
		{ container: "webm" as const },
		{ container: "mov" as const },
		{ container: "mov" as const, alpha: true },
		{ container: "mp4" as const, platformPreset: "youtube-1080p" },
	]) {
		expect(isLegacyExport(plan(project({ exportSettings })))).toBe(false);
	}
});

test("the frames watcher stops once the folder passes its budget", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-frames-watch-"));
	directories.push(directory);
	let exceeded = 0;
	const stop = watchDirectoryBytes(directory, 1000, () => exceeded++, 10);
	await Bun.write(join(directory, "frame_000001.png"), new Uint8Array(600));
	await Bun.sleep(60);
	expect(exceeded).toBe(0);
	await Bun.write(join(directory, "frame_000002.png"), new Uint8Array(600));
	for (let attempt = 0; attempt < 100 && !exceeded; attempt++) {
		await Bun.sleep(10);
	}
	expect(exceeded).toBe(1);
	await Bun.write(join(directory, "frame_000003.png"), new Uint8Array(600));
	await Bun.sleep(60);
	expect(exceeded).toBe(1);
	stop();
});

test("the frames watcher re-measures the frame FFmpeg is still writing", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-frames-watch-"));
	directories.push(directory);
	let exceeded = false;
	const stop = watchDirectoryBytes(
		directory,
		1000,
		() => {
			exceeded = true;
		},
		10
	);
	await Bun.write(join(directory, "frame_000001.png"), new Uint8Array(10));
	await Bun.sleep(60);
	await Bun.write(join(directory, "frame_000001.png"), new Uint8Array(2000));
	for (let attempt = 0; attempt < 100 && !exceeded; attempt++) {
		await Bun.sleep(10);
	}
	expect(exceeded).toBe(true);
	stop();
});

test("the work budget is capped by the disk's free space", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-work-budget-"));
	directories.push(directory);
	expect(await renderWorkBudget(directory, 1000)).toBeLessThanOrEqual(1000);
	const huge = Number.MAX_SAFE_INTEGER;
	expect(await renderWorkBudget(directory, huge)).toBeLessThan(huge);
	expect(workBudgetMessage(64 * 1024 ** 3)).toContain("64 GB budget");
});

test("chunked export intermediates are held to the work budget", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-work-budget-"));
	directories.push(directory);
	const store = new StudioStore(directory);
	try {
		const source: Asset = {
			createdAt: new Date().toISOString(),
			duration: 1,
			hasAudio: false,
			height: 144,
			id: crypto.randomUUID(),
			kind: "video",
			name: "Card",
			width: 256,
		};
		await runMedia([
			"-y",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=size=256x144:duration=1:rate=30",
			"-pix_fmt",
			"yuv420p",
			"-f",
			"mp4",
			store.mediaPath(source.id),
		]);
		store.putAsset(source);
		// Past `CHUNK_MIN_SEGMENTS`, so the export renders in chunks.
		const segments = Array.from({ length: 121 }, (_, index) => ({
			...newSegment(source, index * 0.1),
			sourceOut: 0.1,
		}));
		const timeline = store.save({
			...store.create("Long"),
			fps: 30,
			height: 144,
			segments,
			width: 256,
		});
		const steps: RenderStep["kind"][] = [];
		const job = new RenderQueue(store, {
			chunkSeconds: 2,
			onStep: (step) => steps.push(step.kind),
			workBytes: 1,
		}).start(timeline);
		let current = job;
		for (let attempt = 0; attempt < 600; attempt++) {
			current =
				store.jobs().find((candidate) => candidate.id === job.id) ?? current;
			if (current.status === "completed" || current.status === "failed") {
				break;
			}
			await Bun.sleep(50);
		}
		expect(current.status).toBe("failed");
		expect(current.error).toContain("long-export working files exceed");
		expect(steps[0]).toBe("chunk");
		expect(steps).not.toContain("final");
	} finally {
		store.close();
	}
}, 60_000);

/** A store with one 2 s tone and a timeline of curved clips of it. */
async function curvedAudioStore(starts: number[]) {
	const directory = await mkdtemp(join(tmpdir(), "ryu-curve-budget-"));
	directories.push(directory);
	const store = new StudioStore(directory);
	const source: Asset = {
		createdAt: new Date().toISOString(),
		duration: 2,
		hasAudio: true,
		height: 0,
		id: crypto.randomUUID(),
		kind: "audio",
		name: "Tone",
		width: 0,
	};
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		"sine=f=440:d=2",
		"-f",
		"wav",
		store.mediaPath(source.id),
	]);
	store.putAsset(source);
	const points = [
		{ speed: 0.5, t: 0 },
		{ speed: 2, t: 1 },
	];
	const segments = starts.map((start) => ({
		...newSegment(source, start),
		sourceOut: 2,
		speed: naturalCurveSpeed(points),
		speedCurve: { points },
	}));
	const timeline = store.save({
		...store.create("Curves"),
		fps: 30,
		height: 144,
		segments,
		width: 256,
	});
	return { store, timeline };
}

async function settled(store: StudioStore, id: string) {
	for (let attempt = 0; attempt < 600; attempt++) {
		const current = store.jobs().find((candidate) => candidate.id === id);
		if (current?.status === "completed" || current?.status === "failed") {
			return current;
		}
		await Bun.sleep(50);
	}
	throw new Error("The export did not settle.");
}

test("curve audio is held to the work budget before it is written", async () => {
	const { store, timeline } = await curvedAudioStore([0]);
	try {
		const steps: RenderStep["kind"][] = [];
		const job = new RenderQueue(store, {
			onStep: (step) => steps.push(step.kind),
			workBytes: 100_000,
		}).start(timeline, { audioOnly: true });
		const current = await settled(store, job.id);
		expect(current.status).toBe("failed");
		expect(current.error).toContain("Speed-curve audio needs");
		expect(steps).toEqual([]);
	} finally {
		store.close();
	}
}, 60_000);

test("a curved clip outside the export range is fed silence", async () => {
	const { store, timeline } = await curvedAudioStore([0, 40]);
	try {
		const args: string[][] = [];
		const job = new RenderQueue(store, {
			onStep: (step) => args.push(step.args),
		}).start(timeline, { audioOnly: true, range: { end: 2, start: 0 } });
		const current = await settled(store, job.id);
		expect(current.error).toBeUndefined();
		expect(current.status).toBe("completed");
		const graph = args.flat().join(" ");
		expect(graph).toContain("anullsrc=r=48000:cl=stereo");
		expect(graph.match(/curve-audio-[\w-]+\.wav/g)).toHaveLength(1);
	} finally {
		store.close();
	}
}, 60_000);
