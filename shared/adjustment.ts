/**
 * Adjustment layers (W2-V7): a timed grade, effect stack and optional masks
 * applied to the composite of every clip whose track is at or below the
 * layer's `track`.
 *
 * The render and preview reuse the clip stages (basic color, advanced color,
 * effects, masks) by viewing a layer as a synthetic clip on the **project
 * clock**: its keyframes are shifted by `start`, so FFmpeg expressions of the
 * composite time `t`/`T` and preview lookups at the playhead time read the
 * same curves the layer stores clip-relatively.
 *
 * Everything here is pure and deterministic.
 */
import { z } from "zod";
import {
	animatedValue,
	inKeyframeGroup,
	keyframeBaseValue,
	keyframeGroups,
} from "./animation.ts";
import { isBlended } from "./blend.ts";
import { hasAdvancedGrade } from "./color-advanced.ts";
import { type Effect, effectStackCss } from "./effects.ts";
import { MAX_TRACK_INDEX, trackIndexSchema } from "./limits.ts";
import {
	type Asset,
	type Keyframe,
	type Project,
	type Segment,
	validateProject,
} from "./project.ts";
import {
	type AdjustmentLayer,
	adjustmentLayerSchema,
	MAX_ADJUSTMENT_LAYERS,
} from "./schema/adjustment.ts";
import type { KeyframeProperty } from "./schema/keyframe.ts";
import { idSchema, timeSchema } from "./schema/primitives.ts";

export type { AdjustmentLayer };
export { MAX_ADJUSTMENT_LAYERS };

/** Default length of a new layer, in seconds. */
export const DEFAULT_ADJUSTMENT_DURATION = 5;

/** The neutral basic grade a layer without `colorGrade` uses. */
export const NEUTRAL_GRADE = {
	exposure: 0,
	temperature: 0,
	tint: 0,
	vibrance: 0,
} as const;

/** Basic-color keyframe properties the render animates with `eq`. */
export const animatedBasicProperties: readonly KeyframeProperty[] = [
	"brightness",
	"contrast",
	"saturation",
	"exposure",
];

/**
 * Layers in application order: track ascending, then start, then their order
 * in the project (the sort is stable).
 */
export function orderedAdjustmentLayers(
	layers: readonly AdjustmentLayer[] | undefined
): AdjustmentLayer[] {
	return [...(layers ?? [])].sort(
		(a, b) => a.track - b.track || a.start - b.start
	);
}

/** Layers applied right after every clip on `track` has been composited. */
export function adjustmentLayersAfterTrack(
	project: Pick<Project, "adjustmentLayers">,
	track: number
): AdjustmentLayer[] {
	return orderedAdjustmentLayers(project.adjustmentLayers).filter(
		(layer) => layer.track === track
	);
}

/** Whether the layer draws at project time `time` (inclusive, like `between`). */
export function adjustmentLayerActiveAt(
	layer: Pick<AdjustmentLayer, "start" | "end">,
	time: number
): boolean {
	return time >= layer.start && time <= layer.end;
}

/** Layers that draw at `time`, in application order. */
export function activeAdjustmentLayers(
	project: Pick<Project, "adjustmentLayers">,
	time: number
): AdjustmentLayer[] {
	return orderedAdjustmentLayers(project.adjustmentLayers).filter((layer) =>
		adjustmentLayerActiveAt(layer, time)
	);
}

/**
 * A layer time rounded to the microsecond. Every saved layer time goes
 * through it, so FFmpeg never sees exponent notation (`5e-7`), which its
 * option parsers reject.
 */
