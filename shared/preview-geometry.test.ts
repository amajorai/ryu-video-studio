import { describe, expect, test } from "bun:test";
import {
	boxContainsPx,
	boxCornersPx,
	cropAspectRatio,
	cropGestureChanges,
	croppedBox,
	cropToAspect,
	cropWindowAspect,
	dragCropHandle,
	estimateTitleSize,
	fittedSize,
	frameToLocalPx,
	graphicBox,
	graphicGesturePatch,
	graphicScaleRange,
	handlePositionPx,
	localToFramePx,
	MAX_CROP_EDGE,
	moveBox,
	moveCrop,
	normalizeDegrees,
	normalizedToPixel,
	pixelToNormalized,
	rotateBox,
	rotationHandlePx,
	scaleBox,
	segmentGeometryPatch,
	segmentGestureChanges,
	segmentPlacement,
	segmentScaleRange,
	snapMove,
	snapRotation,
	snapTargets,
	type TransformBox,
	titleBox,
	titleGesturePatch,
	titleScaleRange,
	uncroppedBox,
	upsertKeyframe,
} from "./preview-geometry.ts";
import {
	type Asset,
	type Graphic,
	graphicSchema,
	newSegment,
	type Segment,
	segmentSchema,
	type Title,
	titleSchema,
} from "./project.ts";

const frame = { height: 1080, width: 1920 };
const square = { height: 1000, width: 1000 };

const asset: Asset = {
	createdAt: new Date(0).toISOString(),
	duration: 10,
	hasAudio: false,
	height: 1080,
	id: "00000000-0000-4000-8000-000000000001",
	kind: "video",
	name: "clip.mp4",
	width: 1920,
};

const segment = (patch: Partial<Segment> = {}): Segment => ({
	...newSegment(asset, 0),
	id: "00000000-0000-4000-8000-000000000002",
	...patch,
});

const ids = () => {
	let next = 0;
	return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
};

const box = (patch: Partial<TransformBox> = {}): TransformBox => ({
	cx: 0.5,
	cy: 0.5,
	height: 0.5,
	rotation: 0,
	width: 0.5,
	...patch,
});

describe("coordinates", () => {
	test("normalized and pixel coordinates round-trip", () => {
		const point = { x: 0.25, y: 0.8 };
		const pixel = normalizedToPixel(point, frame);
		expect(pixel).toEqual({ x: 480, y: 864 });
		expect(pixelToNormalized(pixel, frame)).toEqual(point);
		expect(pixelToNormalized({ x: 5, y: 5 }, { height: 0, width: 0 })).toEqual({
			x: 0,
			y: 0,
		});
	});

	test("box-local and frame pixels round-trip under rotation", () => {
		for (const rotation of [-170, -45, 0, 30, 90, 135]) {
			const rotated = box({ cx: 0.3, cy: 0.6, rotation, width: 0.2 });
			const local = { x: 37, y: -12 };
			const framePoint = localToFramePx(rotated, frame, local);
			const back = frameToLocalPx(rotated, frame, framePoint);
			expect(back.x).toBeCloseTo(local.x, 6);
			expect(back.y).toBeCloseTo(local.y, 6);
			const normalized = pixelToNormalized(framePoint, frame);
			const pixel = normalizedToPixel(normalized, frame);
			expect(pixel.x).toBeCloseTo(framePoint.x, 6);
			expect(pixel.y).toBeCloseTo(framePoint.y, 6);
		}
	});

	test("rotation is clockwise with y pointing down", () => {
		const turned = box({ height: 0.2, rotation: 90, width: 0.4 });
		const east = handlePositionPx(turned, square, "e");
		expect(east.x).toBeCloseTo(500, 6);
		expect(east.y).toBeCloseTo(700, 6);
		const knob = rotationHandlePx(box({ rotation: 90 }), square, 10);
		expect(knob.x).toBeCloseTo(760, 6);
		expect(knob.y).toBeCloseTo(500, 6);
	});

	test("corners run clockwise from the top-left and contain the center", () => {
		const corners = boxCornersPx(box(), square);
		expect(corners.map(({ x, y }) => [x, y])).toEqual([
			[250, 250],
			[750, 250],
			[750, 750],
			[250, 750],
		]);
		const diamond = box({ rotation: 45 });
		expect(boxContainsPx(diamond, square, { x: 500, y: 500 })).toBe(true);
		expect(boxContainsPx(diamond, square, { x: 260, y: 260 })).toBe(false);
	});
});

