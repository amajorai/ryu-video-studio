import { describe, expect, test } from "bun:test";
import { creditsForProject } from "../../../shared/credits.ts";
import { importMediaRequestSchema } from "../../../shared/import-media.ts";
import { MAX_TRACK_INDEX } from "../../../shared/limits.ts";
import {
	type Asset,
	assetSchema,
	newSegment,
} from "../../../shared/project.ts";
import {
	STICKER_FOLDER,
	type StickerEntry,
	stickerById,
} from "../../../shared/stickers/catalog.ts";
import {
	STICKER_CLIP_SCALE,
	STICKER_TRACKS_BUSY_MESSAGE,
	stickerAnimation,
} from "../../../shared/stickers/place.ts";
import { StudioRequestError } from "../bridge.ts";
import { createTestRuntime, testProject } from "../editor/test-runtime.ts";
import {
	addSticker,
	CONTRACT_MISMATCH_MESSAGE,
	existingStickerAsset,
	importSticker,
	isContractMismatch,
	type StickerDependencies,
	type StickerImportBody,
	stickerImportBody,
} from "./add-sticker.ts";

function entry(id: string): StickerEntry {
	const found = stickerById(id);
	if (!found) {
		throw new Error(`missing sticker ${id}`);
	}
	return found;
}

const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], {
	type: "image/png",
});

/** A fake sidecar import that stores the asset the way the route would. */
function fakeSidecar(options: { acceptsProvenance: boolean }) {
	const bodies: StickerImportBody[] = [];
	const dependencies: StickerDependencies = {
		importAsset: (body) => {
			bodies.push(body);
			if (!options.acceptsProvenance && (body.origin || body.derivation)) {
				return Promise.reject(
					new StudioRequestError(CONTRACT_MISMATCH_MESSAGE, "INVALID_REQUEST")
				);
			}
			const asset: Asset = {
				createdAt: new Date(0).toISOString(),
				duration: 5,
				folder: body.folder,
				hasAudio: false,
				height: 1024,
				id: crypto.randomUUID(),
				kind: "image",
				name: body.name,
				width: 1024,
			};
			if (body.origin) {
				asset.origin = body.origin;
			}
			if (body.derivation) {
				asset.derivation = body.derivation;
			}
			return Promise.resolve(assetSchema.parse(asset));
		},
		contract: { provenance: "unknown" },
		rasterize: () => Promise.resolve(png),
	};
	return { bodies, dependencies };
}

describe("stickerImportBody", () => {
	test("carries inline PNG bytes, folder, and bundled provenance", () => {
		const body = stickerImportBody(entry("emoji-1f600"), "AAAA");
		expect(body).toEqual({
			derivation: "sticker",
			folder: STICKER_FOLDER,
			name: "Sticker · Grinning face",
			origin: expect.objectContaining({
				identifier: "emoji-1f600",
				provider: "bundled",
			}),
			source: { bytes: "AAAA", mimeType: "image/png" },
		});
		expect(stickerImportBody(entry("flag-fr"), "AAAA", false)).toEqual({
			folder: STICKER_FOLDER,
			name: "Sticker · Flag of France",
			source: { bytes: "AAAA", mimeType: "image/png" },
		});
	});
});

describe("importSticker", () => {
	test("records provenance when the sidecar accepts it", async () => {
		const sidecar = fakeSidecar({ acceptsProvenance: true });
		const result = await importSticker(
			entry("emoji-1f600"),
			sidecar.dependencies
		);
		expect(result.attributed).toBe(true);
		expect(result.asset.origin?.attribution).toContain("Twemoji");
		expect(sidecar.bodies).toHaveLength(1);
		expect(sidecar.bodies[0]?.source.bytes).toBe("iVBORw0KGgo=");
	});

	test("falls back to a plain import on an older import contract", async () => {
		const sidecar = fakeSidecar({ acceptsProvenance: false });
		const result = await importSticker(entry("flag-fr"), sidecar.dependencies);
		expect(result.attributed).toBe(false);
		expect(sidecar.bodies.map((body) => Boolean(body.origin))).toEqual([
			true,
			false,
		]);
	});

	test("after one rejection, later stickers upload once, without provenance", async () => {
		const sidecar = fakeSidecar({ acceptsProvenance: false });
		await importSticker(entry("flag-fr"), sidecar.dependencies);
		const second = await importSticker(
			entry("shape-star"),
			sidecar.dependencies
		);
		expect(second.attributed).toBe(false);
		expect(sidecar.bodies.map((body) => Boolean(body.origin))).toEqual([
			true,
			false,
			false,
		]);
		expect(sidecar.dependencies.contract?.provenance).toBe("rejected");
	});

	test("INVALID_REQUEST failures other than an off-contract body are not retried", async () => {
		const bodies: StickerImportBody[] = [];
		await expect(
			importSticker(entry("flag-fr"), {
				contract: { provenance: "unknown" },
				importAsset: (body) => {
					bodies.push(body);
					return Promise.reject(
						new StudioRequestError(
							"ffprobe could not read the media.",
							"INVALID_REQUEST"
						)
					);
				},
				rasterize: () => Promise.resolve(png),
			})
		).rejects.toThrow("ffprobe could not read the media.");
		expect(bodies).toHaveLength(1);
	});

	test("a sidecar that accepted provenance is never silently downgraded", async () => {
		const bodies: StickerImportBody[] = [];
		await expect(
			importSticker(entry("flag-fr"), {
				contract: { provenance: "accepted" },
				importAsset: (body) => {
					bodies.push(body);
					return Promise.reject(
						new StudioRequestError(CONTRACT_MISMATCH_MESSAGE, "INVALID_REQUEST")
					);
				},
				rasterize: () => Promise.resolve(png),
			})
		).rejects.toThrow(CONTRACT_MISMATCH_MESSAGE);
		expect(bodies).toHaveLength(1);
	});

	test("other failures are not retried", async () => {
		const bodies: StickerImportBody[] = [];
		await expect(
			importSticker(entry("flag-fr"), {
				importAsset: (body) => {
					bodies.push(body);
					return Promise.reject(new StudioRequestError("busy", "MEDIA_BUSY"));
				},
				rasterize: () => Promise.resolve(png),
			})
		).rejects.toThrow("busy");
		expect(bodies).toHaveLength(1);
	});
});

