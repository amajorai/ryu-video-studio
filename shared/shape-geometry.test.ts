import { describe, expect, test } from "bun:test";
import { type Graphic, graphicSchema } from "./project.ts";
import {
	arrowVertices,
	cubicBezierAt,
	easedProgress,
	graphicAnimatedValue,
	graphicAnimationExpression,
	graphicFramePoints,
	graphicFrameState,
	graphicPaint,
	graphicRaster,
	heartVertices,
	MAX_RASTER_SIDE,
	type Point,
	pointInPolygon,
	rasterizeShape,
	rectangleRegions,
	regularPolygonVertices,
	rotatePoints,
	roundedRectVertices,
	shapeOutline,
	signedDistance,
	starVertices,
	strokeAlignOf,
	strokeBand,
	svgPathData,
	usesLegacyDrawbox,
} from "./shape-geometry.ts";

const frame = { height: 1080, width: 1920 };

function graphic(fields: Partial<Graphic> = {}): Graphic {
	return graphicSchema.parse({
		end: 4,
		fill: "#ff0000",
		height: 0.2,
		id: "00000000-0000-4000-8000-000000000001",
		opacity: 1,
		start: 1,
		width: 0.2,
		x: 0.1,
		y: 0.1,
		...fields,
	});
}

/** Whether two numbers agree to `digits` decimal places (like `toBeCloseTo`). */
const near = (actual: number, expected: number, digits = 6) =>
	Math.abs(actual - expected) < 10 ** -digits / 2;

/**
 * A tiny evaluator for the FFmpeg expression subset the keyframe builder
 * emits (`if`, `lt`, `clip`, numbers, `t`, + - * / and parentheses), so the
 * test can prove the render expression equals the preview value.
 */
function evaluate(expression: string, t: number): number {
	let position = 0;
	const peek = () => expression[position];
	const expect_ = (character: string) => {
		if (expression[position] !== character) {
			throw new Error(`Expected ${character} at ${position} in ${expression}`);
		}
		position++;
	};
	const primary = (): number => {
		if (peek() === "(") {
			position++;
			const value = sum();
			expect_(")");
			return value;
		}
		if (peek() === "-") {
			position++;
			return -primary();
		}
		const name = /^[a-z]+/.exec(expression.slice(position))?.[0];
		if (name) {
			position += name.length;
			if (name === "t") {
				return t;
			}
			expect_("(");
			const args = [sum()];
			while (peek() === ",") {
				position++;
				args.push(sum());
			}
			expect_(")");
			const [a = 0, b = 0, c = 0] = args;
			if (name === "if") {
				return a === 0 ? c : b;
			}
			if (name === "lt") {
				return a < b ? 1 : 0;
			}
			if (name === "clip") {
				return Math.min(c, Math.max(b, a));
			}
			throw new Error(`Unknown function ${name}`);
		}
		const number = /^\d+(\.\d+)?(e-?\d+)?/.exec(
			expression.slice(position)
		)?.[0];
		if (!number) {
			throw new Error(`Unexpected ${peek()} at ${position} in ${expression}`);
		}
		position += number.length;
		return Number(number);
	};
	const product = (): number => {
		let value = primary();
		while (peek() === "*" || peek() === "/") {
			const operator = peek();
			position++;
			const right = primary();
			value = operator === "*" ? value * right : value / right;
		}
		return value;
	};
	const sum = (): number => {
		let value = product();
		while (peek() === "+" || peek() === "-") {
			const operator = peek();
			position++;
			const right = product();
			value = operator === "+" ? value + right : value - right;
		}
		return value;
	};
	const value = sum();
	if (position !== expression.length) {
		throw new Error(`Trailing input at ${position} in ${expression}`);
	}
	return value;
}

