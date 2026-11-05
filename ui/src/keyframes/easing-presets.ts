/**
 * Graph-editor easing presets: the built-in curves (smooth, ease in, ease
 * out, ease in-out, pop overshoot, linear, hold) and the viewer's own saved
 * Bezier curves. Built-ins that match a named interpolation keep that name
 * (the render evaluates those as exact polynomials); the rest are Bezier
 * controls. Custom presets are a per-viewer convenience kept in viewer
 * storage; anything unreadable falls back to an empty list.
 */
import { z } from "zod";
import type { KeyframeCurve } from "../../../shared/animation.ts";
import {
	type BezierControls,
	easingControls,
} from "../../../shared/keyframe-easing.ts";
import { keyframeBezierSchema } from "../../../shared/schema/keyframe.ts";
import {
	readViewerValue,
	type ViewerStorageArea,
	writeViewerValue,
} from "../editor/viewer-storage.ts";

export const builtInEasingPresetIds = [
	"smooth",
	"ease-in",
	"ease-out",
	"ease-in-out",
	"pop",
	"linear",
	"hold",
] as const;
export type BuiltInEasingPresetId = (typeof builtInEasingPresetIds)[number];

export interface EasingPreset {
	curve: KeyframeCurve;
	id: string;
	label: string;
}

/** The shipped presets, in the order the graph editor lists them. */
export const BUILT_IN_EASING_PRESETS: readonly EasingPreset[] = [
	{
		curve: { bezier: [0.25, 0.1, 0.25, 1], kind: "bezier" },
		id: "smooth",
		label: "Smooth",
	},
	{ curve: { kind: "ease-in" }, id: "ease-in", label: "Ease in" },
	{ curve: { kind: "ease-out" }, id: "ease-out", label: "Ease out" },
	{
		curve: { kind: "ease-in-out" },
		id: "ease-in-out",
		label: "Ease in and out",
	},
	{
		curve: { bezier: [0.34, 1.56, 0.64, 1], kind: "bezier" },
		id: "pop",
		label: "Pop overshoot",
	},
	{ curve: { kind: "linear" }, id: "linear", label: "Linear" },
	{ curve: { kind: "hold" }, id: "hold", label: "Hold" },
];

/** The most custom curves one viewer keeps. */
export const MAX_CUSTOM_EASING_PRESETS = 24;
/** Viewer-storage key (namespaced by `viewer-storage`) for custom curves. */
export const CUSTOM_EASING_PRESETS_KEY = "keyframes.easing-presets.v1";

export const customEasingPresetSchema = z
	.object({
		bezier: keyframeBezierSchema,
		id: z.string().regex(/^custom-[a-z0-9-]{1,48}$/),
		name: z.string().trim().min(1).max(40),
	})
	.strict();
export type CustomEasingPreset = z.infer<typeof customEasingPresetSchema>;

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

/**
 * Bezier controls clamped to the keyframe schema (x in 0..1, y in -1..2) and
 * rounded to three decimals, so dragged handles always save cleanly.
 */
export function normalizeBezier(controls: readonly number[]): BezierControls {
	return [
		round3(clamp(controls[0] ?? 0, 0, 1)),
		round3(clamp(controls[1] ?? 0, -1, 2)),
		round3(clamp(controls[2] ?? 1, 0, 1)),
		round3(clamp(controls[3] ?? 1, -1, 2)),
	];
}

/**
 * The Bezier controls a curve draws with (named easings use their exact
 * equivalent), or `null` for hold, which is a step.
 */
export function curveControls(curve: KeyframeCurve): BezierControls | null {
	return easingControls(curve.kind, curve.bezier);
}

/** A custom preset as a keyframe curve. */
export function customPresetCurve(preset: CustomEasingPreset): KeyframeCurve {
	return { bezier: [...preset.bezier], kind: "bezier" };
}

const sameControls = (a: readonly number[], b: readonly number[]) =>
	a.length === b.length &&
	a.every((value, index) => Math.abs(value - (b[index] ?? 0)) < 5e-4);

/**
 * The id of the preset (built-in first, then custom) that `curve` equals, or
 * `undefined` for an unsaved custom curve.
 */
