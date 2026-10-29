import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Asset } from "../../../shared/project.ts";
import {
	shotSearchIndexSchema,
	verifiedShotDocument,
} from "../../../shared/search-index.ts";
import { shotIndexSchema } from "../../../shared/shot-index.ts";
import { probe, runMedia } from "../media.ts";
import { createStudioServer } from "../server.ts";
import { StudioStore } from "../store.ts";
import { routes } from "./shots.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-shots-"));
	const store = new StudioStore(directory);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0, routes });
	cleanup.push(async () => {
		app.stop();
		store.close();
		await rm(directory, { force: true, recursive: true });
	});
	const call = (path: string, method = "GET", body?: unknown) =>
		fetch(`http://127.0.0.1:${app.server.port}/api/video-studio${path}`, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	return { call, store };
}

/** 2 s dark navy, 2 s moving test pattern, 2 s near-white: three shots. */
async function threeShotVideo(store: StudioStore): Promise<Asset> {
	const file = join(store.directory, "fixture.mp4");
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-y",
		"-f",
		"lavfi",
		"-i",
		"color=c=0x0a1450:s=320x180:d=2:r=25",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=s=320x180:d=2:r=25",
		"-f",
		"lavfi",
		"-i",
		"color=c=0xf5f5f5:s=320x180:d=2:r=25",
		"-filter_complex",
		"[0][1][2]concat=n=3:v=1:a=0",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		file,
	]);
	const asset: Asset = {
		...(await probe(file)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name: "Three shots",
	};
	await Bun.write(store.mediaPath(asset.id), Bun.file(file));
	store.putAsset(asset);
	store.putAnalysis({
		assetId: asset.id,
		createdAt: "2026-01-01T00:00:00.000Z",
		duration: asset.duration,
		sceneCuts: [2, 4],
		status: "completed",
		waveform: [],
	});
	return asset;
}

const searchResponseSchema = z.object({
	excluded: z.array(z.string()),
	ignored: z.array(z.string()),
	labels: z.array(z.string()),
	results: z.array(
		z.object({
			assetId: z.string(),
			assetName: z.string(),
			end: z.number(),
			labels: z.array(z.string()),
			start: z.number(),
		})
	),
});

test("shots are measured from real frames and found by visual query", async () => {
	const { call, store } = await setup();
	const asset = await threeShotVideo(store);
	expect(await (await call(`/assets/${asset.id}/shots`)).json()).toEqual({
		shots: null,
		current: false,
	});
	const analyzed = await call(`/assets/${asset.id}/shots`, "POST");
	expect(analyzed.status).toBe(200);
	const index = shotIndexSchema.parse(await analyzed.json());
	expect(index.revision).toBe(0);
	expect(index.shots.map((shot) => [shot.start, shot.end])).toEqual([
		[0, 2],
		[2, 4],
		[4, asset.duration],
	]);
	const [navy, pattern, white] = index.shots;
	expect(navy?.labels).toEqual(
		expect.arrayContaining(["dark", "static", "blue", "close-up"])
	);
	expect(pattern?.labels).toEqual(expect.arrayContaining(["wide", "vivid"]));
	expect(white?.labels).toEqual(
		expect.arrayContaining(["bright", "static", "white"])
	);
	// Cached while the analysis is unchanged; refresh bumps the revision.
	const cached = shotIndexSchema.parse(
		await (await call(`/assets/${asset.id}/shots`, "POST", {})).json()
	);
	expect(cached.revision).toBe(0);
	const refreshed = shotIndexSchema.parse(
		await (
			await call(`/assets/${asset.id}/shots`, "POST", { refresh: true })
		).json()
	);
	expect(refreshed.revision).toBe(1);

	const search = searchResponseSchema.parse(
		await (
			await call(`/shot-search?q=${encodeURIComponent("dim navy still shot")}`)
		).json()
	);
	expect(search.labels).toEqual(["dark", "blue", "static"]);
	expect(search.results).toHaveLength(1);
	expect(search.results[0]).toMatchObject({
		assetId: asset.id,
		assetName: "Three shots",
		start: 0,
		end: 2,
	});
	const none = searchResponseSchema.parse(
		await (await call("/shot-search?q=birthday")).json()
	);
	expect(none).toMatchObject({ ignored: ["birthday"], results: [] });
	const notDark = searchResponseSchema.parse(
		await (
			await call(`/shot-search?q=${encodeURIComponent("not dark")}`)
		).json()
	);
	expect(notDark.excluded).toEqual(["dark"]);
	expect(notDark.labels).toEqual([]);
	expect(
		notDark.results.some((match) => match.start === 0 && match.end === 2)
	).toBe(false);
	const lowLight = searchResponseSchema.parse(
		await (
			await call(`/shot-search?q=${encodeURIComponent("low light")}`)
		).json()
	);
	expect(lowLight.labels).toEqual(["dark"]);
	expect((await call("/shot-search?q=")).status).toBe(400);
});