export function roundAdjustmentTime(time: number): number {
	const rounded = Math.round(time * 1e6) / 1e6;
	return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * FFmpeg `enable` window of a layer, inclusive at both ends like
 * `adjustmentLayerActiveAt`. The render bounds the layer only through this
 * expression (never `trim`), so preview and render agree on the end frame.
 */
export function adjustmentEnable(layer: AdjustmentLayer): string {
	return `between(t,${roundAdjustmentTime(layer.start)},${roundAdjustmentTime(layer.end)})`;
}

/**
 * The layer's keyframes on the project clock (shifted by `start`). A curve
 * whose first keyframe is after the layer start gets an explicit anchor at
 * the start holding the static value, as a clip's curve does at time zero.
 * `base` supplies those static values.
 */
export function projectClockKeyframes(
	layer: AdjustmentLayer,
	base: Segment
): Keyframe[] {
	const frames = layer.keyframes ?? [];
	const anchors: Keyframe[] = [];
	for (const group of keyframeGroups(frames)) {
		const first = Math.min(
			...frames.filter(inKeyframeGroup(group)).map((frame) => frame.time)
		);
		if (first > 0) {
			anchors.push({
				id: `${layer.id}-${group.property}-${group.target ?? "self"}`,
				property: group.property,
				time: layer.start,
				value: keyframeBaseValue(base, group.property, group.target),
				...(group.target === undefined ? {} : { target: group.target }),
			});
		}
	}
	return [
		...anchors,
		...frames.map((frame) => ({ ...frame, time: frame.time + layer.start })),
	];
}

/**
 * The layer as a synthetic, neutral clip on the project clock, so the clip
 * color, effect and mask stages can be reused unchanged. Never saved: the
 * keyframe times may exceed the clip time bound.
 */
export function adjustmentLayerAsSegment(layer: AdjustmentLayer): Segment {
	const segment: Segment = {
		assetId: layer.id,
		brightness: layer.brightness ?? 0,
		colorGrade: layer.colorGrade ?? { ...NEUTRAL_GRADE },
		contrast: layer.contrast ?? 1,
		crop: { bottom: 0, left: 0, right: 0, top: 0 },
		duckUnderVoice: false,
		edgeRounding: 0,
		edgeSoftness: 0,
		effects: layer.effects ?? [],
		entryDuration: 0.5,
		entryOffset: 0,
		entryTransition: "none",
		fadeIn: 0,
		fadeOut: 0,
		id: layer.id,
		keyframes: [],
		opacity: layer.opacity,
		rotation: 0,
		saturation: layer.saturation ?? 1,
		scale: 1,
		sourceIn: 0,
		sourceOut: layer.end - layer.start,
		speed: 1,
		start: 0,
		track: layer.track,
		visualization: "none",
		volume: 0,
		waveformColor: "#ffffff",
		waveformHeight: 0.2,
		x: 0,
		y: 0,
	};
	if (layer.blendMode) {
		segment.blendMode = layer.blendMode;
	}
	if (layer.masks) {
		segment.masks = layer.masks;
	}
	segment.keyframes = projectClockKeyframes(layer, segment);
	return segment;
}

/** Whether any keyframe drives `property` (and `target`, when given). */
export function layerAnimates(
	layer: AdjustmentLayer,
	property: KeyframeProperty,
	target?: string
): boolean {
	return (layer.keyframes ?? []).some(
		(frame) =>
			frame.property === property &&
			(target === undefined || frame.target === target)
	);
}

function effectActive(layer: AdjustmentLayer, effect: Effect): boolean {
	if (!effect.enabled) {
		return false;
	}
	if (effect.id && layerAnimates(layer, "effectAmount", effect.id)) {
		return (
			effect.amount > 0 ||
			(layer.keyframes ?? []).some(
				(frame) =>
					frame.property === "effectAmount" &&
					frame.target === effect.id &&
					frame.value > 0
			)
		);
	}
	return effect.amount > 0;
}

/** Enabled effects with a non-zero (or keyframed non-zero) amount. */
export function activeLayerEffects(layer: AdjustmentLayer): Effect[] {
	return (layer.effects ?? []).filter((effect) => effectActive(layer, effect));
}

/** Whether brightness, contrast, saturation or the basic grade change pixels. */
export function hasBasicAdjustment(layer: AdjustmentLayer): boolean {
	const grade = layer.colorGrade;
	return (
		(layer.brightness ?? 0) !== 0 ||
		(layer.contrast ?? 1) !== 1 ||
		(layer.saturation ?? 1) !== 1 ||
		(grade !== undefined &&
			(grade.exposure !== 0 ||
				grade.temperature !== 0 ||
				grade.tint !== 0 ||
				grade.vibrance !== 0)) ||
		animatedBasicProperties.some((property) => layerAnimates(layer, property))
	);
}

/** Whether the layer's advanced grade (levels, wheels, curves, HSL, LUT) is set. */
export function hasAdvancedAdjustment(layer: AdjustmentLayer): boolean {
	return layer.colorGrade !== undefined && hasAdvancedGrade(layer.colorGrade);
}

/** Whether the layer is never visible (zero opacity with no opacity keyframes). */
export function adjustmentLayerInvisible(layer: AdjustmentLayer): boolean {
	return (
		layer.opacity <= 0 &&
		!(layer.keyframes ?? []).some(
			(frame) => frame.property === "opacity" && frame.value > 0
		)
	);
}

/**
 * Whether the layer changes any pixel. Layers that do not are skipped by the
 * render, so an empty or fully transparent layer costs nothing.
 */
export function adjustmentLayerHasEffect(layer: AdjustmentLayer): boolean {
	if (adjustmentLayerInvisible(layer)) {
		return false;
	}
	return (
		hasBasicAdjustment(layer) ||
		hasAdvancedAdjustment(layer) ||
		activeLayerEffects(layer).length > 0
	);
}

/** Basic-color values and opacity of a layer at project time `time`. */
export interface AdjustmentLayerValues {
	brightness: number;
	contrast: number;
	exposure: number;
	opacity: number;
	saturation: number;
	temperature: number;
}

/** The layer's animated values at project time `time`. */
export function adjustmentLayerValuesAt(
	layer: AdjustmentLayer,
	time: number
): AdjustmentLayerValues {
	const segment = adjustmentLayerAsSegment(layer);
	const value = (property: KeyframeProperty) =>
		animatedValue(segment, property, time);
	return {
		brightness: value("brightness"),
		contrast: value("contrast"),
		exposure: value("exposure"),
		opacity: Math.min(1, Math.max(0, value("opacity"))),
		saturation: value("saturation"),
		temperature: value("temperature"),
	};
}

/** Whether CSS can draw an effect (otherwise only the render or GL can). */
function cssCanDraw(effect: Effect): boolean {
	return (
		effectStackCss([{ ...effect, amount: 1, enabled: true }], 0).length > 0
	);
}

/**
 * Whether the CSS `backdrop-filter` preview only approximates the layer: an
 * advanced grade or LUT, a blend mode, or an effect CSS cannot draw. The
 * paused preview then shows the server-rendered frame instead.
 */
export function adjustmentPreviewApproximate(layer: AdjustmentLayer): boolean {
	return (
		hasAdvancedAdjustment(layer) ||
		isBlended(layer) ||
		activeLayerEffects(layer).some((effect) => !cssCanDraw(effect))
	);
}

/** The highest track any clip uses (0 for an empty timeline). */
export function topClipTrack(project: Pick<Project, "segments">): number {
	return project.segments.reduce(
		(top, segment) => Math.max(top, segment.track),
		0
	);
}

/* ------------------------------------------------------------------------ */
/* Edits                                                                     */
/* ------------------------------------------------------------------------ */

const layerShape = adjustmentLayerSchema.shape;

/** Fields a new layer may set; omitted label, opacity and track get defaults. */
export const adjustmentLayerCreateSchema = z
	.object({
		label: layerShape.label.optional(),
		start: timeSchema,
		end: timeSchema,
		track: trackIndexSchema.optional(),
		opacity: layerShape.opacity.optional(),
		brightness: layerShape.brightness,
		contrast: layerShape.contrast,
		saturation: layerShape.saturation,
		colorGrade: layerShape.colorGrade,
		effects: layerShape.effects,
		masks: layerShape.masks,
		keyframes: layerShape.keyframes,
		blendMode: layerShape.blendMode,
	})
	.strict();
export type AdjustmentLayerCreate = z.infer<typeof adjustmentLayerCreateSchema>;

const clearable = <Schema extends z.ZodType>(schema: Schema) =>
	schema.nullable().optional();

/**
 * A partial update. Optional layer fields accept `null` to remove them, so a
 * layer returns to its byte-identical neutral form.
 */
export const adjustmentLayerPatchSchema = z
	.object({
		label: layerShape.label.optional(),
		start: timeSchema.optional(),
		end: timeSchema.optional(),
		track: trackIndexSchema.optional(),
		opacity: layerShape.opacity.optional(),
		brightness: clearable(layerShape.brightness.unwrap()),
		contrast: clearable(layerShape.contrast.unwrap()),
		saturation: clearable(layerShape.saturation.unwrap()),
		colorGrade: clearable(layerShape.colorGrade.unwrap()),
		effects: clearable(layerShape.effects.unwrap()),
		masks: clearable(layerShape.masks.unwrap()),
		keyframes: clearable(layerShape.keyframes.unwrap()),
		blendMode: clearable(layerShape.blendMode.unwrap()),
	})
	.strict()
	.refine((patch) => Object.keys(patch).length > 0, {
		message: "Updating an adjustment layer requires at least one field.",
	});
export type AdjustmentLayerPatch = z.infer<typeof adjustmentLayerPatchSchema>;

const revision = z.number().int().nonnegative();

/** `POST /projects/:id/adjustment-layers`. */
export const adjustmentLayerEditRequestSchema = z.discriminatedUnion("action", [
	z
		.object({
			action: z.literal("create"),
			layer: adjustmentLayerCreateSchema,
			revision,
		})
		.strict(),
	z
		.object({
			action: z.literal("update"),
			layerId: idSchema,
			layer: adjustmentLayerPatchSchema,
			revision,
		})
		.strict(),
	z
		.object({ action: z.literal("delete"), layerId: idSchema, revision })
		.strict(),
	z
		.object({ action: z.literal("duplicate"), layerId: idSchema, revision })
		.strict(),
]);
export type AdjustmentLayerEditRequest = z.infer<
	typeof adjustmentLayerEditRequestSchema
>;
export type AdjustmentLayerEditInput = z.input<
	typeof adjustmentLayerEditRequestSchema
>;

export interface AdjustmentLayerEditResult {
	/** The created, updated or duplicated layer; absent after a delete. */
	layer?: AdjustmentLayer;
	project: Project;
}

const optionalLayerKeys = [
	"brightness",
	"contrast",
	"saturation",
	"colorGrade",
	"effects",
	"masks",
	"keyframes",
	"blendMode",
] as const;

/** Copy a value with `undefined` fields removed (keeps saved JSON minimal). */
function compact(layer: AdjustmentLayer): AdjustmentLayer {
	return Object.fromEntries(
		Object.entries(layer).filter(([, value]) => value !== undefined)
	) as AdjustmentLayer;
}

/** A neutral layer covering `start`-`end` on `track`. */
export function newAdjustmentLayer(
	id: string,
	input: AdjustmentLayerCreate,
	fallbackTrack = MAX_TRACK_INDEX,
	index = 1
): AdjustmentLayer {
	return compact({
		...input,
		end: roundAdjustmentTime(input.end),
		id,
		label: input.label ?? `Adjustment ${index}`,
		opacity: input.opacity ?? 1,
		start: roundAdjustmentTime(input.start),
		track: input.track ?? fallbackTrack,
	});
}

/** Keyframes whose effect or mask target still exists on the layer. */
function keyframesWithTargets(layer: AdjustmentLayer): Keyframe[] | undefined {
	const targets = new Set<string>([
		...(layer.effects ?? []).flatMap((effect) =>
			effect.id ? [effect.id] : []
		),
		...(layer.masks ?? []).map((mask) => mask.id),
	]);
	const kept = layer.keyframes?.filter(
		(frame) => frame.target === undefined || targets.has(frame.target)
	);
	return kept?.length ? kept : undefined;
}

/**
 * Apply a patch. Clearing (`null`) removes an optional field. Times are
 * rounded to the microsecond. When the patch leaves `keyframes` alone,
 * keyframes past a new length, or targeting an effect or mask the patch
 * removed, are dropped so the layer stays valid.
 */
export function patchAdjustmentLayer(
	layer: AdjustmentLayer,
	patch: AdjustmentLayerPatch
): AdjustmentLayer {
	// A layer moved or reshaped by hand no longer follows tracked source moments.
	const reshaped =
		patch.start !== undefined ||
		patch.end !== undefined ||
		patch.keyframes !== undefined ||
		patch.masks !== undefined;
	const { follows: _follows, ...unfollowed } = layer;
	const next: Record<string, unknown> = reshaped ? unfollowed : { ...layer };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			delete next[key];
		} else if (value !== undefined) {
			next[key] = value;
		}
	}
	const patched = next as AdjustmentLayer;
	patched.start = roundAdjustmentTime(patched.start);
	patched.end = roundAdjustmentTime(patched.end);
	if (patch.keyframes !== undefined) {
		return compact(patched);
	}
	const length = patched.end - patched.start;
	if (
		patched.keyframes &&
		(patch.start !== undefined || patch.end !== undefined)
	) {
		patched.keyframes = patched.keyframes.filter(
			(frame) => frame.time <= length
		);
	}
	patched.keyframes = keyframesWithTargets(patched);
	return compact(patched);
}

