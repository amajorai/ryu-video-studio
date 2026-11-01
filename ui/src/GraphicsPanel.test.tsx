import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type Graphic, graphicSchema } from "../../shared/project.ts";
import {
	addGraphicKeyframe,
	GraphicsPanel,
	removeGraphicKeyframe,
	setGraphicKeyframeInterpolation,
	withGraphicFields,
} from "./GraphicsPanel.tsx";

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

describe("graphic field helpers", () => {
	test("cleared optional fields leave no key behind", () => {
		const rotated = withGraphicFields(graphic(), {
			blendMode: "screen",
			rotation: 15,
		});
		expect(rotated.rotation).toBe(15);
		expect(rotated.blendMode).toBe("screen");
		const cleared = withGraphicFields(rotated, {
			blendMode: undefined,
			rotation: undefined,
		});
		expect("rotation" in cleared).toBe(false);
		expect("blendMode" in cleared).toBe(false);
		expect(graphicSchema.parse(cleared)).toEqual(graphic());
	});

	test("keyframes record the current value at the playhead", () => {
		const first = addGraphicKeyframe(
			graphic(),
			"x",
			1,
			"00000000-0000-4000-8000-000000000002"
		);
		expect(first.keyframes).toEqual([
			{
				id: "00000000-0000-4000-8000-000000000002",
				property: "x",
				time: 0,
				value: 0.1,
			},
		]);
		const moved = {
			...first,
			keyframes: [
				...(first.keyframes ?? []),
				{
					id: "00000000-0000-4000-8000-000000000003",
					property: "x" as const,
					time: 2,
					value: 0.5,
				},
			],
		};
		const middle = addGraphicKeyframe(
			moved,
			"x",
			2,
			"00000000-0000-4000-8000-000000000004"
		);
		expect(middle.keyframes?.map((keyframe) => keyframe.time)).toEqual([
			0, 1, 2,
		]);
		expect(middle.keyframes?.[1]?.value).toBe(0.3);
		// Re-recording at the same time replaces rather than duplicates.
		const again = addGraphicKeyframe(
			middle,
			"x",
			2,
			"00000000-0000-4000-8000-000000000005"
		);
		expect(again.keyframes).toHaveLength(3);
		expect(graphicSchema.safeParse(again).success).toBe(true);
	});

	test("keyframes outside the graphic are ignored and removal clears the field", () => {
		const outside = graphic();
		expect(addGraphicKeyframe(outside, "rotation", 0.5, "id")).toBe(outside);
		const keyed = addGraphicKeyframe(
			graphic({ rotation: 30 }),
			"rotation",
			2,
			"00000000-0000-4000-8000-000000000006"
		);
		expect(keyed.keyframes?.[0]?.value).toBe(30);
		const removed = removeGraphicKeyframe(
			keyed,
			"00000000-0000-4000-8000-000000000006"
		);
		expect("keyframes" in removed).toBe(false);
	});
});

describe("keyframe easing", () => {
	const id = "00000000-0000-4000-8000-000000000007";
	const keyed = (fields: Partial<NonNullable<Graphic["keyframes"]>[number]>) =>
		graphic({
			keyframes: [{ id, property: "x", time: 1, value: 0.5, ...fields }],
		});

	test("sets an easing and linear removes the field", () => {
		const eased = setGraphicKeyframeInterpolation(keyed({}), id, "ease-in-out");
		expect(eased.keyframes?.[0]?.interpolation).toBe("ease-in-out");
		expect(graphicSchema.safeParse(eased).success).toBe(true);
		const linear = setGraphicKeyframeInterpolation(eased, id, "linear");
		expect(linear.keyframes?.[0]).toEqual({
			id,
			property: "x",
			time: 1,
			value: 0.5,
		});
	});

	test("bezier needs existing control points; other easings drop them", () => {
		const plain = keyed({});
		expect(setGraphicKeyframeInterpolation(plain, id, "bezier")).toBe(plain);
		const curved = keyed({
			bezier: [0.4, 0, 0.2, 1],
			interpolation: "bezier",
		});
		expect(setGraphicKeyframeInterpolation(curved, id, "bezier")).toEqual(
			curved
		);
		const held = setGraphicKeyframeInterpolation(curved, id, "hold");
		expect(held.keyframes?.[0]?.interpolation).toBe("hold");
		expect("bezier" in (held.keyframes?.[0] ?? {})).toBe(false);
		expect(graphicSchema.safeParse(held).success).toBe(true);
		expect(setGraphicKeyframeInterpolation(curved, "missing", "hold")).toBe(
			curved
		);
	});
});

