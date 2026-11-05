/**
 * The status-bar line after a speed ramp or speed curve is applied, as one
 * translated sentence with the preset name translated inside it and the step
 * count pluralized ("Ease in speed ramp applied in 8 steps.").
 */
import { translate } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";

export function speedRampStatus(
	mode: "smooth" | "steps",
	presetLabel: string,
	steps: number,
	tl: LiteralMessage = translate
): string {
	const preset = tl(presetLabel);
	if (mode === "smooth") {
		return tl("{preset} speed curve applied as one smooth clip.", { preset });
	}
	return tl(
		"{preset} speed ramp applied in {steps, plural, one {# step} other {# steps}}.",
		{ preset, steps }
	);
}
