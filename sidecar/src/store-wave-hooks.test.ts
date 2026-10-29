import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Asset, type Avatar, newSegment } from "../../shared/project.ts";
import { StudioStore } from "./store.ts";

/**
 * Cross-wave store hooks applied when W1 (store owner, W1-WS5) and W3 met:
 * generation provenance (W3-G1), dangling lip-sync repair (W3-G3) and shot
 * file cleanup on asset delete (W3-X5).
 */

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const task of cleanup.splice(0)) {
		await task();
	}
});

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-hooks-"));
	const store = new StudioStore(directory);
	cleanup.push(async () => {
		store.close();
		await rm(directory, { force: true, recursive: true });
	});
	return store;
}

function media(kind: Asset["kind"]): Asset {
	return {
		createdAt: new Date().toISOString(),
		duration: 10,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : 360,
		id: crypto.randomUUID(),
		kind,
		name: `${kind} media`,
		width: kind === "audio" ? 0 : 640,
	};
}

function avatar(extra: Partial<Avatar> = {}): Avatar {
	return {
		accent: "#f97316",
		animation: "none",
		depth: 0.45,
		end: 4,
		entryDuration: 0,
		height: 0.6,
		id: crypto.randomUUID(),
		outfit: "#4f46e5",
		pose: "neutral",
		skin: "#f4c7a1",
		start: 0,
		width: 0.3,
		x: 0.5,
		y: 0.2,
		...extra,
	};
}

