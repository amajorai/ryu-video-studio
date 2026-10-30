import { describe, expect, test } from "bun:test";
import {
	animatedRange,
	animatedValue,
	animationExpression,
	bezierPieceLimit,
	boundaryKeyframe,
	isAnimated,
	retimeKeyframes,
	subCurve,
} from "./animation.ts";
import { compileFfmpegExpression } from "./ffmpeg-expression-eval.ts";
import type { BezierControls, KeyframeEasing } from "./keyframe-easing.ts";
import {
	type Keyframe,
	newProject,
	newSegment,
	type Segment,
	validateProject,
} from "./project.ts";
import type { KeyframeProperty } from "./schema/keyframe.ts";

const asset = {
	createdAt: new Date().toISOString(),
	duration: 20,
	hasAudio: true,
	height: 360,
	id: crypto.randomUUID(),
	kind: "video" as const,
	name: "Clip",
	width: 640,
};

const effectId = crypto.randomUUID();

function clip(keyframes: Omit<Keyframe, "id">[]): Segment {
	const segment = { ...newSegment(asset), sourceOut: 10 };
	segment.effects = [
		{ amount: 0.5, enabled: true, id: effectId, type: "blur" },
	];
	segment.keyframes = keyframes.map((frame) => ({
		...frame,
		id: crypto.randomUUID(),
	}));
	return segment;
}

const easings: { bezier?: BezierControls; kind: KeyframeEasing }[] = [
	{ kind: "linear" },
	{ kind: "hold" },
	{ kind: "ease-in" },
	{ kind: "ease-out" },
	{ kind: "ease-in-out" },
	{ bezier: [0.25, 0.1, 0.25, 1], kind: "bezier" },
	{ bezier: [0.34, 1.56, 0.64, 1], kind: "bezier" },
];

const eased = (
	property: KeyframeProperty,
	easing: (typeof easings)[number],
	from: number,
	to: number,
	extra: Partial<Keyframe> = {}
): Omit<Keyframe, "id">[] => [
	{
		property,
		time: 1,
		value: from,
		interpolation: easing.kind,
		...(easing.bezier ? { bezier: easing.bezier } : {}),
		...extra,
	},
	{ property, time: 3, value: to, ...extra },
	{ property, time: 6, value: from, interpolation: "ease-in-out", ...extra },
	{ property, time: 8, value: to, ...extra },
];

describe("animatedValue easing", () => {
	test("each interval eases by its starting keyframe", () => {
		const value = (kind: KeyframeEasing, bezier?: BezierControls) =>
			animatedValue(clip(eased("x", { kind, bezier }, 0, 1)), "x", 2);
		expect(value("linear")).toBeCloseTo(0.5);
		expect(value("hold")).toBe(0);
		expect(value("ease-in")).toBeCloseTo(0.25);
		expect(value("ease-out")).toBeCloseTo(0.75);
		expect(value("ease-in-out")).toBeCloseTo(0.5);
		expect(value("bezier", [0.25, 0.1, 0.25, 1])).toBeCloseTo(0.8024, 3);
	});

	test("hold jumps at the next keyframe and keeps later intervals", () => {
		const segment = clip(eased("opacity", { kind: "hold" }, 1, 0.2));
		expect(animatedValue(segment, "opacity", 2.999)).toBe(1);
		expect(animatedValue(segment, "opacity", 3)).toBe(0.2);
		// The 3 → 6 interval is linear again.
		expect(animatedValue(segment, "opacity", 4.5)).toBeCloseTo(0.6);
		// ease-in-out from 6 to 8
		expect(animatedValue(segment, "opacity", 7)).toBeCloseTo(0.6);
	});

	test("before the first keyframe the static value leads in linearly", () => {
		const segment = clip(eased("x", { kind: "ease-in" }, 0.5, 1));
		segment.x = 0;
		expect(animatedValue(segment, "x", 0.5)).toBeCloseTo(0.25);
	});

	test("legacy keyframes without interpolation stay linear", () => {
		const segment = clip([
			{ property: "scale", time: 0, value: 1 },
			{ property: "scale", time: 2, value: 2 },
		]);
		expect(animatedValue(segment, "scale", 0.5)).toBe(1.25);
	});
});

