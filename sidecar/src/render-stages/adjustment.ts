import {
	type AdjustmentLayer,
	adjustmentEnable,
	adjustmentLayerAsSegment,
	adjustmentLayerHasEffect,
	adjustmentLayersAfterTrack,
	animatedBasicProperties,
	hasAdvancedAdjustment,
	hasBasicAdjustment,
	layerAnimates,
} from "../../../shared/adjustment.ts";
import { animationExpression } from "../../../shared/animation.ts";
import type { Project, Segment } from "../../../shared/project.ts";
import { compositeLayer } from "../render-composite.ts";
import { advancedColorFilters } from "./color-advanced.ts";
import { basicColorFilters } from "./color-basic.ts";
import { segmentEffectFilters } from "./effects.ts";
import {
	exprNumber,
	maskKeyframeValues,
	maskMatteFilters,
	segmentMaskValue,
} from "./mask.ts";
import type { RenderStageContext } from "./types.ts";

/**
 * Adjustment layers (W2-V7), applied by the orchestrator once every clip on
 * `track` (and below) is composited. Per layer, in `track`/`start` order:
 *
 *   [last] split ─ keep ────────────────────────────┐
 *                └ fx → grade → effects → rgba        │
 *                     → opacity → masks ─ compositeLayer(enable) → [out]
 *
 * The grade and effects reuse the clip stages through
 * `adjustmentLayerAsSegment`, whose keyframes are on the project clock, so
 * their `t`/`T` expressions read the composite time directly.
 *
 * The graded branch is deliberately **not** trimmed to the layer window: a
 * branch that drops frames before `start` stalls the overlay, which then
 * buffers every composite frame up to `start` (unbounded memory for a late
 * layer in a long export). Both branches stay frame-for-frame in step and
 * only `compositeLayer`'s inclusive `enable` window (the same convention as
 * `adjustmentLayerActiveAt` in the preview) decides where the grade shows.
 * Blend modes come from `compositeLayer`. Layers that change no pixel are
 * skipped, so projects without adjustment layers keep their exact argv.
 */

/** Resolvers the adjustment stage needs; the LUT path is optional. */
export type AdjustmentStageContext = Partial<
	Pick<RenderStageContext, "lutPath">
>;

function missingLut(lutId: string): string {
	throw new Error(
		`The LUT ${lutId} used by an adjustment layer is not available to this render.`
	);
}

/** `eq` with per-frame expressions for keyframed brightness/contrast/saturation. */
function animatedEq(segment: Segment): string[] {
	const expression = (property: (typeof animatedBasicProperties)[number]) =>
		`(${animationExpression(segment, property, "t")})`;
	const vibrance = segment.colorGrade.vibrance;
	const saturation =
		vibrance === 0
			? expression("saturation")
			: `${expression("saturation")}*${exprNumber(1 + vibrance * 0.5)}`;
	const filters = [
		`eq=brightness='${expression("brightness")}+${expression("exposure")}/3':contrast='${expression("contrast")}':saturation='${saturation}':eval=frame`,
	];
	const { temperature, tint } = segment.colorGrade;
	if (temperature || tint) {
		filters.push(
			`colorbalance=rs=${temperature}:gs=${tint}:bs=${-temperature}`
		);
	}
	return filters;
}

/** Brightness, contrast, saturation and the basic grade of a layer. */
export function layerBasicFilters(layer: AdjustmentLayer): string[] {
	if (!hasBasicAdjustment(layer)) {
		return [];
	}
	const segment = adjustmentLayerAsSegment(layer);
	return animatedBasicProperties.some((property) =>
		layerAnimates(layer, property)
	)
		? animatedEq(segment)
		: basicColorFilters(segment);
}

/** Opacity of the graded branch: static `colorchannelmixer` or keyframed `geq`. */
export function layerOpacityFilters(layer: AdjustmentLayer): string[] {
	if (layerAnimates(layer, "opacity")) {
		const segment = adjustmentLayerAsSegment(layer);
		return [
			`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip(${animationExpression(segment, "opacity", "T")},0,1)'`,
		];
	}
	return layer.opacity < 1
		? [`colorchannelmixer=aa=${exprNumber(layer.opacity)}`]
		: [];
}

/** The per-pixel chain of one layer (before masks and compositing). */
export function layerFilterChain(
	layer: AdjustmentLayer,
	context: AdjustmentStageContext = {}
): string[] {
	const segment = adjustmentLayerAsSegment(layer);
	return [
		...layerBasicFilters(layer),
		...(hasAdvancedAdjustment(layer)
			? advancedColorFilters(segment, {
					lutPath: context.lutPath ?? missingLut,
				})
			: []),
		// The legacy `visualEffect` slot is a `null` passthrough for layers.
		...segmentEffectFilters(segment).filter((filter) => filter !== "null"),
		"format=rgba",
		...layerOpacityFilters(layer),
	];
}

/** Filter statements of one layer over `base`, writing `[<prefix>out]`. */
export function adjustmentLayerFilters(
	layer: AdjustmentLayer,
	base: string,
	prefix: string,
	context: AdjustmentStageContext = {}
): { filters: string[]; last: string } {
	const segment = adjustmentLayerAsSegment(layer);
	const keep = `${prefix}keep`;
	const graded = `${prefix}graded`;
	const filters = [
		`[${base}]split=2[${keep}][${prefix}fx]`,
		`[${prefix}fx]${layerFilterChain(layer, context).join(",")}[${graded}]`,
	];
	const mask = maskMatteFilters(
		{
			input: graded,
			masks: layer.masks ?? [],
			prefix: `${prefix}m`,
			value: segmentMaskValue(segment),
		},
		maskKeyframeValues(segment, "maskFeather")
	);
	filters.push(...mask.filters);
	const out = `${prefix}out`;
	filters.push(
		...compositeLayer({
			base: keep,
			enable: adjustmentEnable(layer),
			layer: mask.label,
			out,
			s: layer,
			x: "0",
			y: "0",
		})
	);
	return { filters, last: out };
}

/**
 * Adjustment layers applied to the composite once every clip on `track` and
 * below has been drawn. `n` is unique per call; layers inside one call are
 * numbered after it. `context.lutPath` resolves LUTs in a layer's grade.
 */
export function adjustmentAfterTrack(
	project: Project,
	track: number,
	last: string,
	n: number,
	context: AdjustmentStageContext = {}
): { filters: string[]; last: string } {
	const filters: string[] = [];
	let current = last;
	for (const [index, layer] of adjustmentLayersAfterTrack(
		project,
		track
	).entries()) {
		if (!adjustmentLayerHasEffect(layer)) {
			continue;
		}
		const applied = adjustmentLayerFilters(
			layer,
			current,
			`adj${n}_${index}`,
			context
		);
		filters.push(...applied.filters);
		current = applied.last;
	}
	return { filters, last: current };
}