describe("regular polygons and stars", () => {
	test("polygon vertices sit on the ellipse, first one straight up", () => {
		const center = { x: 50, y: 50 };
		const vertices = regularPolygonVertices(6, center, 40, 40);
		expect(vertices).toHaveLength(6);
		expect(near(vertices[0]?.x ?? 0, 50)).toBe(true);
		expect(near(vertices[0]?.y ?? 0, 10)).toBe(true);
		for (const vertex of vertices) {
			expect(near(Math.hypot(vertex.x - 50, vertex.y - 50), 40)).toBe(true);
		}
		const edges = vertices.map((vertex, index) => {
			const next = vertices[(index + 1) % vertices.length] as Point;
			return Math.hypot(next.x - vertex.x, next.y - vertex.y);
		});
		for (const edge of edges) {
			expect(near(edge, 40)).toBe(true);
		}
		// Second vertex is clockwise on screen (to the right of the top).
		expect(vertices[1]?.x ?? 0).toBeGreaterThan(50);
	});

	test("polygon sides are clamped to at least three", () => {
		expect(regularPolygonVertices(1, { x: 0, y: 0 }, 1, 1)).toHaveLength(3);
	});

	test("star vertices alternate tips and notches at the inner radius", () => {
		const vertices = starVertices(5, 0.4, { x: 0, y: 0 }, 100, 100);
		expect(vertices).toHaveLength(10);
		for (const [index, vertex] of vertices.entries()) {
			expect(
				near(Math.hypot(vertex.x, vertex.y), index % 2 === 0 ? 100 : 40)
			).toBe(true);
			const angle = (Math.atan2(vertex.y, vertex.x) * 180) / Math.PI;
			const expected = -90 + index * 36;
			expect(near(((angle - expected + 540) % 360) - 180, 0)).toBe(true);
		}
		expect(near(vertices[0]?.y ?? 0, -100)).toBe(true);
	});

	test("stretched stars scale tips by the box radii", () => {
		const vertices = starVertices(4, 0.5, { x: 0, y: 0 }, 200, 50);
		expect(near(vertices[0]?.y ?? 0, -50)).toBe(true);
		expect(near(vertices[2]?.x ?? 0, 200)).toBe(true);
		expect(near(vertices[3]?.x ?? 0, 50 * Math.cos(Math.PI / 4) * 2)).toBe(
			true
		);
	});
});

describe("outlines", () => {
	test("rounded rectangles clamp the radius and keep the box", () => {
		const square = roundedRectVertices(100, 50, 0);
		expect(square).toHaveLength(4);
		const pill = roundedRectVertices(100, 50, 999);
		const xs = pill.map((point) => point.x);
		const ys = pill.map((point) => point.y);
		expect(near(Math.min(...xs), 0)).toBe(true);
		expect(near(Math.max(...xs), 100)).toBe(true);
		expect(near(Math.min(...ys), 0)).toBe(true);
		expect(near(Math.max(...ys), 50)).toBe(true);
		// The corner itself is cut away.
		expect(pointInPolygon(pill, 1, 1)).toBe(false);
		expect(pointInPolygon(pill, 50, 1)).toBe(true);
	});

	test("hearts and arrows fill their box", () => {
		for (const points of [heartVertices(80, 60), arrowVertices(80, 60)]) {
			const xs = points.map((point) => point.x);
			const ys = points.map((point) => point.y);
			expect(near(Math.min(...xs), 0)).toBe(true);
			expect(near(Math.max(...xs), 80)).toBe(true);
			expect(near(Math.min(...ys), 0)).toBe(true);
			expect(near(Math.max(...ys), 60)).toBe(true);
		}
		const heart = heartVertices(80, 60);
		expect(pointInPolygon(heart, 40, 2)).toBe(false);
		expect(pointInPolygon(heart, 20, 15)).toBe(true);
		const arrow = arrowVertices(80, 60);
		expect(pointInPolygon(arrow, 79, 30)).toBe(true);
		expect(pointInPolygon(arrow, 10, 5)).toBe(false);
	});

	test("every shape outline is in box pixels", () => {
		for (const shape of graphicSchema.shape.shape.unwrap().options) {
			const points = shapeOutline(graphic({ shape }), frame);
			expect(points.length).toBeGreaterThanOrEqual(3);
			for (const point of points) {
				expect(point.x).toBeGreaterThanOrEqual(-1e-9);
				expect(point.x).toBeLessThanOrEqual(384 + 1e-9);
				expect(point.y).toBeGreaterThanOrEqual(-1e-9);
				expect(point.y).toBeLessThanOrEqual(216 + 1e-9);
			}
		}
		const line = shapeOutline(
			graphic({ shape: "line", strokeWidth: 0.01 }),
			frame
		);
		expect(near((line[3]?.y ?? 0) - (line[0]?.y ?? 0), 10.8)).toBe(true);
	});

	test("rotation is clockwise on screen", () => {
		const [point] = rotatePoints([{ x: 10, y: 0 }], { x: 0, y: 0 }, 90);
		expect(near(point?.x ?? 1, 0)).toBe(true);
		expect(near(point?.y ?? 0, 10)).toBe(true);
	});

	test("svg path data closes the polygon", () => {
		expect(
			svgPathData([
				{ x: 0, y: 0 },
				{ x: 1.234_56, y: 0 },
				{ x: 1, y: 1 },
			])
		).toBe("M0 0 L1.235 0 L1 1 Z");
	});
});

