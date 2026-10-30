import {
	activeCurves,
	type CurveChannel,
	hueSaturationFilters,
	levelsOf,
	lutIntensityOf,
	toneCurveOf,
	wheelBalanceOf,
} from "../../../shared/color-advanced.ts";
import type { Segment } from "../../../shared/project.ts";
import type { CurvePoint } from "../../../shared/schema/color.ts";
import type { RenderStageContext } from "./types.ts";

/**
 * Advanced grade (W2-V5), in the fixed order of `shared/color-advanced.ts`:
 *
 * 1. `colorlevels` for whites and blacks;
 * 2. `curves` (master) for shadows and highlights;
 * 3. `colorbalance` from the lift/gamma/gain wheels;
 * 4. `curves` for the user's master and RGB curves (PCHIP, like the preview);
 * 5. `huesaturation`: the adjustment all hue ranges share as one global
 *    filter (high `strength`), then one selective filter per distinct
 *    per-range residual (HSL bands / hue-vs-sat);
 * 6. `lut3d` with tetrahedral interpolation. Below full intensity the chain
 *    forks (`split`), grades one branch and mixes them back with
 *    `blend=all_mode=normal`, so it stays a single chain for the caller.
 *
 * A neutral grade adds no filters, so legacy renders stay byte-identical.
 */
export function advancedColorFilters(
	segment: Segment,
	context: Pick<RenderStageContext, "lutPath">
): string[] {
	const grade = segment.colorGrade;
	const filters: string[] = [];
	const levels = levelsOf(grade);
	if (levels) {
		const channels = ["r", "g", "b"];
		filters.push(
			`colorlevels=${[
				...channels.map((channel) => `${channel}imin=${levels.inMin}`),
				...channels.map((channel) => `${channel}imax=${levels.inMax}`),
				...channels.map((channel) => `${channel}omin=${levels.outMin}`),
				...channels.map((channel) => `${channel}omax=${levels.outMax}`),
			].join(":")}`
		);
	}
	const tone = toneCurveOf(grade);
	if (tone) {
		filters.push(`curves=interp=pchip:master='${curvePoints(tone)}'`);
	}
	const balance = wheelBalanceOf(grade);
	if (balance) {
		const values = (prefix: string, rgb: readonly number[]) =>
			["r", "g", "b"].map(
				(channel, index) => `${channel}${prefix}=${rgb[index] ?? 0}`
			);
		filters.push(
			`colorbalance=${[
				...values("s", balance.shadows),
				...values("m", balance.midtones),
				...values("h", balance.highlights),
			].join(":")}`
		);
	}
	const curves = activeCurves(grade);
	const curveOptions = (
		Object.entries(curves) as [CurveChannel, CurvePoint[]][]
	).map(([channel, points]) => `${channel}='${curvePoints(points)}'`);
	if (curveOptions.length) {
		filters.push(`curves=interp=pchip:${curveOptions.join(":")}`);
	}
	for (const adjustment of hueSaturationFilters(grade)) {
		filters.push(
			`huesaturation=hue=${adjustment.hue}:saturation=${adjustment.saturation}:intensity=${adjustment.intensity}:colors=${adjustment.colors.join("+")}:strength=${adjustment.strength}`
		);
	}
	const intensity = lutIntensityOf(grade);
	if (grade.lut && intensity > 0) {
		const lut = `lut3d=file=${filterPath(context.lutPath(grade.lut.lutId))}:interp=tetrahedral`;
		if (intensity >= 1) {
			filters.push(lut);
		} else {
			// Labels are unique per clip; the chain resumes after `blend`.
			const tag = `lut${segment.id.replaceAll("-", "")}`;
			filters.push(
				`split[${tag}o][${tag}i];[${tag}i]${lut}[${tag}g];[${tag}g][${tag}o]blend=all_mode=normal:all_opacity=${Number(intensity.toFixed(6))}`
			);
		}
	}
	return filters;
}

/** FFmpeg `curves` key points: `x/y` pairs separated by spaces. */
export function curvePoints(points: readonly CurvePoint[]): string {
	return points
		.map(
			(point) => `${Number(point.x.toFixed(6))}/${Number(point.y.toFixed(6))}`
		)
		.join(" ");
}

/**
 * Escape a file path for a filter option inside `-filter_complex`: first for
 * the option parser (`\`, `'`, `:`), then for the graph parser
 * (`\`, `'`, `[`, `]`, `,`, `;`).
 */
export function filterPath(path: string): string {
	const option = path.replace(/[\\':]/g, "\\$&");
	return option.replace(/[\\'[\],;]/g, "\\$&");
}