describe("rotation", () => {
	test("angles wrap into (-180, 180]", () => {
		expect(normalizeDegrees(190)).toBe(-170);
		expect(normalizeDegrees(-180)).toBe(180);
		expect(normalizeDegrees(540)).toBe(180);
		expect(normalizeDegrees(-30)).toBe(-30);
	});

	test("Shift snaps to 15 degree steps", () => {
		expect(snapRotation(7)).toBe(0);
		expect(snapRotation(8)).toBe(15);
		expect(snapRotation(-52)).toBe(-45);
		expect(snapRotation(173)).toBe(180);
		expect(snapRotation(44, 90)).toBe(0);
	});

	test("rotating follows the swept pointer angle", () => {
		const start = box();
		const top = { x: 500, y: 100 };
		const right = { x: 900, y: 500 };
		expect(rotateBox(start, top, right, square).rotation).toBeCloseTo(90);
		const nearly = { x: 900, y: 450 };
		const free = rotateBox(start, top, nearly, square);
		expect(free.rotation).toBeGreaterThan(80);
		expect(free.rotation).toBeLessThan(90);
		expect(rotateBox(start, top, nearly, square, true).rotation).toBe(90);
	});
});

describe("move and scale", () => {
	test("moving by 10% of the width shifts the center by 0.1", () => {
		const moved = moveBox(box(), { x: 192, y: -108 }, frame);
		expect(moved.cx).toBeCloseTo(0.6, 6);
		expect(moved.cy).toBeCloseTo(0.4, 6);
	});

	test("corner scaling keeps the opposite corner and the aspect ratio", () => {
		const start = box({ cx: 0.5, cy: 0.5, height: 0.4, width: 0.4 });
		const scaled = scaleBox(start, "se", { x: 850, y: 950 }, square);
		expect(scaled.width).toBeCloseTo(0.6, 6);
		expect(scaled.height).toBeCloseTo(0.6, 6);
		const anchor = handlePositionPx(scaled, square, "nw");
		expect(anchor.x).toBeCloseTo(300, 6);
		expect(anchor.y).toBeCloseTo(300, 6);
	});

	test("Alt scales about the center", () => {
		const scaled = scaleBox(
			box({ height: 0.4, width: 0.4 }),
			"se",
			{ x: 800, y: 800 },
			square,
			{ fromCenter: true }
		);
		expect(scaled.width).toBeCloseTo(0.6, 6);
		expect(scaled.cx).toBeCloseTo(0.5, 6);
		expect(scaled.cy).toBeCloseTo(0.5, 6);
	});

	test("edge handles scale one axis of a rotated box", () => {
		const start = box({ height: 0.2, rotation: 90, width: 0.4 });
		// The east handle points down after a 90 degree turn.
		const scaled = scaleBox(start, "e", { x: 500, y: 800 }, square);
		expect(scaled.width).toBeCloseTo(0.5, 6);
		expect(scaled.height).toBeCloseTo(0.2, 6);
		const west = handlePositionPx(scaled, square, "w");
		expect(west.x).toBeCloseTo(500, 6);
		expect(west.y).toBeCloseTo(300, 6);
	});

	test("scale factors respect the given range", () => {
		const scaled = scaleBox(
			box({ height: 0.4, width: 0.4 }),
			"se",
			{ x: 1000, y: 1000 },
			square,
			{ range: { x: [0.5, 1.2], y: [0.5, 1.2] } }
		);
		expect(scaled.width).toBeCloseTo(0.48, 6);
		const tiny = scaleBox(box(), "e", { x: 0, y: 500 }, square);
		expect(tiny.width * square.width).toBeGreaterThanOrEqual(4 - 1e-9);
	});
});

