/**
 * Preview stage: visual effects. Mirrors
 * `sidecar/src/render-stages/effects.ts` (legacy `visualEffect` followed by
 * the effect stack) for the effects CSS can show; the WebGL effects pass
 * (`../gl/passes/effects.ts`) draws the library effects that need pixel
 * access. Keyframed amounts resolve at the clip-relative `elapsed` time. The
 * vignette is drawn as a separate overlay element.
 */
import {
	effectStackCss,
	effectStackVignetteAmount,
	effectsAt,
} from "../../../../shared/effects.ts";
import type { Segment } from "../../../../shared/project.ts";

const legacyEffectCss: Record<string, string> = {
	blur: "blur(2px)",
	grayscale: "grayscale(1)",
	sepia: "sepia(1)",
};

/** `<legacy effect> <stack...>`; both halves may be empty. */
export function effectFilterCss(segment: Segment, elapsed: number): string {
	const legacy = segment.visualEffect
		? (legacyEffectCss[segment.visualEffect] ?? "")
		: "";
	return `${legacy} ${effectStackCss(effectsAt(segment, elapsed), elapsed).join(" ")}`;
}

/** Strength of the vignette overlay, 0 when none is enabled. */
export function vignetteAmount(segment: Segment, elapsed: number): number {
	return effectStackVignetteAmount(effectsAt(segment, elapsed));
}
