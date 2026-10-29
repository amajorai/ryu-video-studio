import { describe, expect, test } from "bun:test";
import {
	applyGraphicMasks,
	boxBlurMatte,
	graphicMaskPlacement,
	graphicMasksRequestSchema,
	maskedGraphicRaster,
	maskedGraphicRasterHalf,
	setGraphicMasks,
} from "./graphic-masks.ts";
import { defaultMask, type Mask } from "./masks.ts";
import { type Graphic, graphicSchema, newProject } from "./project.ts";
import {
	graphicRaster,
	graphicRasterHalf,
	usesLegacyDrawbox,
} from "./shape-geometry.ts";

const ID = "00000000-0000-4000-8000-000000000001";
const ID2 = "00000000-0000-4000-8000-000000000002";
const frame = { height: 200, width: 200 };

const graphic = (patch: Partial<Graphic> = {}): Graphic =>
	graphicSchema.parse({
		end: 4,
		fill: "#ff0000",
		height: 0.5,
		id: ID2,
		opacity: 1,
		shape: "rectangle",
		start: 0,
		width: 0.5,
		x: 0.25,
		y: 0.25,
		...patch,
	});

/** Pixel (x, y) of a raster, relative to the box center, in frame pixels. */
function pixelAt(
	raster: ReturnType<typeof graphicRaster>,
	dx: number,
	dy: number
): [number, number, number, number] {
	const half = raster.size / 2;
	const index =
		(Math.floor(half + dy) * raster.pixelSize + Math.floor(half + dx)) * 4;
	return [
		raster.pixels[index] ?? 0,
		raster.pixels[index + 1] ?? 0,
		raster.pixels[index + 2] ?? 0,
		raster.pixels[index + 3] ?? 0,
	];
}

describe("graphic mask schema and edits", () => {
	test("graphics take up to four non-text masks", () => {
		expect(graphic({ masks: [defaultMask("ellipse", ID)] }).masks).toHaveLength(
			1
		);
		expect(
			graphicSchema.safeParse({
				...graphic(),
				masks: [defaultMask("text", ID)],
			}).success
		).toBe(false);
		expect(
			graphicSchema.safeParse({
				...graphic(),
				masks: Array.from({ length: 5 }, () => defaultMask("ellipse", ID)),
			}).success
		).toBe(false);
	});

	test("masked graphics leave the legacy drawbox path", () => {
		expect(usesLegacyDrawbox(graphic())).toBe(true);
		expect(
			usesLegacyDrawbox(graphic({ masks: [defaultMask("ellipse", ID)] }))
		).toBe(false);
	});

	test("setGraphicMasks replaces or clears one graphic's masks", () => {
		const project = { ...newProject("Masks"), graphics: [graphic()] };
		const masked = setGraphicMasks(project, {
			graphicId: ID2,
			masks: [defaultMask("star", ID)],
		});
		expect(masked.graphics[0]?.masks?.[0]?.shape).toBe("star");
		const cleared = setGraphicMasks(masked, { graphicId: ID2, masks: null });
		expect("masks" in (cleared.graphics[0] ?? {})).toBe(false);
		expect(() =>
			setGraphicMasks(project, { graphicId: ID, masks: [] })
		).toThrow("That graphic is not in this project.");
		expect(
			graphicMasksRequestSchema.safeParse({
				graphicId: ID2,
				masks: [defaultMask("text", ID)],
				revision: 0,
			}).success
		).toBe(false);
	});
});

