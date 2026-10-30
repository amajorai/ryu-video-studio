import { describe, expect, test } from "bun:test";
import {
	applyLayout,
	isLayoutFillCrop,
	type Layout,
	layoutRange,
	layoutRequestSchema,
	layoutSchema,
	layoutSlots,
	layoutSupported,
	slotFillCrop,
	slotRect,
} from "./layouts.ts";
import {
	type Asset,
	newProject,
	newSegment,
	projectSchema,
} from "./project.ts";
import { previewScaleFactors } from "./transform.ts";

function asset(id: string) {
	return {
		id,
		name: id,
		kind: "video" as const,
		duration: 4,
		width: 640,
		height: 360,
		hasAudio: false,
		createdAt: new Date().toISOString(),
	};
}

describe("timeline layout presets", () => {
	test("places selected clips in order and clears conflicting framing keyframes", () => {
		const first = asset(crypto.randomUUID());
		const second = asset(crypto.randomUUID());
		const project = newProject("Layout");
		const firstSegment = newSegment(first);
		firstSegment.keyframes = [
			{ id: crypto.randomUUID(), property: "x", time: 1, value: 0.4 },
			{ id: crypto.randomUUID(), property: "rotation", time: 1, value: 20 },
		];
		project.segments = [firstSegment, newSegment(second, 0, 1)];
		const next = applyLayout(
			project,
			[project.segments[0]!.id, project.segments[1]!.id],
			"side-by-side"
		);
		expect(next.segments.map(({ scale, x, y }) => ({ scale, x, y }))).toEqual([
			{ scale: 0.5, x: -0.5, y: 0 },
			{ scale: 0.5, x: 0.5, y: 0 },
		]);
		expect(next.segments[0]?.keyframes.map((frame) => frame.property)).toEqual([
			"rotation",
		]);
	});
	test("bounds named layout selection", () => {
		expect(layoutRange("grid-2x2")).toEqual({ max: 4, min: 2 });
		expect(layoutRange("grid-3x3")).toEqual({ max: 9, min: 2 });
		expect(layoutRange("grid-4x4")).toEqual({ max: 16, min: 2 });
		expect(() =>
			applyLayout(newProject("Invalid"), [], "picture-in-picture")
		).toThrow("Picture in picture needs 2 visual clips");
	});
	test("fills larger grids in deterministic top-left order", () => {
		const project = newProject("Large grid");
		const assets = Array.from({ length: 9 }, () => asset(crypto.randomUUID()));
		project.segments = assets.map((item, index) => newSegment(item, index));
		const next = applyLayout(
			project,
			project.segments.map((segment) => segment.id),
			"grid-3x3"
		);
		expect(next.segments[0]?.scale).toBeCloseTo(1 / 3, 12);
		expect(next.segments[0]?.x).toBeCloseTo(-2 / 3, 12);
		expect(next.segments[0]?.y).toBeCloseTo(-2 / 3, 12);
		expect(next.segments[8]?.scale).toBeCloseTo(1 / 3, 12);
		expect(next.segments[8]?.x).toBeCloseTo(2 / 3, 12);
		expect(next.segments[8]?.y).toBeCloseTo(2 / 3, 12);
	});
	test("every layout has a slot table matching its range", () => {
		for (const layout of layoutSchema.options) {
			expect(layoutSupported(layout)).toBe(true);
			expect(layoutSlots(layout).length).toBe(layoutRange(layout).max);
			expect(layoutSlots(layout)).toEqual(layoutSlots(layout));
		}
	});
});

const area = (layout: Layout) =>
	layoutSlots(layout)
		.map(slotRect)
		.reduce((sum, rect) => sum + rect.width * rect.height, 0);

const overlaps = (layout: Layout) => {
	const rects = layoutSlots(layout).map(slotRect);
	return rects.some((a, i) =>
		rects.some(
			(b, j) =>
				j > i &&
				Math.min(a.left + a.width, b.left + b.width) -
					Math.max(a.left, b.left) >
					1e-9 &&
				Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top) >
					1e-9
		)
	);
};

