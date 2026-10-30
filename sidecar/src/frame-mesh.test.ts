import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { meshRigSchema } from "../../shared/mesh-animation.ts";
import { type Asset, meshSchema, newSegment } from "../../shared/project.ts";
import { renderTimelineFrame } from "./capture.ts";
import { runMedia } from "./media.ts";
import { RenderQueue } from "./render.ts";
import { StudioStore } from "./store.ts";

async function pixels(path: string): Promise<Uint8Array> {
	const raw = `${path}.rgb`;
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-y",
		"-i",
		path,
		"-frames:v",
		"1",
		"-f",
		"rawvideo",
		"-pix_fmt",
		"rgb24",
		raw,
	]);
	return new Uint8Array(await Bun.file(raw).arrayBuffer());
}
function difference(a: Uint8Array, b: Uint8Array): number {
	let sum = 0;
	for (let index = 0; index < a.length; index++) {
		sum += Math.abs(a[index]! - b[index]!);
	}
	return sum / a.length;
}

test("frame capture samples textured rig poses like the real export, including nested sequence frames", async () => {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-mesh-frame-"))
	);
	try {
		const texture = join(store.directory, "texture.png");
		await runMedia([
			"-hide_banner",
			"-loglevel",
			"error",
			"-nostdin",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"color=yellow:s=8x8",
			"-frames:v",
			"1",
			"-pix_fmt",
			"rgba",
			texture,
		]);
		const meshFixture = meshSchema.parse({
			id: crypto.randomUUID(),
			start: 0,
			end: 1,
			fill: "#ffffff",
			scale: 3.75,
			vertices: [
				[-0.1, -0.1, 0],
				[0.1, -0.1, 0],
				[0, 0.1, 0],
			],
			faces: [[0, 1, 2]],
			uvs: [
				[0, 0],
				[1, 0],
				[0.5, 1],
			],
			texture: `data:image/png;base64,${Buffer.from(await Bun.file(texture).arrayBuffer()).toString("base64")}`,
		});
		const identity = Array.from({ length: 16 }, (_, index) =>
			index % 5 === 0 ? 1 : 0
		);
		meshFixture.rig = meshRigSchema.parse({
			bindMatrices: [identity],
			meshMatrix: identity,
			joints: [{ name: "Joint", origin: [0, 0, 0] }],
			influences: meshFixture.vertices.map(() => [0, 0, 0, 0]),
			weights: meshFixture.vertices.map(() => [1, 0, 0, 0]),
			vertices: meshFixture.vertices,
			keyframes: [
				{
					id: crypto.randomUUID(),
					joint: 0,
					property: "rotationZ",
					time: 0,
					value: 0,
				},
				{
					id: crypto.randomUUID(),
					joint: 0,
					property: "rotationZ",
					time: 1,
					value: 120,
				},
			],
		});
		const project = store.save({
			...store.create("Textured animated frame"),
			width: 128,
			height: 128,
			fps: 30,
			meshes: [meshFixture],
		});
		const queue = new RenderQueue(store);
		const job = queue.start(project);
		let state = store.jobs().find((candidate) => candidate.id === job.id);
		for (
			let index = 0;
			index < 1800 &&
			state?.status !== "completed" &&
			state?.status !== "failed";
			index++
		) {
			await Bun.sleep(50);
			state = store.jobs().find((candidate) => candidate.id === job.id);
		}
		expect(state?.error).toBeUndefined();
		expect(state?.status).toBe("completed");
		const alias: Asset = {
			id: crypto.randomUUID(),
			name: "Mesh sequence",
			kind: "video",
			duration: 1,
			width: 128,
			height: 128,
			hasAudio: false,
			createdAt: new Date().toISOString(),
			sequenceProjectId: project.id,
		};
		store.putAsset(alias);
		const parent = store.save({
			...store.create("Nested animated frame"),
			width: 128,
			height: 128,
			fps: 30,
			segments: [newSegment(alias)],
		});
		const actualFrames: Uint8Array[] = [];
		for (const time of [0, 0.5, 1]) {
			const direct = join(store.directory, `direct-${time}.png`);
			const baseline = join(store.directory, `baseline-${time}.png`);
			const nested = join(store.directory, `nested-${time}.png`);
			await Bun.write(direct, await renderTimelineFrame(store, project, time));
			await runMedia([
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostdin",
				"-y",
				"-ss",
				String(Math.min(time, 1 - 1 / 30)),
				"-i",
				store.renderPath(job.id),
				"-frames:v",
				"1",
				baseline,
			]);
			await Bun.write(nested, await renderTimelineFrame(store, parent, time));
			const actual = await pixels(direct);
			const exported = await pixels(baseline);
			const nestedPixels = await pixels(nested);
			expect(actual.length).toBe(128 * 128 * 3);
			expect(exported.length).toBe(actual.length);
			expect(nestedPixels.length).toBe(actual.length);
			expect(
				exported.reduce((sum, value) => sum + value, 0) / exported.length
			).toBeGreaterThan(10);
			expect(difference(actual, exported)).toBeLessThan(8);
			expect(difference(nestedPixels, actual)).toBeLessThan(8);
			actualFrames.push(actual);
		}
		expect(difference(actualFrames[0]!, actualFrames[1]!)).toBeGreaterThan(10);
	} finally {
		store.close();
		await rm(store.directory, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
}, 240_000);
