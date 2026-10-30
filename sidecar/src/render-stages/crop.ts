import {
	animatedRange,
	animationExpression,
	isAnimated,
} from "../../../shared/animation.ts";
import type { Segment } from "../../../shared/project.ts";

type CropEdge = "bottom" | "left" | "right" | "top";
type CropProperty = "cropBottom" | "cropLeft" | "cropRight" | "cropTop";

const cropProperty: Record<CropEdge, CropProperty> = {
	bottom: "cropBottom",
	left: "cropLeft",
	right: "cropRight",
	top: "cropTop",
};

/** Largest share of an axis the fixed window may remove. */
const MAX_AXIS_CROP = 0.98;

const decimal = (value: number) => Number(value.toFixed(6));

/** Smallest crop of an edge over the clip, clamped to the schema range. */
function minimumCrop(segment: Segment, edge: CropEdge): number {
	return Math.min(
		0.9,
		Math.max(0, animatedRange(segment, cropProperty[edge]).min)
	);
}

/** Scale an axis's two minimum crops down so the window keeps 2% of it. */
function fitAxis(a: number, b: number): [number, number] {
	const total = a + b;
	if (total <= MAX_AXIS_CROP) {
		return [a, b];
	}
	const factor = MAX_AXIS_CROP / total;
	return [decimal(a * factor), decimal(b * factor)];
}

/**
 * Source crop.
 *
 * Static crop keeps its historical single `crop` (or a `null` placeholder,
 * so the chain shape is identical when the clip is uncropped).
 *
 * Keyframed crop: FFmpeg's `crop` evaluates `w`/`h` once per stream, so the
 * window cannot shrink over time. The stage crops once to the *largest*
 * window the animation ever shows (each edge at its minimum over the clip,
 * eased overshoot included), converts to `yuva444p`, and a `geq` alpha mask
 * hides the rest of each edge per frame from the edge's keyframe expression
 * over `T` (clip-relative seconds, after the source `setpts`). The animated
 * edges therefore become transparent instead of re-fitting the clip, which
 * matches the preview's animated `inset()` clip path. `eq` and `colorbalance`
 * after this stage keep the alpha plane.
 */
export function cropFilters(segment: Segment): string[] {
	const animated = (Object.keys(cropProperty) as CropEdge[]).filter((edge) =>
		isAnimated(segment, cropProperty[edge])
	);
	if (animated.length === 0) {
		const { bottom, left, right, top } = segment.crop;
		if (!(left || right || top || bottom)) {
			return ["null"];
		}
		return [
			`crop=w='iw*(1-${left + right})':h='ih*(1-${top + bottom})':x='iw*${left}':y='ih*${top}'`,
		];
	}
	const [left, right] = fitAxis(
		minimumCrop(segment, "left"),
		minimumCrop(segment, "right")
	);
	const [top, bottom] = fitAxis(
		minimumCrop(segment, "top"),
		minimumCrop(segment, "bottom")
	);
	const width = decimal(1 - left - right);
	const height = decimal(1 - top - bottom);
	const minimum: Record<CropEdge, number> = { bottom, left, right, top };
	/** Share of the cropped window an edge still hides at time `T`. */
	const extra = (edge: CropEdge) => {
		const axis = edge === "left" || edge === "right" ? width : height;
		const value = animated.includes(edge)
			? animationExpression(segment, cropProperty[edge], "T")
			: String(segment.crop[edge]);
		// Clamp to the schema range like the preview's `edgeAt`, so an
		// overshooting curve never hides more than 90% of an edge.
		return `max(0,min(0.9,${value})-${minimum[edge]})/${axis}`;
	};
	const filters: string[] = [];
	if (left || right || top || bottom) {
		filters.push(
			`crop=w='iw*${width}':h='ih*${height}':x='iw*${left}':y='ih*${top}'`
		);
	}
	const visible = [
		`gte(X,W*(${extra("left")}))`,
		`lt(X,W*(1-(${extra("right")})))`,
		`gte(Y,H*(${extra("top")}))`,
		`lt(Y,H*(1-(${extra("bottom")})))`,
	].join("*");
	filters.push(
		"format=yuva444p",
		`geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*${visible}'`
	);
	return filters;
}
