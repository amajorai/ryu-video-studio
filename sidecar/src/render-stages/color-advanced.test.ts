import { describe, expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	newSegment,
	type Segment,
	segmentSchema,
} from "../../../shared/project.ts";
import type { ColorGrade } from "../../../shared/schema/color.ts";
import { segmentVideoFilters } from "../render-segment-video.ts";
import {
	advancedColorFilters,
	curvePoints,
	filterPath,
} from "./color-advanced.ts";
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
const LUT_ID = "00000000-0000-4000-8000-0000000000aa";

const context: RenderStageContext = {
	inputIndex: (offset) => 10 + offset,
	lutPath: (id) => `/store/luts/${id}.cube`,
	mediaPath: (id) => `/media/${id}`,
};

function graded(grade: Partial<ColorGrade>): Segment {
	const segment = newSegment(video);
	return segmentSchema.parse({
		...segment,
		colorGrade: { ...segment.colorGrade, ...grade },
	});
}

describe("advanced color filters", () => {
	test("a neutral grade adds nothing", () => {
		expect(advancedColorFilters(newSegment(video), context)).toEqual([]);
		expect(
			advancedColorFilters(
				graded({
					blacks: 0,
					curves: {
						master: [
							{ x: 0, y: 0 },
							{ x: 1, y: 1 },
						],
					},
					hueVsSat: [],
					lift: { b: 0, g: 0, master: 0, r: 0 },
					lut: { intensity: 0, lutId: LUT_ID },
					whites: 0,
				}),
				context
			)
		).toEqual([]);
	});

	test("whites and blacks become colorlevels", () => {
		expect(
			advancedColorFilters(graded({ blacks: 0.4, whites: -0.4 }), context)
		).toEqual([
			"colorlevels=rimin=0.1:gimin=0.1:bimin=0.1:rimax=1:gimax=1:bimax=1:romin=0:gomin=0:bomin=0:romax=0.9:gomax=0.9:bomax=0.9",
		]);
		expect(
			advancedColorFilters(graded({ blacks: -0.4, whites: 0.4 }), context)
		).toEqual([
			"colorlevels=rimin=0:gimin=0:bimin=0:rimax=0.9:gimax=0.9:bimax=0.9:romin=0.1:gomin=0.1:bomin=0.1:romax=1:gomax=1:bomax=1",
		]);
	});

	test("shadows and highlights become a PCHIP master curve", () => {
		expect(
			advancedColorFilters(graded({ highlights: -1, shadows: 1 }), context)
		).toEqual(["curves=interp=pchip:master='0/0 0.25/0.375 0.75/0.625 1/1'"]);
	});

	test("wheels become colorbalance shadows, midtones and highlights", () => {
		expect(
			advancedColorFilters(
				graded({
					gain: { b: 0, g: 0, master: 0.2, r: 0 },
					lift: { b: 0.4, g: 0, master: 0, r: -0.2 },
				}),
				context
			)
		).toEqual([
			"colorbalance=rs=-0.1:gs=0:bs=0.2:rm=0:gm=0:bm=0:rh=0.1:gh=0.1:bh=0.1",
		]);
	});

	test("curves emit one filter with every non-identity channel", () => {
		const invert = [
			{ x: 0, y: 1 },
			{ x: 1, y: 0 },
		];
		expect(
			advancedColorFilters(
				graded({
					curves: {
						blue: [
							{ x: 0, y: 0 },
							{ x: 1, y: 1 },
						],
						master: invert,
						red: [
							{ x: 0, y: 0.1 },
							{ x: 0.5, y: 0.6 },
							{ x: 1, y: 1 },
						],
					},
				}),
				context
			)
		).toEqual(["curves=interp=pchip:master='0/1 1/0':red='0/0.1 0.5/0.6 1/1'"]);
	});

	test("HSL bands and hue-vs-sat become grouped huesaturation filters", () => {
		expect(
			advancedColorFilters(
				graded({
					hsl: [
						{ band: "orange", hue: 0.5, lightness: 0, saturation: 0.4 },
						{ band: "aqua", hue: 0, lightness: -1, saturation: 0 },
					],
				}),
				context
			)
		).toEqual([
			"huesaturation=hue=7.5:saturation=0.2:intensity=0:colors=r+y:strength=1",
			"huesaturation=hue=0:saturation=0:intensity=-0.5:colors=c:strength=1",
		]);
		expect(
			advancedColorFilters(graded({ hueVsSat: [{ x: 0, y: 0 }] }), context)
		).toEqual([
			"huesaturation=hue=0:saturation=-1:intensity=0:colors=r+y+g+c+b+m:strength=100",
		]);
	});

	test("a full-strength LUT is one lut3d filter", () => {
		expect(
			advancedColorFilters(
				graded({ lut: { intensity: 1, lutId: LUT_ID } }),
				context
			)
		).toEqual([`lut3d=file=/store/luts/${LUT_ID}.cube:interp=tetrahedral`]);
	});

	test("a partial LUT forks and blends inside the chain", () => {
		const segment = graded({ lut: { intensity: 0.25, lutId: LUT_ID } });
		const tag = `lut${segment.id.replaceAll("-", "")}`;
		expect(advancedColorFilters(segment, context)).toEqual([
			`split[${tag}o][${tag}i];[${tag}i]lut3d=file=/store/luts/${LUT_ID}.cube:interp=tetrahedral[${tag}g];[${tag}g][${tag}o]blend=all_mode=normal:all_opacity=0.25`,
		]);
	});

	test("filters keep the documented order", () => {
		const filters = advancedColorFilters(
			graded({
				blacks: 0.2,
				curves: {
					master: [
						{ x: 0, y: 1 },
						{ x: 1, y: 0 },
					],
				},
				hsl: [{ band: "red", hue: 0, lightness: 0, saturation: -1 }],
				lift: { b: 0.1, g: 0, master: 0, r: 0 },
				lut: { intensity: 1, lutId: LUT_ID },
				shadows: 0.5,
			}),
			context
		);
		expect(filters.map((filter) => filter.split("=")[0])).toEqual([
			"colorlevels",
			"curves",
			"colorbalance",
			"curves",
			"huesaturation",
			"lut3d",
		]);
	});

	test("the clip chain stays one well-formed statement per fork", () => {
		const p = newProject("Grade");
		const s = graded({ lut: { intensity: 0.5, lutId: LUT_ID } });
		p.segments = [s];
		const output = segmentVideoFilters({
			base: "base",
			context,
			length: 4,
			n: 1,
			p,
			s,
			visualize: false,
		});
		const graph = output.filters.join(";");
		const tag = `lut${s.id.replaceAll("-", "")}`;
		expect(graph).toContain(`split[${tag}o][${tag}i];[${tag}i]lut3d=`);
		expect(graph).toContain(
			`[${tag}g][${tag}o]blend=all_mode=normal:all_opacity=0.5,`
		);
		expect(graph.startsWith("[1:v]setpts=")).toBe(true);
	});
});

test("curve points format as x/y pairs", () => {
	expect(
		curvePoints([
			{ x: 0, y: 0.123_456_7 },
			{ x: 1, y: 1 },
		])
	).toBe("0/0.123457 1/1");
});

test("filter paths escape option and graph separators", () => {
	expect(filterPath("/plain/path.cube")).toBe("/plain/path.cube");
	expect(filterPath("C:\\luts\\a b.cube")).toBe(
		"C\\\\:\\\\\\\\luts\\\\\\\\a b.cube"
	);
	expect(filterPath("/x/it's[1],v;2.cube")).toBe(
		"/x/it\\\\\\'s\\[1\\]\\,v\\;2.cube"
	);
});