describe("stroke alignment", () => {
	test("bands sit inside, across or outside the outline", () => {
		expect(strokeBand("inside", 10)).toEqual({ inner: -10, outer: 0 });
		expect(strokeBand("center", 10)).toEqual({ inner: -5, outer: 5 });
		expect(strokeBand("outside", 10)).toEqual({ inner: 0, outer: 10 });
		expect(strokeBand("outside", 0)).toEqual({ inner: 0, outer: 0 });
	});

	test("absent alignment is inside, like the legacy border", () => {
		expect(strokeAlignOf({})).toBe("inside");
		expect(strokeAlignOf({ strokeAlign: "outside" })).toBe("outside");
	});

	test("signed distance is negative inside", () => {
		const square = roundedRectVertices(10, 10, 0);
		expect(near(signedDistance(square, 5, 5), -5)).toBe(true);
		expect(near(signedDistance(square, 15, 5), 5)).toBe(true);
		expect(near(signedDistance(square, 5, 1), -1)).toBe(true);
	});
});

describe("rasterizer", () => {
	const alphaSum = (pixels: Uint8Array) => {
		let sum = 0;
		for (let index = 3; index < pixels.length; index += 4) {
			sum += pixels[index] ?? 0;
		}
		return sum / 255;
	};
	const base = {
		band: { inner: 0, outer: 0 },
		fill: [255, 0, 0] as const,
		height: 100,
		opacity: 1,
		stroke: [0, 0, 255] as const,
		width: 100,
	};

	test("coverage matches the polygon area within 1%", () => {
		const square = roundedRectVertices(50.5, 30.25, 0).map((point) => ({
			x: point.x + 20,
			y: point.y + 20,
		}));
		const squareCoverage = alphaSum(
			rasterizeShape({ ...base, points: square })
		);
		expect(
			Math.abs(squareCoverage - 50.5 * 30.25) / (50.5 * 30.25)
		).toBeLessThan(0.01);
		const circle = regularPolygonVertices(256, { x: 50, y: 50 }, 40, 40);
		const circleCoverage = alphaSum(
			rasterizeShape({ ...base, points: circle })
		);
		expect(
			Math.abs(circleCoverage - Math.PI * 1600) / (Math.PI * 1600)
		).toBeLessThan(0.01);
		const star = starVertices(5, 0.5, { x: 50, y: 50 }, 45, 45);
		let area = 0;
		for (let i = 0, j = star.length - 1; i < star.length; j = i++) {
			const a = star[j] as Point;
			const b = star[i] as Point;
			area += a.x * b.y - b.x * a.y;
		}
		area = Math.abs(area) / 2;
		const starCoverage = alphaSum(rasterizeShape({ ...base, points: star }));
		expect(Math.abs(starCoverage - area) / area).toBeLessThan(0.01);
	});

	test("strokes paint the aligned band over the fill", () => {
		const square = roundedRectVertices(60, 60, 0).map((point) => ({
			x: point.x + 20,
			y: point.y + 20,
		}));
		const pixel = (pixels: Uint8Array, x: number, y: number) =>
			Array.from(pixels.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 4));
		const outside = rasterizeShape({
			...base,
			band: strokeBand("outside", 6),
			points: square,
		});
		expect(pixel(outside, 50, 16)).toEqual([0, 0, 255, 255]);
		expect(pixel(outside, 50, 22)).toEqual([255, 0, 0, 255]);
		expect(pixel(outside, 50, 12)[3]).toBe(0);
		const inside = rasterizeShape({
			...base,
			band: strokeBand("inside", 6),
			points: square,
		});
		expect(pixel(inside, 50, 22)).toEqual([0, 0, 255, 255]);
		expect(pixel(inside, 50, 30)).toEqual([255, 0, 0, 255]);
		expect(pixel(inside, 50, 18)[3]).toBe(0);
		const centered = rasterizeShape({
			...base,
			band: strokeBand("center", 6),
			points: square,
		});
		expect(pixel(centered, 50, 18)).toEqual([0, 0, 255, 255]);
		expect(pixel(centered, 50, 21)).toEqual([0, 0, 255, 255]);
		expect(pixel(centered, 50, 25)).toEqual([255, 0, 0, 255]);
	});

	test("opacity scales alpha and edges are anti-aliased", () => {
		const half = roundedRectVertices(10.5, 10, 0).map((point) => ({
			x: point.x + 10,
			y: point.y + 10,
		}));
		const pixels = rasterizeShape({ ...base, opacity: 0.5, points: half });
		expect(pixels[(15 * 100 + 15) * 4 + 3]).toBe(128);
		// x = 20 is half covered (the edge is at 20.5).
		expect(pixels[(15 * 100 + 20) * 4 + 3]).toBe(64);
	});

	test("graphic rasters are even squares that fit any rotation", () => {
		const star = graphic({
			shape: "star",
			strokeAlign: "outside",
			strokeWidth: 0.01,
		});
		const raster = graphicRaster(star, frame, { opacity: 1, rotation: 0 });
		expect(raster.size % 2).toBe(0);
		// Half-diagonal of a 384x216 box is ~192 (the star tips are on the
		// ellipse, so at most 192), plus the 10.8 px stroke and margin.
		expect(raster.size).toBeLessThanOrEqual(2 * Math.ceil(192 + 10.8 + 2));
		expect(raster.offset.x).toBeCloseTo(192 - raster.size / 2, 6);
		expect(raster.offset.y).toBeCloseTo(108 - raster.size / 2, 6);
		const rotated = graphicRaster(star, frame, { opacity: 1, rotation: 36 });
		expect(rotated.size).toBe(raster.size);
		expect(Array.from(rotated.pixels)).not.toEqual(Array.from(raster.pixels));
	});

	test("rasterizing is deterministic", () => {
		const heart = graphic({ shape: "heart" });
		const first = graphicRaster(heart, frame, { opacity: 0.7, rotation: 12 });
		const second = graphicRaster(heart, frame, { opacity: 0.7, rotation: 12 });
		expect(Buffer.from(first.pixels).equals(Buffer.from(second.pixels))).toBe(
			true
		);
	});
});

