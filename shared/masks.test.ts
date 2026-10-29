import { describe, expect, test } from "bun:test";
import {
	addMask,
	defaultMask,
	dragMask,
	flattenMaskPath,
	frameToMaskBox,
	heartOutline,
	insideOutline,
	MAX_STROKE_OUTLINE_EDGES,
	type Mask,
	maskAlphaAt,
	maskAnimated,
	maskAt,
	maskBoxToFrame,
	maskDistanceOutline,
	maskFeatherSigma,
	maskFontName,
	maskHasStroke,
	maskOutline,
	maskRampWidth,
	maskShapeCoverage,
	maskShapes,
	maskSignedDistance,
	maskStrokeAlignOf,
	maskStrokeAlphaAt,
	maskStrokeBand,
	maskStrokeColorOf,
	maskStrokeSvg,
	maskStrokeSvgUrl,
	maskStrokeWidthPx,
	maskSvgPad,
	maskSvgUrl,
	maskToSvg,
	polygonOutline,
	removeMask,
	removeMaskPatch,
	sanitizeMaskText,
	segmentMasksAt,
	starOutline,
	updateMask,
} from "./masks.ts";
import {
	newProject,
	newSegment,
	type Segment,
	validateProject,
} from "./project.ts";
import { maskSchema } from "./schema/mask.ts";

const ID = "00000000-0000-4000-8000-000000000001";
const ID2 = "00000000-0000-4000-8000-000000000002";

const asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 5,
	hasAudio: false,
	height: 1080,
	id: "00000000-0000-4000-8000-0000000000a1",
	kind: "video" as const,
	name: "clip.mp4",
	width: 1920,
};

function segmentWith(patch: Partial<Segment>): Segment {
	return { ...newSegment(asset), ...patch };
}

describe("feather mapping", () => {
	test("sigma is a tenth of the shorter side per unit of feather", () => {
		expect(maskFeatherSigma(0.5, 1920, 1080)).toBeCloseTo(54);
		expect(maskFeatherSigma(1, 1080, 1920)).toBeCloseTo(108);
		expect(maskFeatherSigma(0, 1920, 1080)).toBe(0);
	});

	test("the ramp of linear and mirror masks is four sigmas, at least a pixel", () => {
		expect(maskRampWidth(0.5, 1920, 1080)).toBeCloseTo(216);
		expect(maskRampWidth(0, 1920, 1080)).toBe(1);
	});
});

describe("outlines", () => {
	test("polygons and stars start at the top", () => {
		const hexagon = polygonOutline(6);
		expect(hexagon).toHaveLength(6);
		expect(hexagon[0]?.x).toBeCloseTo(0);
		expect(hexagon[0]?.y).toBeCloseTo(-1);
		const star = starOutline(5, 0.4);
		expect(star).toHaveLength(10);
		expect(Math.hypot(star[1]?.x ?? 0, star[1]?.y ?? 0)).toBeCloseTo(0.4);
	});

	test("the heart fills its box", () => {
		const xs = heartOutline.map((point) => point.x);
		const ys = heartOutline.map((point) => point.y);
		expect(Math.min(...xs)).toBeCloseTo(-1);
		expect(Math.max(...xs)).toBeCloseTo(1);
		expect(Math.min(...ys)).toBeCloseTo(-1);
		expect(Math.max(...ys)).toBeCloseTo(1);
		expect(insideOutline(heartOutline, 0, 0)).toBe(true);
		expect(insideOutline(heartOutline, 0, -0.95)).toBe(false);
	});

	test("straight freeform edges stay straight and handles add curve steps", () => {
		const straight = [
			{ x: 0, y: -0.5 },
			{ x: 0.5, y: 0.5 },
			{ x: -0.5, y: 0.5 },
		];
		expect(flattenMaskPath(straight)).toEqual(straight);
		const curved = flattenMaskPath(
			[
				{ outX: 0.5, outY: -0.5, x: 0, y: -0.5 },
				{ x: 0.5, y: 0.5 },
				{ x: -0.5, y: 0.5 },
			],
			4
		);
		expect(curved).toHaveLength(6);
		expect(curved[2]).toEqual({ x: 0.4375, y: 0 });
	});

	test("analytic polygon and star tests agree with their outlines", () => {
		const shapes: Mask[] = [
			{ ...defaultMask("polygon", ID), sides: 5 },
			{ ...defaultMask("star", ID), innerRadius: 0.3, points: 7 },
		];
		for (const mask of shapes) {
			const outline = maskOutline(mask) ?? [];
			for (let y = -1; y <= 1; y += 0.037) {
				for (let x = -1; x <= 1; x += 0.041) {
					const analytic = maskShapeCoverage(
						mask,
						x * 100,
						y * 100,
						{ halfHeight: 100, halfWidth: 100 },
						1
					);
					expect([mask.shape, x, y, analytic]).toEqual([
						mask.shape,
						x,
						y,
						insideOutline(outline, x, y) ? 1 : 0,
					]);
				}
			}
		}
	});
});

