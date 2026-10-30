import { describe, expect, test } from "bun:test";
import { PROJECT_FRAME_RATES } from "./frame-rate.ts";
import {
	type Asset,
	isWritableProjectFps,
	newProject,
	newSegment,
} from "./project.ts";
import {
	CANVAS_PRESETS,
	canvasForMedia,
	customCanvas,
	firstClipMediaAsset,
	matchMediaSettingsRequest,
	matchProjectToMedia,
	mediaSettingsMismatch,
	projectSettingsRequestSchema,
	updateProjectSettings,
} from "./settings.ts";

test("partial settings preserve omitted export preset and accept explicit changes", () => {
	const project = {
		...newProject("Review cut"),
		exportPreset: "review" as const,
	};
	const parsed = projectSettingsRequestSchema.parse({
		revision: project.revision,
		fps: 60,
	});
	expect(parsed.exportPreset).toBeUndefined();
	expect(updateProjectSettings(project, [], parsed)).toMatchObject({
		fps: 60,
		exportPreset: "review",
	});
	expect(
		updateProjectSettings(project, [], {
			revision: project.revision,
			exportPreset: "master",
		}).exportPreset
	).toBe("master");
	expect(
		updateProjectSettings(project, [], {
			revision: project.revision,
			exportCodec: "h265",
		})
	).toMatchObject({ exportCodec: "h265", exportPreset: "review" });
	expect(
		projectSettingsRequestSchema.safeParse({ revision: project.revision })
			.success
	).toBe(false);
});

test("settings accepts aspect-ratio presets and preserves the current short edge", () => {
	const project = newProject("Portrait");
	const changed = updateProjectSettings(project, [], {
		aspectRatio: "9:16",
		revision: project.revision,
	});
	expect(changed).toMatchObject({ height: 1920, width: 1080 });
});

test("settings quality presets preserve the selected ratio", () => {
	const project = newProject("Quality");
	const changed = updateProjectSettings(project, [], {
		exportCodec: "prores",
		quality: "4K",
		revision: project.revision,
	});
	expect(changed).toMatchObject({
		exportCodec: "prores",
		height: 2160,
		width: 3840,
	});
});

test("settings rejects mixed explicit dimensions and ratio/quality", () => {
	const project = newProject("Invalid settings");
	expect(() =>
		updateProjectSettings(project, [], {
			aspectRatio: "1:1",
			height: 720,
			revision: project.revision,
			width: 720,
		})
	).toThrow();
});

test("settings updates the visual style profile with revision validation", () => {
	const project = newProject("Style settings");
	const next = updateProjectSettings(project, [], {
		revision: project.revision,
		styleProfile: "cinematic",
	});
	expect(next.styleProfile).toBe("cinematic");
});

function mediaAsset(overrides: Partial<Asset> = {}): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration: 10,
		hasAudio: true,
		height: 2160,
		id: crypto.randomUUID(),
		kind: "video",
		name: "Drone.mov",
		width: 3840,
		...overrides,
	};
}

describe("frame rates", () => {
	test("the settings request accepts every project rate and rejects others", () => {
		const project = newProject("Rates");
		for (const fps of PROJECT_FRAME_RATES) {
			expect(
				projectSettingsRequestSchema.safeParse({
					revision: project.revision,
					fps,
				}).success
			).toBe(true);
		}
		for (const fps of [15, 29.976, 0, 240]) {
			expect(
				projectSettingsRequestSchema.safeParse({
					revision: project.revision,
					fps,
				}).success
			).toBe(false);
		}
	});

	test.each([
		48, 50, 120,
	] as const)("integer rate %p persists through settings", (fps) => {
		const project = newProject("Rates");
		expect(
			updateProjectSettings(project, [], { revision: project.revision, fps })
				.fps
		).toBe(fps);
	});

	test.each([
		23.976, 29.97, 59.94,
	] as const)("NTSC rate %p persists exactly", (fps) => {
		const project = newProject("Rates");
		expect(isWritableProjectFps(fps)).toBe(true);
		expect(
			updateProjectSettings(project, [], { revision: project.revision, fps })
				.fps
		).toBe(fps);
	});
});