describe("rectangle borders (review fix)", () => {
	const alphaAt = (
		raster: ReturnType<typeof graphicRaster>,
		x: number,
		y: number
	) => raster.pixels[(y * raster.pixelSize + x) * 4 + 3] ?? 0;
	const colorAt = (
		raster: ReturnType<typeof graphicRaster>,
		x: number,
		y: number
	) =>
		Array.from(
			raster.pixels.subarray(
				(y * raster.pixelSize + x) * 4,
				(y * raster.pixelSize + x) * 4 + 3
			)
		);
	/** Stroke-colored pixels walking in from the box edge along a row/column. */
	function borderRun(
		raster: ReturnType<typeof graphicRaster>,
		from: Point,
		step: Point
	): number {
		let run = 0;
		let x = from.x;
		let y = from.y;
		while (
			colorAt(raster, x, y).join() === "255,255,0" &&
			alphaAt(raster, x, y) === 255
		) {
			run++;
			x += step.x;
			y += step.y;
		}
		return run;
	}

	test("the raster border equals drawbox's when only the blend mode differs", () => {
		const fields = {
			fill: "#ff0000",
			height: 0.5,
			shape: "rectangle" as const,
			stroke: "#ffff00",
			strokeWidth: 0.05,
			width: 0.5,
		};
		expect(usesLegacyDrawbox(graphic(fields))).toBe(true);
		const blended = graphic({ ...fields, blendMode: "multiply" });
		expect(usesLegacyDrawbox(blended)).toBe(false);
		const raster = graphicRaster(blended, frame, { opacity: 1, rotation: 0 });
		// Box top-left in raster pixels.
		const left = Math.round(-raster.offset.x);
		const top = Math.round(-raster.offset.y);
		const middleY = top + 270;
		const middleX = left + 480;
		// Legacy drawbox: strokeWidth*W = 96 px sideways, strokeWidth*H = 54 px.
		expect(borderRun(raster, { x: left, y: middleY }, { x: 1, y: 0 })).toBe(96);
		expect(
			borderRun(raster, { x: left + 959, y: middleY }, { x: -1, y: 0 })
		).toBe(96);
		expect(borderRun(raster, { x: middleX, y: top }, { x: 0, y: 1 })).toBe(54);
		expect(
			borderRun(raster, { x: middleX, y: top + 539 }, { x: 0, y: -1 })
		).toBe(54);
		expect(colorAt(raster, left + 96, middleY)).toEqual([255, 0, 0]);
		expect(alphaAt(raster, left - 1, middleY)).toBe(0);
	});

	test("alignment offsets both regions anisotropically", () => {
		const box = { height: 0.5, shape: "rectangle" as const, width: 0.5 };
		const inside = rectangleRegions(
			graphic({ ...box, strokeWidth: 0.05 }),
			frame
		);
		expect(inside?.outer[0]).toEqual({ x: 0, y: 0 });
		expect(inside?.inner[0]).toEqual({ x: 96, y: 54 });
		const center = rectangleRegions(
			graphic({ ...box, strokeAlign: "center", strokeWidth: 0.05 }),
			frame
		);
		expect(center?.outer[0]).toEqual({ x: -48, y: -27 });
		expect(center?.inner[0]).toEqual({ x: 48, y: 27 });
		const outside = rectangleRegions(
			graphic({ ...box, strokeAlign: "outside", strokeWidth: 0.05 }),
			frame
		);
		expect(outside?.outer[2]).toEqual({ x: 960 + 96, y: 540 + 54 });
		expect(outside?.inner[2]).toEqual({ x: 960, y: 540 });
		// Rounded corners shrink inside and grow outside, per axis.
		const rounded = rectangleRegions(
			graphic({ ...box, cornerRadius: 0.2, strokeWidth: 0.05 }),
			frame
		);
		// 0.2 * 540 = 108 px radius; the inner corner radii are 12 x 54 px.
		// The last point ends the top-left arc where the top edge begins.
		expect(rounded?.inner.at(-1)?.x).toBeCloseTo(96 + 12, 6);
		expect(rounded?.inner.at(-1)?.y).toBeCloseTo(54, 6);
		expect(rounded?.outer.at(-1)?.x).toBeCloseTo(108, 6);
		expect(rounded?.outer.at(-1)?.y).toBeCloseTo(0, 6);
		// A stroke wider than half the box leaves no fill region.
		const solid = rectangleRegions(
			graphic({
				height: 0.05,
				shape: "rectangle",
				strokeWidth: 0.04,
				width: 0.05,
			}),
			frame
		);
		expect(solid?.inner).toEqual([]);
		expect(rectangleRegions(graphic({ shape: "rectangle" }), frame)).toBe(
			undefined
		);
		expect(
			rectangleRegions(graphic({ shape: "star", strokeWidth: 0.05 }), frame)
		).toBe(undefined);
		expect(
			graphicPaint(graphic({ ...box, strokeWidth: 0.05 }), frame).band
		).toEqual({
			inner: 0,
			outer: 0,
		});
	});
});