describe("reference alpha", () => {
	test("a centered rectangle keeps its box and hides the rest", () => {
		const mask = { ...defaultMask("rectangle", ID), height: 0.5, width: 0.5 };
		expect(maskAlphaAt(mask, 50, 50, 100, 100)).toBe(1);
		expect(maskAlphaAt(mask, 5, 5, 100, 100)).toBe(0);
	});

	test("invert and opacity", () => {
		const mask = { ...defaultMask("ellipse", ID), height: 0.4, width: 0.4 };
		expect(maskAlphaAt({ ...mask, invert: true }, 50, 50, 100, 100)).toBe(0);
		expect(maskAlphaAt({ ...mask, invert: true }, 2, 2, 100, 100)).toBe(1);
		expect(maskAlphaAt({ ...mask, opacity: 0.25 }, 2, 2, 100, 100)).toBe(0.75);
		expect(maskAlphaAt({ ...mask, opacity: 0 }, 2, 2, 100, 100)).toBe(1);
	});

	test("rotation turns the shape clockwise in pixel space", () => {
		// A wide bar rotated 90° becomes a tall bar.
		const bar = {
			...defaultMask("rectangle", ID),
			height: 0.1,
			rotation: 90,
			width: 0.8,
		};
		expect(maskAlphaAt(bar, 50, 15, 100, 100)).toBe(1);
		expect(maskAlphaAt(bar, 15, 50, 100, 100)).toBe(0);
	});

	test("rounded corners cut the box corners", () => {
		const mask = { ...defaultMask("rectangle", ID), cornerRadius: 0.5 };
		expect(maskAlphaAt(mask, 0, 0, 100, 100)).toBe(0);
		expect(maskAlphaAt(mask, 50, 0, 100, 100)).toBe(1);
	});

	test("linear keeps the top half with a ramp; mirror keeps a band", () => {
		const linear = { ...defaultMask("linear", ID), feather: 0.5 };
		expect(maskAlphaAt(linear, 50, 0, 100, 100)).toBe(1);
		expect(maskAlphaAt(linear, 50, 99, 100, 100)).toBe(0);
		expect(maskAlphaAt(linear, 50, 50, 100, 100)).toBeCloseTo(0.475, 3);
		const mirror = { ...defaultMask("mirror", ID), height: 0.2 };
		expect(maskAlphaAt(mirror, 10, 50, 100, 100)).toBe(1);
		expect(maskAlphaAt(mirror, 10, 80, 100, 100)).toBe(0);
	});

	test("every drawn shape covers its center; a linear edge passes through it", () => {
		for (const shape of maskShapes) {
			if (shape === "text") {
				continue;
			}
			expect([
				shape,
				maskAlphaAt(defaultMask(shape, ID), 50, 50, 101, 101),
			]).toEqual([shape, shape === "linear" ? 0.5 : 1]);
		}
	});
});