describe("snapping", () => {
	test("a box near the canvas center snaps to it and reports the guide", () => {
		const nearly = box({ cx: 0.503, cy: 0.2, width: 0.2 });
		const result = snapMove(nearly, snapTargets([], frame), frame);
		expect(result.box.cx).toBeCloseTo(0.5, 6);
		expect(result.guides).toEqual({ x: 0.5, y: null });
	});

	test("edges snap to other items and to the frame edges", () => {
		const other = box({ cx: 0.2, cy: 0.5, height: 0.2, width: 0.2 });
		const moving = box({ cx: 0.382, cy: 0.9, height: 0.2, width: 0.16 });
		const result = snapMove(moving, snapTargets([other], frame), frame);
		// Left edge 0.302 meets the other's right edge 0.3; bottom 1.0 is the frame.
		expect(result.box.cx).toBeCloseTo(0.38, 6);
		expect(result.guides.x).toBeCloseTo(0.3);
		expect(result.guides.y).toBe(1);
	});

	test("nothing snaps outside the threshold", () => {
		const far = box({ cx: 0.53, cy: 0.27, width: 0.1, height: 0.1 });
		const result = snapMove(far, snapTargets([], frame), frame);
		expect(result.box).toEqual(far);
		expect(result.guides).toEqual({ x: null, y: null });
	});
});