describe("bounded rasterization (review fix)", () => {
	test("per-row spans match a brute-force signed distance", () => {
		const points = rotatePoints(
			starVertices(5, 0.4, { x: 40, y: 40 }, 30, 25),
			{ x: 40, y: 40 },
			17
		);
		const band = strokeBand("center", 6);
		const pixels = rasterizeShape({
			band,
			fill: [255, 0, 0],
			height: 80,
			opacity: 1,
			points,
			stroke: [0, 0, 255],
			width: 80,
		});
		const cover = (d: number, edge: number) =>
			Math.max(0, Math.min(1, 0.5 - (d - edge)));
		let worst = 0;
		for (let y = 0; y < 80; y++) {
			for (let x = 0; x < 80; x++) {
				const d = signedDistance(points, x + 0.5, y + 0.5);
				const fillAlpha = cover(d, 0);
				const strokeAlpha = Math.max(
					0,
					cover(d, band.outer) - cover(d, band.inner)
				);
				const alpha = strokeAlpha + fillAlpha * (1 - strokeAlpha);
				const expected = Math.round(255 * Math.min(1, alpha));
				worst = Math.max(
					worst,
					Math.abs((pixels[(y * 80 + x) * 4 + 3] ?? 0) - expected)
				);
			}
		}
		expect(worst).toBeLessThanOrEqual(1);
	});

	test("transparent pixels carry the edge color", () => {
		const square = roundedRectVertices(20, 20, 0).map((point) => ({
			x: point.x + 10,
			y: point.y + 10,
		}));
		const request = {
			band: { inner: 0, outer: 0 },
			fill: [255, 0, 0] as const,
			height: 40,
			opacity: 1,
			points: square,
			stroke: [0, 0, 255] as const,
			width: 40,
		};
		expect(Array.from(rasterizeShape(request).subarray(0, 4))).toEqual([
			255, 0, 0, 0,
		]);
		const stroked = rasterizeShape({
			...request,
			band: strokeBand("outside", 2),
		});
		expect(Array.from(stroked.subarray(0, 4))).toEqual([0, 0, 255, 0]);
	});

	test("huge rasters are capped at MAX_RASTER_SIDE", () => {
		const uhd = { height: 2160, width: 3840 };
		const full = graphic({
			height: 1,
			shape: "triangle",
			strokeAlign: "center",
			strokeWidth: 0.08,
			width: 1,
		});
		const raster = graphicRaster(full, uhd, { opacity: 1, rotation: 0 });
		expect(raster.pixelSize).toBe(MAX_RASTER_SIDE);
		expect(raster.size).toBeGreaterThan(MAX_RASTER_SIDE);
		expect(raster.pixels.length).toBe(MAX_RASTER_SIDE ** 2 * 4);
		// The centre of the box is still the centre of the raster.
		expect(raster.offset.x).toBeCloseTo(1920 - raster.size / 2, 6);
		const middle = (MAX_RASTER_SIDE / 2) * (MAX_RASTER_SIDE + 1) * 4;
		expect(raster.pixels[middle + 3]).toBe(255);
		const small = graphicRaster(graphic({ shape: "star" }), frame, {
			opacity: 1,
			rotation: 0,
		});
		expect(small.pixelSize).toBe(small.size);
	});
});