describe("animation", () => {
	const mask = defaultMask("ellipse", ID);
	const segment = segmentWith({
		keyframes: [
			{ id: ID2, property: "maskX", target: ID, time: 0, value: -0.5 },
			{
				id: "00000000-0000-4000-8000-000000000003",
				property: "maskX",
				target: ID,
				time: 2,
				value: 0.5,
			},
		],
		masks: [mask],
	});

	test("keyframed fields evaluate at the clip time", () => {
		expect(maskAnimated(segment, mask)).toBe(true);
		expect(maskAt(segment, mask, 1).x).toBeCloseTo(0);
		expect(maskAt(segment, mask, 2).x).toBeCloseTo(0.5);
		expect(segmentMasksAt(segment, 0)[0]?.x).toBeCloseTo(-0.5);
	});

	test("keyframes for another mask leave this one static", () => {
		const other = defaultMask("ellipse", ID2);
		expect(maskAnimated(segment, other)).toBe(false);
		expect(maskAt(segment, other, 1)).toBe(other);
		expect(segmentMasksAt(segmentWith({}), 0)).toEqual([]);
	});
});

describe("edits", () => {
	test("add up to four masks", () => {
		let masks = addMask(undefined, "ellipse", ID);
		expect(masks).toEqual([defaultMask("ellipse", ID)]);
		for (const index of [2, 3, 4]) {
			masks = addMask(
				masks,
				"rectangle",
				`00000000-0000-4000-8000-00000000000${index}`
			);
		}
		expect(() =>
			addMask(masks, "rectangle", "00000000-0000-4000-8000-000000000009")
		).toThrow("at most 4");
	});

	test("update validates and fills defaults for a new shape", () => {
		const masks = [defaultMask("ellipse", ID)];
		const star = updateMask(masks, ID, { shape: "star" });
		expect(star[0]).toMatchObject({
			innerRadius: 0.5,
			points: 5,
			shape: "star",
		});
		const text = updateMask(masks, ID, { shape: "text", text: "Hello" });
		expect(text[0]).toMatchObject({ text: "Hello" });
		expect(() => updateMask(masks, ID, { feather: 2 })).toThrow();
		expect(() => updateMask(masks, ID2, { feather: 0.2 })).toThrow(
			"not on this clip"
		);
	});

	test("removing the last mask clears the field", () => {
		const masks = [defaultMask("ellipse", ID), defaultMask("heart", ID2)];
		expect(removeMask(masks, ID)).toEqual([defaultMask("heart", ID2)]);
		expect(removeMask([defaultMask("ellipse", ID)], ID)).toBeUndefined();
	});

	test("removing a keyframed mask drops its keyframes and stays valid", () => {
		const segment = segmentWith({
			keyframes: [
				{
					id: "00000000-0000-4000-8000-0000000000b1",
					property: "maskX",
					target: ID,
					time: 0,
					value: 0.2,
				},
				{
					id: "00000000-0000-4000-8000-0000000000b2",
					property: "maskRotation",
					target: ID,
					time: 1,
					value: 30,
				},
				{
					id: "00000000-0000-4000-8000-0000000000b3",
					property: "maskWidth",
					target: ID2,
					time: 0,
					value: 0.4,
				},
				{
					id: "00000000-0000-4000-8000-0000000000b4",
					property: "opacity",
					time: 0,
					value: 1,
				},
			],
			masks: [defaultMask("ellipse", ID), defaultMask("heart", ID2)],
		});
		const project = { ...newProject("Masks"), segments: [segment] };
		expect(() => validateProject(project, [asset])).not.toThrow();
		const patch = removeMaskPatch(segment, ID);
		expect(patch).toEqual({
			keyframes: segment.keyframes.slice(2),
			masks: [defaultMask("heart", ID2)],
		});
		const edited = { ...project, segments: [{ ...segment, ...patch }] };
		expect(() => validateProject(edited, [asset])).not.toThrow();
		// Without dropping the keyframes the project would be refused.
		const stale = {
			...project,
			segments: [{ ...segment, masks: removeMask(segment.masks ?? [], ID) }],
		};
		expect(() => validateProject(stale, [asset])).toThrow();
	});

	test("removing an unanimated mask leaves keyframes alone", () => {
		const segment = segmentWith({ masks: [defaultMask("ellipse", ID)] });
		expect(removeMaskPatch(segment, ID)).toEqual({ masks: undefined });
	});
});

