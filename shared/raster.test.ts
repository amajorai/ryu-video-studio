import { describe, expect, test } from "bun:test";
import {
	type AlphaRaster,
	alphaArea,
	alphaToRgba,
	combineAlpha,
	contourArea,
	contoursToSvgPath,
	flattenPath,
	heartPath,
	hexColor,
	invertAlpha,
	MAX_RASTER_EDGE,
	MAX_RASTER_VERTICES,
	MAX_SHAPE_SIDES,
	type RasterPathPoint,
	type RasterShape,
	rasterizeContours,
	rasterizeShape,
	rotateContour,
	scaleAlpha,
	shapeContours,
	strokeContour,
} from "./raster.ts";

const SIZE = 400;

function pixel(mask: AlphaRaster, x: number, y: number): number {
	return mask.data[y * mask.width + x] ?? -1;
}

/** Relative error of a covered area against its analytic value. */
function areaError(actual: number, expected: number): number {
	return Math.abs(actual - expected) / expected;
}

describe("area coverage of known shapes", () => {
	test("an axis-aligned rectangle is exact", () => {
		const mask = rasterizeShape(
			{
				cx: 200,
				cy: 200,
				height: 100,
				kind: "rounded-rect",
				radius: 0,
				width: 200,
			},
			SIZE,
			SIZE
		);
		expect(alphaArea(mask)).toBe(20_000);
		expect(pixel(mask, 100, 150)).toBe(255);
		expect(pixel(mask, 99, 150)).toBe(0);
	});

	test("a fractional rectangle edge is partially covered", () => {
		const mask = rasterizeContours(
			[
				[
					{ x: 10, y: 10 },
					{ x: 20.5, y: 10 },
					{ x: 20.5, y: 20 },
					{ x: 10, y: 20 },
				],
			],
			32,
			32
		);
		expect(pixel(mask, 20, 15)).toBe(128);
		expect(alphaArea(mask)).toBeCloseTo(105, 0);
	});

	test("ellipse matches pi * a * b", () => {
		const mask = rasterizeShape(
			{ cx: 200, cy: 200, kind: "ellipse", rx: 150, ry: 80 },
			SIZE,
			SIZE
		);
		expect(areaError(alphaArea(mask), Math.PI * 150 * 80)).toBeLessThan(0.01);
	});

	test("a radius-10 circle stays within 2%", () => {
		const mask = rasterizeShape(
			{ cx: 16, cy: 16, kind: "ellipse", rx: 10, ry: 10 },
			32,
			32
		);
		expect(areaError(alphaArea(mask), Math.PI * 100)).toBeLessThan(0.02);
	});

	test("rounded rectangle loses (4 - pi) r^2 at the corners", () => {
		const mask = rasterizeShape(
			{
				cx: 200,
				cy: 200,
				height: 160,
				kind: "rounded-rect",
				radius: 40,
				width: 300,
			},
			SIZE,
			SIZE
		);
		expect(
			areaError(alphaArea(mask), 300 * 160 - (4 - Math.PI) * 40 * 40)
		).toBeLessThan(0.01);
	});

	test("the corner radius clamps to half the shorter side", () => {
		const mask = rasterizeShape(
			{
				cx: 200,
				cy: 200,
				height: 100,
				kind: "rounded-rect",
				radius: 999,
				width: 100,
			},
			SIZE,
			SIZE
		);
		expect(areaError(alphaArea(mask), Math.PI * 50 * 50)).toBeLessThan(0.01);
	});

	test("regular polygon matches n/2 r^2 sin(2 pi / n)", () => {
		for (const sides of [3, 5, 6, 12]) {
			const mask = rasterizeShape(
				{ cx: 200, cy: 200, kind: "regular-polygon", rx: 150, ry: 150, sides },
				SIZE,
				SIZE
			);
			expect(
				areaError(
					alphaArea(mask),
					(sides / 2) * 150 * 150 * Math.sin((2 * Math.PI) / sides)
				)
			).toBeLessThan(0.01);
		}
	});

	test("star matches n R r sin(pi / n)", () => {
		const mask = rasterizeShape(
			{
				cx: 200,
				cy: 200,
				innerRadius: 0.5,
				kind: "star",
				points: 5,
				rx: 160,
				ry: 160,
			},
			SIZE,
			SIZE
		);
		expect(
			areaError(alphaArea(mask), 5 * 160 * 80 * Math.sin(Math.PI / 5))
		).toBeLessThan(0.01);
		// A tip is covered; the notch between two tips is not.
		expect(pixel(mask, 200, 45)).toBe(255);
		expect(pixel(mask, 200, 330)).toBe(0);
	});

	test("heart covers its flattened outline's area", () => {
		const contours = shapeContours({
			cx: 200,
			cy: 200,
			height: 300,
			kind: "heart",
			width: 300,
		});
		const mask = rasterizeContours(contours, SIZE, SIZE);
		const outline = Math.abs(contourArea(contours[0] ?? []));
		expect(areaError(alphaArea(mask), outline)).toBeLessThan(0.01);
		// Lobes on top, the tip at the bottom, a dip between the lobes.
		expect(pixel(mask, 140, 70)).toBe(255);
		expect(pixel(mask, 200, 340)).toBe(255);
		expect(pixel(mask, 200, 80)).toBe(0);
		expect(pixel(mask, 60, 330)).toBe(0);
	});

	test("a four-segment Bezier circle matches pi r^2", () => {
		const r = 120;
		const k = 0.552_284_75 * r;
		const points = [
			{ inX: 200 - k, inY: 80, outX: 200 + k, outY: 80, x: 200, y: 80 },
			{ inX: 320, inY: 200 - k, outX: 320, outY: 200 + k, x: 320, y: 200 },
			{ inX: 200 + k, inY: 320, outX: 200 - k, outY: 320, x: 200, y: 320 },
			{ inX: 80, inY: 200 + k, outX: 80, outY: 200 - k, x: 80, y: 200 },
		];
		const mask = rasterizeShape({ kind: "path", points }, SIZE, SIZE);
		expect(areaError(alphaArea(mask), Math.PI * r * r)).toBeLessThan(0.01);
	});

	test("a path without handles is a straight-edged polygon", () => {
		const points = [
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 0, y: 100 },
		];
		expect(flattenPath(points)).toEqual(points);
		const mask = rasterizeShape({ kind: "path", points }, 128, 128);
		expect(areaError(alphaArea(mask), 5000)).toBeLessThan(0.01);
	});

	test("rotation preserves area", () => {
		const shape: RasterShape = {
			cx: 200,
			cy: 200,
			height: 120,
			kind: "rounded-rect",
			radius: 10,
			rotation: 33,
			width: 220,
		};
		expect(
			areaError(
				alphaArea(rasterizeShape(shape, SIZE, SIZE)),
				alphaArea(rasterizeShape({ ...shape, rotation: 0 }, SIZE, SIZE))
			)
		).toBeLessThan(0.005);
	});
});