describe("new layout slot tables", () => {
	test("tiling layouts cover the canvas exactly once", () => {
		for (const layout of ["main-sidebar", "three-up", "three-stack"] as const) {
			expect(area(layout)).toBeCloseTo(1, 12);
			expect(overlaps(layout)).toBe(false);
			for (const rect of layoutSlots(layout).map(slotRect)) {
				expect(rect.left).toBeGreaterThanOrEqual(-1e-12);
				expect(rect.top).toBeGreaterThanOrEqual(-1e-12);
				expect(rect.left + rect.width).toBeLessThanOrEqual(1 + 1e-12);
				expect(rect.top + rect.height).toBeLessThanOrEqual(1 + 1e-12);
			}
		}
		for (const layout of ["grid-2x2", "grid-3x3", "grid-4x4"] as const) {
			expect(area(layout)).toBeCloseTo(1, 12);
			expect(overlaps(layout)).toBe(false);
		}
	});

	test("main-sidebar splits 70/30", () => {
		const [main, side] = layoutSlots("main-sidebar").map(slotRect);
		expect(main).toMatchObject({ height: 1, left: 0, top: 0 });
		expect(main?.width).toBeCloseTo(0.7, 12);
		expect(side?.left).toBeCloseTo(0.7, 12);
		expect(side?.width).toBeCloseTo(0.3, 12);
	});

	test("three-up and three-stack are thirds", () => {
		const columns = layoutSlots("three-up").map(slotRect);
		const rows = layoutSlots("three-stack").map(slotRect);
		columns.forEach((rect, index) => {
			expect(rect.left).toBeCloseTo(index / 3, 12);
			expect(rect.width).toBeCloseTo(1 / 3, 12);
			expect(rect.height).toBe(1);
		});
		rows.forEach((rect, index) => {
			expect(rect.top).toBeCloseTo(index / 3, 12);
			expect(rect.height).toBeCloseTo(1 / 3, 12);
			expect(rect.width).toBe(1);
		});
	});

	test("corner insets are 25% with a 4% margin over a full-frame main", () => {
		const corners = {
			"pip-bottom-left": { left: 0.04, top: 0.71 },
			"pip-bottom-right": { left: 0.71, top: 0.71 },
			"pip-top-left": { left: 0.04, top: 0.04 },
			"pip-top-right": { left: 0.71, top: 0.04 },
		} as const;
		for (const [layout, expected] of Object.entries(corners)) {
			const [main, inset] = layoutSlots(layout as Layout).map(slotRect);
			expect(main).toEqual({ height: 1, left: 0, top: 0, width: 1 });
			expect(inset?.width).toBeCloseTo(0.25, 12);
			expect(inset?.height).toBeCloseTo(0.25, 12);
			expect(inset?.left).toBeCloseTo(expected.left, 12);
			expect(inset?.top).toBeCloseTo(expected.top, 12);
		}
	});

	test("legacy slot positions are unchanged", () => {
		expect(layoutSlots("picture-in-picture")).toEqual([
			{ scale: 1, x: 0, y: 0 },
			{ scale: 0.35, x: 0.55, y: -0.55 },
		]);
		expect(layoutSlots("stacked")).toEqual([
			{ scale: 0.5, x: 0, y: -0.5 },
			{ scale: 0.5, x: 0, y: 0.5 },
		]);
	});
});

const wide = (id = crypto.randomUUID()): Asset => ({
	createdAt: new Date().toISOString(),
	duration: 4,
	hasAudio: false,
	height: 1080,
	id,
	kind: "video",
	name: id,
	width: 1920,
});

function projectWith(count: number) {
	const assets = Array.from({ length: count }, () => wide());
	const project = newProject("Fill");
	project.segments = assets.map((item, index) => newSegment(item, 0, index));
	return { assets, ids: project.segments.map((s) => s.id), project };
}