test("shot Space projection is revision-checked and follows the analysis", async () => {
	const { call, store } = await setup();
	const asset = await threeShotVideo(store);
	expect(
		(
			await call(`/assets/${asset.id}/shots/index`, "POST", {
				spaceId: "space-1",
				spaceName: "Footage",
			})
		).status
	).toBe(400);
	await call(`/assets/${asset.id}/shots`, "POST");
	let index = shotSearchIndexSchema.parse(
		await (
			await call(`/assets/${asset.id}/shots/index`, "POST", {
				spaceId: "space-1",
				spaceName: "Footage",
			})
		).json()
	);
	expect(index.entries).toHaveLength(3);
	const entry = index.entries[0];
	if (!entry) {
		throw new Error("Expected a shot entry.");
	}
	index = shotSearchIndexSchema.parse(
		await (
			await call(`/assets/${asset.id}/shots/index`, "PUT", {
				revision: index.revision,
				key: entry.key,
				docId: "doc-1",
				ready: true,
			})
		).json()
	);
	expect(verifiedShotDocument(index, "doc-1", entry.source)?.start).toBe(0);
	const stale = await call(`/assets/${asset.id}/shots/index`, "PUT", {
		revision: 0,
		key: entry.key,
		docId: "doc-1",
		ready: true,
	});
	expect(stale.status).toBe(409);
	const listed = z
		.object({
			indexes: z.array(shotSearchIndexSchema.extend({ current: z.boolean() })),
		})
		.parse(await (await call("/shot-indexes")).json());
	expect(listed.indexes.map((item) => item.current)).toEqual([true]);

	// A fresh source analysis makes the shots and their projection stale.
	store.putAnalysis({
		...(store.analysis(asset.id) ?? {
			assetId: asset.id,
			duration: asset.duration,
			sceneCuts: [],
			status: "completed",
			waveform: [],
		}),
		createdAt: "2026-03-01T00:00:00.000Z",
	});
	expect(await (await call(`/assets/${asset.id}/shots`)).json()).toMatchObject({
		current: false,
	});
	const after = z
		.object({ indexes: z.array(z.object({ current: z.boolean() })) })
		.parse(await (await call("/shot-indexes")).json());
	expect(after.indexes.map((item) => item.current)).toEqual([false]);
	expect(
		searchResponseSchema.parse(await (await call("/shot-search?q=dark")).json())
			.results
	).toEqual([]);

	// Reanalysis moves the mapped document to obsolete; prune forgets it.
	await call(`/assets/${asset.id}/shots`, "POST");
	const rebuilt = shotSearchIndexSchema.parse(
		await (
			await call(`/assets/${asset.id}/shots/index`, "POST", {
				spaceId: "space-1",
				spaceName: "Footage",
			})
		).json()
	);
	expect(rebuilt.obsolete.map((item) => item.docId)).toEqual(["doc-1"]);
	const pruned = shotSearchIndexSchema.parse(
		await (
			await call(`/assets/${asset.id}/shots/prune-index`, "POST", {
				revision: rebuilt.revision,
				docId: "doc-1",
			})
		).json()
	);
	expect(pruned.obsolete).toEqual([]);
});