function findLayer(project: Project, layerId: string): AdjustmentLayer {
	const layer = project.adjustmentLayers?.find(
		(candidate) => candidate.id === layerId
	);
	if (!layer) {
		throw new Error("That adjustment layer is not in this project.");
	}
	return layer;
}

function withLayers(
	project: Project,
	layers: AdjustmentLayer[]
): Project & { adjustmentLayers?: AdjustmentLayer[] } {
	const { adjustmentLayers: _previous, ...rest } = project;
	return layers.length ? { ...rest, adjustmentLayers: layers } : rest;
}

/** Fresh ids for a copied layer's effects, masks and keyframes. */
function remintLayer(
	layer: AdjustmentLayer,
	id: string,
	mintId: () => string
): AdjustmentLayer {
	const effectIds = new Map<string, string>();
	const effects = layer.effects?.map((effect) => {
		if (!effect.id) {
			return effect;
		}
		const next = mintId();
		effectIds.set(effect.id, next);
		return { ...effect, id: next };
	});
	const maskIds = new Map<string, string>();
	const masks = layer.masks?.map((mask) => {
		const next = mintId();
		maskIds.set(mask.id, next);
		return { ...mask, id: next };
	});
	const keyframes = layer.keyframes?.map((frame) => ({
		...frame,
		id: mintId(),
		...(frame.target
			? {
					target:
						effectIds.get(frame.target) ??
						maskIds.get(frame.target) ??
						frame.target,
				}
			: {}),
	}));
	return compact({
		...layer,
		effects,
		id,
		keyframes,
		label: `${layer.label.slice(0, 73)} (copy)`,
		masks,
	});
}