describe("masked graphic rasters", () => {
	test("an ellipse mask hides the box corners and keeps the center", () => {
		const masked = maskedGraphicRaster(
			graphic({ masks: [defaultMask("ellipse", ID)] }),
			frame,
			{ opacity: 1, rotation: 0 }
		);
		expect(pixelAt(masked, 0, 0)[3]).toBe(255);
		expect(pixelAt(masked, 45, 45)[3]).toBe(0);
		expect(pixelAt(masked, 45, 0)[3]).toBe(255);
	});

	test("invert keeps the outside of the mask", () => {
		const masked = maskedGraphicRaster(
			graphic({
				masks: [
					{
						...defaultMask("ellipse", ID),
						height: 0.5,
						invert: true,
						width: 0.5,
					},
				],
			}),
			frame,
			{ opacity: 1, rotation: 0 }
		);
		expect(pixelAt(masked, 0, 0)[3]).toBe(0);
		expect(pixelAt(masked, 45, 45)[3]).toBe(255);
	});

	test("masks turn with the baked rotation", () => {
		// A left-half rectangle mask; rotated 90° clockwise it covers the top.
		const mask: Mask = { ...defaultMask("rectangle", ID), width: 0.5, x: -0.5 };
		const masked = maskedGraphicRaster(graphic({ masks: [mask] }), frame, {
			opacity: 1,
			rotation: 90,
		});
		expect(pixelAt(masked, 0, -30)[3]).toBe(255);
		expect(pixelAt(masked, 0, 30)[3]).toBe(0);
	});

	test("a feather softens the mask edge", () => {
		const masked = maskedGraphicRaster(
			graphic({
				masks: [
					{
						...defaultMask("rectangle", ID),
						feather: 0.5,
						width: 0.5,
						x: -0.5,
					},
				],
			}),
			frame,
			{ opacity: 1, rotation: 0 }
		);
		const edge = pixelAt(masked, 0, 0)[3];
		expect(edge).toBeGreaterThan(60);
		expect(edge).toBeLessThan(200);
		expect(pixelAt(masked, -45, 0)[3]).toBeGreaterThan(200);
	});

	test("a stroked mask draws its band in the stroke color inside the box", () => {
		const masked = maskedGraphicRaster(
			graphic({
				masks: [
					{
						...defaultMask("ellipse", ID),
						strokeColor: "#00ff00",
						strokeWidth: 0.1,
					},
				],
			}),
			frame,
			{ opacity: 1, rotation: 0 }
		);
		// The ellipse edge at the box's right side is 50 px from the center.
		expect(pixelAt(masked, 49, 0)).toEqual([0, 255, 0, 255]);
		expect(pixelAt(masked, 0, 0)).toEqual([255, 0, 0, 255]);
		expect(pixelAt(masked, 54, 0)[3]).toBe(0);
	});

	test("stroked masks grow the raster to the whole box", () => {
		const ellipse = graphic({ shape: "ellipse" });
		const stroked = graphic({
			masks: [{ ...defaultMask("rectangle", ID), strokeWidth: 0.05 }],
			shape: "ellipse",
		});
		expect(maskedGraphicRasterHalf(ellipse, frame)).toBe(
			graphicRasterHalf(ellipse, frame)
		);
		expect(maskedGraphicRasterHalf(stroked, frame)).toBeGreaterThanOrEqual(
			Math.ceil(Math.hypot(100, 100) / 2)
		);
	});

	test("graphics without masks keep their raster", () => {
		const plain = graphic();
		const raster = graphicRaster(plain, frame, { opacity: 1, rotation: 0 });
		expect(
			applyGraphicMasks(raster, plain, frame, { opacity: 1, rotation: 0 })
		).toBe(raster);
	});

	test("the box blur keeps a flat matte flat", () => {
		const flat = new Float32Array(16).fill(0.5);
		expect(
			[...boxBlurMatte(flat, 4, 1)].every(
				(value) => Math.abs(value - 0.5) < 1e-6
			)
		).toBe(true);
		expect(boxBlurMatte(flat, 4, 0)).toBe(flat);
	});
});

describe("graphic mask preview placement", () => {
	test("places mask and stroke images on the rotated box", () => {
		const placement = graphicMaskPlacement(
			graphic({
				masks: [
					{ ...defaultMask("ellipse", ID), feather: 0.2 },
					{ ...defaultMask("rectangle", ID2), strokeWidth: 0.05 },
				],
				rotation: 30,
			}),
			frame,
			1
		);
		expect(placement?.box).toEqual({ height: 100, width: 100 });
		expect(placement?.transform).toBe(
			"translate(100 100) rotate(30) translate(-50 -50)"
		);
		expect(placement?.layers).toHaveLength(2);
		expect(placement?.layers[0]?.image.x).toBeLessThan(0);
		expect(placement?.layers[0]?.stroke).toBeUndefined();
		expect(placement?.layers[1]?.image.width).toBe(100);
		expect(placement?.layers[1]?.image.x).toBe(0);
		expect(placement?.layers[1]?.stroke).toStartWith("data:image/svg+xml,");
		expect(graphicMaskPlacement(graphic(), frame, 1)).toBeUndefined();
	});
});