test("non-video sources and unanalyzed sources are refused", async () => {
	const { call, store } = await setup();
	const audio: Asset = {
		createdAt: new Date().toISOString(),
		duration: 3,
		hasAudio: true,
		height: 0,
		id: crypto.randomUUID(),
		kind: "audio",
		name: "Voice",
		width: 0,
	};
	store.putAsset(audio);
	const refused = await call(`/assets/${audio.id}/shots`, "POST");
	expect(refused.status).toBe(400);
	expect(await refused.json()).toMatchObject({
		message: "Visual shot search indexes video sources only.",
	});
	const video = { ...audio, id: crypto.randomUUID(), kind: "video" as const };
	store.putAsset(video);
	expect(
		await (await call(`/assets/${video.id}/shots`, "POST")).json()
	).toMatchObject({
		message: "Complete source analysis before indexing shots.",
	});
});

test("vision keyframes and descriptions make shots searchable by words", async () => {
	const { call, store } = await setup();
	const asset = await threeShotVideo(store);
	// Keyframes need a current shot index first.
	expect(
		(await call(`/assets/${asset.id}/shots/keyframes`, "POST", {})).status
	).toBe(400);
	const index = shotIndexSchema.parse(
		await (await call(`/assets/${asset.id}/shots`, "POST")).json()
	);
	const keyframes = z
		.object({
			analysisCreatedAt: z.string(),
			keyframes: z.array(
				z.object({
					end: z.number(),
					frame: z.number(),
					image: z.string(),
					index: z.number(),
					start: z.number(),
				})
			),
			revision: z.number(),
			total: z.number(),
		})
		.parse(
			await (
				await call(`/assets/${asset.id}/shots/keyframes`, "POST", {
					limit: 2,
					offset: 1,
				})
			).json()
		);
	expect(keyframes.total).toBe(3);
	expect(keyframes.keyframes.map((frame) => frame.index)).toEqual([1, 2]);
	// The middle frame of each shot: 3 s and 5 s at 25 fps.
	expect(keyframes.keyframes.map((frame) => frame.frame)).toEqual([75, 125]);
	for (const frame of keyframes.keyframes) {
		expect(frame.image.startsWith("data:image/jpeg;base64,/9j/")).toBe(true);
		expect(frame.image.length).toBeLessThan(200_000);
	}
	const describe = (body: Record<string, unknown>) =>
		call(`/assets/${asset.id}/shots/descriptions`, "POST", {
			analysisCreatedAt: keyframes.analysisCreatedAt,
			model: "vision-model",
			provider: "test",
			revision: keyframes.revision,
			...body,
		});
	// Descriptions of an older index are refused.
	expect(
		(
			await describe({
				revision: index.revision + 1,
				shots: [{ caption: "x", index: 0, tags: [] }],
			})
		).status
	).toBe(409);
	const described = shotIndexSchema.parse(
		await (
			await describe({
				shots: [
					{
						caption: "A colourful test card with moving bars.",
						index: 1,
						tags: ["Test Card", "bars"],
					},
					{ caption: "A white wall.", index: 2, tags: ["wall"] },
				],
			})
		).json()
	);
	expect(described.shots[1]?.tags).toEqual(["test card", "bars"]);
	expect(described.shots[0]?.caption).toBeUndefined();
	expect(described.describedBy).toMatchObject({
		model: "vision-model",
		provider: "test",
	});
	// Descriptions keep the revision, so Space projections stay current.
	expect(described.revision).toBe(index.revision);

	const words = z
		.object({
			results: z.array(
				z.object({
					start: z.number(),
					textMatches: z.array(z.string()).optional(),
				})
			),
		})
		.parse(await (await call("/shot-search?q=bars")).json());
	expect(words.results.map((match) => match.start)).toEqual([2]);
	expect(words.results[0]?.textMatches).toEqual(["bars"]);
	// A look word plus a caption word must both hold.
	const both = z
		.object({ results: z.array(z.object({ start: z.number() })) })
		.parse(
			await (
				await call(`/shot-search?q=${encodeURIComponent("bright wall")}`)
			).json()
		);
	expect(both.results.map((match) => match.start)).toEqual([4]);
	// GET /search merges shot matches with transcripts.
	const merged = z
		.object({
			results: z.array(
				z.object({ source: z.string().optional(), text: z.string() })
			),
		})
		.parse(await (await call("/search?q=wall")).json());
	expect(merged.results).toEqual([
		expect.objectContaining({ source: "shot", text: "A white wall. (wall)" }),
	]);
});