/**
 * Create, update, duplicate or delete an adjustment layer. The result is
 * validated (timing, unique ids, keyframe targets); the caller checks the
 * revision. `mintId` makes ids deterministic in tests.
 */
export function editAdjustmentLayers(
	project: Project,
	assets: readonly Asset[],
	request: AdjustmentLayerEditRequest,
	mintId: () => string = () => crypto.randomUUID()
): AdjustmentLayerEditResult {
	const layers = project.adjustmentLayers ?? [];
	let layer: AdjustmentLayer | undefined;
	let next: AdjustmentLayer[];
	switch (request.action) {
		case "create": {
			if (layers.length >= MAX_ADJUSTMENT_LAYERS) {
				throw new Error(
					`A project can hold at most ${MAX_ADJUSTMENT_LAYERS} adjustment layers.`
				);
			}
			layer = newAdjustmentLayer(
				mintId(),
				request.layer,
				topClipTrack(project),
				layers.length + 1
			);
			next = [...layers, layer];
			break;
		}
		case "update": {
			const current = findLayer(project, request.layerId);
			layer = patchAdjustmentLayer(current, request.layer);
			const updated = layer;
			next = layers.map((candidate) =>
				candidate.id === updated.id ? updated : candidate
			);
			break;
		}
		case "duplicate": {
			if (layers.length >= MAX_ADJUSTMENT_LAYERS) {
				throw new Error(
					`A project can hold at most ${MAX_ADJUSTMENT_LAYERS} adjustment layers.`
				);
			}
			const current = findLayer(project, request.layerId);
			const length = current.end - current.start;
			const copy = remintLayer(current, mintId(), mintId);
			layer = { ...copy, end: current.end + length, start: current.end };
			next = [...layers, layer];
			break;
		}
		default: {
			findLayer(project, request.layerId);
			next = layers.filter((candidate) => candidate.id !== request.layerId);
		}
	}
	const validated = validateProject(withLayers(project, next), [...assets]);
	return layer ? { layer, project: validated } : { project: validated };
}