describe("GraphicsPanel", () => {
	const render = (graphics: Graphic[]) =>
		renderToStaticMarkup(
			<GraphicsPanel
				graphics={graphics}
				onChange={() => undefined}
				styleProfile="clean-professional"
				time={2}
			/>
		);

	test("offers every shape and the new controls", () => {
		const markup = render([graphic({ shape: "star" })]);
		for (const label of ["Polygon", "Star", "Heart", "Arrow"]) {
			expect(markup).toContain(`>${label}</option>`);
		}
		expect(markup).toContain('aria-label="Vector shape 1 points"');
		expect(markup).toContain('aria-label="Vector shape 1 inner radius"');
		expect(markup).toContain('aria-label="Vector shape 1 rotation"');
		expect(markup).toContain('aria-label="Vector shape 1 stroke alignment"');
		expect(markup).toContain('aria-label="Vector shape 1 blend mode"');
		expect(markup).toContain("Add keyframe at playhead");
		expect(markup).not.toContain('aria-label="Vector shape 1 sides"');
	});

	test("graphic masks use the mask editor without text masks", () => {
		const markup = render([
			graphic({
				masks: [
					{
						feather: 0,
						height: 1,
						id: "00000000-0000-4000-8000-0000000000c1",
						invert: false,
						opacity: 1,
						rotation: 0,
						shape: "star",
						strokeWidth: 0.02,
						width: 1,
						x: 0,
						y: 0,
					},
				],
			}),
		]);
		expect(markup).toContain('aria-label="Graphic masks"');
		expect(markup).toContain('aria-label="Edit mask 1: Star"');
		expect(markup).toContain('aria-label="Mask stroke width"');
		expect(markup).toContain('aria-label="New mask shape"');
		expect(markup).not.toContain('<option value="text">');
		expect(render([graphic()])).not.toContain('aria-label="Graphic masks"');
	});

	test("keyframe rows name the visible property and offer easing", () => {
		const markup = render([
			graphic({
				keyframes: [
					{
						id: "00000000-0000-4000-8000-000000000008",
						interpolation: "ease-out",
						property: "x",
						time: 0,
						value: 0.1,
					},
					{
						bezier: [0.4, 0, 0.2, 1],
						id: "00000000-0000-4000-8000-000000000009",
						interpolation: "bezier",
						property: "y",
						time: 1,
						value: 0.3,
					},
				],
			}),
		]);
		expect(markup).toContain(
			'aria-label="Remove Left keyframe at 0.00 seconds"'
		);
		expect(markup).toContain(
			'aria-label="Left keyframe at 0.00 seconds, easing to the next keyframe"'
		);
		expect(markup).not.toContain("Remove x keyframe");
		expect(markup).toMatch(/value="ease-out" selected="">Ease out<\/option>/);
		expect(markup).toContain(">Hold</option>");
		// Only a keyframe that already has a curve offers "Custom curve".
		expect(markup.match(/>Custom curve<\/option>/g)).toHaveLength(1);
	});

	test("shape-specific fields follow the shape", () => {
		expect(render([graphic({ shape: "polygon" })])).toContain(
			'aria-label="Vector shape 1 sides"'
		);
		expect(render([graphic({ shape: "rectangle" })])).toContain(
			'aria-label="Vector shape 1 corner radius"'
		);
		expect(render([graphic({ shape: "line" })])).not.toContain(
			"stroke alignment"
		);
	});
});