describe("fill rules, clipping and determinism", () => {
	const outer = [
		{ x: 50, y: 50 },
		{ x: 350, y: 50 },
		{ x: 350, y: 350 },
		{ x: 50, y: 350 },
	];
	const innerSameDirection = [
		{ x: 150, y: 150 },
		{ x: 250, y: 150 },
		{ x: 250, y: 250 },
		{ x: 150, y: 250 },
	];

	test("evenodd punches a hole; nonzero fills it", () => {
		const evenOdd = rasterizeContours([outer, innerSameDirection], SIZE, SIZE, {
			fillRule: "evenodd",
		});
		const nonZero = rasterizeContours([outer, innerSameDirection], SIZE, SIZE);
		expect(alphaArea(evenOdd)).toBe(300 * 300 - 100 * 100);
		expect(alphaArea(nonZero)).toBe(300 * 300);
		expect(pixel(evenOdd, 200, 200)).toBe(0);
		expect(pixel(nonZero, 200, 200)).toBe(255);
	});

	test("an opposite-direction inner contour is a hole under nonzero", () => {
		const hole = [...innerSameDirection].reverse();
		const mask = rasterizeContours([outer, hole], SIZE, SIZE);
		expect(alphaArea(mask)).toBe(300 * 300 - 100 * 100);
	});

	test("geometry outside the raster is clipped", () => {
		const mask = rasterizeShape(
			{
				cx: 0,
				cy: 0,
				height: 100,
				kind: "rounded-rect",
				radius: 0,
				width: 100,
			},
			64,
			64
		);
		expect(alphaArea(mask)).toBe(2500);
		const offscreen = rasterizeShape(
			{ cx: -500, cy: -500, kind: "ellipse", rx: 10, ry: 10 },
			64,
			64
		);
		expect(alphaArea(offscreen)).toBe(0);
	});

	test("rasterizing twice gives identical bytes", () => {
		const shape: RasterShape = {
			cx: 123.4,
			cy: 87.6,
			kind: "heart",
			height: 90,
			rotation: 17,
			width: 110,
		};
		const first = rasterizeShape(shape, 256, 192);
		const second = rasterizeShape(shape, 256, 192);
		expect(Buffer.from(first.data).equals(Buffer.from(second.data))).toBe(true);
	});

	test("degenerate contours are empty", () => {
		expect(alphaArea(rasterizeContours([], 8, 8))).toBe(0);
		expect(
			alphaArea(
				rasterizeContours(
					[
						[
							{ x: 1, y: 1 },
							{ x: 7, y: 1 },
						],
					],
					8,
					8
				)
			)
		).toBe(0);
	});

	test("invalid sizes and coordinates are rejected", () => {
		expect(() => rasterizeContours([], 0, 8)).toThrow(RangeError);
		expect(() => rasterizeContours([], 8.5, 8)).toThrow(RangeError);
		expect(() => rasterizeContours([], MAX_RASTER_EDGE + 1, 1)).toThrow(
			RangeError
		);
		expect(() =>
			rasterizeContours([], MAX_RASTER_EDGE, MAX_RASTER_EDGE)
		).toThrow(RangeError);
		expect(() =>
			rasterizeShape(
				{ cx: Number.NaN, cy: 0, kind: "ellipse", rx: 1, ry: 1 },
				8,
				8
			)
		).toThrow(RangeError);
		expect(() =>
			rasterizeShape(
				{ cx: 0, cy: 0, kind: "regular-polygon", rx: 1, ry: 1, sides: 2 },
				8,
				8
			)
		).toThrow(RangeError);
		expect(() =>
			rasterizeContours(
				[
					[
						{ x: 0, y: 0 },
						{ x: Number.POSITIVE_INFINITY, y: 4 },
						{ x: 0, y: 4 },
					],
				],
				8,
				8
			)
		).toThrow(RangeError);
	});

	test("finite vertices whose edge extent overflows are rejected", () => {
		// |dx| exceeds Number.MAX_VALUE: the slope would be Infinity and every
		// crossing NaN, silently producing an empty mask.
		expect(() =>
			rasterizeContours(
				[
					[
						{ x: -1e308, y: 0 },
						{ x: 1e308, y: 10 },
						{ x: 1e308, y: 20 },
						{ x: -1e308, y: 20 },
					],
				],
				10,
				30
			)
		).toThrow(RangeError);
		// |dy| overflow would otherwise collapse the slope to 0.
		expect(() =>
			rasterizeContours(
				[
					[
						{ x: 0, y: -1e308 },
						{ x: 5, y: 1e308 },
						{ x: 10, y: 1e308 },
					],
				],
				10,
				10
			)
		).toThrow(RangeError);
		// Large but representable geometry still rasterizes normally.
		const huge = rasterizeContours(
			[
				[
					{ x: -1e300, y: -1e300 },
					{ x: 1e300, y: -1e300 },
					{ x: 1e300, y: 1e300 },
					{ x: -1e300, y: 1e300 },
				],
			],
			10,
			10
		);
		expect(alphaArea(huge)).toBeCloseTo(100, 6);
	});
});

