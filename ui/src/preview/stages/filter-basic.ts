/**
 * Preview stage: basic colour (brightness, contrast, saturation and the
 * legacy grade). Mirrors `sidecar/src/render-stages/color-basic.ts`:
 * keyframed brightness, contrast, saturation, exposure and temperature follow
 * their eased curves at `elapsed` clip seconds.
 */
import { animatedValue } from "../../../../shared/animation.ts";
import type { Segment } from "../../../../shared/project.ts";

/** CSS filter functions reject negative amounts, which eased overshoot can reach. */
const nonNegative = (value: number) => Math.max(0, value);

export function basicFilterCss(segment: Segment, elapsed: number): string {
	const grade = segment.colorGrade;
	const value = (
		property:
			| "brightness"
			| "contrast"
			| "exposure"
			| "saturation"
			| "temperature"
	) => animatedValue(segment, property, elapsed);
	const brightness = nonNegative(
		1 + value("brightness") + value("exposure") / 3
	);
	const contrast = nonNegative(value("contrast"));
	const saturation = nonNegative(
		value("saturation") * (1 + grade.vibrance * 0.5)
	);
	const hue = grade.tint * 18 - value("temperature") * 6;
	return `brightness(${brightness}) contrast(${contrast}) saturate(${saturation}) hue-rotate(${hue}deg)`;
}