describe("direct manipulation", () => {
	const mask = { ...defaultMask("rectangle", ID), height: 0.5, width: 0.5 };

	test("frame and box coordinates round-trip", () => {
		const rotated = { ...mask, rotation: 33, x: 0.2 };
		const frame = maskBoxToFrame(rotated, { x: 0.7, y: -0.4 }, 16 / 9);
		const box = frameToMaskBox(rotated, frame, 16 / 9);
		expect(box.x).toBeCloseTo(0.7);
		expect(box.y).toBeCloseTo(-0.4);
	});

	test("move, resize, rotate and feather", () => {
		expect(
			dragMask(mask, "move", { x: 0.5, y: 0.5 }, { x: 0.6, y: 0.4 }, 1)
		).toMatchObject({ x: 0.2, y: -0.2 });
		const corner = maskBoxToFrame(mask, { x: 1, y: 1 }, 1);
		const grown = dragMask(
			mask,
			"se",
			corner,
			maskBoxToFrame(mask, { x: 1.5, y: 2 }, 1),
			1
		);
		expect(grown.width).toBeCloseTo(0.75);
		expect(grown.height).toBeCloseTo(1);
		expect(
			dragMask(mask, "rotate", { x: 0.5, y: 0 }, { x: 1, y: 0.5 }, 1).rotation
		).toBeCloseTo(90);
		expect(
			dragMask(mask, "feather", { x: 0.75, y: 0.5 }, { x: 0.79, y: 0.5 }, 1)
				.feather
		).toBeCloseTo(0.1);
	});

	test("freeform points move in box space", () => {
		const freeform = defaultMask("freeform", ID);
		const moved = dragMask(
			freeform,
			"point:1",
			{ x: 0, y: 0 },
			{ x: 0.5, y: 0.5 },
			1
		);
		expect(moved.path?.[1]).toEqual({ x: 0, y: 0 });
		expect(moved.path?.[0]).toEqual(freeform.path?.[0]);
	});
});

describe("text", () => {
	test("sanitizes filtergraph and markup characters", () => {
		expect(sanitizeMaskText("It's 50%: [a];b,c <d> & e\\f")).toBe(
			"It\u2019s 50 abc d  ef"
		);
		expect(maskFontName(undefined)).toBe("Sans");
		expect(maskFontName("bebas-neue")).toBe("Bebas Neue");
	});
});

describe("preview SVG", () => {
	test("a feathered inverted ellipse", () => {
		expect(
			maskToSvg(
				{
					...defaultMask("ellipse", ID),
					feather: 0.2,
					invert: true,
					opacity: 0.8,
					rotation: 30,
					width: 0.5,
					x: 0.25,
				},
				160,
				90
			)
		).toMatchSnapshot();
	});

	test("every shape draws its own element", () => {
		const elements: Record<string, string> = {
			ellipse: "<ellipse",
			freeform: "<polygon",
			heart: "<polygon",
			linear: "<linearGradient",
			mirror: "<linearGradient",
			polygon: "<polygon",
			rectangle: "<rect",
			star: "<polygon",
			text: "<text",
		};
		for (const shape of maskShapes) {
			expect(maskToSvg(defaultMask(shape, ID), 160, 90)).toContain(
				elements[shape] ?? "missing"
			);
		}
		expect(maskSvgUrl(defaultMask("ellipse", ID), 16, 9)).toStartWith(
			'url("data:image/svg+xml,%3Csvg'
		);
	});

	test("a feathered shape is mirrored past the frame, like the render's blur", () => {
		const full = { ...defaultMask("rectangle", ID), feather: 0.5 };
		// sigma = 0.5 × 180 × 0.1 = 9 px; pad = ceil(3 × 9) + 2.
		expect(maskSvgPad(full, 320, 180)).toBe(29);
		const svg = maskToSvg(full, 320, 180);
		expect(svg).toContain('width="378" height="238" viewBox="-29 -29 378 238"');
		expect(svg).toContain(
			'<filter id="f" filterUnits="userSpaceOnUse" x="-29" y="-29" width="378" height="238"'
		);
		expect(svg.match(/<use href="#s"\/>/g)).toHaveLength(9);
		expect(svg).toContain(
			'<g transform="translate(640 360) scale(-1 -1)"><g clip-path="url(#c)">'
		);
		// Sharp and ramp masks draw no pad and no reflections.
		for (const mask of [
			defaultMask("rectangle", ID),
			{ ...defaultMask("linear", ID), feather: 0.5 },
		]) {
			expect(maskSvgPad(mask, 320, 180)).toBe(0);
			const plain = maskToSvg(mask, 320, 180);
			expect(plain).toContain('viewBox="0 0 320 180"');
			expect(plain).not.toContain("<use");
		}
	});

	test("text is escaped for markup", () => {
		expect(
			maskToSvg({ ...defaultMask("text", ID), text: 'A "b"' }, 160, 90)
		).toContain("A ”b”</text>");
	});
});