/** Clear-to-neutral patch for an optional field list (used by the UI reset). */
export const neutralAdjustmentPatch: AdjustmentLayerPatch = Object.fromEntries(
	optionalLayerKeys.map((key) => [key, null])
) as AdjustmentLayerPatch;

/** Quick grade presets for new or existing layers. */
export const adjustmentPresets = [
	{ id: "mono", label: "Black and white", patch: { saturation: 0 } },
	{
		id: "warm",
		label: "Warm",
		patch: {
			colorGrade: { ...NEUTRAL_GRADE, temperature: 0.3, vibrance: 0.1 },
		},
	},
	{
		id: "cool",
		label: "Cool",
		patch: { colorGrade: { ...NEUTRAL_GRADE, temperature: -0.3 } },
	},
	{
		id: "punch",
		label: "Punch",
		patch: { contrast: 1.2, saturation: 1.25 },
	},
	{
		id: "fade",
		label: "Faded",
		patch: { brightness: 0.05, contrast: 0.8, saturation: 0.8 },
	},
	{ id: "dim", label: "Dim", patch: { brightness: -0.25 } },
] as const satisfies readonly {
	id: string;
	label: string;
	patch: AdjustmentLayerPatch;
}[];
export type AdjustmentPresetId = (typeof adjustmentPresets)[number]["id"];