describe("legacy drawbox selection", () => {
	test("original shapes without new fields keep drawbox", () => {
		expect(
			usesLegacyDrawbox(graphic({ shape: "rectangle", strokeWidth: 0.01 }))
		).toBe(true);
		expect(usesLegacyDrawbox(graphic({ shape: "line" }))).toBe(true);
		expect(usesLegacyDrawbox(graphic({ shape: "ellipse" }))).toBe(true);
		expect(
			usesLegacyDrawbox(graphic({ shape: "triangle", strokeWidth: 0.01 }))
		).toBe(true);
		expect(usesLegacyDrawbox(graphic({ shape: "triangle" }))).toBe(true);
	});

	test("new shapes and fields rasterize", () => {
		for (const fields of [
			{ shape: "star" },
			{ shape: "polygon" },
			{ shape: "heart" },
			{ shape: "arrow" },
			{ cornerRadius: 0.1 },
			{ rotation: 5 },
			{ strokeAlign: "inside" },
			{ blendMode: "multiply" },
			{ shape: "ellipse", strokeAlign: "center", strokeWidth: 0.01 },
			{
				keyframes: [
					{
						id: "00000000-0000-4000-8000-000000000009",
						property: "x",
						time: 1,
						value: 0.2,
					},
				],
			},
		] as Partial<Graphic>[]) {
			expect(usesLegacyDrawbox(graphic(fields))).toBe(false);
		}
		expect(
			usesLegacyDrawbox(graphic({ blendMode: "normal", rotation: 0 }))
		).toBe(true);
	});
});