describe("import contract", () => {
	test("only the sidecar's off-contract refusal counts as a mismatch", () => {
		expect(
			isContractMismatch(
				new StudioRequestError(CONTRACT_MISMATCH_MESSAGE, "INVALID_REQUEST")
			)
		).toBe(true);
		expect(
			isContractMismatch(new StudioRequestError("disk full", "INVALID_REQUEST"))
		).toBe(false);
		expect(isContractMismatch(new Error(CONTRACT_MISMATCH_MESSAGE))).toBe(
			false
		);
	});

	test("the real import schema accepts both the plain and the attributed body", () => {
		const sticker = entry("emoji-1f600");
		expect(
			importMediaRequestSchema.safeParse(
				stickerImportBody(sticker, "AAAA", false)
			).success
		).toBe(true);
		expect(
			importMediaRequestSchema.safeParse(stickerImportBody(sticker, "AAAA"))
				.success
		).toBe(true);
	});
});

describe("existingStickerAsset", () => {
	const base: Asset = {
		createdAt: new Date(0).toISOString(),
		duration: 5,
		folder: STICKER_FOLDER,
		hasAudio: false,
		height: 1024,
		id: "00000000-0000-4000-8000-000000000001",
		kind: "image",
		name: "Sticker · Flag of France",
		width: 1024,
	};

	test("matches an attributed asset by its bundled origin", () => {
		const sticker = entry("flag-fr");
		const attributed: Asset = {
			...base,
			derivation: "sticker",
			name: "Renamed",
			origin: stickerImportBody(sticker, "AAAA").origin,
		};
		expect(
			existingStickerAsset([attributed], sticker, { provenance: "unknown" })
		).toEqual({ asset: attributed, attributed: true });
		expect(
			existingStickerAsset([attributed], entry("shape-star"), {
				provenance: "unknown",
			})
		).toBeNull();
	});

	test("reuses an unattributed asset only once provenance is known rejected", () => {
		const sticker = entry("flag-fr");
		expect(
			existingStickerAsset([base], sticker, { provenance: "unknown" })
		).toBeNull();
		expect(
			existingStickerAsset([base], sticker, { provenance: "rejected" })
		).toEqual({ asset: base, attributed: false });
	});
});

