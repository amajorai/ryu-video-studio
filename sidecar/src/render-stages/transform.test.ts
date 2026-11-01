import { describe, expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
	segmentSchema,
} from "../../../shared/project.ts";
import { segmentVideoFilters } from "../render-segment-video.ts";
import { flipFilters } from "./flip.ts";
import {
	boxBeforeRotation,
	fillCropFilter,
	maxContentSize,
	padFilter,
	rotateFilter,
	scaledSize,
	scaleFilters,
} from "./transform.ts";
import type { RenderStageContext } from "./types.ts";

const video: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 4,
	hasAudio: false,
	height: 360,
	id: "00000000-0000-4000-8000-000000000001",
	kind: "video",
	name: "Clip",
	width: 640,
};

const context: RenderStageContext = {
	inputIndex: (offset) => 10 + offset,
	lutPath: (id) => `/luts/${id}.cube`,
	mediaPath: (id) => `/media/${id}`,
};

function fixture(patch: Partial<Segment> = {}): { p: Project; s: Segment } {
	const p = newProject("Transform");
	const s = segmentSchema.parse({ ...newSegment(video), ...patch });
	p.segments = [s];
	return { p, s };
}

const LEGACY_SCALE =
	"scale='2*max(1,round(1920*(1)/2))*1':'2*max(1,round(1080*(1)/2))*1':force_original_aspect_ratio=decrease:eval=frame";

describe("flip", () => {
	test("adds a filter only for the flipped axes", () => {
		expect(flipFilters(fixture().s)).toEqual([]);
		expect(flipFilters(fixture({ flipH: false, flipV: false }).s)).toEqual([]);
		expect(flipFilters(fixture({ flipH: true }).s)).toEqual(["hflip"]);
		expect(flipFilters(fixture({ flipV: true }).s)).toEqual(["vflip"]);
		expect(flipFilters(fixture({ flipH: true, flipV: true }).s)).toEqual([
			"hflip",
			"vflip",
		]);
	});
	test("flips run after the crop and before rotation", () => {
		const { p, s } = fixture({ flipH: true, rotation: 10 });
		const [chain] = segmentVideoFilters({
			base: "base",
			context,
			length: 4,
			n: 1,
			p,
			s,
			visualize: false,
		}).filters;
		expect(chain).toContain("null,hflip,");
		expect(chain?.indexOf("hflip")).toBeLessThan(
			chain?.indexOf("rotate=") ?? -1
		);
	});
});

describe("scale X/Y and fit", () => {
	test("legacy clips keep the legacy scale, pad and no fill crop", () => {
		const { p, s } = fixture({ fit: "fit", scaleX: 1, scaleY: 1 });
		expect(scaleFilters(s, p, "1")).toEqual([LEGACY_SCALE, "setsar=1"]);
		expect(padFilter(s, p)).toBe(
			"pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black@0:eval=frame"
		);
	});
	test("scale X/Y multiply the box and keyframes animate it", () => {
		const { p, s } = fixture({ scaleX: 0.5, scaleY: 2 });
		expect(scaledSize(s, p)).toEqual({
			h: "2*max(1,round(1080*(1)*(2)/2))",
			w: "2*max(1,round(1920*(1)*(0.5)/2))",
		});
		const animated = fixture({
			keyframes: [
				{
					id: "00000000-0000-4000-8000-000000000002",
					property: "scaleX",
					time: 0,
					value: 1,
				},
				{
					id: "00000000-0000-4000-8000-000000000003",
					property: "scaleX",
					time: 2,
					value: 3,
				},
			],
		});
		const size = scaledSize(animated.s, animated.p);
		expect(size.w).toBe(
			"2*max(1,round(1920*(1)*(if(lt(t,2),1+(2)*max(0,(t-0))/2,3))/2))"
		);
		expect(size.h).toBe("2*max(1,round(1080*(1)*(1)/2))");
		expect(padFilter(animated.s, animated.p)).toBe(
			"pad=5760:1080:(ow-iw)/2:(oh-ih)/2:color=black@0:eval=frame"
		);
		expect(padFilter(s, p)).toBe(
			"pad=1920:2160:(ow-iw)/2:(oh-ih)/2:color=black@0:eval=frame"
		);
	});
	test("fit keeps the aspect inside a non-uniform box", () => {
		const { p, s } = fixture({ scaleX: 0.5 });
		expect(scaleFilters(s, p, "1")[0]).toEndWith(
			":force_original_aspect_ratio=decrease:eval=frame"
		);
	});
	test("stretch disables the aspect lock", () => {
		const { p, s } = fixture({ fit: "stretch" });
		expect(scaleFilters(s, p, "1")).toEqual([
			LEGACY_SCALE.replace("=decrease", "=disable"),
			"setsar=1",
		]);
	});
	test("fill crops to the box aspect before scaling to the box", () => {
		const { p, s } = fixture({ fit: "fill" });
		expect(scaleFilters(s, p, "1")).toEqual([
			"crop=w='min(iw,ih*1.777778)':h='min(ih,iw/1.777778)'",
			LEGACY_SCALE.replace("=decrease", "=disable"),
			"setsar=1",
		]);
		// A 9:16 project: a 16:9 clip keeps a centred 9:16 column.
		const vertical: Project = { ...p, height: 1920, width: 1080 };
		expect(fillCropFilter(s, vertical)).toBe(
			"crop=w='min(iw,ih*0.5625)':h='min(ih,iw/0.5625)'"
		);
		// The box aspect includes scale X/Y.
		const cell = fixture({ fit: "fill", scaleX: 0.3 });
		expect(fillCropFilter(cell.s, cell.p)).toBe(
			"crop=w='min(iw,ih*0.533333)':h='min(ih,iw/0.533333)'"
		);
	});

	test("fill with a keyframed box covers it instead of distorting", () => {
		const { p, s } = fixture({
			fit: "fill",
			keyframes: [
				{
					id: "00000000-0000-4000-8000-000000000004",
					property: "scaleX",
					time: 0,
					value: 0.5,
				},
				{
					id: "00000000-0000-4000-8000-000000000005",
					property: "scaleX",
					time: 2,
					value: 2,
				},
			],
		});
		const [crop, scale] = scaleFilters(s, p, "1");
		// The crop keeps the first frame's 8:9 shape ...
		expect(crop).toBe("crop=w='min(iw,ih*0.888889)':h='min(ih,iw/0.888889)'");
		// ... and the scale covers each frame's box without changing it.
		expect(scale).toEndWith(":force_original_aspect_ratio=increase:eval=frame");
		// At 2x the box is 3840x1080; covering it at 8:9 needs 4320 px high
		// (plus a 2 px rounding margin).
		expect(maxContentSize(s, p)).toEqual({ height: 4322, width: 3840 });
		expect(padFilter(s, p)).toBe(
			"pad=3840:4322:(ow-iw)/2:(oh-ih)/2:color=black@0:eval=frame"
		);
	});
});