describe("match project to media", () => {
	test("canvasForMedia keeps aspect, even edges and canvas bounds", () => {
		expect(canvasForMedia(3840, 2160)).toEqual({ height: 2160, width: 3840 });
		expect(canvasForMedia(1919, 1081)).toEqual({ height: 1082, width: 1920 });
		expect(canvasForMedia(16_384, 9216)).toEqual({ height: 4608, width: 8192 });
		expect(canvasForMedia(100, 50)).toEqual({ height: 128, width: 256 });
		expect(canvasForMedia(0, 0)).toBeNull();
		expect(canvasForMedia(2000, 100)).toBeNull();
	});

	test("reports canvas and writable rate differences", () => {
		const project = { ...newProject("Match"), fps: 30 as const };
		const asset = mediaAsset({ frameRate: 25 });
		expect(mediaSettingsMismatch(project, asset)).toEqual({
			assetId: asset.id,
			canvas: { height: 2160, width: 3840 },
			fps: 25,
			mediaFrameRate: 25,
		});
	});

	test("an NTSC source proposes its exact rate", () => {
		const project = { ...newProject("Match"), height: 2160, width: 3840 };
		const asset = mediaAsset({ frameRate: 29.97 });
		const mismatch = mediaSettingsMismatch(project, asset);
		expect(mismatch).toMatchObject({ fps: 29.97 });
		expect(mismatch?.unsupportedFps).toBeUndefined();
		expect(matchMediaSettingsRequest(0, mismatch!)).toMatchObject({
			fps: 29.97,
		});
	});

	test("matching media, audio and unmapped rates produce no prompt", () => {
		const project = { ...newProject("Match"), height: 2160, width: 3840 };
		expect(
			mediaSettingsMismatch(project, mediaAsset({ frameRate: 30 }))
		).toBeNull();
		expect(
			mediaSettingsMismatch(project, mediaAsset({ frameRate: 15 }))
		).toBeNull();
		expect(mediaSettingsMismatch(project, mediaAsset())).toBeNull();
		expect(
			mediaSettingsMismatch(
				project,
				mediaAsset({ height: 0, kind: "audio", width: 0 })
			)
		).toBeNull();
		const still = mediaAsset({ height: 1080, kind: "image", width: 1080 });
		expect(mediaSettingsMismatch(project, still)).toEqual({
			assetId: still.id,
			canvas: { height: 1080, width: 1080 },
		});
	});

	test("matchProjectToMedia applies canvas and rate in one revision-checked request", () => {
		const project = newProject("Match");
		const asset = mediaAsset({ frameRate: 50, height: 1080, width: 1440 });
		const result = matchProjectToMedia(project, [asset], {
			assetId: asset.id,
			revision: project.revision,
		});
		expect(result.project).toMatchObject({
			fps: 50,
			height: 1080,
			width: 1440,
		});
		expect(result.mismatch.assetId).toBe(asset.id);
		expect(() =>
			matchProjectToMedia(result.project, [asset], {
				assetId: asset.id,
				revision: project.revision,
			})
		).toThrow("already matches");
		expect(() =>
			matchProjectToMedia(project, [], {
				assetId: asset.id,
				revision: project.revision,
			})
		).toThrow("not found");
		const voice = mediaAsset({ height: 0, kind: "audio", width: 0 });
		expect(() =>
			matchProjectToMedia(project, [voice], {
				assetId: voice.id,
				revision: project.revision,
			})
		).toThrow("Audio has no picture");
	});

	test("firstClipMediaAsset is the lone picture clip and its derived audio", () => {
		const video = mediaAsset();
		const detached = mediaAsset({
			derivedFromAssetId: video.id,
			height: 0,
			kind: "audio",
			width: 0,
		});
		const other = mediaAsset({ name: "Other.mov" });
		const project = newProject("First clip");
		expect(firstClipMediaAsset(project, [video])).toBeUndefined();
		project.segments = [newSegment(video, 0)];
		expect(firstClipMediaAsset(project, [video])?.id).toBe(video.id);
		project.segments = [newSegment(video, 0), newSegment(detached, 0, 1)];
		expect(firstClipMediaAsset(project, [video, detached])?.id).toBe(video.id);
		project.segments = [newSegment(video, 0), newSegment(video, 10)];
		expect(firstClipMediaAsset(project, [video])).toBeUndefined();
		project.segments = [newSegment(video, 0), newSegment(other, 0, 1)];
		expect(firstClipMediaAsset(project, [video, other])).toBeUndefined();
		project.segments = [newSegment(detached, 0)];
		expect(firstClipMediaAsset(project, [detached])).toBeUndefined();
		project.segments = [newSegment(video, 0)];
		expect(firstClipMediaAsset(project, [])).toBeUndefined();
	});
});

describe("custom canvas", () => {
	test("edges round to even pixels within 128..8192", () => {
		expect(customCanvas(1441, 1081)).toEqual({ height: 1082, width: 1442 });
		expect(customCanvas(20, 50_000)).toEqual({ height: 8192, width: 820 });
		expect(customCanvas(Number.NaN, 300)).toEqual({ height: 300, width: 128 });
	});

	test("the aspect stays within 1:10..10:1", () => {
		const wide = customCanvas(8192, 128);
		expect(wide.width / wide.height).toBeLessThanOrEqual(10);
		expect(wide).toEqual({ height: 820, width: 8192 });
	});

	test("every preset is a valid even canvas", () => {
		for (const [width, height] of CANVAS_PRESETS) {
			expect(customCanvas(width, height)).toEqual({ height, width });
		}
		expect(
			CANVAS_PRESETS.map(([width, height]) => `${width}x${height}`)
		).toContain("7680x4320");
	});
});