describe("fit and fill", () => {
	test("three-up with fill crops every cell with no letterboxing", () => {
		const { assets, ids, project } = projectWith(3);
		const next = applyLayout(project, ids, "three-up", { assets, fit: "fill" });
		for (const segment of next.segments) {
			expect(segment.fit).toBe("fill");
			expect(segment.scaleX).toBeCloseTo(1 / 3, 12);
			expect(segment.crop.left).toBeGreaterThan(0);
			expect(segment.crop.right).toBeGreaterThan(0);
			expect(segment.crop.top).toBe(0);
			// Cropped aspect equals the cell aspect (640x1080 of a 1920x1080 canvas).
			const keptAspect =
				(1920 * (1 - segment.crop.left - segment.crop.right)) / 1080;
			expect(keptAspect).toBeCloseTo(project.width / 3 / project.height, 4);
		}
		expect(() => projectSchema.parse(next)).not.toThrow();
	});

	test("fill crop for each new layout matches the cell aspect", () => {
		const canvas = { height: 1080, width: 1920 };
		const asset = { height: 1080, width: 1920 };
		const expectations: Record<string, (string | null)[]> = {
			"main-sidebar": ["sides", "sides"],
			"pip-top-left": [null, null],
			"three-stack": ["topBottom", "topBottom", "topBottom"],
			"three-up": ["sides", "sides", "sides"],
		};
		for (const [layout, axes] of Object.entries(expectations)) {
			layoutSlots(layout as Layout).forEach((slot, index) => {
				const crop = slotFillCrop(slot, asset, canvas);
				const rect = slotRect(slot);
				const cellAspect =
					(canvas.width * rect.width) / (canvas.height * rect.height);
				const keptAspect =
					(asset.width * (1 - (crop?.left ?? 0) - (crop?.right ?? 0))) /
					(asset.height * (1 - (crop?.top ?? 0) - (crop?.bottom ?? 0)));
				expect(keptAspect).toBeCloseTo(cellAspect, 4);
				const axis = axes[index];
				if (axis === "sides") {
					expect(crop?.left).toBeGreaterThan(0);
				} else if (axis === "topBottom") {
					expect(crop?.top).toBeGreaterThan(0);
				} else {
					expect(crop).toEqual({ bottom: 0, left: 0, right: 0, top: 0 });
				}
			});
		}
	});

	test("unknown asset size keeps the crop and relies on the render fill", () => {
		expect(
			slotFillCrop(
				layoutSlots("three-up")[0]!,
				{ height: 0, width: 0 },
				{
					height: 1080,
					width: 1920,
				}
			)
		).toBeNull();
	});

	test("fill replaces crop keyframes; fit clears fill; omitted keeps both", () => {
		const { assets, ids, project } = projectWith(2);
		project.segments[0] = {
			...project.segments[0]!,
			crop: { bottom: 0.1, left: 0, right: 0, top: 0 },
			fit: "stretch",
			keyframes: [
				{ id: crypto.randomUUID(), property: "cropLeft", time: 1, value: 0.2 },
				{ id: crypto.randomUUID(), property: "scaleX", time: 1, value: 2 },
			],
			scaleX: 2,
		};
		const kept = applyLayout(project, ids, "side-by-side");
		expect(kept.segments[0]).toMatchObject({
			crop: { bottom: 0.1 },
			fit: "stretch",
		});
		expect(kept.segments[0]?.scaleX).toBeUndefined();
		expect("scaleX" in kept.segments[0]!).toBe(false);
		expect(kept.segments[0]?.keyframes.map((f) => f.property)).toEqual([
			"cropLeft",
		]);
		const filled = applyLayout(project, ids, "main-sidebar", {
			assets,
			fit: "fill",
		});
		expect(filled.segments[0]?.keyframes).toEqual([]);
		expect(filled.segments[0]?.crop.bottom).toBe(0);
		const fitted = applyLayout(filled, ids, "main-sidebar", { fit: "fit" });
		expect("fit" in fitted.segments[0]!).toBe(false);
		expect(fitted.segments[0]?.scaleX).toBeCloseTo(0.7, 12);
	});

	test("legacy layouts keep the serialized key order", () => {
		const { ids, project } = projectWith(2);
		const next = applyLayout(project, ids, "side-by-side");
		expect(Object.keys(next.segments[0]!)).toEqual(
			Object.keys(project.segments[0]!)
		);
	});

	test("unknown asset size fills with a canvas-aspect crop", () => {
		const { ids, project } = projectWith(3);
		const next = applyLayout(project, ids, "three-up", { fit: "fill" });
		for (const segment of next.segments) {
			expect(segment.fit).toBe("fill");
			// Canvas-aspect media cropped to a 1/3-width cell keeps its middle third.
			expect(segment.crop.left).toBeCloseTo(1 / 3, 5);
			expect(segment.crop.right).toBeCloseTo(1 / 3, 5);
		}
		const unsized = projectWith(3);
		const zeroSized = unsized.assets.map((item) => ({
			...item,
			height: 0,
			width: 0,
		}));
		expect(
			applyLayout(unsized.project, unsized.ids, "three-up", {
				assets: zeroSized,
				fit: "fill",
			}).segments.map((segment) => segment.crop)
		).toEqual(next.segments.map((segment) => segment.crop));
	});

	test("preview inset times scale lands on the cell for three-up fill", () => {
		// The preview draws canvas-aspect media over the canvas, clips it with
		// the crop as an inset of that box and scales by previewScaleFactors.
		// For canvas-aspect (or unknown-size) media this must equal the cell.
		const { ids, project } = projectWith(3);
		const next = applyLayout(project, ids, "three-up", { fit: "fill" });
		next.segments.forEach((segment, index) => {
			const factors = previewScaleFactors("fill", {
				scale: segment.scale,
				scaleX: segment.scaleX ?? 1,
				scaleY: segment.scaleY ?? 1,
			});
			const width =
				project.width *
				(1 - segment.crop.left - segment.crop.right) *
				factors.x;
			const height =
				project.height *
				(1 - segment.crop.top - segment.crop.bottom) *
				factors.y;
			const cell = slotRect(layoutSlots("three-up")[index]!);
			expect(width).toBeCloseTo(project.width * cell.width, 2);
			expect(height).toBeCloseTo(project.height * cell.height, 2);
		});
	});

	test("fit after fill removes the layout crop but keeps a user crop", () => {
		const { assets, ids, project } = projectWith(2);
		const filled = applyLayout(project, ids, "main-sidebar", {
			assets,
			fit: "fill",
		});
		expect(filled.segments[0]?.crop.left).toBeGreaterThan(0);
		expect(isLayoutFillCrop(filled.segments[0]!, project, { assets })).toBe(
			true
		);
		const fitted = applyLayout(filled, ids, "main-sidebar", {
			assets,
			fit: "fit",
		});
		for (const segment of fitted.segments) {
			expect(segment.crop).toEqual({ bottom: 0, left: 0, right: 0, top: 0 });
			expect("fit" in segment).toBe(false);
		}
		// A crop the user changed after the fill is theirs and is kept.
		const edited = {
			...filled,
			segments: filled.segments.map((segment, index) =>
				index === 0
					? { ...segment, crop: { bottom: 0.2, left: 0, right: 0, top: 0.05 } }
					: segment
			),
		};
		const keptUser = applyLayout(edited, ids, "main-sidebar", {
			assets,
			fit: "fit",
		});
		expect(keptUser.segments[0]?.crop).toEqual({
			bottom: 0.2,
			left: 0,
			right: 0,
			top: 0.05,
		});
		// Keep leaves a fill crop alone.
		const kept = applyLayout(filled, ids, "main-sidebar");
		expect(kept.segments[0]?.crop).toEqual(filled.segments[0]!.crop);
	});

	test("refuses clips on a locked track", () => {
		const { assets, ids, project } = projectWith(2);
		const locked = {
			...project,
			trackSettings: [
				{
					locked: true,
					muted: false,
					name: "Track",
					solo: false,
					track: project.segments[0]!.track,
				},
			],
		};
		expect(() =>
			applyLayout(locked, ids, "pip-top-left", { assets, fit: "fill" })
		).toThrow("Unlock");
		expect(() => applyLayout(locked, ids, "side-by-side")).toThrow("Unlock");
	});

	test("route body is strict with an optional fit", () => {
		const body = {
			layout: "three-up",
			revision: 1,
			segmentIds: [crypto.randomUUID()],
		};
		expect(layoutRequestSchema.parse(body).fit).toBeUndefined();
		expect(layoutRequestSchema.parse({ ...body, fit: "fill" }).fit).toBe(
			"fill"
		);
		expect(() =>
			layoutRequestSchema.parse({ ...body, fit: "stretch" })
		).toThrow();
		expect(() => layoutRequestSchema.parse({ ...body, extra: 1 })).toThrow();
	});
});