describe("mask strokes", () => {
	const stroked = (patch: Partial<Mask> = {}): Mask => ({
		...defaultMask("rectangle", ID),
		strokeWidth: 0.05,
		...patch,
	});

	test("the schema bounds stroke fields and refuses text strokes", () => {
		expect(maskSchema.parse(stroked({ strokeAlign: "outside" }))).toMatchObject(
			{ strokeAlign: "outside", strokeWidth: 0.05 }
		);
		expect(maskSchema.safeParse(stroked({ strokeWidth: 0.2 })).success).toBe(
			false
		);
		expect(
			maskSchema.safeParse(stroked({ strokeColor: "white" })).success
		).toBe(false);
		expect(
			maskSchema.safeParse({ ...defaultMask("text", ID), strokeWidth: 0.02 })
				.success
		).toBe(false);
	});

	test("switching a stroked mask to text drops the stroke", () => {
		const [mask] = updateMask(
			[stroked({ strokeAlign: "inside", strokeColor: "#ff0000" })],
			ID,
			{ shape: "text" }
		);
		expect(mask?.shape).toBe("text");
		expect(mask?.strokeWidth).toBeUndefined();
		expect(mask?.strokeColor).toBeUndefined();
		expect(mask?.strokeAlign).toBeUndefined();
		const [kept] = updateMask([stroked()], ID, { shape: "ellipse" });
		expect(kept?.strokeWidth).toBe(0.05);
	});

	test("defaults and the band follow the alignment", () => {
		expect(maskHasStroke(defaultMask("ellipse", ID))).toBe(false);
		expect(maskHasStroke(stroked())).toBe(true);
		expect(maskStrokeColorOf(stroked())).toBe("#ffffff");
		expect(maskStrokeAlignOf(stroked())).toBe("center");
		expect(maskStrokeWidthPx(stroked(), 200)).toBe(10);
		expect(maskStrokeBand(stroked(), 200)).toEqual({ inner: -5, outer: 5 });
		expect(maskStrokeBand(stroked({ strokeAlign: "inside" }), 200)).toEqual({
			inner: -10,
			outer: 0,
		});
		expect(maskStrokeBand(stroked({ strokeAlign: "outside" }), 200)).toEqual({
			inner: 0,
			outer: 10,
		});
		expect(maskStrokeBand(defaultMask("ellipse", ID), 200)).toEqual({
			inner: 0,
			outer: 0,
		});
	});

	test("signed distances are negative inside and measure pixels", () => {
		const geometry = { halfHeight: 50, halfWidth: 100 };
		const rectangle = stroked();
		expect(maskSignedDistance(rectangle, 0, 0, geometry)).toBe(-50);
		expect(maskSignedDistance(rectangle, 110, 0, geometry)).toBe(10);
		expect(maskSignedDistance(rectangle, 103, 54, geometry)).toBe(5);
		const ellipse = { ...rectangle, shape: "ellipse" as const };
		expect(maskSignedDistance(ellipse, 100, 0, geometry)).toBeCloseTo(0, 6);
		expect(maskSignedDistance(ellipse, 0, 60, geometry)).toBeCloseTo(10, 0);
		expect(maskSignedDistance(ellipse, 0, 0, geometry)).toBeLessThan(0);
		const polygon = { ...defaultMask("polygon", ID), sides: 4 };
		expect(maskSignedDistance(polygon, 0, 0, geometry)).toBeLessThan(0);
		expect(maskSignedDistance(polygon, 0, -60, geometry)).toBeCloseTo(10, 6);
		const linear = defaultMask("linear", ID);
		expect(maskSignedDistance(linear, 0, -7, geometry)).toBe(-7);
		const mirror = defaultMask("mirror", ID);
		expect(maskSignedDistance(mirror, 0, -60, geometry)).toBe(10);
		expect(
			maskSignedDistance(defaultMask("heart", ID), 0, 20, geometry)
		).toBeLessThan(0);
	});

	test("detailed outlines are simplified for stroke distances", () => {
		const path = Array.from({ length: 64 }, (_, index) => {
			const angle = (index / 64) * 2 * Math.PI;
			return {
				outX: 0.9 * Math.cos(angle) - 0.05 * Math.sin(angle),
				outY: 0.9 * Math.sin(angle) + 0.05 * Math.cos(angle),
				x: 0.9 * Math.cos(angle),
				y: 0.9 * Math.sin(angle),
			};
		});
		const mask = { ...defaultMask("freeform", ID), path };
		expect(maskOutline(mask)).toHaveLength(512);
		const simplified = maskDistanceOutline(mask);
		expect(simplified.length).toBeLessThanOrEqual(MAX_STROKE_OUTLINE_EDGES);
		expect(simplified.length).toBeGreaterThan(16);
		for (const point of maskOutline(mask) ?? []) {
			expect(insideOutline(simplified, point.x * 0.99, point.y * 0.99)).toBe(
				true
			);
		}
		const star = defaultMask("star", ID);
		expect(maskDistanceOutline(star)).toEqual(maskOutline(star) ?? []);
	});

	test("the reference stroke covers the band around the edge", () => {
		const mask = stroked({ height: 0.5, width: 0.5 });
		// 200x100 frame: the box spans x 50..150, y 25..75; stroke 5 px.
		expect(maskStrokeAlphaAt(mask, 50, 50, 200, 100)).toBe(1);
		expect(maskStrokeAlphaAt(mask, 100, 50, 200, 100)).toBe(0);
		expect(maskStrokeAlphaAt(mask, 10, 50, 200, 100)).toBe(0);
		const outside = { ...mask, strokeAlign: "outside" as const };
		expect(maskStrokeAlphaAt(outside, 47, 50, 200, 100)).toBe(1);
		expect(maskStrokeAlphaAt(outside, 52, 50, 200, 100)).toBe(0);
		const inside = { ...mask, strokeAlign: "inside" as const };
		expect(maskStrokeAlphaAt(inside, 47, 50, 200, 100)).toBe(0);
		expect(maskStrokeAlphaAt(inside, 52, 50, 200, 100)).toBe(1);
		expect(
			maskStrokeAlphaAt(defaultMask("rectangle", ID), 50, 50, 200, 100)
		).toBe(0);
	});

	test("the preview stroke SVG follows the alignment", () => {
		expect(maskStrokeSvg(defaultMask("ellipse", ID), 200, 100)).toBeUndefined();
		expect(maskStrokeSvgUrl(defaultMask("ellipse", ID), 200, 100)).toBe(
			undefined
		);
		const center = maskStrokeSvg(stroked({ strokeColor: "#ff0000" }), 200, 100);
		expect(center).toContain('stroke="#ff0000" stroke-width="5"');
		expect(center).toContain('stroke-linejoin="round"');
		expect(center).not.toContain("<mask");
		const inside = maskStrokeSvg(stroked({ strokeAlign: "inside" }), 200, 100);
		expect(inside).toContain('stroke-width="10"');
		expect(inside).toContain('<rect width="200" height="100" fill="#000"/>');
		const outside = maskStrokeSvg(
			stroked({ strokeAlign: "outside" }),
			200,
			100
		);
		expect(outside).toContain('<rect width="200" height="100" fill="#fff"/>');
		const linear = maskStrokeSvg(
			{ ...defaultMask("linear", ID), strokeWidth: 0.05 },
			200,
			100
		);
		expect(linear).toContain('y="-2.5"');
		expect(linear).not.toContain("stroke=");
		const flipped = maskStrokeSvg(stroked(), 200, 100, { flipX: true });
		expect(flipped).toContain("translate(200 0) scale(-1 1)");
		expect(maskStrokeSvgUrl(stroked(), 200, 100)).toStartWith(
			'url("data:image/svg+xml,'
		);
	});
});
