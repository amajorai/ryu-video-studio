import { describe, expect, test } from "bun:test";
import { newProject } from "./project.ts";
import {
	chapterTimestamp,
	markerChapters,
	PUBLISH_PRESETS,
	publishMetadataText,
	publishPresetFor,
	publishPresetIdSchema,
	publishPresetWarnings,
} from "./publish-presets.ts";
import { exportSettingsSchema } from "./schema/export.ts";

const marker = (time: number, label: string) => ({ label, time });

describe("publish presets", () => {
	test("one preset per id, each with valid export settings", () => {
		expect(PUBLISH_PRESETS.map((preset) => preset.id)).toEqual(
			publishPresetIdSchema.options
		);
		for (const preset of PUBLISH_PRESETS) {
			expect(exportSettingsSchema.safeParse(preset.settings).success).toBe(
				true
			);
			expect(publishPresetFor(preset.id)).toBe(preset);
		}
		expect(publishPresetFor("unknown")).toBeUndefined();
		expect(publishPresetFor(undefined)).toBeUndefined();
	});
	test("short-form presets are vertical 1080 × 1920 with a 60 s warning", () => {
		for (const id of ["youtube-shorts", "instagram-reels", "tiktok"]) {
			const preset = publishPresetFor(id);
			expect(preset?.settings).toMatchObject({
				outputWidth: 1080,
				outputHeight: 1920,
			});
			expect(preset?.maxDurationSeconds).toBe(60);
		}
	});
});

describe("chapters and metadata", () => {
	test("timestamps", () => {
		expect(chapterTimestamp(0)).toBe("00:00");
		expect(chapterTimestamp(65.9)).toBe("01:05");
		expect(chapterTimestamp(3725)).toBe("1:02:05");
		expect(chapterTimestamp(-3)).toBe("00:00");
	});
	test("chapters are sorted, re-based to the range, and open at 00:00", () => {
		const markers = [
			marker(40, "Outro"),
			marker(12, "Middle"),
			marker(2, "Before"),
			marker(60, "After"),
		];
		expect(markerChapters(markers, { start: 10, end: 50 })).toEqual([
			"00:00 Start",
			"00:02 Middle",
			"00:30 Outro",
		]);
		expect(markerChapters([marker(0, "Intro")], { start: 0, end: 5 })).toEqual([
			"00:00 Intro",
		]);
		expect(markerChapters([], { start: 0, end: 5 })).toEqual([]);
	});
	test("metadata text has title, platform, description and chapters", () => {
		const project = {
			...newProject("Launch film"),
			brief: "  A short launch film.  ",
			markers: [
				{ id: "00000000-0000-4000-8000-000000000001", label: "Intro", time: 0 },
				{ id: "00000000-0000-4000-8000-000000000002", label: "Demo", time: 30 },
			],
		};
		const youtube = publishPresetFor("youtube-1080p");
		const tiktok = publishPresetFor("tiktok");
		if (!(youtube && tiktok)) {
			throw new Error("missing presets");
		}
		expect(publishMetadataText(project, youtube, { start: 0, end: 90 })).toBe(
			[
				"Title: Launch film",
				"Platform: YouTube 1080p",
				"Duration: 01:30",
				"",
				"Description:",
				"A short launch film.",
				"",
				"Chapters:",
				"00:00 Intro",
				"00:30 Demo",
				"",
			].join("\n")
		);
		const short = publishMetadataText({ ...project, brief: "" }, tiktok, {
			start: 0,
			end: 20,
		});
		expect(short).toContain("(no description)");
		expect(short).not.toContain("Chapters:");
	});
	test("warnings for long short-form exports and letterboxing", () => {
		const tiktok = publishPresetFor("tiktok");
		const youtube = publishPresetFor("youtube-1080p");
		if (!(tiktok && youtube)) {
			throw new Error("missing presets");
		}
		expect(
			publishPresetWarnings(tiktok, {
				canvasWidth: 1080,
				canvasHeight: 1920,
				duration: 75,
			})
		).toEqual([
			"TikTok exports are meant to be at most 60 seconds; this export is 75.0 seconds.",
		]);
		expect(
			publishPresetWarnings(tiktok, {
				canvasWidth: 1920,
				canvasHeight: 1080,
				duration: 30,
			})[0]
		).toContain("letterboxed into 1080 × 1920");
		expect(
			publishPresetWarnings(youtube, {
				canvasWidth: 1280,
				canvasHeight: 720,
				duration: 600,
			})
		).toEqual([]);
	});
});
