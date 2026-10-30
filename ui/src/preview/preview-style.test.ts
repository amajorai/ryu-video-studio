import { describe, expect, test } from "bun:test";
import { segmentSchema } from "../../../shared/project.ts";
import { mediaLayerFixtures } from "./__fixtures__/media-layer-segments.ts";
import { mediaLayerStyle } from "./preview-style.ts";
import { segmentActiveAt } from "./stages/visibility.ts";

/**
 * Values captured by running the pre-split `MediaLayer` style formula (and the
 * pre-Wave-0 shared helpers) against `mediaLayerFixtures`. The split must not
 * change a single character.
 */
const preRefactor: Record<string, Record<string, string>> = {
	"plain clip mid-way": {
		"--studio-media-clip-path": "inset(0% 0% 0% 0% round 0%)",
		"--studio-media-opacity": "1",
		"--studio-media-transform": "translate(0%, 0%) scale(1) rotate(0deg)",
		"--studio-media-filter":
			"  brightness(1) contrast(1) saturate(1) hue-rotate(0deg)",
		"--studio-media-z-index": "1",
	},
	"inactive before start": {
		"--studio-media-clip-path": "inset(0% 0% 0% 0% round 0%)",
		"--studio-media-opacity": "0",
		"--studio-media-transform": "translate(0%, 0%) scale(1) rotate(0deg)",
		"--studio-media-filter":
			"  brightness(1) contrast(1) saturate(1) hue-rotate(0deg)",
		"--studio-media-z-index": "2",
	},
	"keyframed transform and opacity": {
		"--studio-media-clip-path": "inset(0% 0% 0% 0% round 0%)",
		"--studio-media-opacity": "0.8",
		"--studio-media-transform":
			"translate(-6.25%, 9.375%) scale(1.25) rotate(67.5deg)",
		"--studio-media-filter":
			"  brightness(1) contrast(1) saturate(1) hue-rotate(0deg)",
		"--studio-media-z-index": "1",
	},
	"slide-left entry transition": {
		"--studio-media-clip-path": "inset(0% 0% 0% 0% round 0%)",
		"--studio-media-opacity": "1",
		"--studio-media-transform": "translate(85%, 0%) scale(1) rotate(0deg)",
		"--studio-media-filter":
			"  brightness(1) contrast(1) saturate(1) hue-rotate(0deg)",
		"--studio-media-z-index": "1",
	},
	"zoom-in entry with offset": {
		"--studio-media-clip-path": "inset(0% 0% 0% 0% round 0%)",
		"--studio-media-opacity": "1",
		"--studio-media-transform": "translate(0%, 0%) scale(1.3875) rotate(0deg)",
		"--studio-media-filter":
			"  brightness(1) contrast(1) saturate(1) hue-rotate(0deg)",
		"--studio-media-z-index": "1",
	},
	"crossfade entry with fades": {
		"--studio-media-clip-path": "inset(0% 0% 0% 0% round 0%)",
		"--studio-media-opacity": "0.144",
		"--studio-media-transform": "translate(0%, 0%) scale(1) rotate(0deg)",
		"--studio-media-filter":
			"  brightness(1) contrast(1) saturate(1) hue-rotate(0deg)",
		"--studio-media-z-index": "1",
	},
	"crop with rounded soft edges": {
		"--studio-media-clip-path": "inset(15% 20% 5% 10% round 25%)",
		"--studio-media-opacity": "1",
		"--studio-media-transform": "translate(0%, 0%) scale(1) rotate(0deg)",
		"--studio-media-filter":
			"  brightness(1) contrast(1) saturate(1) hue-rotate(0deg) blur(6px)",
		"--studio-media-z-index": "3",
	},
	"legacy blur with an effect stack": {
		"--studio-media-clip-path": "inset(0% 0% 0% 0% round 0%)",
		"--studio-media-opacity": "1",
		"--studio-media-transform": "translate(0%, 0%) scale(1) rotate(0deg)",
		"--studio-media-filter":
			"blur(2px) blur(1.00px) contrast(1.060) sepia(0.4) brightness(1) contrast(1) saturate(1) hue-rotate(0deg)",
		"--studio-media-z-index": "1",
	},
	"sepia with a colour grade": {
		"--studio-media-clip-path": "inset(0% 0% 0% 0% round 0%)",
		"--studio-media-opacity": "1",
		"--studio-media-transform": "translate(0%, 0%) scale(1) rotate(0deg)",
		"--studio-media-filter":
			"sepia(1)  brightness(1.4) contrast(1.3) saturate(0.84) hue-rotate(-7.5deg)",
		"--studio-media-z-index": "1",
	},
	"grayscale fading out on an upper track": {
		"--studio-media-clip-path": "inset(0% 0% 0% 0% round 0%)",
		"--studio-media-opacity": "0.5",
		"--studio-media-transform": "translate(0%, 0%) scale(1) rotate(0deg)",
		"--studio-media-filter":
			"grayscale(1)  brightness(1) contrast(1) saturate(1) hue-rotate(0deg)",
		"--studio-media-z-index": "4",
	},
};

describe("mediaLayerStyle", () => {
	for (const fixture of mediaLayerFixtures) {
		test(`matches the pre-refactor preview for ${fixture.name}`, () => {
			const segment = segmentSchema.parse(fixture.segment);
			const style = mediaLayerStyle(segment, fixture.time - segment.start, {
				active: segmentActiveAt(segment, fixture.time),
			});
			expect(style).toEqual(preRefactor[fixture.name] ?? {});
		});
	}

	test("covers ten fixtures", () => {
		expect(mediaLayerFixtures).toHaveLength(10);
		expect(Object.keys(preRefactor).sort()).toEqual(
			mediaLayerFixtures.map((fixture) => fixture.name).sort()
		);
	});

	test("is transparent when the playhead is outside the clip", () => {
		const segment = segmentSchema.parse(mediaLayerFixtures[0]?.segment);
		expect(
			mediaLayerStyle(segment, 2, { active: false })["--studio-media-opacity"]
		).toBe("0");
	});
});
