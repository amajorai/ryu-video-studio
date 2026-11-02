import { describe, expect, test } from "bun:test";
import { easedProgress } from "../../../shared/keyframe-easing.ts";
import { setKeyframesRequestSchema } from "../../../shared/keyframe-edits.ts";
import {
	VIEWER_STORAGE_PREFIX,
	type ViewerStorageArea,
} from "../editor/viewer-storage.ts";
import {
	addCustomPreset,
	BUILT_IN_EASING_PRESETS,
	builtInEasingPresetIds,
	CUSTOM_EASING_PRESETS_KEY,
	type CustomEasingPreset,
	curveControls,
	curveFromControls,
	loadCustomPresets,
	MAX_CUSTOM_EASING_PRESETS,
	matchingPresetId,
	normalizeBezier,
	parseCustomPresets,
	removeCustomPreset,
	saveCustomPresets,
	serializeCustomPresets,
} from "./easing-presets.ts";

function memoryArea(): ViewerStorageArea & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (key) => data.get(key) ?? null,
		removeItem: (key) => {
			data.delete(key);
		},
		setItem: (key, value) => {
			data.set(key, value);
		},
	};
}

const throwingArea: ViewerStorageArea = {
	getItem: () => {
		throw new Error("blocked");
	},
	removeItem: () => {
		throw new Error("blocked");
	},
	setItem: () => {
		throw new Error("blocked");
	},
};

describe("built-in presets", () => {
	test("the graph editor lists the seven planned presets in order", () => {
		expect(BUILT_IN_EASING_PRESETS.map((preset) => preset.id)).toEqual([
			...builtInEasingPresetIds,
		]);
	});

	test("every preset is a valid /keyframes interpolation", () => {
		for (const preset of BUILT_IN_EASING_PRESETS) {
			const result = setKeyframesRequestSchema.safeParse({
				clipId: crypto.randomUUID(),
				keyframes: [
					{
						time: 0,
						value: 0,
						interpolation: preset.curve.kind,
						...(preset.curve.bezier ? { bezier: preset.curve.bezier } : {}),
					},
					{ time: 1, value: 1 },
				],
				property: "opacity",
				revision: 0,
			});
			expect(result.success).toBe(true);
		}
	});

	test("named presets keep their interpolation; pop overshoots", () => {
		const byId = new Map(
			BUILT_IN_EASING_PRESETS.map((preset) => [preset.id, preset.curve])
		);
		expect(byId.get("ease-in")).toEqual({ kind: "ease-in" });
		expect(byId.get("hold")).toEqual({ kind: "hold" });
		const pop = byId.get("pop");
		expect(pop?.kind).toBe("bezier");
		const peak = Math.max(
			...Array.from({ length: 51 }, (_, index) =>
				easedProgress("bezier", index / 50, pop?.bezier)
			)
		);
		expect(peak).toBeGreaterThan(1.05);
	});

	test("curves draw from Bezier controls, hold has none", () => {
		expect(curveControls({ kind: "hold" })).toBeNull();
		expect(curveControls({ kind: "linear" })).toEqual([
			1 / 3,
			1 / 3,
			2 / 3,
			2 / 3,
		]);
		expect(
			curveControls({ bezier: [0.1, 0.2, 0.3, 0.4], kind: "bezier" })
		).toEqual([0.1, 0.2, 0.3, 0.4]);
	});

	test("matchingPresetId recognises built-in and custom curves", () => {
		expect(matchingPresetId({ kind: "ease-out" })).toBe("ease-out");
		expect(
			matchingPresetId({ bezier: [0.34, 1.56, 0.64, 1], kind: "bezier" })
		).toBe("pop");
		const custom: CustomEasingPreset[] = [
			{ bezier: [0.5, 0, 0.5, 1], id: "custom-snap", name: "Snap" },
		];
		expect(
			matchingPresetId({ bezier: [0.5, 0, 0.5, 1], kind: "bezier" }, custom)
		).toBe("custom-snap");
		expect(
			matchingPresetId({ bezier: [0.4, 0, 0.5, 1], kind: "bezier" }, custom)
		).toBeUndefined();
	});
});

