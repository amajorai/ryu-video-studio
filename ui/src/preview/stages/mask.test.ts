import { describe, expect, test } from "bun:test";
import { defaultMask } from "../../../../shared/masks.ts";
import { newSegment, type Segment } from "../../../../shared/project.ts";
import { maskStrokeLayerStyle, mediaLayerStyle } from "../preview-style.ts";
import { maskFrameBox, maskStrokeStyle, maskStyle } from "./mask.ts";

const ID = "00000000-0000-4000-8000-000000000001";
const ID2 = "00000000-0000-4000-8000-000000000002";

const segment = (patch: Partial<Segment> = {}): Segment => ({
	...newSegment({
		createdAt: "2026-01-01T00:00:00.000Z",
		duration: 4,
		hasAudio: false,
		height: 1080,
		id: "00000000-0000-4000-8000-0000000000a1",
		kind: "video",
		name: "Clip",
		width: 1920,
	}),
	...patch,
});

const decode = (image: unknown) =>
	decodeURIComponent(String(image).split("data:image/svg+xml,")[1] ?? "");

describe("mask preview stage", () => {
	test("clips without masks add no CSS", () => {
		expect(maskStyle(segment(), 0)).toEqual({});
		expect(maskStyle(segment({ masks: [] }), 0)).toEqual({});
	});

	test("each mask is one intersected, unrepeated layer over the frame", () => {
		const style = maskStyle(
			segment({
				masks: [defaultMask("ellipse", ID), defaultMask("star", ID2)],
			}),
			0
		);
		expect(String(style.maskImage).match(/url\("data:/g)).toHaveLength(2);
		expect(style.WebkitMaskImage).toBe(style.maskImage);
		expect(style.maskComposite).toBe("intersect, intersect");
		expect(style.WebkitMaskComposite).toBe("source-in, source-in");
		expect(style.maskRepeat).toBe("no-repeat, no-repeat");
		expect(style.maskSize).toBe("100% 100%, 100% 100%");
		expect(style.maskPosition).toBe("50% 50%, 50% 50%");
	});

	test("masks sit over the crop window, drawn at its aspect", () => {
		const style = maskStyle(
			segment({
				crop: { bottom: 0, left: 0.25, right: 0.25, top: 0 },
				masks: [defaultMask("ellipse", ID)],
			}),
			0,
			{ height: 1000, width: 2000 }
		);
		expect(style.maskSize).toBe("50% 100%");
		expect(style.maskPosition).toBe("50% 50%");
		expect(decode(style.maskImage)).toContain('viewBox="0 0 1000 1000"');
		const left = maskStyle(
			segment({
				crop: { bottom: 0.5, left: 0.2, right: 0, top: 0 },
				masks: [defaultMask("ellipse", ID)],
			}),
			0
		);
		expect(left.maskPosition).toBe("100% 0%");
	});

	test("a 4:3 clip in a 16:9 project masks its pillarboxed picture, like the render", () => {
		const frame = { height: 1080, width: 1920 };
		const source = { height: 1080, width: 1440 };
		const { box, size } = maskFrameBox(segment(), frame, source);
		expect(size).toEqual(source);
		expect(box.left * frame.width).toBeCloseTo(240, 6);
		expect(box.width * frame.width).toBeCloseTo(1440, 6);
		expect(box.top).toBe(0);
		// Mask x = 0.5 is 75% across the picture: 240 + 0.75 × 1440 = 1320 px.
		const mask = { ...defaultMask("ellipse", ID), width: 0.5, x: 0.5 };
		const style = maskStyle(segment({ masks: [mask] }), 0, frame, source);
		expect(style.maskSize).toBe("75% 100%");
		expect(style.maskPosition).toBe("50% 50%");
		const svg = decode(style.maskImage);
		expect(svg).toContain('viewBox="0 0 1440 1080"');
		expect(svg).toContain("translate(1080 540)");
		expect((box.left + 0.75 * box.width) * frame.width).toBeCloseTo(1320, 6);
	});

	test("crop applies inside the letterboxed picture", () => {
		const { box, size } = maskFrameBox(
			segment({ crop: { bottom: 0, left: 0.5, right: 0, top: 0 } }),
			{ height: 1080, width: 1920 },
			{ height: 1080, width: 1440 }
		);
		expect(box.left * 1920).toBeCloseTo(960, 6);
		expect(box.width * 1920).toBeCloseTo(720, 6);
		expect(size).toEqual({ height: 1080, width: 720 });
	});

	test("a feathered mask's layer grows by the SVG's blur pad", () => {
		const style = maskStyle(
			segment({ masks: [{ ...defaultMask("rectangle", ID), feather: 0.5 }] }),
			0,
			{ height: 180, width: 320 }
		);
		// sigma 9 px → pad ceil(27) + 2 = 29 px on each side.
		const svg = decode(style.maskImage);
		expect(svg).toContain('viewBox="-29 -29 378 238"');
		expect(style.maskSize).toBe(
			`${Math.round((378 / 320) * 1e6) / 1e4}% ${Math.round((238 / 180) * 1e6) / 1e4}%`
		);
		expect(style.maskPosition).toBe("50% 50%");
	});

	test("keyframes move the preview mask", () => {
		const animated = segment({
			keyframes: [
				{ id: ID2, property: "maskX", target: ID, time: 0, value: -1 },
				{
					id: "00000000-0000-4000-8000-000000000003",
					property: "maskX",
					target: ID,
					time: 2,
					value: 1,
				},
			],
			masks: [defaultMask("ellipse", ID)],
		});
		expect(decode(maskStyle(animated, 0).maskImage)).toContain(
			"translate(0 540)"
		);
		expect(decode(maskStyle(animated, 1).maskImage)).toContain(
			"translate(960 540)"
		);
	});

	test("flipped clips mirror the drawn mask so it lands where the render puts it", () => {
		const flipped = maskStyle(
			segment({ flipH: true, masks: [defaultMask("ellipse", ID)] }),
			0
		);
		expect(decode(flipped.maskImage)).toContain(
			'<g transform="translate(1920 0) scale(-1 1)">'
		);
	});
});

describe("mask stroke preview", () => {
	test("masks without a stroke add no overlay", () => {
		expect(maskStrokeStyle(segment(), 0)).toBeUndefined();
		expect(
			maskStrokeStyle(segment({ masks: [defaultMask("ellipse", ID)] }), 0)
		).toBeUndefined();
	});

	test("each stroked mask is one background layer over the mask frame", () => {
		const style = maskStrokeStyle(
			segment({
				flipH: true,
				masks: [
					{
						...defaultMask("ellipse", ID),
						strokeColor: "#ff0000",
						strokeWidth: 0.02,
					},
					defaultMask("star", ID2),
				],
			}),
			0
		);
		expect(String(style?.backgroundImage).match(/url\("data:/g)).toHaveLength(
			1
		);
		const svg = decode(style?.backgroundImage);
		expect(svg).toContain('stroke="#ff0000"');
		expect(svg).toContain("translate(1920 0) scale(-1 1)");
		expect(style?.backgroundRepeat).toBe("no-repeat");
		expect(style?.backgroundSize).toBe("100% 100%");
	});

	test("the overlay keeps the clip's placement but drops masks and filters", () => {
		const clip = segment({
			masks: [{ ...defaultMask("rectangle", ID), strokeWidth: 0.03 }],
			scale: 0.5,
		});
		const media = {
			canvas: { height: 1080, width: 1920 },
			media: { height: 1080, width: 1920 },
		};
		const layer = mediaLayerStyle(clip, 0, { active: true, media });
		const overlay = maskStrokeLayerStyle(clip, 0, layer, media);
		expect(overlay?.["--studio-media-transform"]).toBe(
			layer["--studio-media-transform"]
		);
		expect(overlay?.["--studio-media-clip-path"]).toBe(
			layer["--studio-media-clip-path"]
		);
		expect(overlay?.maskImage).toBeUndefined();
		expect(overlay?.WebkitMaskImage).toBeUndefined();
		expect(overlay?.["--studio-media-filter"]).toBe("none");
		expect(overlay?.backgroundImage).toStartWith('url("data:image/svg+xml,');
		expect(maskStrokeLayerStyle(segment(), 0, layer, media)).toBeUndefined();
	});
});