describe("clip placement", () => {
	test("media is contained in the canvas", () => {
		const vertical = { height: 1920, width: 1080 };
		const fitted = fittedSize(vertical, frame);
		expect(fitted.height).toBeCloseTo(1, 6);
		expect(fitted.width).toBeCloseTo((1080 / 1920) * (1080 / 1920), 6);
		expect(fittedSize({ height: 0, width: 0 }, frame)).toEqual({
			height: 1,
			width: 1,
		});
	});

	test("fit letterboxes, fill and stretch cover the box (render-stages/transform.ts)", () => {
		const vertical: Asset = { ...asset, height: 1920, width: 1080 };
		const [fit, fill, stretch] = (["fit", "fill", "stretch"] as const).map(
			(mode) => segmentPlacement(segment({ fit: mode }), vertical, frame, 0)
		);
		expect(fit?.visible.height).toBeCloseTo(1, 6);
		expect(fit?.visible.width).toBeCloseTo(0.3164, 4);
		for (const placement of [fill, stretch]) {
			expect(placement?.visible.width).toBeCloseTo(1, 6);
			expect(placement?.visible.height).toBeCloseTo(1, 6);
		}
		// Stretch distorts the whole source to the box; fill cuts a centred
		// canvas-aspect window, so the whole source is taller than the frame.
		expect(stretch?.full.height).toBeCloseTo(1, 6);
		expect(fill?.full.width).toBeCloseTo(1, 6);
		expect(fill?.full.height).toBeCloseTo((1920 / 1080) * (1920 / 1080), 4);
		expect(fill?.crop).toEqual({ bottom: 0, left: 0, right: 0, top: 0 });
	});

	test("placement follows x/y, scale and the scaleX/scaleY box", () => {
		const plain = segmentPlacement(
			segment({ scale: 0.5, x: 0.2 }),
			asset,
			frame,
			0
		);
		expect(plain.visible.cx).toBeCloseTo(0.6, 6);
		expect(plain.visible.width).toBeCloseTo(0.5, 6);
		expect(plain.visible.height).toBeCloseTo(0.5, 6);
		// Fit contains the media in a 2×0.5 box: the height limits it.
		const wide = segmentPlacement(
			segment({ scale: 0.5, scaleX: 2, scaleY: 0.5, x: 0.2 }),
			asset,
			frame,
			0
		);
		expect(wide.visible.cx).toBeCloseTo(0.6, 6);
		expect(wide.visible.width).toBeCloseTo(0.25, 6);
		expect(wide.visible.height).toBeCloseTo(0.25, 6);
		const stretched = segmentPlacement(
			segment({ fit: "stretch", scale: 0.5, scaleX: 2, scaleY: 0.5 }),
			asset,
			frame,
			0
		);
		expect(stretched.visible.width).toBeCloseTo(1, 6);
		expect(stretched.visible.height).toBeCloseTo(0.25, 6);
		const doubled = segmentPlacement(
			segment({ fit: "stretch", scaleX: 2 }),
			asset,
			frame,
			0
		);
		expect(doubled.visible.width).toBeCloseTo(2, 6);
		expect(doubled.visible.height).toBeCloseTo(1, 6);
	});

	test("a letterboxed crop matches the render: crop the source, then fit", () => {
		// 1440×1080 in 1920×1080 with 20% cropped from the left. The render
		// crops to 1152×1080 (`crop=iw*(1-0.2)`), scales it to fit
		// (`force_original_aspect_ratio=decrease`) and overlays it at (W-w)/2.
		const four3: Asset = { ...asset, height: 1080, width: 1440 };
		const clip = segment({ crop: { bottom: 0, left: 0.2, right: 0, top: 0 } });
		const placement = segmentPlacement(clip, four3, frame, 0);
		const renderWidth = 1440 * 0.8;
		const renderLeft = (1920 - renderWidth) / 2;
		expect(placement.visible.width).toBeCloseTo(renderWidth / 1920, 6);
		expect(placement.visible.cx).toBeCloseTo(
			(renderLeft + renderWidth / 2) / 1920,
			6
		);
		expect(placement.visible.height).toBeCloseTo(1, 6);
		// The whole source sits so that the crop leaves exactly that window.
		expect(placement.full.width).toBeCloseTo(0.75, 6);
		expect(placement.full.cx - placement.full.width / 2).toBeCloseTo(0.05, 6);
		expect(placement.full.cx + placement.full.width / 2).toBeCloseTo(0.8, 6);
	});

	test("a crop never moves the clip center; the kept part re-fits", () => {
		const clip = segment({
			crop: { bottom: 0.1, left: 0.3, right: 0, top: 0.2 },
			scale: 0.6,
			x: -0.1,
			y: 0.2,
		});
		const placement = segmentPlacement(clip, asset, frame, 0);
		expect(placement.visible.cx).toBeCloseTo(0.45, 6);
		expect(placement.visible.cy).toBeCloseTo(0.6, 6);
		// 1344×756 kept → contained at full height × 0.6 scale.
		expect(placement.visible.height).toBeCloseTo(0.6, 6);
		expect(placement.visible.width).toBeCloseTo(0.6, 6);
	});

	test("uncropped and cropped boxes invert each other under rotation", () => {
		const crop = { bottom: 0.1, left: 0.3, right: 0.05, top: 0.2 };
		const visible = box({
			cx: 0.4,
			cy: 0.55,
			height: 0.3,
			rotation: 30,
			width: 0.2,
		});
		const full = uncroppedBox(visible, crop, frame);
		const back = croppedBox(full, crop, frame);
		for (const key of ["cx", "cy", "height", "width", "rotation"] as const) {
			expect(back[key]).toBeCloseTo(visible[key], 6);
		}
	});

	test("inverting a placement reproduces the clip transform under rotation and crop", () => {
		const clip = segment({
			crop: { bottom: 0.1, left: 0.3, right: 0, top: 0.2 },
			rotation: 30,
			scale: 0.6,
			x: -0.1,
			y: 0.2,
		});
		const start = segmentPlacement(clip, asset, frame, 0);
		const moved = moveBox(start.visible, { x: 192, y: 0 }, frame);
		const changes = segmentGestureChanges(clip, start, moved, 0);
		expect(changes.x ?? Number.NaN).toBeCloseTo(0.1, 6);
		expect(changes.y).toBeUndefined();
		expect(changes.rotation).toBeUndefined();
		expect(changes.scale).toBeUndefined();
	});

	test("corners write scale; edges stretch one axis through scaleX / scaleY", () => {
		const clip = segment({ scale: 0.5 });
		const start = segmentPlacement(clip, asset, frame, 0);
		const corner = scaleBox(
			start.visible,
			"se",
			handlePositionPx(
				{ ...start.visible, width: 0.75, height: 0.75 },
				frame,
				"se"
			),
			frame,
			{ fromCenter: true }
		);
		const uniform = segmentGestureChanges(clip, start, corner, 0);
		expect(uniform.scale ?? Number.NaN).toBeCloseTo(0.75, 6);
		// An edge handle stretches the width only: scaleX, not scale.
		const edge = scaleBox(
			start.visible,
			"e",
			{ x: 1920 * 0.875, y: 540 },
			frame,
			{ fromCenter: true }
		);
		const stretched = segmentGestureChanges(clip, start, edge, 0);
		expect(Object.keys(stretched)).toEqual(["scaleX"]);
		expect(stretched.scaleX ?? Number.NaN).toBeCloseTo(1.5, 6);
		expect(segmentScaleRange(clip, 0).x).toEqual([0.2, 8]);
		// Edge handles are bounded by scaleX / scaleY (0.1..4 from 1).
		expect(segmentScaleRange(clip, 0, "e").x).toEqual([0.1, 4]);
	});
});