/**
 * Runs `build` and returns how long it took to throw a RangeError, in
 * milliseconds, or Infinity when it returned or threw anything else.
 */
function msToThrow(build: () => unknown): number {
	const started = performance.now();
	try {
		build();
	} catch (error) {
		return error instanceof RangeError
			? performance.now() - started
			: Number.POSITIVE_INFINITY;
	}
	return Number.POSITIVE_INFINITY;
}

describe("oversized geometry is rejected before it is built", () => {
	test("side and tip counts are capped", () => {
		const polygon = (sides: number): RasterShape => ({
			cx: 8,
			cy: 8,
			kind: "regular-polygon",
			rx: 4,
			ry: 4,
			sides,
		});
		const star = (points: number): RasterShape => ({
			cx: 8,
			cy: 8,
			innerRadius: 0.5,
			kind: "star",
			points,
			rx: 4,
			ry: 4,
		});
		expect(shapeContours(polygon(MAX_SHAPE_SIDES))[0]).toHaveLength(
			MAX_SHAPE_SIDES
		);
		expect(shapeContours(star(MAX_SHAPE_SIDES))[0]).toHaveLength(
			MAX_SHAPE_SIDES * 2
		);
		expect(() => shapeContours(polygon(MAX_SHAPE_SIDES + 1))).toThrow(
			RangeError
		);
		expect(() => shapeContours(star(1))).toThrow(RangeError);
		expect(
			msToThrow(() => rasterizeShape(star(5_000_000), 16, 16))
		).toBeLessThan(50);
		expect(msToThrow(() => rasterizeShape(star(1e9), 16, 16))).toBeLessThan(50);
		expect(msToThrow(() => rasterizeShape(polygon(1e9), 16, 16))).toBeLessThan(
			50
		);
	});

	test("path and polygon point counts are capped before flattening", () => {
		const straight = Array.from(
			{ length: MAX_RASTER_VERTICES + 1 },
			(_, index): RasterPathPoint => ({ x: index % 7, y: index % 5 })
		);
		expect(msToThrow(() => flattenPath(straight))).toBeLessThan(50);
		expect(
			msToThrow(() => shapeContours({ kind: "polygon", points: straight }))
		).toBeLessThan(50);
	});

	test("curved paths stop once the running vertex budget is spent", () => {
		// 20,000 segments with huge handles each want ~1,024 chords (~20M
		// vertices); the running budget throws once ~1M would be exceeded.
		const curvy = Array.from(
			{ length: 20_000 },
			(_, index): RasterPathPoint => ({
				inX: index * 10 - 1e6,
				inY: 1e6,
				outX: index * 10 + 1e6,
				outY: -1e6,
				x: index * 10,
				y: 0,
			})
		);
		expect(msToThrow(() => flattenPath(curvy))).toBeLessThan(1000);
	});

	test("strokes size their output before allocating it", () => {
		const contour = Array.from({ length: 3000 }, (_, index) => ({
			x: index,
			y: index % 2,
		}));
		expect(msToThrow(() => strokeContour(contour, 1e6))).toBeLessThan(50);
		// A normal stroke of the same contour still succeeds.
		expect(strokeContour(contour, 2).length).toBe(3000 * 2);
	});
});