describe("bezier normalization", () => {
	test("handles clamp to the keyframe schema and round to thousandths", () => {
		expect(normalizeBezier([-0.2, 2.5, 1.4, -1.5])).toEqual([0, 2, 1, -1]);
		expect(normalizeBezier([0.123_456, 0.5, 0.987_654, 1])).toEqual([
			0.123, 0.5, 0.988, 1,
		]);
		expect(curveFromControls([0.2, 0.1, 0.3, 0.9])).toEqual({
			bezier: [0.2, 0.1, 0.3, 0.9],
			kind: "bezier",
		});
	});
});

describe("custom preset serialization", () => {
	test("save, name collision, removal and the cap", () => {
		let presets = addCustomPreset([], "Snap in", [0.5, 0, 0.5, 1]);
		expect(presets).toEqual([
			{ bezier: [0.5, 0, 0.5, 1], id: "custom-snap-in", name: "Snap in" },
		]);
		presets = addCustomPreset(presets, "snap IN", [0.6, 0, 0.4, 1]);
		expect(presets).toHaveLength(1);
		expect(presets[0]?.bezier).toEqual([0.6, 0, 0.4, 1]);
		presets = addCustomPreset(presets, "Snap-in!", [0.1, 0, 0.9, 1]);
		expect(presets.map((preset) => preset.id)).toEqual([
			"custom-snap-in",
			"custom-snap-in-2",
		]);
		expect(removeCustomPreset(presets, "custom-snap-in")).toHaveLength(1);
		expect(() => addCustomPreset(presets, "   ", [0, 0, 1, 1])).toThrow(
			"Name the curve"
		);
		let many: CustomEasingPreset[] = [];
		for (let index = 0; index < MAX_CUSTOM_EASING_PRESETS + 3; index++) {
			many = addCustomPreset(many, `Curve ${index}`, [0.2, 0, 0.8, 1]);
		}
		expect(many).toHaveLength(MAX_CUSTOM_EASING_PRESETS);
		expect(many[0]?.name).toBe("Curve 3");
	});

	test("serialization is stable and round-trips", () => {
		const presets: CustomEasingPreset[] = [
			{ bezier: [0.25, 0.1, 0.25, 1], id: "custom-a", name: "A" },
			{ bezier: [0.5, -0.5, 0.5, 1.5], id: "custom-b", name: "B" },
		];
		const text = serializeCustomPresets(presets);
		expect(text).toBe(
			'[{"bezier":[0.25,0.1,0.25,1],"id":"custom-a","name":"A"},{"bezier":[0.5,-0.5,0.5,1.5],"id":"custom-b","name":"B"}]'
		);
		expect(parseCustomPresets(JSON.parse(text))).toEqual(presets);
		expect(serializeCustomPresets(parseCustomPresets(JSON.parse(text)))).toBe(
			text
		);
	});

	test("parsing drops invalid entries and duplicate ids but keeps the rest", () => {
		expect(parseCustomPresets("nope")).toEqual([]);
		expect(
			parseCustomPresets([
				{ bezier: [0.2, 0, 0.8, 1], id: "custom-ok", name: "Ok" },
				{ bezier: [2, 0, 0.8, 1], id: "custom-bad", name: "Bad x" },
				{ bezier: [0.2, 0, 0.8, 1], id: "custom-ok", name: "Duplicate" },
				{ bezier: [0.2, 0, 0.8, 1], id: "smooth", name: "Not custom" },
				{ bezier: [0.2, 0, 0.8, 1], extra: 1, id: "custom-x", name: "X" },
			])
		).toEqual([{ bezier: [0.2, 0, 0.8, 1], id: "custom-ok", name: "Ok" }]);
	});

	test("presets persist per viewer and fall back when storage fails", () => {
		const area = memoryArea();
		const presets = addCustomPreset([], "Soft", [0.3, 0, 0.7, 1]);
		expect(saveCustomPresets(presets, area)).toBe(true);
		expect(
			area.data.get(VIEWER_STORAGE_PREFIX + CUSTOM_EASING_PRESETS_KEY)
		).toBe(serializeCustomPresets(presets));
		expect(loadCustomPresets(area)).toEqual(presets);
		area.data.set(VIEWER_STORAGE_PREFIX + CUSTOM_EASING_PRESETS_KEY, "{oops");
		expect(loadCustomPresets(area)).toEqual([]);
		expect(loadCustomPresets(throwingArea)).toEqual([]);
		expect(saveCustomPresets(presets, throwingArea)).toBe(false);
		expect(loadCustomPresets(null)).toEqual([]);
	});
});