describe("clip-properties patches", () => {
	test("static properties change the clip field and stay schema-valid", () => {
		const clip = segment();
		const patch = segmentGeometryPatch(
			clip,
			{ rotation: 200, scale: 9, x: 0.2, y: 0 },
			1
		);
		expect(patch).toEqual({ rotation: 180, scale: 4, x: 0.2 });
		expect(() => segmentSchema.parse({ ...clip, ...patch })).not.toThrow();
	});

	test("a keyframed property gets a keyframe at the playhead", () => {
		const clip = segment({
			keyframes: [
				{
					id: "00000000-0000-4000-8000-0000000000a1",
					interpolation: "ease-in",
					property: "x",
					time: 0,
					value: 0,
				},
				{
					id: "00000000-0000-4000-8000-0000000000a2",
					property: "x",
					time: 4,
					value: 0.8,
				},
			],
		});
		const patch = segmentGeometryPatch(clip, { x: -0.5, y: 0.25 }, 2, {
			newId: ids(),
		});
		expect(patch.x).toBeUndefined();
		expect(patch.y).toBe(0.25);
		const inserted = patch.keyframes?.find((frame) => frame.time === 2);
		expect(inserted).toEqual({
			id: "00000000-0000-4000-8000-000000000001",
			interpolation: "ease-in",
			property: "x",
			time: 2,
			value: -0.5,
		});
		expect(() => segmentSchema.parse({ ...clip, ...patch })).not.toThrow();
		const replaced = segmentGeometryPatch(clip, { x: 0.1 }, 4.01, {
			tolerance: 0.02,
		});
		expect(replaced.keyframes).toHaveLength(2);
		expect(replaced.keyframes?.[1]?.value).toBe(0.1);
	});

	test("unchanged values write nothing", () => {
		expect(segmentGeometryPatch(segment(), { scale: 1, x: 0 }, 0)).toEqual({});
	});

	test("crop changes write a clamped crop object", () => {
		const clip = segment();
		const patch = segmentGeometryPatch(
			clip,
			cropGestureChanges({ bottom: 0, left: 0.95, right: 0.2, top: 0.1 }),
			0
		);
		expect(patch.crop?.left).toBeLessThanOrEqual(MAX_CROP_EDGE);
		expect(() => segmentSchema.parse({ ...clip, ...patch })).not.toThrow();
	});

	test("upsertKeyframe replaces within the tolerance", () => {
		const frames = upsertKeyframe([], "scale", 1, 2, { newId: ids() });
		expect(frames).toHaveLength(1);
		const again = upsertKeyframe(frames, "scale", 1.0001, 3, {
			tolerance: 0.01,
		});
		expect(again).toHaveLength(1);
		expect(again[0]?.value).toBe(3);
	});
});