describe("geometry helpers", () => {
	test("contour area is positive clockwise on screen", () => {
		const square = [
			{ x: 0, y: 0 },
			{ x: 2, y: 0 },
			{ x: 2, y: 2 },
			{ x: 0, y: 2 },
		];
		expect(contourArea(square)).toBe(4);
		expect(contourArea([...square].reverse())).toBe(-4);
	});

	test("rotation turns clockwise on screen", () => {
		const [point] = rotateContour([{ x: 10, y: 0 }], 0, 0, 90);
		expect(point?.x).toBeCloseTo(0, 10);
		expect(point?.y).toBeCloseTo(10, 10);
	});

	test("shapes start at the top and run clockwise", () => {
		for (const shape of [
			{ cx: 0, cy: 0, kind: "ellipse", rx: 10, ry: 10 },
			{ cx: 0, cy: 0, kind: "regular-polygon", rx: 10, ry: 10, sides: 5 },
			{
				cx: 0,
				cy: 0,
				innerRadius: 0.4,
				kind: "star",
				points: 5,
				rx: 10,
				ry: 10,
			},
			{ cx: 0, cy: 0, height: 10, kind: "heart", width: 10 },
			{ cx: 0, cy: 0, height: 10, kind: "rounded-rect", radius: 2, width: 10 },
		] satisfies RasterShape[]) {
			const [contour] = shapeContours(shape);
			expect(contourArea(contour ?? [])).toBeGreaterThan(0);
		}
		const [polygon] = shapeContours({
			cx: 0,
			cy: 0,
			kind: "regular-polygon",
			rx: 10,
			ry: 10,
			sides: 4,
		});
		expect(polygon?.[0]?.x).toBeCloseTo(0, 10);
		expect(polygon?.[0]?.y).toBeCloseTo(-10, 10);
	});

	test("heart path fills its box", () => {
		const path = heartPath(50, 50, 100, 80);
		const xs = flattenPath(path).map((point) => point.x);
		const ys = flattenPath(path).map((point) => point.y);
		expect(Math.min(...xs)).toBeCloseTo(0, 1);
		expect(Math.max(...xs)).toBeCloseTo(100, 1);
		expect(Math.min(...ys)).toBeCloseTo(10, 1);
		expect(Math.max(...ys)).toBeCloseTo(90, 1);
	});

	test("SVG path data mirrors the contours", () => {
		expect(
			contoursToSvgPath([
				[
					{ x: 0, y: 0 },
					{ x: 1.234_56, y: -0.0001 },
					{ x: 1, y: 2 },
				],
			])
		).toBe("M0 0L1.235 0L1 2Z");
	});
});

