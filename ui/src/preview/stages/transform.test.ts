import { describe, expect, test } from "bun:test";
import {
	type Asset,
	newSegment,
	type Segment,
	segmentSchema,
} from "../../../../shared/project.ts";
import { clipContentSize } from "../../../../shared/transform.ts";
import { cropInsetCss } from "./crop.ts";
import { mediaObjectFit, transformCss } from "./transform.ts";

const video: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 4,
	hasAudio: false,
	height: 1080,
	id: "00000000-0000-4000-8000-000000000001",
	kind: "video",
	name: "Clip",
	width: 1920,
};

const still = { opacity: 1, scale: 1, shiftX: 0, shiftY: 0 };

function clip(patch: Partial<Segment> = {}): Segment {
	return segmentSchema.parse({ ...newSegment(video), ...patch });
}

describe("preview transform", () => {
	test("legacy clips keep the legacy transform string", () => {
		expect(transformCss(clip({ rotation: 30, scale: 1.5 }), 0, still)).toBe(
			"translate(0%, 0%) scale(1.5) rotate(30deg)"
		);
		expect(
			transformCss(clip({ fit: "fit", scaleX: 1, scaleY: 1 }), 0, still)
		).toBe("translate(0%, 0%) scale(1) rotate(0deg)");
	});
	test("flips mirror before rotation", () => {
		expect(transformCss(clip({ flipH: true, rotation: 10 }), 0, still)).toBe(
			"translate(0%, 0%) scale(1) rotate(10deg) scale(-1, 1)"
		);
		expect(transformCss(clip({ flipV: true }), 0, still)).toBe(
			"translate(0%, 0%) scale(1) rotate(0deg) scale(1, -1)"
		);
		expect(
			transformCss(clip({ flipH: true, flipV: true }), 0, still)
		).toEndWith("scale(-1)");
	});
	test("stretch scales each axis, fit stays uniform in the box", () => {
		expect(
			transformCss(clip({ fit: "stretch", scaleX: 0.5, scaleY: 2 }), 0, still)
		).toBe("translate(0%, 0%) rotate(0deg) scale(0.5, 2)");
		expect(transformCss(clip({ scaleX: 0.5, scaleY: 2 }), 0, still)).toBe(
			"translate(0%, 0%) scale(0.5) rotate(0deg)"
		);
	});
	test("scale X keyframes animate", () => {
		const animated = clip({
			fit: "stretch",
			keyframes: [
				{
					id: "00000000-0000-4000-8000-000000000002",
					property: "scaleX",
					time: 2,
					value: 3,
				},
			],
		});
		expect(transformCss(animated, 1, still)).toBe(
			"translate(0%, 0%) rotate(0deg) scale(2, 1)"
		);
	});
	test("media sizes make fill exact for portrait media", () => {
		const css = transformCss(clip({ fit: "fill" }), 0, still, {
			canvas: { height: 1080, width: 1920 },
			media: { height: 1920, width: 1080 },
		});
		const factor = Number(/scale\(([\d.]+)\)/.exec(css)?.[1]);
		expect(factor).toBeCloseTo(1920 / 607.5, 6);
	});
	test("a rotated stretch box is sized before it rotates", () => {
		expect(
			transformCss(
				clip({ fit: "stretch", rotation: 30, scaleX: 0.5 }),
				0,
				still
			)
		).toBe("translate(0%, 0%) rotate(30deg) scale(0.5, 1)");
		expect(
			transformCss(
				clip({ fit: "stretch", flipH: true, rotation: 30, scaleX: 0.5 }),
				0,
				still
			)
		).toBe("translate(0%, 0%) rotate(30deg) scale(0.5, 1) scale(-1, 1)");
	});
	test("with media sizes, fill and stretch match the render's content size", () => {
		// A 16:9 clip in a 9:16 project: contain draws it 1080x607.5.
		const sizes = {
			canvas: { height: 1920, width: 1080 },
			media: { height: 1080, width: 1920 },
		};
		const contained = { height: 607.5, width: 1080 };
		const scales = { scale: 1, scaleX: 1, scaleY: 1 };
		const crop = { bottom: 0, left: 0, right: 0, top: 0 };
		const parse = (css: string) => {
			const match = /scale\(([\d.]+)(?:, ([\d.]+))?\)/.exec(css);
			const x = Number(match?.[1]);
			return { x, y: match?.[2] === undefined ? x : Number(match[2]) };
		};
		const stretch = parse(
			transformCss(clip({ fit: "stretch" }), 0, still, sizes)
		);
		const stretched = clipContentSize(
			{ crop, fit: "stretch" },
			sizes.media,
			sizes.canvas,
			scales
		);
		expect(contained.width * stretch.x).toBeCloseTo(stretched.width, 6);
		expect(contained.height * stretch.y).toBeCloseTo(stretched.height, 6);
		// Fill covers the 1080x1920 canvas: the height reaches 1920.
		const fill = parse(transformCss(clip({ fit: "fill" }), 0, still, sizes));
		expect(contained.height * fill.y).toBeCloseTo(1920, 6);
		expect(contained.width * fill.x).toBeGreaterThanOrEqual(1080);
	});
	test("object-fit follows the mode", () => {
		expect(mediaObjectFit(clip())).toBe("contain");
		expect(mediaObjectFit(clip({ fit: "fill" }))).toBe("cover");
		expect(mediaObjectFit(clip({ fit: "stretch" }))).toBe("fill");
	});

	test("a static crop re-fits the kept window like the render (reframe)", () => {
		// A 16:9 source reframed into a 9:16 canvas: the band keeps 43% of
		// the width, filled into a box 1.362 canvas widths wide.
		const media = {
			canvas: { height: 1920, width: 1080 },
			media: { height: 1080, width: 1920 },
		};
		const crop = { bottom: 0, left: 0.222_814, right: 0.346_231, top: 0 };
		const segment = clip({ crop, fit: "fill", scaleX: 1.362_031 });
		const css = transformCss(segment, 0, still, media);
		const match =
			/^translate\(0%, 0%\) rotate\(0deg\) scale\(([\d.]+), ([\d.]+)\) translate\((-?[\d.]+)%, (-?[\d.]+)%\)$/.exec(
				css
			);
		expect(match).not.toBeNull();
		const [zoomX, zoomY, centreX] = [1, 2, 3].map((index) =>
			Number(match?.[index])
		);
		// The contained picture is the full element width; the kept window
		// (0.431 of it) is drawn 1.362 canvas widths wide and full height.
		const kept = 1 - crop.left - crop.right;
		expect((zoomX ?? 0) * kept).toBeGreaterThanOrEqual(1.362);
		expect((zoomX ?? 0) * kept).toBeLessThan(1.364);
		expect((zoomY ?? 0) * (1080 * (1080 / 1920))).toBeGreaterThanOrEqual(
			1919.9
		);
		expect(zoomX).toBeCloseTo(zoomY ?? 0, 6);
		// The window centre (left of the picture centre) moves to the middle.
		expect(centreX).toBeCloseTo(((crop.right - crop.left) * 100) / 2, 4);
		// The inset is measured on the contained picture, not the element.
		expect(cropInsetCss(segment, 0, media)).toBe(
			`${(1 - 0.316_406_25) * 50}% 34.6231% ${(1 - 0.316_406_25) * 50}% 22.2814%`
		);
		// Without sizes the legacy approximation stays.
		expect(transformCss(segment, 0, still)).not.toContain("translate(-");
	});

	test("animated crop edges only hide the clip and never re-fit", () => {
		const media = {
			canvas: { height: 1080, width: 1920 },
			media: { height: 1080, width: 1920 },
		};
		const segment = clip({
			crop: { bottom: 0, left: 0.2, right: 0, top: 0 },
			keyframes: [
				{
					id: "00000000-0000-4000-8000-000000000031",
					property: "cropLeft",
					time: 0,
					value: 0.1,
				},
				{
					id: "00000000-0000-4000-8000-000000000032",
					property: "cropLeft",
					time: 1,
					value: 0.3,
				},
			],
		});
		expect(transformCss(segment, 0.5, still, media)).toBe(
			"translate(0%, 0%) scale(1) rotate(0deg)"
		);
	});
});