describe("titles and graphics", () => {
	const title: Title = titleSchema.parse({
		color: "#ffffff",
		end: 3,
		fadeIn: 0,
		fadeOut: 0,
		fontSize: 0.1,
		id: "00000000-0000-4000-8000-0000000000b1",
		start: 0,
		text: "Hello\nworld!",
		x: 0.5,
		y: 0.5,
	});
	const graphic: Graphic = graphicSchema.parse({
		end: 3,
		fill: "#ff0000",
		height: 0.2,
		id: "00000000-0000-4000-8000-0000000000c1",
		opacity: 1,
		start: 0,
		width: 0.4,
		x: 0.1,
		y: 0.1,
	});

	test("title size is estimated from the longest line", () => {
		const size = estimateTitleSize(title, frame);
		expect(size.height).toBeCloseTo(0.24, 6);
		expect(size.width).toBeCloseTo((6 * 0.1 * 1080 * 0.56) / 1920, 6);
		const long = estimateTitleSize({ ...title, text: "x".repeat(200) }, frame);
		expect(long.width).toBe(0.9);
	});

	test("overlay boxes carry rotation and rotation gestures write it", () => {
		const turnedTitle = { ...title, rotation: 30 };
		const turnedGraphic = { ...graphic, rotation: 30 };
		const titleStart = titleBox(turnedTitle, { height: 0.2, width: 0.4 });
		expect(titleStart.rotation).toBe(30);
		expect(graphicBox(turnedGraphic).rotation).toBe(30);
		expect(
			titleGesturePatch(turnedTitle, titleStart, {
				...titleStart,
				rotation: 45,
			})
		).toEqual({ rotation: 45 });
		expect(
			graphicGesturePatch(turnedGraphic, {
				...graphicBox(turnedGraphic),
				rotation: 200,
			})
		).toEqual({ rotation: -160 });
		// An unrotated box leaves rotation unwritten.
		expect(
			titleGesturePatch(
				title,
				titleBox(title, { height: 0.2, width: 0.4 }),
				titleBox(title, { height: 0.2, width: 0.4 })
			)
		).toEqual({});
	});

	test("scaling a title changes its font size; moving changes its center", () => {
		const start = titleBox(title, { height: 0.2, width: 0.4 });
		const grown = { ...moveBox(start, { x: 192, y: 0 }, frame), width: 0.6 };
		const patch = titleGesturePatch(title, start, grown);
		expect(patch).toEqual({ fontSize: 0.15, x: 0.6 });
		const [minimum = 0, maximum = 0] = titleScaleRange(title).x ?? [];
		expect(minimum).toBeCloseTo(0.2, 6);
		expect(maximum).toBeCloseTo(2, 6);
		expect(() => titleSchema.parse({ ...title, ...patch })).not.toThrow();
	});

	test("graphics keep their top-left anchor and size limits", () => {
		const start = graphicBox(graphic);
		expect(start.cx).toBeCloseTo(0.3, 6);
		const moved = moveBox(start, { x: 192, y: 108 }, frame);
		expect(graphicGesturePatch(graphic, moved)).toEqual({ x: 0.2, y: 0.2 });
		const wide = { ...start, width: 2 };
		const patch = graphicGesturePatch(graphic, wide);
		expect(patch.width).toBe(1);
		const [minimum = 0, maximum = 0] = graphicScaleRange(graphic).x ?? [];
		expect(minimum).toBeCloseTo(0.05, 6);
		expect(maximum).toBeCloseTo(2.5, 6);
		expect(() => graphicSchema.parse({ ...graphic, ...patch })).not.toThrow();
	});
});

describe("crop", () => {
	const content = { height: 1080, width: 1920 };
	const none = { bottom: 0, left: 0, right: 0, top: 0 };

	test("aspect presets produce windows with that pixel aspect", () => {
		for (const id of ["16:9", "9:16", "1:1", "4:5", "4:3"] as const) {
			const ratio = cropAspectRatio(id);
			if (ratio === null) {
				throw new Error(`missing ratio for ${id}`);
			}
			const crop = cropToAspect(none, ratio, content);
			expect(cropWindowAspect(crop, content)).toBeCloseTo(ratio, 2);
		}
		expect(cropAspectRatio("free")).toBeNull();
	});

	test("a 9:16 window is centered and full height", () => {
		const crop = cropToAspect(none, 9 / 16, content);
		expect(crop.top).toBe(0);
		expect(crop.bottom).toBe(0);
		expect(crop.left).toBeCloseTo(crop.right, 4);
	});

	test("locked corner drags keep the aspect ratio and the opposite corner", () => {
		const start = cropToAspect(none, 1, content);
		const dragged = dragCropHandle(
			start,
			"se",
			{ x: -0.1, y: -0.02 },
			{ content, ratio: 1 }
		);
		expect(cropWindowAspect(dragged, content)).toBeCloseTo(1, 3);
		expect(dragged.left).toBeCloseTo(start.left, 4);
		expect(dragged.top).toBeCloseTo(start.top, 4);
		expect(
			dragCropHandle(start, "e", { x: 0.1, y: 0 }, { content, ratio: 1 })
		).toEqual(start);
	});

	test("free drags move one edge and keep a visible window", () => {
		const dragged = dragCropHandle(
			none,
			"w",
			{ x: 0.25, y: 0.3 },
			{ content, ratio: null }
		);
		expect(dragged).toEqual({ bottom: 0, left: 0.25, right: 0, top: 0 });
		const collapsed = dragCropHandle(
			none,
			"e",
			{ x: -2, y: 0 },
			{ content, ratio: null }
		);
		expect(collapsed.right).toBeLessThanOrEqual(MAX_CROP_EDGE);
		expect(collapsed.left + collapsed.right).toBeLessThan(1);
	});

	test("moving the window keeps its size inside the source", () => {
		const start = { bottom: 0.25, left: 0.25, right: 0.25, top: 0.25 };
		expect(moveCrop(start, { x: 0.5, y: -0.1 })).toEqual({
			bottom: 0.35,
			left: 0.5,
			right: 0,
			top: 0.15,
		});
	});
});