describe("strokes", () => {
	test("a closed stroke band covers perimeter times width", () => {
		const square = [
			{ x: 100, y: 100 },
			{ x: 300, y: 100 },
			{ x: 300, y: 300 },
			{ x: 100, y: 300 },
		];
		const mask = rasterizeContours(strokeContour(square, 10), SIZE, SIZE);
		// Four bands of 200 x 10 overlap in a 5 x 5 square inside each corner;
		// round joins add a quarter circle of radius 5 outside each corner.
		expect(
			areaError(alphaArea(mask), 4 * 200 * 10 - 4 * 25 + Math.PI * 25)
		).toBeLessThan(0.01);
		expect(pixel(mask, 200, 100)).toBe(255);
		expect(pixel(mask, 200, 200)).toBe(0);
	});

	test("an open stroke has no closing edge", () => {
		const line = [
			{ x: 50, y: 50 },
			{ x: 250, y: 50 },
		];
		const mask = rasterizeContours(
			strokeContour(line, 8, { closed: false }),
			SIZE,
			SIZE
		);
		expect(areaError(alphaArea(mask), 200 * 8 + Math.PI * 16)).toBeLessThan(
			0.01
		);
	});

	test("inside alignment is the doubled band intersected with the fill", () => {
		const shape: RasterShape = {
			cx: 200,
			cy: 200,
			kind: "ellipse",
			rx: 100,
			ry: 100,
		};
		const [contour] = shapeContours(shape);
		const fill = rasterizeShape(shape, SIZE, SIZE);
		const band = rasterizeContours(
			strokeContour(contour ?? [], 20),
			SIZE,
			SIZE
		);
		const inside = combineAlpha(band, fill, "intersect");
		const outside = combineAlpha(band, fill, "subtract");
		expect(
			areaError(alphaArea(inside), Math.PI * (100 * 100 - 90 * 90))
		).toBeLessThan(0.02);
		expect(
			areaError(alphaArea(outside), Math.PI * (110 * 110 - 100 * 100))
		).toBeLessThan(0.02);
	});

	test("a zero-width stroke is empty", () => {
		expect(strokeContour([{ x: 0, y: 0 }], 0)).toEqual([]);
	});
});

describe("mask operations", () => {
	const left: AlphaRaster = {
		data: new Uint8Array([0, 128, 255, 255]),
		height: 2,
		width: 2,
	};
	const right: AlphaRaster = {
		data: new Uint8Array([255, 255, 128, 0]),
		height: 2,
		width: 2,
	};

	test("combine modes", () => {
		expect([...combineAlpha(left, right, "union").data]).toEqual([
			255, 255, 255, 255,
		]);
		expect([...combineAlpha(left, right, "intersect").data]).toEqual([
			0, 128, 128, 0,
		]);
		expect([...combineAlpha(left, right, "multiply").data]).toEqual([
			0, 128, 128, 0,
		]);
		expect([...combineAlpha(left, right, "subtract").data]).toEqual([
			0, 0, 127, 255,
		]);
	});

	test("combining different sizes is rejected", () => {
		expect(() =>
			combineAlpha(
				left,
				{ data: new Uint8Array(1), height: 1, width: 1 },
				"union"
			)
		).toThrow(RangeError);
	});

	test("invert and opacity", () => {
		expect([...invertAlpha(left).data]).toEqual([255, 127, 0, 0]);
		expect([...scaleAlpha(left, 0.5).data]).toEqual([0, 64, 128, 128]);
		expect([...scaleAlpha(left, 2).data]).toEqual([...left.data]);
	});

	test("colorize into straight RGBA", () => {
		const rgba = alphaToRgba(left, { ...hexColor("#ff8000"), a: 128 });
		expect([...rgba.data.subarray(4, 8)]).toEqual([255, 128, 0, 64]);
		expect([...rgba.data.subarray(8, 12)]).toEqual([255, 128, 0, 128]);
		expect(() => hexColor("red")).toThrow(RangeError);
	});
});
