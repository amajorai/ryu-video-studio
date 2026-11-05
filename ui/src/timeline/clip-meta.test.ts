import { expect, test } from "bun:test";
import { clipColorLabelSchema } from "../../../shared/project.ts";
import {
	CLIP_COLOR_LABELS,
	CLIP_COLOR_SWATCHES,
	clipColorName,
	clipColorPatch,
	clipLabelPatch,
	normalizeClipLabel,
} from "./clip-meta.ts";

test("labels are trimmed, collapsed, capped, and blank clears", () => {
	expect(normalizeClipLabel("  B-roll   take  2 ")).toBe("B-roll take 2");
	expect(normalizeClipLabel("   ")).toBeUndefined();
	expect(normalizeClipLabel("x".repeat(120))).toHaveLength(80);
});

test("label patches skip no-op edits", () => {
	expect(clipLabelPatch({ label: "Intro" }, " Intro ")).toBe(null);
	expect(clipLabelPatch({ label: "Intro" }, "Outro")).toEqual({
		label: "Outro",
	});
	expect(clipLabelPatch({ label: "Intro" }, "")).toEqual({ label: undefined });
	expect(clipLabelPatch({}, "")).toBe(null);
});

test("color patches set, change, and clear the tag", () => {
	expect(clipColorPatch({}, "teal")).toEqual({ color: "teal" });
	expect(clipColorPatch({ color: "teal" }, "teal")).toBe(null);
	expect(clipColorPatch({ color: "teal" }, undefined)).toEqual({
		color: undefined,
	});
});

test("every schema color has a swatch and a name", () => {
	expect(CLIP_COLOR_LABELS).toEqual(clipColorLabelSchema.options);
	for (const color of CLIP_COLOR_LABELS) {
		expect(CLIP_COLOR_SWATCHES[color]).toMatch(/^#[0-9a-f]{6}$/);
	}
	expect(clipColorName("purple")).toBe("Purple");
});
