import { describe, expect, test } from "bun:test";
import type { Asset } from "../../../shared/project.ts";
import {
	DEFAULT_LIBRARY_PREFERENCES,
	filterAssets,
	libraryFolders,
	libraryPreferencesSchema,
	sortAssets,
} from "./sort.ts";

function asset(
	name: string,
	patch: Partial<Asset> & { createdAt: string }
): Asset {
	return {
		duration: 10,
		hasAudio: true,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video",
		name,
		width: 640,
		...patch,
	};
}

const clip2 = asset("clip 2", {
	createdAt: "2026-01-02T00:00:00.000Z",
	duration: 4,
	height: 1080,
	width: 1920,
});
const clip10 = asset("Clip 10", {
	createdAt: "2026-01-03T00:00:00.000Z",
	duration: 30,
	folder: "B-roll",
});
const music = asset("Music", {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 120,
	height: 0,
	kind: "audio",
	width: 0,
});
const logo = asset("Logo", {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 5,
	folder: "Brand",
	height: 512,
	kind: "image",
	width: 512,
});
const all = [music, clip2, logo, clip10];
const names = (items: Asset[]) => items.map((item) => item.name);

describe("library sorting", () => {
	test("sorts by each key in both directions", () => {
		expect(names(sortAssets(all, "name", "asc"))).toEqual([
			"clip 2",
			"Clip 10",
			"Logo",
			"Music",
		]);
		expect(names(sortAssets(all, "name", "desc"))).toEqual([
			"Music",
			"Logo",
			"Clip 10",
			"clip 2",
		]);
		expect(names(sortAssets(all, "date", "desc"))).toEqual([
			"Clip 10",
			"clip 2",
			"Logo",
			"Music",
		]);
		expect(names(sortAssets(all, "duration", "asc"))).toEqual([
			"clip 2",
			"Logo",
			"Clip 10",
			"Music",
		]);
		// 1920x1080, then 512x512 (262k px) before 640x360 (230k px).
		expect(names(sortAssets(all, "size", "desc"))).toEqual([
			"clip 2",
			"Logo",
			"Clip 10",
			"Music",
		]);
		expect(names(sortAssets(all, "type", "asc"))).toEqual([
			"clip 2",
			"Clip 10",
			"Logo",
			"Music",
		]);
		expect(names(sortAssets(all, "type", "desc"))).toEqual([
			"Music",
			"Logo",
			"clip 2",
			"Clip 10",
		]);
	});

	test("ties fall back to name then id and never mutate the input", () => {
		const twin = { ...logo, id: "00000000-0000-4000-8000-000000000000" };
		const input = [logo, twin, music];
		const sorted = sortAssets(input, "date", "asc");
		expect(sorted.map((item) => item.id)).toEqual([twin.id, logo.id, music.id]);
		expect(input[0]).toBe(logo);
		expect(sortAssets(input, "date", "asc")).toEqual(sorted);
	});

	test("filters by query and folder and lists folders", () => {
		expect(names(filterAssets(all, { folder: "", query: " CLIP " }))).toEqual([
			"clip 2",
			"Clip 10",
		]);
		expect(names(filterAssets(all, { folder: "Brand", query: "" }))).toEqual([
			"Logo",
		]);
		expect(libraryFolders(all)).toEqual(["B-roll", "Brand"]);
	});

	test("preferences are strict", () => {
		expect(
			libraryPreferencesSchema.safeParse(DEFAULT_LIBRARY_PREFERENCES).success
		).toBe(true);
		expect(
			libraryPreferencesSchema.safeParse({
				...DEFAULT_LIBRARY_PREFERENCES,
				sort: "rating",
			}).success
		).toBe(false);
		expect(
			libraryPreferencesSchema.safeParse({
				...DEFAULT_LIBRARY_PREFERENCES,
				extra: 1,
			}).success
		).toBe(false);
	});
});
