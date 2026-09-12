import type { Segment } from "./project.ts";

function direction(segment: Segment, axis: "x" | "y") {
	if (axis === "x") {
		return segment.entryTransition === "slide-left"
			? 1
			: segment.entryTransition === "slide-right"
				? -1
				: 0;
	}
	return segment.entryTransition === "slide-up"
		? 1
		: segment.entryTransition === "slide-down"
			? -1
			: 0;
}

export function entryProgress(segment: Segment, elapsed: number): number {
	if (!segment.entryDuration) {
		return 1;
	}
	return Math.max(
		0,
		Math.min(1, (elapsed + segment.entryOffset) / segment.entryDuration)
	);
}

export function entryOpacity(segment: Segment, elapsed: number): number {
	return segment.entryTransition === "crossfade"
		? entryProgress(segment, elapsed)
		: 1;
}

export function entryScale(segment: Segment, elapsed: number): number {
	const progress = entryProgress(segment, elapsed);
	if (segment.entryTransition === "zoom-in" && segment.entryDuration > 0) {
		return 0.85 + progress * 0.15;
	}
	if (segment.entryTransition === "zoom-out" && segment.entryDuration > 0) {
		return 1.15 - progress * 0.15;
	}
	return 1;
}

/** Translation in output-frame widths/heights, independent of source speed. */
export function entryShift(
	segment: Segment,
	elapsed: number,
	axis: "x" | "y"
): number {
	if (!segment.entryDuration) {
		return 0;
	}
	return direction(segment, axis) * (1 - entryProgress(segment, elapsed));
}

export function entryScaleExpression(
	segment: Segment,
	elapsed: string
): string {
	if (segment.entryTransition === "zoom-in") {
		return `(0.85+0.15*clip(((${elapsed})+${segment.entryOffset})/${segment.entryDuration},0,1))`;
	}
	if (segment.entryTransition === "zoom-out") {
		return `(1.15-0.15*clip(((${elapsed})+${segment.entryOffset})/${segment.entryDuration},0,1))`;
	}
	return "1";
}

export function entryExpression(
	segment: Segment,
	axis: "x" | "y",
	elapsed: string
): string {
	const value = direction(segment, axis);
	if (!(value && segment.entryDuration)) {
		return "0";
	}
	return `${value}*(1-clip(((${elapsed})+${segment.entryOffset})/${segment.entryDuration},0,1))`;
}
