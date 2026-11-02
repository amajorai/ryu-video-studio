import { describe, expect, test } from "bun:test";
import {
	DEFAULT_TIMELINE_COLORS,
	mediaClipKind,
	normalizeHexColor,
	overlayClipKind,
	resolveTimelineColors,
	TIMELINE_CLIP_KIND_LABELS,
	TIMELINE_CLIP_KINDS,
	timelineColorOverridesSchema,
	timelineColorVariables,
	withTimelineColor,
} from "./timeline-colors.ts";

describe("timeline clip colors", () => {
	test("every kind has a valid default and a label", () => {
		for (const kind of TIMELINE_CLIP_KINDS) {
			expect(normalizeHexColor(DEFAULT_TIMELINE_COLORS[kind])).toBe(
				DEFAULT_TIMELINE_COLORS[kind]
			);
			expect(TIMELINE_CLIP_KIND_LABELS[kind].length).toBeGreaterThan(0);
		}
	});

	test("normalizes hex colors and rejects others", () => {
		expect(normalizeHexColor(" #ABCDEF ")).toBe("#abcdef");
		expect(normalizeHexColor("#f0a")).toBe("#ff00aa");
		expect(normalizeHexColor("red")).toBeNull();
		expect(normalizeHexColor("#12345")).toBeNull();
		expect(normalizeHexColor("url(x)")).toBeNull();
	});

	test("stored overrides drop unknown kinds, bad colors and defaults", () => {
		const parsed = timelineColorOverridesSchema.parse({
			audio: "#FF0000",
			bogus: "#00ff00",
			image: "not a color",
			video: DEFAULT_TIMELINE_COLORS.video,
		});
		expect(parsed).toEqual({ audio: "#ff0000" });
		expect(timelineColorOverridesSchema.safeParse("x").success).toBe(false);
	});

	test("setting a color stores only real changes", () => {
		const changed = withTimelineColor({}, "title", "#112233");
		expect(changed).toEqual({ title: "#112233" });
		expect(
			withTimelineColor(changed, "title", DEFAULT_TIMELINE_COLORS.title)
		).toEqual({});
		expect(withTimelineColor(changed, "title", "nope")).toEqual({});
	});

	test("resolves colors and CSS variables with overrides over defaults", () => {
		const overrides = { caption: "#000000" };
		expect(resolveTimelineColors(overrides).caption).toBe("#000000");
		expect(resolveTimelineColors(overrides).video).toBe(
			DEFAULT_TIMELINE_COLORS.video
		);
		const variables = timelineColorVariables(overrides);
		expect(variables["--studio-clip-kind-caption"]).toBe("#000000");
		expect(Object.keys(variables)).toHaveLength(TIMELINE_CLIP_KINDS.length);
	});

	test("maps media and overlay kinds", () => {
		expect(mediaClipKind("audio")).toBe("audio");
		expect(mediaClipKind(undefined)).toBe("video");
		expect(overlayClipKind("adjustmentLayers")).toBe("adjustment");
		expect(overlayClipKind("captions")).toBe("caption");
		expect(overlayClipKind("titles")).toBe("title");
		expect(overlayClipKind("graphics")).toBe("graphic");
		expect(overlayClipKind("avatars")).toBe("avatar");
	});
});
