import { describe, expect, test } from "bun:test";
import type { Asset } from "./project.ts";
import {
	beginShotSearchIndex,
	pruneShotSearchEntry,
	SearchIndexConflictError,
	shotDocuments,
	updateShotSearchEntry,
	verifiedShotDocument,
} from "./search-index.ts";
import type { ShotIndex } from "./shot-index.ts";

const asset: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 12,
	hasAudio: false,
	height: 360,
	id: crypto.randomUUID(),
	kind: "video",
	name: "Harbor",
	width: 640,
};

function shots(revision: number): ShotIndex {
	return {
		format: "ryu.video-studio.shots.v1",
		assetId: asset.id,
		analysisCreatedAt: "2026-01-01T00:00:00.000Z",
		revision,
		sampleRate: 4,
		shots: [
			{
				start: 0,
				end: 4,
				brightness: 0.2,
				saturation: 0.5,
				motion: 0.06,
				edgeDensity: 0.3,
				colors: [{ hex: "#1020c0", name: "blue", weight: 0.8 }],
				labels: ["dark", "vivid", "wide", "motion", "blue"],
			},
			{
				start: 4,
				end: 12,
				brightness: 0.8,
				saturation: 0.05,
				motion: 0,
				edgeDensity: 0.01,
				colors: [{ hex: "#f0f0f0", name: "white", weight: 1 }],
				labels: ["bright", "muted", "close-up", "static", "white"],
			},
		],
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

const space = { rebuild: false, spaceId: "space-1", spaceName: "Footage" };
const now = "2026-02-01T00:00:00.000Z";

describe("shot search documents", () => {
	test("one document per shot describes labels and colors", () => {
		const entries = shotDocuments(asset, shots(2));
		expect(entries.map((entry) => entry.key)).toEqual(["shot:2:0", "shot:2:1"]);
		const body = JSON.parse(entries[0]?.source ?? "{}");
		expect(body).toMatchObject({
			format: "ryu.video-studio.shot.v1",
			assetId: asset.id,
			shotsRevision: 2,
			start: 0,
			end: 4,
		});
		expect(body.text).toContain("dark, vivid, wide, motion, blue");
		expect(body.text).toContain("blue 80%");
		expect(() => shotDocuments(asset, { ...shots(1), shots: [] })).toThrow();
	});

	test("begin keeps a matching projection and obsoletes mapped documents on change", () => {
		const first = beginShotSearchIndex(null, asset, shots(1), space, now);
		expect(first.revision).toBe(0);
		expect(beginShotSearchIndex(first, asset, shots(1), space, now)).toBe(
			first
		);
		const mapped = updateShotSearchEntry(
			first,
			{ docId: "doc-a", key: "shot:1:0", ready: true, revision: 0 },
			now
		);
		const next = beginShotSearchIndex(mapped, asset, shots(2), space, now);
		expect(next.revision).toBe(2);
		expect(next.obsolete.map((entry) => entry.docId)).toEqual(["doc-a"]);
		expect(next.entries.every((entry) => entry.docId === null)).toBe(true);
		const rebuilt = beginShotSearchIndex(
			next,
			asset,
			shots(2),
			{ ...space, rebuild: true },
			now
		);
		expect(rebuilt.revision).toBe(3);
	});

	test("entry updates and pruning are revision-checked", () => {
		const first = beginShotSearchIndex(null, asset, shots(1), space, now);
		expect(() =>
			updateShotSearchEntry(first, {
				docId: "doc-a",
				key: "shot:1:0",
				ready: false,
				revision: 7,
			})
		).toThrow(SearchIndexConflictError);
		const mapped = updateShotSearchEntry(first, {
			docId: "doc-a",
			key: "shot:1:0",
			ready: false,
			revision: 0,
		});
		expect(() =>
			updateShotSearchEntry(mapped, {
				docId: "doc-b",
				key: "shot:1:0",
				ready: true,
				revision: 1,
			})
		).toThrow(SearchIndexConflictError);
		expect(() =>
			updateShotSearchEntry(mapped, {
				docId: "doc-a",
				key: "shot:1:1",
				ready: true,
				revision: 1,
			})
		).toThrow("two index entries");
		expect(() =>
			updateShotSearchEntry(mapped, {
				docId: "doc-c",
				key: "missing",
				ready: true,
				revision: 1,
			})
		).toThrow("not found");
		const next = beginShotSearchIndex(mapped, asset, shots(2), space, now);
		expect(() =>
			pruneShotSearchEntry(next, { docId: "doc-a", revision: 0 })
		).toThrow(SearchIndexConflictError);
		expect(
			pruneShotSearchEntry(next, { docId: "doc-a", revision: next.revision })
				.obsolete
		).toEqual([]);
	});

	test("verification accepts only the exact ready source of the current revision", () => {
		let index = beginShotSearchIndex(null, asset, shots(1), space, now);
		const source = index.entries[0]?.source ?? "";
		expect(verifiedShotDocument(index, "doc-a", source)).toBeNull();
		index = updateShotSearchEntry(index, {
			docId: "doc-a",
			key: "shot:1:0",
			ready: true,
			revision: index.revision,
		});
		expect(verifiedShotDocument(index, "doc-a", source)?.end).toBe(4);
		expect(
			verifiedShotDocument(index, "doc-a", source.replace("dark", "bright"))
		).toBeNull();
		expect(verifiedShotDocument(index, "doc-other", source)).toBeNull();
		expect(
			verifiedShotDocument({ ...index, shotsRevision: 9 }, "doc-a", source)
		).toBeNull();
	});
});
