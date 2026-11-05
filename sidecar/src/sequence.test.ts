import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Asset,
	assetSchema,
	newProject,
	newSegment,
	projectSchema,
} from "../../shared/project.ts";
import type { ExportSettings } from "../../shared/schema/export.ts";
import { probe, runMedia } from "./media.ts";
import { buildRender } from "./render.ts";
import { createSequenceAsset, nestedRenderProject } from "./sequence.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

test("sequence route renders and refreshes an independent timeline clip", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-sequence-test-"));
	const store = new StudioStore(directory);
	const sourcePath = join(directory, "source.mp4");
	try {
		await runMedia([
			"-f",
			"lavfi",
			"-i",
			"color=c=red:s=8x4:r=10:d=0.5",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			sourcePath,
		]);
		const sourceAsset = assetSchema.parse({
			...(await probe(sourcePath)),
			createdAt: new Date().toISOString(),
			id: crypto.randomUUID(),
			name: "Sequence source",
		});
		await Bun.write(
			store.mediaPath(sourceAsset.id),
			await Bun.file(sourcePath).arrayBuffer()
		);
		store.putAsset(sourceAsset);
		const source = store.save({
			...store.create("Source workspace"),
			segments: [newSegment(sourceAsset)],
		});
		const parent = store.create("Parent workspace");
		const token = crypto.randomUUID();
		const app = createStudioServer({ store, token, port: 0 });
		try {
			const response = await fetch(
				`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${parent.id}/sequence`,
				{
					body: JSON.stringify({
						revision: parent.revision,
						sourceProjectId: source.id,
					}),
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					method: "POST",
				}
			);
			expect(response.status).toBe(201);
			const sequence = assetSchema.parse(await response.json());
			expect(sequence.sequenceProjectId).toBe(source.id);
			expect(sequence.kind).toBe("video");
			expect(await Bun.file(store.mediaPath(sequence.id)).exists()).toBe(true);
			const refreshed = await fetch(
				`http://127.0.0.1:${app.server.port}/api/video-studio/assets/${sequence.id}/refresh-sequence`,
				{
					body: "{}",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					method: "POST",
				}
			);
			expect(refreshed.status).toBe(200);
			expect(
				projectSchema.parse(store.project(source.id)).segments
			).toHaveLength(1);
		} finally {
			app.stop();
		}
	} finally {
		store.close();
		await rm(directory, {
			force: true,
			recursive: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
}, 30_000);

test("a nested timeline with a graph too long for argv renders in chunks", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-sequence-test-"));
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
		// 260 clips make a one-pass graph of about 156 KB, past the 128 KiB
		// argv string limit (posix_spawn fails with E2BIG).
		const segments = Array.from({ length: 260 }, (_, index) => ({
			...newSegment(source, index * 0.1),
			sourceOut: 0.1,
		}));
		const timeline = store.save({
			...store.create("Long nested"),
			fps: 30,
			height: 144,
			segments,
			width: 256,
		});
		const longest = Math.max(
			...buildRender(
				nestedRenderProject(timeline),
				[source],
				() => "clip.mp4",
				undefined,
				[],
				undefined,
				{ codec: "h264" }
			).map((arg) => Buffer.byteLength(arg))
		);
		expect(longest).toBeGreaterThan(128 * 1024);
		const parent = store.create("Parent");
		const nested = await createSequenceAsset(store, parent, timeline);
		expect(nested.sequenceProjectId).toBe(timeline.id);
		expect(nested.duration).toBeCloseTo(26, 1);
	} finally {
		store.close();
		await rm(directory, {
			force: true,
			recursive: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
}, 120_000);

test("nested timelines render a neutral H.264 MP4 whatever the source project's export settings", () => {
	const asset: Asset = {
		createdAt: new Date().toISOString(),
		duration: 2,
		hasAudio: true,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video",
		name: "Clip",
		width: 640,
	};
	const project = {
		...newProject("Nested"),
		exportCodec: "prores" as const,
		segments: [newSegment(asset)],
	};
	const render = (exportSettings?: ExportSettings) =>
		buildRender(
			nestedRenderProject({ ...project, exportSettings }),
			[asset],
			() => "clip.mp4",
			undefined,
			[],
			undefined,
			{ codec: "h264" }
		);
	const neutral = render();
	expect(neutral).toContain("libx264");
	expect(neutral).toContain("[mix]");
	expect(neutral).not.toContain("-an");
	for (const settings of [
		{ container: "gif" },
		{ container: "wav" },
		{ container: "mov", alpha: true },
		{
			container: "mp4",
			includeAudio: false,
			outputHeight: 360,
			outputWidth: 640,
		},
		{ container: "mp4", platformPreset: "youtube-shorts" },
	] satisfies ExportSettings[]) {
		expect({ args: render(settings), settings }).toEqual({
			args: neutral,
			settings,
		});
	}
});
