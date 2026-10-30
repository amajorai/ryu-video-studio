import { describe, expect, test } from "bun:test";
import {
	type AdjustmentLayer,
	activeAdjustmentLayers,
	adjustmentEnable,
	adjustmentLayerAsSegment,
	adjustmentLayerEditRequestSchema,
	adjustmentLayerHasEffect,
	adjustmentLayersAfterTrack,
	adjustmentLayerValuesAt,
	adjustmentPresets,
	adjustmentPreviewApproximate,
	editAdjustmentLayers,
	neutralAdjustmentPatch,
	orderedAdjustmentLayers,
	patchAdjustmentLayer,
	roundAdjustmentTime,
} from "./adjustment.ts";
import { animatedValue } from "./animation.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	projectSchema,
} from "./project.ts";
import { defaultMask } from "./schema/mask.ts";

const asset: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 10,
	hasAudio: false,
	height: 720,
	id: "00000000-0000-4000-8000-000000000001",
	kind: "video",
	name: "clip.mp4",
	width: 1280,
};

const uuid = (n: number) =>
	`00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function minter(from = 100) {
	let next = from;
	return () => uuid(next++);
}

function layer(overrides: Partial<AdjustmentLayer> = {}): AdjustmentLayer {
	return {
		end: 2,
		id: uuid(50),
		label: "Grade",
		opacity: 1,
		start: 1,
		track: 0,
		...overrides,
	};
}

function project(layers?: AdjustmentLayer[]): Project {
	const base: Project = {
		...newProject("Adjustment test"),
		segments: [
			{ ...newSegment(asset, 0, 0), id: uuid(10) },
			{ ...newSegment(asset, 0, 2), id: uuid(11) },
		],
	};
	return layers ? { ...base, adjustmentLayers: layers } : base;
}

describe("ordering and windows", () => {
	test("orders by track, then start, keeping project order for ties", () => {
		const a = layer({ id: uuid(1), start: 3, end: 4, track: 1 });
		const b = layer({ id: uuid(2), start: 0, end: 1, track: 2 });
		const c = layer({ id: uuid(3), start: 1, end: 2, track: 1 });
		const d = layer({ id: uuid(4), start: 1, end: 5, track: 1 });
		expect(orderedAdjustmentLayers([a, b, c, d]).map((l) => l.id)).toEqual([
			uuid(3),
			uuid(4),
			uuid(1),
			uuid(2),
		]);
		expect(orderedAdjustmentLayers(undefined)).toEqual([]);
		expect(
			adjustmentLayersAfterTrack({ adjustmentLayers: [a, b, c] }, 1).map(
				(l) => l.id
			)
		).toEqual([uuid(3), uuid(1)]);
	});

	test("enable windows are inclusive between start and end", () => {
		const graded = layer({ start: 1, end: 2.5 });
		expect(adjustmentEnable(graded)).toBe("between(t,1,2.5)");
		const timeline = { adjustmentLayers: [graded] };
		expect(activeAdjustmentLayers(timeline, 0.99)).toEqual([]);
		expect(activeAdjustmentLayers(timeline, 1)).toHaveLength(1);
		expect(activeAdjustmentLayers(timeline, 2.5)).toHaveLength(1);
		expect(activeAdjustmentLayers(timeline, 2.51)).toEqual([]);
	});
});

describe("synthetic clip on the project clock", () => {
	test("is a neutral, schema-shaped clip with shifted keyframes", () => {
		const graded = layer({
			keyframes: [
				{ id: uuid(60), property: "saturation", time: 0, value: 1 },
				{ id: uuid(61), property: "saturation", time: 1, value: 0 },
			],
			start: 2,
			end: 4,
		});
		const segment = adjustmentLayerAsSegment(graded);
		expect(segment.brightness).toBe(0);
		expect(segment.contrast).toBe(1);
		expect(segment.saturation).toBe(1);
		expect(segment.colorGrade).toEqual({
			exposure: 0,
			temperature: 0,
			tint: 0,
			vibrance: 0,
		});
		expect(segment.keyframes.map((frame) => frame.time)).toEqual([2, 3]);
		expect(segment).not.toHaveProperty("masks");
		expect(segment).not.toHaveProperty("blendMode");
		expect(animatedValue(segment, "saturation", 2.5)).toBeCloseTo(0.5);
		expect(adjustmentLayerValuesAt(graded, 3.5).saturation).toBe(0);
	});

	test("values resolve opacity keyframes and clamp", () => {
		const fading = layer({
			keyframes: [{ id: uuid(62), property: "opacity", time: 1, value: 0 }],
			opacity: 1,
			start: 1,
			end: 3,
		});
		expect(adjustmentLayerValuesAt(fading, 1).opacity).toBe(1);
		expect(adjustmentLayerValuesAt(fading, 1.5).opacity).toBeCloseTo(0.5);
		expect(adjustmentLayerValuesAt(fading, 2.5).opacity).toBe(0);
	});
});

describe("which layers do anything", () => {
	test("neutral, empty and invisible layers have no effect", () => {
		expect(adjustmentLayerHasEffect(layer())).toBe(false);
		expect(adjustmentLayerHasEffect(layer({ saturation: 0, opacity: 0 }))).toBe(
			false
		);
		expect(
			adjustmentLayerHasEffect(
				layer({
					effects: [{ amount: 0.5, enabled: false, type: "grain" }],
				})
			)
		).toBe(false);
		expect(adjustmentLayerHasEffect(layer({ saturation: 0 }))).toBe(true);
		expect(
			adjustmentLayerHasEffect(
				layer({
					colorGrade: { exposure: 0, temperature: 0.2, tint: 0, vibrance: 0 },
				})
			)
		).toBe(true);
		expect(
			adjustmentLayerHasEffect(
				layer({ effects: [{ amount: 0.5, enabled: true, type: "grain" }] })
			)
		).toBe(true);
		expect(
			adjustmentLayerHasEffect(
				layer({
					keyframes: [
						{ id: uuid(63), property: "brightness", time: 0.5, value: 0.2 },
					],
				})
			)
		).toBe(true);
		expect(
			adjustmentLayerHasEffect(
				layer({
					keyframes: [
						{ id: uuid(64), property: "opacity", time: 0.5, value: 1 },
					],
					opacity: 0,
					saturation: 0,
				})
			)
		).toBe(true);
	});

	test("the CSS preview is approximate for GL-only grades, effects and blends", () => {
		expect(adjustmentPreviewApproximate(layer({ saturation: 0 }))).toBe(false);
		expect(
			adjustmentPreviewApproximate(
				layer({ effects: [{ amount: 1, enabled: true, type: "invert" }] })
			)
		).toBe(false);
		expect(
			adjustmentPreviewApproximate(
				layer({ effects: [{ amount: 1, enabled: true, type: "grain" }] })
			)
		).toBe(true);
		expect(adjustmentPreviewApproximate(layer({ blendMode: "multiply" }))).toBe(
			true
		);
		expect(
			adjustmentPreviewApproximate(
				layer({
					colorGrade: {
						exposure: 0,
						shadows: 0.3,
						temperature: 0,
						tint: 0,
						vibrance: 0,
					},
				})
			)
		).toBe(true);
	});
});

describe("edits", () => {
	test("create defaults label, opacity and the top clip track", () => {
		const input = adjustmentLayerEditRequestSchema.parse({
			action: "create",
			layer: { end: 3, saturation: 0, start: 1 },
			revision: 0,
		});
		const result = editAdjustmentLayers(project(), [asset], input, minter());
		expect(result.layer).toEqual({
			end: 3,
			id: uuid(100),
			label: "Adjustment 1",
			opacity: 1,
			saturation: 0,
			start: 1,
			track: 2,
		});
		expect(result.project.adjustmentLayers).toEqual([result.layer!]);
		expect(projectSchema.parse(result.project)).toEqual(result.project);
	});

	test("update patches, clears with null and trims keyframes past a shorter end", () => {
		const graded = layer({
			brightness: 0.2,
			end: 4,
			keyframes: [
				{ id: uuid(70), property: "saturation", time: 0.5, value: 0 },
				{ id: uuid(71), property: "saturation", time: 2.5, value: 1 },
			],
			start: 1,
		});
		const patched = patchAdjustmentLayer(graded, {
			brightness: null,
			end: 2,
			label: "Shorter",
		});
		expect(patched).not.toHaveProperty("brightness");
		expect(patched.label).toBe("Shorter");
		expect(patched.keyframes?.map((frame) => frame.id)).toEqual([uuid(70)]);
		const reset = patchAdjustmentLayer(graded, neutralAdjustmentPatch);
		expect(reset).toEqual({
			end: 4,
			id: graded.id,
			label: "Grade",
			opacity: 1,
			start: 1,
			track: 0,
		});
	});

	test("update through the request runs project validation", () => {
		const timeline = project([layer()]);
		const ok = editAdjustmentLayers(
			timeline,
			[asset],
			adjustmentLayerEditRequestSchema.parse({
				action: "update",
				layer: { saturation: 0.5 },
				layerId: uuid(50),
				revision: 0,
			})
		);
		expect(ok.layer?.saturation).toBe(0.5);
		expect(() =>
			editAdjustmentLayers(
				timeline,
				[asset],
				adjustmentLayerEditRequestSchema.parse({
					action: "update",
					layer: { end: 0.5 },
					layerId: uuid(50),
					revision: 0,
				})
			)
		).toThrow("Invalid adjustment layer timing");
		expect(() =>
			editAdjustmentLayers(
				timeline,
				[asset],
				adjustmentLayerEditRequestSchema.parse({
					action: "update",
					layer: { label: "x" },
					layerId: uuid(99),
					revision: 0,
				})
			)
		).toThrow("not in this project");
	});

	test("an empty patch and unknown fields are refused", () => {
		expect(
			adjustmentLayerEditRequestSchema.safeParse({
				action: "update",
				layer: {},
				layerId: uuid(50),
				revision: 0,
			}).success
		).toBe(false);
		expect(
			adjustmentLayerEditRequestSchema.safeParse({
				action: "create",
				layer: { end: 2, start: 1, hue: 3 },
				revision: 0,
			}).success
		).toBe(false);
	});

	test("times are rounded to the microsecond so FFmpeg never sees exponents", () => {
		expect(roundAdjustmentTime(5e-7)).toBe(0.000_001);
		expect(roundAdjustmentTime(4e-7)).toBe(0);
		expect(Object.is(roundAdjustmentTime(-1e-9), -0)).toBe(false);
		const created = editAdjustmentLayers(
			project(),
			[asset],
			adjustmentLayerEditRequestSchema.parse({
				action: "create",
				layer: { end: 2.000_000_04, saturation: 0, start: 5e-7 },
				revision: 0,
			}),
			minter()
		).layer!;
		expect(created.start).toBe(0.000_001);
		expect(created.end).toBe(2);
		expect(adjustmentEnable(created)).toBe("between(t,0.000001,2)");
		expect(adjustmentEnable(layer({ start: 3e-8 }))).toBe("between(t,0,2)");
		const patched = patchAdjustmentLayer(layer(), { start: 1.234_567_89 });
		expect(patched.start).toBe(1.234_568);
	});

	test("removing an effect or mask drops the keyframes that target it", () => {
		const effectId = uuid(80);
		const mask = defaultMask("ellipse", uuid(81));
		const timeline = project([
			layer({
				effects: [{ amount: 0.4, enabled: true, id: effectId, type: "grain" }],
				keyframes: [
					{
						id: uuid(82),
						property: "effectAmount",
						target: effectId,
						time: 0.5,
						value: 1,
					},
					{
						id: uuid(83),
						property: "maskFeather",
						target: mask.id,
						time: 0.5,
						value: 0.2,
					},
					{ id: uuid(84), property: "opacity", time: 0.5, value: 0.5 },
				],
				masks: [mask],
			}),
		]);
		const update = (patch: Record<string, unknown>, from = timeline) =>
			editAdjustmentLayers(
				from,
				[asset],
				adjustmentLayerEditRequestSchema.parse({
					action: "update",
					layer: patch,
					layerId: uuid(50),
					revision: 0,
				})
			);
		const withoutEffect = update({ effects: null });
		expect(withoutEffect.layer?.keyframes?.map((frame) => frame.id)).toEqual([
			uuid(83),
			uuid(84),
		]);
		const withoutMask = update({ masks: null }, withoutEffect.project);
		expect(withoutMask.layer?.keyframes?.map((frame) => frame.id)).toEqual([
			uuid(84),
		]);
		// Explicit keyframes are taken as sent (and validated), never pruned.
		expect(() =>
			update({
				effects: null,
				keyframes: timeline.adjustmentLayers?.[0]?.keyframes,
			})
		).toThrow();
	});

	test("a LUT in a layer grade is accepted on create and update", () => {
		const grade = {
			exposure: 0,
			lut: { intensity: 1, lutId: uuid(90) },
			temperature: 0,
			tint: 0,
			vibrance: 0,
		};
		const created = editAdjustmentLayers(
			project(),
			[asset],
			adjustmentLayerEditRequestSchema.parse({
				action: "create",
				layer: { colorGrade: grade, end: 2, start: 1 },
				revision: 0,
			}),
			minter()
		);
		expect(created.layer?.colorGrade?.lut?.lutId).toBe(uuid(90));
		const updated = editAdjustmentLayers(
			project([layer()]),
			[asset],
			adjustmentLayerEditRequestSchema.parse({
				action: "update",
				layer: { colorGrade: grade },
				layerId: uuid(50),
				revision: 0,
			})
		);
		expect(updated.layer?.colorGrade?.lut).toEqual({
			intensity: 1,
			lutId: uuid(90),
		});
	});

	test("duplicate re-mints ids, keeps keyframe targets and follows the original", () => {
		const effectId = uuid(80);
		const graded = layer({
			effects: [{ amount: 0.4, enabled: true, id: effectId, type: "grain" }],
			end: 3,
			keyframes: [
				{
					id: uuid(81),
					property: "effectAmount",
					target: effectId,
					time: 0.5,
					value: 1,
				},
			],
			start: 1,
		});
		const result = editAdjustmentLayers(
			project([graded]),
			[asset],
			{ action: "duplicate", layerId: graded.id, revision: 0 },
			minter(200)
		);
		const copy = result.layer!;
		expect(copy.id).toBe(uuid(200));
		expect(copy.start).toBe(3);
		expect(copy.end).toBe(5);
		expect(copy.label).toBe("Grade (copy)");
		expect(copy.effects?.[0]?.id).toBe(uuid(201));
		expect(copy.keyframes?.[0]).toMatchObject({
			id: uuid(202),
			target: uuid(201),
		});
		expect(result.project.adjustmentLayers).toHaveLength(2);
	});

	test("delete removes the layer and drops the empty list", () => {
		const result = editAdjustmentLayers(project([layer()]), [asset], {
			action: "delete",
			layerId: uuid(50),
			revision: 0,
		});
		expect(result.layer).toBeUndefined();
		expect(result.project).not.toHaveProperty("adjustmentLayers");
	});

	test("ids must not collide with other project ids", () => {
		expect(() =>
			editAdjustmentLayers(
				project(),
				[asset],
				{ action: "create", layer: { end: 2, start: 1 }, revision: 0 },
				() => uuid(10)
			)
		).toThrow();
	});

	test("presets are valid patches", () => {
		for (const preset of adjustmentPresets) {
			const parsed = adjustmentLayerEditRequestSchema.safeParse({
				action: "update",
				layer: preset.patch,
				layerId: uuid(50),
				revision: 0,
			});
			expect(parsed.success).toBe(true);
		}
	});
});
