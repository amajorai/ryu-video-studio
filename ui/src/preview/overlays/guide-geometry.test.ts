import { describe, expect, test } from "bun:test";
import {
	aspectRect,
	type GuideRect,
	isPreviewGuideId,
	normalizeCustomGuide,
	PREVIEW_GUIDE_IDS,
	parseGuideAspect,
	previewGuideShapes,
	safeAreaRect,
	verticalArea,
} from "./guide-geometry.ts";

const rects = (shapes: ReturnType<typeof previewGuideShapes>) =>
	shapes.filter((shape): shape is GuideRect => shape.kind === "rect");

describe("preview guide geometry", () => {
	test("safe areas are centered 90% and 80% boxes", () => {
		expect(safeAreaRect(1920, 1080, 0.9)).toEqual({
			height: 972,
			width: 1728,
			x: 96,
			y: 54,
		});
		const [action, title] = rects(
			previewGuideShapes(["title-safe", "action-safe"], 1920, 1080)
		);
		expect(action?.id).toBe("action-safe");
		expect(title).toMatchObject({ height: 864, width: 1536, x: 192, y: 108 });
	});

	test("aspect guides pillarbox narrower and letterbox wider ratios", () => {
		expect(aspectRect(1920, 1080, 9 / 16)).toEqual({
			height: 1080,
			width: 607.5,
			x: 656.25,
			y: 0,
		});
		const scope = aspectRect(1920, 1080, 2.39);
		expect(scope.width).toBe(1920);
		expect(scope.height).toBeCloseTo(1920 / 2.39);
		expect(scope.y).toBeCloseTo((1080 - 1920 / 2.39) / 2);
	});

	test("an aspect guide equal to the frame's aspect draws nothing", () => {
		expect(previewGuideShapes(["aspect-1:1"], 1080, 1080)).toEqual([]);
		expect(previewGuideShapes(["aspect-9:16"], 1080, 1920)).toEqual([]);
	});

	test("thirds and center cross are lines", () => {
		const thirds = previewGuideShapes(["thirds"], 900, 600);
		expect(thirds).toHaveLength(4);
		expect(thirds).toContainEqual({
			id: "thirds:v1",
			kind: "line",
			tone: "grid",
			x1: 300,
			x2: 300,
			y1: 0,
			y2: 600,
		});
		const cross = previewGuideShapes(["center"], 1000, 500);
		expect(cross).toContainEqual({
			id: "center:h",
			kind: "line",
			tone: "grid",
			x1: 480,
			x2: 520,
			y1: 250,
			y2: 250,
		});
	});

	test("vertical UI zones sit inside the 9:16 area", () => {
		const zones = rects(previewGuideShapes(["vertical-ui"], 1080, 1920));
		expect(zones.map((zone) => zone.id)).toEqual([
			"vertical-ui:top",
			"vertical-ui:rail",
			"vertical-ui:bottom",
		]);
		const [top, rail, bottom] = zones;
		expect(top).toMatchObject({ height: 153.6, width: 1080, x: 0, y: 0 });
		expect(rail).toMatchObject({ width: 162, x: 918, y: 153.6 });
		expect(rail?.height).toBeCloseTo(1920 - 153.6 - 384);
		expect(bottom).toMatchObject({ height: 384, y: 1536 });
		// On a landscape frame the zones follow the centered 9:16 box.
		const area = verticalArea(1920, 1080);
		const [landscapeTop] = rects(
			previewGuideShapes(["vertical-ui"], 1920, 1080)
		);
		expect(landscapeTop?.x).toBe(area.x);
		expect(landscapeTop?.width).toBe(area.width);
	});

	test("shapes follow the fixed guide order and ignore unknown ids", () => {
		const ids = previewGuideShapes(
			["center", "bogus", "action-safe"],
			1920,
			1080
		).map((shape) => shape.id);
		expect(ids).toEqual(["action-safe", "center:h", "center:v"]);
		expect(isPreviewGuideId("bogus")).toBe(false);
		expect(previewGuideShapes(PREVIEW_GUIDE_IDS, 0, 1080)).toEqual([]);
	});
});

describe("custom guides and vertical layouts", () => {
	test("aspect text parses W:H and decimals within 1:10..10:1", () => {
		expect(parseGuideAspect("2.35:1")).toBeCloseTo(2.35, 6);
		expect(parseGuideAspect("4/5")).toBeCloseTo(0.8, 6);
		expect(parseGuideAspect("1.85")).toBeCloseTo(1.85, 6);
		expect(parseGuideAspect("")).toBeNull();
		expect(parseGuideAspect("20:1")).toBeNull();
		expect(parseGuideAspect("abc")).toBeNull();
	});

	test("the custom guide draws margins and an aspect box", () => {
		const shapes = previewGuideShapes(["custom"], 1920, 1080, {
			aspect: 1,
			margins: { bottom: 0.05, left: 0.1, right: 0.1, top: 0.05 },
		});
		expect(shapes.map((shape) => shape.id)).toEqual([
			"custom:margins",
			"custom:aspect",
		]);
		const [margins, aspect] = shapes as GuideRect[];
		expect(margins?.width).toBeCloseTo(1536, 6);
		expect(margins?.height).toBeCloseTo(972, 6);
		expect(margins?.x).toBeCloseTo(192, 6);
		expect(margins?.y).toBeCloseTo(54, 6);
		expect(aspect?.label).toBe("Custom 1:1");
		expect(aspect?.width).toBeCloseTo(1080, 6);
		expect(aspect?.x).toBeCloseTo(420, 6);
	});

	test("grid density follows the viewer's columns and rows", () => {
		const lines = previewGuideShapes(["grid"], 1000, 600, {
			gridColumns: 5,
			gridRows: 3,
		});
		expect(lines).toHaveLength(4 + 2);
		expect(lines[0]).toMatchObject({ x1: 200, x2: 200 });
		expect(
			normalizeCustomGuide({ gridColumns: 99, gridRows: 0 })
		).toMatchObject({ gridColumns: 24, gridRows: 2 });
	});

	test("generic vertical layouts mark the chrome of a 9:16 area", () => {
		const sheet = previewGuideShapes(["vertical-sheet"], 1080, 1920);
		expect(sheet.map((shape) => shape.id)).toEqual([
			"vertical-sheet:top",
			"vertical-sheet:bottom",
		]);
		expect((sheet[1] as GuideRect).label).toBe("Bottom sheet");
		expect((sheet[1] as GuideRect).height).toBeCloseTo(768, 6);
		const rail = previewGuideShapes(["vertical-rail"], 1080, 1920);
		const railZone = rail.find((shape) => shape.id === "vertical-rail:rail") as
			| GuideRect
			| undefined;
		expect(railZone?.width).toBeCloseTo(216, 6);
		expect(railZone?.x).toBeCloseTo(864, 6);
		expect(previewGuideShapes(["vertical-captions"], 1080, 1920)).toHaveLength(
			3
		);
	});
});