describe("keyframes", () => {
	const keyframe = (
		property: "x" | "y" | "rotation" | "opacity",
		time: number,
		value: number,
		extra: Partial<NonNullable<Graphic["keyframes"]>[number]> = {}
	) => ({
		id: crypto.randomUUID(),
		property,
		time,
		value,
		...extra,
	});

	test("eased progress hits its endpoints", () => {
		for (const interpolation of [
			"linear",
			"ease-in",
			"ease-out",
			"ease-in-out",
		] as const) {
			expect(near(easedProgress(interpolation, 0), 0)).toBe(true);
			expect(near(easedProgress(interpolation, 1), 1)).toBe(true);
		}
		expect(easedProgress("hold", 0.9)).toBe(0);
		expect(easedProgress("ease-in", 0.5)).toBe(0.25);
		expect(easedProgress("ease-out", 0.5)).toBe(0.75);
		expect(near(cubicBezierAt([0.25, 0.1, 0.25, 1], 0.5), 0.8024, 3)).toBe(
			true
		);
		expect(near(easedProgress("bezier", 1, [0.42, 0, 0.58, 1]), 1)).toBe(true);
	});

	test("values start from the base, hold the last keyframe", () => {
		const moving = graphic({
			keyframes: [
				keyframe("x", 1, 0.5),
				keyframe("x", 2, 0.3, { interpolation: "hold" }),
				keyframe("x", 3, 0.9),
			],
			x: 0.1,
		});
		expect(near(graphicAnimatedValue(moving, "x", 0), 0.1)).toBe(true);
		expect(near(graphicAnimatedValue(moving, "x", 0.5), 0.3)).toBe(true);
		expect(near(graphicAnimatedValue(moving, "x", 1), 0.5)).toBe(true);
		expect(near(graphicAnimatedValue(moving, "x", 2.5), 0.3)).toBe(true);
		expect(near(graphicAnimatedValue(moving, "x", 3), 0.9)).toBe(true);
		expect(near(graphicAnimatedValue(moving, "x", 10), 0.9)).toBe(true);
		expect(near(graphicAnimatedValue(moving, "y", 1), 0.1)).toBe(true);
		expect(graphicAnimationExpression(moving, "y", "t")).toBe("0.1");
	});

	test("render expressions equal preview values", () => {
		const animated = graphic({
			keyframes: [
				keyframe("rotation", 0, -30, { interpolation: "ease-in" }),
				keyframe("rotation", 0.5, 45, { interpolation: "ease-out" }),
				keyframe("rotation", 1.25, 10, { interpolation: "ease-in-out" }),
				keyframe("rotation", 2, 90, {
					bezier: [0.3, -0.4, 0.6, 1.6],
					interpolation: "bezier",
				}),
				keyframe("rotation", 2.75, 0, { interpolation: "hold" }),
				keyframe("rotation", 3, 180),
			],
		});
		const expression = graphicAnimationExpression(animated, "rotation", "t");
		for (let time = -0.2; time <= 3.4; time += 0.0625) {
			expect(
				near(
					evaluate(expression, time),
					graphicAnimatedValue(animated, "rotation", time),
					5
				)
			).toBe(true);
		}
	});

	test("frame state adds the entry slide and clamps opacity", () => {
		const sliding = graphic({
			animation: "slide-left",
			entryDuration: 1,
			keyframes: [keyframe("opacity", 1, 2)],
			opacity: 0.5,
		});
		const atStart = graphicFrameState(sliding, 1);
		expect(near(atStart.x, 0.1 - 0.08)).toBe(true);
		expect(near(atStart.opacity, 0.5)).toBe(true);
		const settled = graphicFrameState(sliding, 3);
		expect(near(settled.x, 0.1)).toBe(true);
		expect(settled.opacity).toBe(1);
	});

	test("frame points rotate about the box center at the animated position", () => {
		const turned = graphic({
			keyframes: [keyframe("rotation", 1, 90)],
			shape: "arrow",
		});
		const points = graphicFramePoints(turned, frame, 2);
		// The arrow tip points down after a 90 degree clockwise turn.
		const tip = points[3] as Point;
		expect(near(tip.x, 192 + 192, 6)).toBe(true);
		expect(near(tip.y, 108 + 108 + 192, 6)).toBe(true);
	});
});