export function matchingPresetId(
	curve: KeyframeCurve,
	custom: readonly CustomEasingPreset[] = []
): string | undefined {
	for (const preset of BUILT_IN_EASING_PRESETS) {
		if (preset.curve.kind !== curve.kind) {
			continue;
		}
		if (
			curve.kind !== "bezier" ||
			sameControls(preset.curve.bezier ?? [], curve.bezier ?? [])
		) {
			return preset.id;
		}
	}
	if (curve.kind !== "bezier" || !curve.bezier) {
		return undefined;
	}
	const controls = curve.bezier;
	return custom.find((preset) => sameControls(preset.bezier, controls))?.id;
}

/**
 * A curve whose controls were edited by hand. Moving a handle always makes a
 * Bezier, whatever the curve was before.
 */
export function curveFromControls(controls: readonly number[]): KeyframeCurve {
	return { bezier: normalizeBezier(controls), kind: "bezier" };
}

function slug(name: string): string {
	const base = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return base || "curve";
}

/**
 * Save `bezier` under `name`. A preset with the same name (ignoring case) is
 * replaced in place; otherwise the new one is appended with a fresh id. The
 * list is capped at `MAX_CUSTOM_EASING_PRESETS`, dropping the oldest.
 */
export function addCustomPreset(
	presets: readonly CustomEasingPreset[],
	name: string,
	bezier: readonly number[]
): CustomEasingPreset[] {
	const trimmed = name.trim().slice(0, 40);
	if (!trimmed) {
		throw new Error("Name the curve before saving it.");
	}
	const controls = normalizeBezier(bezier);
	const existing = presets.find(
		(preset) => preset.name.toLowerCase() === trimmed.toLowerCase()
	);
	if (existing) {
		return presets.map((preset) =>
			preset.id === existing.id
				? { ...preset, bezier: controls, name: trimmed }
				: preset
		);
	}
	const ids = new Set(presets.map((preset) => preset.id));
	const base = `custom-${slug(trimmed)}`;
	let id = base;
	for (let suffix = 2; ids.has(id); suffix++) {
		id = `${base}-${suffix}`;
	}
	return [...presets, { bezier: controls, id, name: trimmed }].slice(
		-MAX_CUSTOM_EASING_PRESETS
	);
}

/** The list without the preset `id`. */
export function removeCustomPreset(
	presets: readonly CustomEasingPreset[],
	id: string
): CustomEasingPreset[] {
	return presets.filter((preset) => preset.id !== id);
}

/**
 * Read stored presets leniently: entries that fail the schema and repeated
 * ids are dropped, and at most `MAX_CUSTOM_EASING_PRESETS` are kept, so one
 * bad entry never discards the rest.
 */
export function parseCustomPresets(raw: unknown): CustomEasingPreset[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const seen = new Set<string>();
	const presets: CustomEasingPreset[] = [];
	for (const entry of raw) {
		const parsed = customEasingPresetSchema.safeParse(entry);
		if (parsed.success && !seen.has(parsed.data.id)) {
			seen.add(parsed.data.id);
			presets.push(parsed.data);
		}
	}
	return presets.slice(-MAX_CUSTOM_EASING_PRESETS);
}

/**
 * The stored form: entries in list order with keys in a fixed order, so the
 * same presets always serialize to the same text.
 */
export function serializeCustomPresets(
	presets: readonly CustomEasingPreset[]
): string {
	return JSON.stringify(
		parseCustomPresets(presets).map((preset) => ({
			bezier: normalizeBezier(preset.bezier),
			id: preset.id,
			name: preset.name,
		}))
	);
}

/** The viewer's saved curves (empty when storage is missing or unreadable). */
export function loadCustomPresets(
	area?: ViewerStorageArea | null
): CustomEasingPreset[] {
	return parseCustomPresets(
		readViewerValue(CUSTOM_EASING_PRESETS_KEY, z.unknown(), [], area)
	);
}

/** Persist the viewer's curves; false when storage is unavailable. */
export function saveCustomPresets(
	presets: readonly CustomEasingPreset[],
	area?: ViewerStorageArea | null
): boolean {
	return writeViewerValue(
		CUSTOM_EASING_PRESETS_KEY,
		JSON.parse(serializeCustomPresets(presets)),
		area
	);
}