describe("store wave hooks", () => {
	test("a completed generation stamps its saved media with provenance", async () => {
		const store = await setup();
		const project = store.create("Generated");
		const still = media("image");
		store.putAsset(still);
		const job = store.beginGeneration({
			id: crypto.randomUUID(),
			kind: "image",
			model: "test-model",
			projectId: project.id,
			prompt: "Make the sky purple",
			sourceAssetId: still.id,
		}).job;
		const output = media("image");
		store.putAsset(output);
		store.finishGeneration(job.id, {
			assetIds: [output.id],
			status: "completed",
		});
		const stamped = store.assets().find((item) => item.id === output.id);
		expect(stamped).toMatchObject({
			derivation: "ai-edit",
			derivedFromAssetId: still.id,
			generation: {
				kind: "image",
				model: "test-model",
				prompt: "Make the sky purple",
				requestId: job.id,
			},
		});
		// The source still is untouched.
		expect(
			store.assets().find((item) => item.id === still.id)?.generation
		).toBeUndefined();
	});

	test("projects with a dangling lip-sync link still open and save", async () => {
		const store = await setup();
		const voice = media("audio");
		store.putAsset(voice);
		const created = store.create("Lip-sync");
		const clip = newSegment(voice, 0, 1);
		const linked = avatar({
			lipSync: {
				assetId: voice.id,
				segmentId: clip.id,
				sensitivity: 0.5,
				smoothing: 0.5,
			},
		});
		const saved = store.save({
			...created,
			avatars: [linked],
			segments: [clip],
		});
		expect(saved.avatars[0]?.lipSync?.segmentId).toBe(clip.id);
		// Removing the clip under a live link is refused (W3 validation): the
		// edit ops prune their own links, so the save never repairs a new one.
		expect(() => store.save({ ...saved, segments: [] })).toThrow(
			"Avatar lip-sync references missing audio."
		);
		// A link the request adds to a missing clip is refused, not dropped.
		expect(() =>
			store.save({
				...saved,
				avatars: [
					{
						...linked,
						lipSync: {
							assetId: voice.id,
							segmentId: crypto.randomUUID(),
							sensitivity: 0.5,
							smoothing: 0.5,
						},
					},
				],
			})
		).toThrow("Avatar lip-sync references missing audio.");
		// A stored project whose linked media vanished loads repaired.
		store.discardAsset(voice.id);
		const loaded = store.project(saved.id);
		expect(loaded.avatars[0]).not.toHaveProperty("lipSync");
		// A client still holding the stored (stale) link saves too; the link
		// that was already dangling in the row is dropped.
		const stale = store.save({
			...loaded,
			avatars: [linked],
			segments: [],
		});
		expect(stale.avatars[0]).not.toHaveProperty("lipSync");
		// Only the clip of the missing media blocks a save now, not the link.
		expect(() =>
			store.save({ ...stale, segments: [], title: "Still saves" })
		).not.toThrow();
	});

	test("deleting media removes its shot files and lip-sync links", async () => {
		const store = await setup();
		const voice = media("audio");
		store.putAsset(voice);
		const created = store.create("Shots");
		const clip = newSegment(voice, 0, 1);
		store.save({
			...created,
			avatars: [
				avatar({
					lipSync: {
						assetId: voice.id,
						segmentId: clip.id,
						sensitivity: 0.5,
						smoothing: 0.5,
					},
				}),
			],
			segments: [clip],
		});
		const shots = join(store.directory, "shots");
		mkdirSync(shots, { recursive: true });
		const files = [".json", ".space.json"].map((suffix) =>
			join(shots, `${voice.id}${suffix}`)
		);
		const other = join(shots, `${crypto.randomUUID()}.json`);
		for (const file of [...files, other]) {
			writeFileSync(file, "{}");
		}
		const result = store.organizeAsset(voice.id, { delete: true });
		expect(result.deleted).toBe(true);
		for (const file of files) {
			expect(existsSync(file)).toBe(false);
		}
		expect(existsSync(other)).toBe(true);
		const after = store.project(created.id);
		expect(after.segments).toEqual([]);
		expect(after.avatars[0]).not.toHaveProperty("lipSync");
	});

	test("deleting media rewrites a project linked only through lip sync", async () => {
		const store = await setup();
		const voice = media("audio");
		store.putAsset(voice);
		const created = store.create("Library voice");
		const saved = store.save({
			...created,
			avatars: [
				avatar({
					lipSync: { assetId: voice.id, sensitivity: 0.5, smoothing: 0.5 },
				}),
			],
		});
		expect(() =>
			store.organizeAsset(voice.id, {
				delete: true,
				projectRevisions: { [saved.id]: saved.revision - 1 },
			})
		).toThrow("Reload before deleting");
		store.organizeAsset(voice.id, {
			delete: true,
			projectRevisions: { [saved.id]: saved.revision },
		});
		const after = store.project(created.id);
		expect(after.revision).toBe(saved.revision + 1);
		expect(after.avatars[0]).not.toHaveProperty("lipSync");
		// The stored row itself lost the link, not just the repaired read.
		const raw = store.db
			.query("SELECT data FROM projects WHERE id=?")
			.get(created.id) as { data: string };
		expect(JSON.parse(raw.data).avatars[0]).not.toHaveProperty("lipSync");
	});

	test("listing projects reads the library once, and not at all without links", async () => {
		const store = await setup();
		for (const title of ["One", "Two", "Three"]) {
			store.create(title);
		}
		const original = store.assets.bind(store);
		let reads = 0;
		store.assets = () => {
			reads += 1;
			return original();
		};
		expect(store.projects()).toHaveLength(3);
		expect(reads).toBe(0);
		const voice = media("audio");
		store.putAsset(voice);
		const [first, second] = store.projects();
		for (const project of [first, second]) {
			if (project) {
				store.save({
					...project,
					avatars: [
						avatar({
							lipSync: { assetId: voice.id, sensitivity: 0.5, smoothing: 0.5 },
						}),
					],
				});
			}
		}
		reads = 0;
		expect(store.projects()).toHaveLength(3);
		expect(reads).toBe(1);
		reads = 0;
		store.create("Four");
		expect(reads).toBe(0);
	});

	test("deleting media used as the canvas background resets it (W2-V8)", async () => {
		const store = await setup();
		const image = media("image");
		store.putAsset(image);
		const created = store.create("Backdrop");
		store.save({
			...created,
			background: { assetId: image.id, type: "image" },
		});
		expect(store.project(created.id).background).toEqual({
			assetId: image.id,
			type: "image",
		});
		store.organizeAsset(image.id, { delete: true });
		expect(store.project(created.id)).not.toHaveProperty("background");
	});
});
