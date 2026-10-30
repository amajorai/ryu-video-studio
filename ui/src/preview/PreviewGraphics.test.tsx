import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type Graphic,
	graphicSchema,
	newProject,
	type Project,
} from "../../../shared/project.ts";
import {
	graphicFramePoints,
	graphicFrameRegions,
	svgPathData,
} from "../../../shared/shape-geometry.ts";
import {
	graphicStyle,
	PreviewGraphics,
	shapeDrawing,
	shapeLayerStyle,
} from "./PreviewGraphics.tsx";

const frame = { height: 360, width: 640 };

function graphic(fields: Partial<Graphic> = {}): Graphic {
	return graphicSchema.parse({
		end: 3,
		fill: "#ff0000",
		height: 0.25,
		id: "00000000-0000-4000-8000-000000000001",
		opacity: 0.8,
		start: 1,
		stroke: "#ffff00",
		width: 0.25,
		x: 0.1,
		y: 0.2,
		...fields,
	});
}

function project(graphics: Graphic[]): Project {
	return { ...newProject("Shapes"), graphics, ...frame };
}

describe("vector shape preview", () => {
	test("legacy graphics keep their CSS box", () => {
		const markup = renderToStaticMarkup(
			<PreviewGraphics project={project([graphic()])} time={2} />
		);
		expect(markup).toStartWith('<div class="studio-graphic"');
		expect(markup).not.toContain("<svg");
		expect(graphicStyle(graphic(), 2)["--studio-graphic-width"]).toBe("25%");
	});

	test("new shapes draw the shared outline as an SVG path", () => {
		const star = graphic({ shape: "star" });
		const markup = renderToStaticMarkup(
			<PreviewGraphics project={project([star])} time={2} />
		);
		expect(markup).toContain('class="studio-graphic"');
		expect(markup).toContain('viewBox="0 0 640 360"');
		expect(markup).toContain(
			`d="${svgPathData(graphicFramePoints(star, frame, 2))}"`
		);
		expect(markup).toContain('opacity="0.8"');
		expect(markup).not.toContain("clipPath");
	});

	test("hidden outside the graphic's time range", () => {
		expect(
			renderToStaticMarkup(
				<PreviewGraphics
					project={project([graphic({ shape: "heart" })])}
					time={3}
				/>
			)
		).toBe("");
	});

	test("stroke alignment maps onto SVG stroke width, order and clipping", () => {
		const strokeWidth = 10 / 360;
		const inside = shapeDrawing(
			graphic({ shape: "arrow", strokeAlign: "inside", strokeWidth }),
			frame,
			2
		);
		expect(inside.clipStroke).toBe(true);
		expect(inside.strokeOrder).toBe("over");
		expect(inside.strokeWidth).toBeCloseTo(20, 6);
		const outside = shapeDrawing(
			graphic({ shape: "arrow", strokeAlign: "outside", strokeWidth }),
			frame,
			2
		);
		expect(outside.clipStroke).toBe(false);
		expect(outside.strokeOrder).toBe("under");
		expect(outside.strokeWidth).toBeCloseTo(20, 6);
		const center = shapeDrawing(
			graphic({ shape: "arrow", strokeAlign: "center", strokeWidth }),
			frame,
			2
		);
		expect(center.strokeOrder).toBe("over");
		expect(center.strokeWidth).toBeCloseTo(10, 6);
		const markup = renderToStaticMarkup(
			<PreviewGraphics
				project={project([
					graphic({ shape: "arrow", strokeAlign: "inside", strokeWidth }),
				])}
				time={2}
			/>
		);
		expect(markup).toContain("<clipPath");
		expect(markup).toContain('stroke-linejoin="round"');
	});

	test("stroked rectangles draw the render's two regions", () => {
		// 0.05 of 640x360: 32 px left/right and 18 px top/bottom, like drawbox.
		const rectangle = graphic({
			blendMode: "multiply",
			shape: "rectangle",
			strokeWidth: 0.05,
		});
		const drawing = shapeDrawing(rectangle, frame, 2);
		const regions = graphicFrameRegions(rectangle, frame, 2);
		expect(drawing.strokeWidth).toBe(0);
		expect(drawing.regions).toEqual({
			inner: svgPathData(regions?.inner ?? []),
			outer: svgPathData(regions?.outer ?? []),
		});
		expect(regions?.inner[0]).toEqual({ x: 64 + 32, y: 72 + 18 });
		const markup = renderToStaticMarkup(
			<PreviewGraphics project={project([rectangle])} time={2} />
		);
		expect(markup).toContain(`fill="#ffff00"`);
		expect(markup).toContain(`d="${drawing.regions?.inner}" fill="#ff0000"`);
		expect(markup).not.toContain("stroke-width");
	});

	test("lines fill with the stroke color and never stroke", () => {
		const line = shapeDrawing(
			graphic({ rotation: 30, shape: "line", strokeWidth: 0.02 }),
			frame,
			2
		);
		expect(line.fill).toBe("#ffff00");
		expect(line.strokeWidth).toBe(0);
	});

	test("keyframed opacity and rotation follow the playhead", () => {
		const animated = graphic({
			keyframes: [
				{
					id: "00000000-0000-4000-8000-000000000002",
					property: "opacity",
					time: 1,
					value: 0,
				},
				{
					id: "00000000-0000-4000-8000-000000000003",
					property: "rotation",
					time: 1,
					value: 90,
				},
			],
			shape: "polygon",
		});
		expect(shapeDrawing(animated, frame, 1.5).opacity).toBeCloseTo(0.4, 6);
		expect(shapeDrawing(animated, frame, 1.5).path).toBe(
			svgPathData(graphicFramePoints(animated, frame, 1.5))
		);
		expect(shapeDrawing(animated, frame, 1.5).path).not.toBe(
			shapeDrawing(animated, frame, 1).path
		);
	});

	test("blend modes become mix-blend-mode on the shape layer", () => {
		expect(shapeLayerStyle(graphic({ blendMode: "screen" })).mixBlendMode).toBe(
			"screen"
		);
		expect(shapeLayerStyle(graphic()).mixBlendMode).toBeUndefined();
		expect(shapeLayerStyle(graphic())["--studio-graphic-width"]).toBe("100%");
	});
});

describe("graphic masks in the preview", () => {
	test("masks wrap the shape in SVG masks and strokes draw over it", () => {
		const markup = renderToStaticMarkup(
			<PreviewGraphics
				project={project([
					graphic({
						masks: [
							{
								feather: 0,
								height: 1,
								id: "00000000-0000-4000-8000-0000000000a1",
								invert: false,
								opacity: 1,
								rotation: 0,
								shape: "ellipse",
								strokeColor: "#00ff00",
								strokeWidth: 0.05,
								width: 1,
								x: 0,
								y: 0,
							},
						],
					}),
				])}
				time={2}
			/>
		);
		expect(markup).toContain("<mask");
		expect(markup).toContain('style="mask-type:alpha"');
		expect(markup).toContain('mask="url(#');
		expect(markup).toContain("data-graphic-mask-strokes");
		expect(markup).toContain("data:image/svg+xml,");
		expect(markup).toContain(
			'transform="translate(144 117) rotate(0) translate(-80 -45)"'
		);
	});

	test("unmasked shapes draw no masks", () => {
		const markup = renderToStaticMarkup(
			<PreviewGraphics
				project={project([graphic({ rotation: 10 })])}
				time={2}
			/>
		);
		expect(markup).not.toContain("<mask");
	});
});