describe("rotation order", () => {
	const chainOf = (patch: Partial<Segment>) => {
		const { p, s } = fixture(patch);
		const [chain] = segmentVideoFilters({
			base: "base",
			context,
			length: 4,
			n: 1,
			p,
			s,
			visualize: false,
		}).filters;
		return chain ?? "";
	};
	test("fit keeps the legacy rotate-then-scale order", () => {
		const { s } = fixture({ rotation: 30, scaleX: 0.5 });
		expect(boxBeforeRotation(s)).toBe(false);
		expect(rotateFilter(s)).toBe(
			"rotate=a='(30)*PI/180':ow=iw:oh=ih:fillcolor=black@0"
		);
		const chain = chainOf({ rotation: 30, scaleX: 0.5 });
		expect(chain.indexOf("rotate=")).toBeLessThan(chain.indexOf("scale="));
	});
	for (const fit of ["stretch", "fill"] as const) {
		test(`${fit} resizes the box before rotating it`, () => {
			const { p, s } = fixture({ fit, rotation: 30, scaleX: 0.5 });
			expect(rotateFilter(s)).toBe("null");
			const filters = scaleFilters(s, p, "1");
			// hypot(1920, 1080) rounded up to even: 2204.
			expect(filters.slice(-2)).toEqual([
				"pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black@0:eval=frame",
				"rotate=a='(30)*PI/180':ow=2204:oh=2204:fillcolor=black@0",
			]);
			expect(padFilter(s, p)).toBe(
				"pad=2204:2204:(ow-iw)/2:(oh-ih)/2:color=black@0:eval=frame"
			);
			const chain = chainOf({ fit, rotation: 30, scaleX: 0.5 });
			expect(chain).toContain("null,format=rgba,");
			expect(chain.indexOf("scale=")).toBeLessThan(chain.indexOf("rotate="));
		});
	}
	test("unrotated stretch adds no rotation and pads to the box", () => {
		const { p, s } = fixture({ fit: "stretch", scaleX: 0.5 });
		expect(scaleFilters(s, p, "1")).toHaveLength(2);
		expect(padFilter(s, p)).toBe(
			"pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black@0:eval=frame"
		);
	});
	test("the pad holds a zoom-out entry for clips resized first", () => {
		const { p, s } = fixture({
			entryDuration: 0.5,
			entryTransition: "zoom-out",
			fit: "stretch",
		});
		expect(padFilter(s, p)).toBe(
			"pad=2208:1242:(ow-iw)/2:(oh-ih)/2:color=black@0:eval=frame"
		);
	});
});