describe("addSticker", () => {
	test("imports, places at the playhead, and the credits list Twemoji", async () => {
		const { asset: video, project } = testProject();
		const runtime = createTestRuntime(project, [video]);
		runtime.time = 2;
		const sidecar = fakeSidecar({ acceptsProvenance: true });
		await addSticker(
			runtime,
			entry("emoji-1f600"),
			"pop",
			sidecar.dependencies
		);
		const setAssets = runtime.calls.find(([name]) => name === "setAssets");
		const update = setAssets?.[1] as (current: Asset[]) => Asset[];
		const assets = update([video]);
		const sticker = assets[0];
		expect(sticker?.name).toBe("Sticker · Grinning face");
		const placed = runtime.project?.segments.find(
			(segment) => segment.assetId === sticker?.id
		);
		expect(placed).toMatchObject({
			scale: STICKER_CLIP_SCALE,
			start: 2,
			track: 1,
		});
		expect(placed?.animation).toEqual(stickerAnimation("pop"));
		expect(runtime.selectedId).toBe(placed?.id ?? "missing");
		expect(runtime.calls).toContainEqual(["edit", "Add sticker Grinning face"]);
		if (!runtime.project) {
			throw new Error("project missing");
		}
		const credits = creditsForProject(runtime.project, assets);
		expect(credits.entries).toHaveLength(1);
		expect(credits.entries[0]?.attribution).toBe(
			"Twemoji graphics by Twitter, Inc and other contributors, licensed under CC-BY 4.0."
		);
		expect(credits.entries[0]?.provider).toBe("bundled");
	});

	test("places above existing overlays and reports a missing credit", async () => {
		const { asset: video, project } = testProject();
		const overlay = newSegment(video, 0, 1);
		const runtime = createTestRuntime(
			{ ...project, segments: [...project.segments, overlay] },
			[video]
		);
		runtime.time = 1;
		const statuses: string[] = [];
		const setStatus = runtime.setStatus;
		runtime.setStatus = (status) => {
			statuses.push(status);
			setStatus(status);
		};
		await addSticker(
			runtime,
			entry("shape-star"),
			"none",
			fakeSidecar({ acceptsProvenance: false }).dependencies
		);
		const placed = runtime.project?.segments.at(-1);
		expect(placed?.track).toBe(2);
		expect(placed).not.toHaveProperty("animation");
		expect(statuses.at(-1)).toContain("license credit was not recorded");
	});

	test("re-adding a sticker reuses its asset: one import, one credit entry", async () => {
		const { asset: video, project } = testProject();
		const runtime = createTestRuntime(project, [video]);
		const sidecar = fakeSidecar({ acceptsProvenance: true });
		const library: Asset[] = [video];
		runtime.setAssets = (update) => {
			const next = typeof update === "function" ? update(library) : update;
			library.splice(0, library.length, ...next);
			runtime.assets = [...library];
		};
		await addSticker(
			runtime,
			entry("emoji-1f600"),
			"none",
			sidecar.dependencies
		);
		runtime.time = 6;
		await addSticker(
			runtime,
			entry("emoji-1f600"),
			"none",
			sidecar.dependencies
		);
		expect(sidecar.bodies).toHaveLength(1);
		expect(library).toHaveLength(2);
		const sticker = library[0];
		const placed = runtime.project?.segments.filter(
			(segment) => segment.assetId === sticker?.id
		);
		expect(placed?.map((segment) => segment.start)).toEqual([0, 6]);
		if (!runtime.project) {
			throw new Error("project missing");
		}
		expect(creditsForProject(runtime.project, library).entries).toHaveLength(1);
	});

	test("every track busy: no rasterize, no import, no orphan asset", async () => {
		const { asset: video, project } = testProject();
		const overlays = Array.from({ length: MAX_TRACK_INDEX }, (_, index) =>
			newSegment(video, 0, index + 1)
		);
		const runtime = createTestRuntime(
			{ ...project, segments: [...project.segments, ...overlays] },
			[video]
		);
		const statuses: string[] = [];
		runtime.setStatus = (status) => {
			statuses.push(status);
		};
		let rasterized = 0;
		const sidecar = fakeSidecar({ acceptsProvenance: true });
		await addSticker(runtime, entry("shape-star"), "none", {
			...sidecar.dependencies,
			rasterize: () => {
				rasterized += 1;
				return Promise.resolve(png);
			},
		});
		expect(rasterized).toBe(0);
		expect(sidecar.bodies).toHaveLength(0);
		expect(runtime.calls.some(([name]) => name === "setAssets")).toBe(false);
		expect(statuses.at(-1)).toBe(STICKER_TRACKS_BUSY_MESSAGE);
	});

	test("when the editor cannot draw the SVG, the sidecar route places it", async () => {
		const { asset: video, project } = testProject();
		const runtime = createTestRuntime(project, [video]);
		runtime.time = 3;
		const edits: [string, Record<string, unknown>][] = [];
		runtime.routeEdit = (action, body, describe) => {
			edits.push([action, body]);
			runtime.setStatus(describe({}));
			return Promise.resolve({ extras: {}, status: "ok" });
		};
		const sidecar = fakeSidecar({ acceptsProvenance: true });
		await addSticker(runtime, entry("shape-star"), "spin", {
			...sidecar.dependencies,
			rasterize: () =>
				Promise.reject(new Error("This browser cannot draw stickers.")),
		});
		expect(edits).toEqual([
			["stickers", { preset: "spin", stickerId: "shape-star", time: 3 }],
		]);
		expect(sidecar.bodies).toHaveLength(0);
		expect(runtime.calls.some(([name]) => name === "edit")).toBe(false);
	});

	test("needs a project", async () => {
		const runtime = createTestRuntime(null);
		const statuses: string[] = [];
		runtime.setStatus = (status) => {
			statuses.push(status);
		};
		await addSticker(
			runtime,
			entry("shape-star"),
			"pop",
			fakeSidecar({ acceptsProvenance: true }).dependencies
		);
		expect(statuses).toEqual(["Create a project before adding stickers."]);
	});
});