describe("animationExpression matches animatedValue", () => {
	const properties: KeyframeProperty[] = [
		"x",
		"opacity",
		"brightness",
		"cropLeft",
	];
	for (const easing of easings) {
		test(`${easing.kind}${easing.bezier ? ` ${easing.bezier.join(",")}` : ""}`, () => {
			for (const property of properties) {
				const to = property === "brightness" ? -0.5 : 0.8;
				const segment = clip(eased(property, easing, 0.1, to));
				const run = compileFfmpegExpression(
					animationExpression(segment, property, "T")
				);
				for (let i = 0; i <= 50; i++) {
					const time = (i / 50) * 10;
					const expected = animatedValue(segment, property, time);
					// The Bezier render fit is within 1% of the value change.
					const tolerance = easing.kind === "bezier" ? 0.01 * 0.7 : 1e-9;
					expect(Math.abs(run({ T: time }) - expected)).toBeLessThanOrEqual(
						tolerance
					);
				}
			}
		});
	}

	test("targeted channels evaluate their own target", () => {
		const segment = clip(
			eased("effectAmount", { kind: "ease-out" }, 0, 1, { target: effectId })
		);
		const run = compileFfmpegExpression(
			animationExpression(segment, "effectAmount", "t", effectId)
		);
		expect(run({ t: 2 })).toBeCloseTo(0.75, 9);
		expect(animationExpression(segment, "effectAmount", "t")).toBe("0");
	});

	test("linear keyframes keep the historical expression text", () => {
		const segment = clip([
			{ property: "x", time: 0, value: 0 },
			{ property: "x", time: 2, value: 1 },
		]);
		expect(animationExpression(segment, "x", "T")).toBe(
			"if(lt(T,2),0+(1)*max(0,(T-0))/2,1)"
		);
	});

	test("hold intervals are constants", () => {
		const segment = clip([
			{ interpolation: "hold", property: "opacity", time: 0, value: 1 },
			{ property: "opacity", time: 2, value: 0.2 },
		]);
		expect(animationExpression(segment, "opacity", "T")).toBe(
			"if(lt(T,2),1,0.2)"
		);
	});
});

