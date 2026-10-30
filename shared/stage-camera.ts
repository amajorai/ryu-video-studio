import { z } from "zod";

export const stageCameraPropertySchema = z.enum([
	"x",
	"y",
	"zoom",
	"orbit",
	"tilt",
]);
export type StageCameraProperty = z.infer<typeof stageCameraPropertySchema>;

export const stageCameraKeyframeSchema = z
	.object({
		id: z.uuid(),
		property: stageCameraPropertySchema,
		time: z.number().finite().min(0).max(7200),
		value: z.number().finite().min(-1).max(2),
	})
	.strict();
export type StageCameraKeyframe = z.infer<typeof stageCameraKeyframeSchema>;

export interface StageCameraSource {
	keyframes?: StageCameraKeyframe[];
	orbit: number;
	tilt: number;
	x: number;
	y: number;
	zoom: number;
}

export function stageCameraValueBounds(property: StageCameraProperty) {
	return property === "zoom" ? { max: 2, min: 0.5 } : { max: 1, min: -1 };
}

function valueAt(
	keyframes: readonly StageCameraKeyframe[],
	property: StageCameraProperty,
	time: number,
	defaultValue: number
): number {
	const points = keyframes
		.filter((keyframe) => keyframe.property === property)
		.toSorted((left, right) => left.time - right.time);
	if (!points.length) {
		return defaultValue;
	}
	const first = points[0]!;
	const last = points.at(-1)!;
	if (time <= first.time) {
		return first.value;
	}
	if (time >= last.time) {
		return last.value;
	}
	for (let index = 1; index < points.length; index += 1) {
		const right = points[index]!;
		const left = points[index - 1]!;
		if (time > right.time) {
			continue;
		}
		const span = right.time - left.time;
		const progress = span > 0 ? (time - left.time) / span : 1;
		return left.value + (right.value - left.value) * progress;
	}
	return last.value;
}

export function stageCameraAtTime(
	camera: StageCameraSource,
	time: number
): Omit<StageCameraSource, "keyframes"> {
	const keyframes = camera.keyframes ?? [];
	return {
		x: valueAt(keyframes, "x", time, camera.x),
		y: valueAt(keyframes, "y", time, camera.y),
		zoom: valueAt(keyframes, "zoom", time, camera.zoom),
		orbit: valueAt(keyframes, "orbit", time, camera.orbit),
		tilt: valueAt(keyframes, "tilt", time, camera.tilt),
	};
}

/** Build the matching FFmpeg expression for an absolute timeline time. */
export function stageCameraExpression(
	camera: StageCameraSource,
	property: StageCameraProperty
): string {
	const keyframes = (camera.keyframes ?? [])
		.filter((keyframe) => keyframe.property === property)
		.toSorted((left, right) => left.time - right.time);
	if (!keyframes.length) {
		return String(camera[property]);
	}
	let expression = String(keyframes.at(-1)!.value);
	for (let index = keyframes.length - 2; index >= 0; index -= 1) {
		const left = keyframes[index]!;
		const right = keyframes[index + 1]!;
		const span = right.time - left.time;
		const value = `${left.value}+(${right.value}-${left.value})*(t-${left.time})/${span}`;
		expression = `if(lt(t,${right.time}),${value},${expression})`;
	}
	return `if(lt(t,${keyframes[0]!.time}),${keyframes[0]!.value},${expression})`;
}