describe("retimeKeyframes keeps eased curves", () => {
	const channels: { property: KeyframeProperty; target?: string }[] = [
		{ property: "x" },
		{ property: "brightness" },
		{ property: "cropLeft" },
		{ property: "temperature" },
		{ property: "effectAmount", target: effectId },
	];

	for (const easing of easings.filter((item) => item.kind !== "linear")) {
		test(`trims through ${easing.kind} intervals`, () => {
			for (const { property, target } of channels) {
				const extra = target === undefined ? {} : { target };
				const original = clip(eased(property, easing, 0.1, 0.6, extra));
				for (const [shift, duration] of [
					[2, 8],
					[0, 7],
					[2, 5],
					[1.5, 1],
				] as const) {
					const keyframes = retimeKeyframes(original, shift, duration);
					const trimmed = { ...original, keyframes };
					const project = newProject("Retime");
					project.segments = [
						{ ...trimmed, sourceIn: shift, sourceOut: shift + duration },
					];
					expect(() => validateProject(project, [asset])).not.toThrow();
					// Exact subdivision, except where an overshooting half leaves the
					// schema's control bounds: that half keeps the original curve,
					// within 1% of the 0.5 value change.
					const overshoot = easing.bezier?.some((value) => value > 1);
					const tolerance = overshoot ? 0.005 : 1e-4;
					for (let i = 0; i <= 50; i++) {
						const time = (i / 50) * duration;
						expect(
							Math.abs(
								animatedValue(trimmed, property, time, target) -
									animatedValue(original, property, time + shift, target)
							)
						).toBeLessThanOrEqual(tolerance);
					}
				}
			}
		});
	}

	test("legacy linear keyframes are untouched by a trim", () => {
		const original = clip([
			{ property: "x", time: 0, value: 0 },
			{ property: "x", time: 4, value: 1 },
		]);
		const keyframes = retimeKeyframes(original, 1, 2);
		for (const frame of keyframes) {
			expect(frame.interpolation).toBeUndefined();
			expect(frame.bezier).toBeUndefined();
		}
		expect(keyframes.map((frame) => [frame.time, frame.value])).toEqual([
			[0, 0.25],
			[2, 0.75],
		]);
	});

	test("boundary keyframes carry the rest of the curve", () => {
		const original = clip(eased("x", { kind: "ease-in" }, 0, 1));
		const frame = boundaryKeyframe(original, { property: "x" }, 0, 2);
		expect(frame.value).toBeCloseTo(0.25);
		expect(frame.interpolation).toBe("bezier");
		const trimmed = {
			...original,
			keyframes: [
				frame,
				...original.keyframes
					.filter((item) => item.time >= 3)
					.map((item) => ({ ...item, time: item.time - 2 })),
			],
		};
		expect(animatedValue(trimmed, "x", 0.5)).toBeCloseTo(
			animatedValue(original, "x", 2.5),
			6
		);
	});

	test("subCurve of the whole interval is the curve itself", () => {
		expect(subCurve({ kind: "ease-out" }, 0, 1)).toEqual({ kind: "ease-out" });
		expect(subCurve({ kind: "ease-in" }, 0, 0.5)).toEqual({ kind: "ease-in" });
	});
});

describe("channel helpers", () => {
	test("isAnimated tracks a property and target", () => {
		const segment = clip(
			eased("effectAmount", { kind: "linear" }, 0, 1, { target: effectId })
		);
		expect(isAnimated(segment, "effectAmount", effectId)).toBe(true);
		expect(isAnimated(segment, "effectAmount")).toBe(false);
		expect(isAnimated(segment, "x")).toBe(false);
	});

	test("animatedRange includes eased overshoot", () => {
		const segment = clip(
			eased("x", { bezier: [0.34, 1.56, 0.64, 1], kind: "bezier" }, 0, 0.5)
		);
		const range = animatedRange(segment, "x");
		expect(range.min).toBe(0);
		expect(range.max).toBeGreaterThan(0.5);
		const flat = clip([]);
		flat.crop.left = 0.2;
		expect(animatedRange(flat, "cropLeft")).toEqual({ max: 0.2, min: 0.2 });
	});
});

describe("render expression budget", () => {
	const bezierFrames = (count: number) =>
		Array.from({ length: count }, (_, index) => ({
			bezier: [1, -1, 0, 2] as BezierControls,
			id: `k${index}`,
			interpolation: "bezier" as const,
			property: "opacity" as const,
			time: index,
			value: index % 2,
		}));

	test("a clip's Bezier keyframes share a piece budget", () => {
		expect(bezierPieceLimit({ keyframes: [] })).toBe(32);
		expect(bezierPieceLimit({ keyframes: bezierFrames(4) })).toBe(32);
		expect(bezierPieceLimit({ keyframes: bezierFrames(16) })).toBe(8);
		expect(bezierPieceLimit({ keyframes: bezierFrames(200) })).toBe(1);
	});

	test("200 extreme Bezier keyframes stay a compact, exact-at-keys expression", () => {
		const segment = {
			...newSegment({ ...asset, duration: 300 }),
			sourceOut: 300,
			keyframes: bezierFrames(200),
		};
		const expression = animationExpression(segment, "opacity");
		expect(expression.length).toBeLessThan(48 * 1024);
		const evaluate = compileFfmpegExpression(expression);
		for (const time of [0, 1, 57, 198]) {
			expect(evaluate({ t: time })).toBeCloseTo(
				animatedValue(segment, "opacity", time),
				6
			);
		}
	});
});
