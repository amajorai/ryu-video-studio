import { expect, test } from "bun:test";
import {
	effectStackCss,
	effectStackFilters,
	effectStackVignetteAmount,
	visualEffectFilters,
} from "./effects.ts";

test("visual effects expose bounded local filter graphs", () => {
	expect(visualEffectFilters("none")).toEqual(["null"]);
	expect(visualEffectFilters("blur")).toEqual([
		"boxblur=luma_radius=2:luma_power=1",
	]);
	expect(visualEffectFilters("grayscale")).toEqual(["hue=s=0"]);
	expect(visualEffectFilters("sepia")).toEqual([
		"colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131",
	]);
	expect(
		effectStackFilters([{ amount: 0.5, enabled: true, type: "blur" }])
	).toEqual(["boxblur=luma_radius=3.00:luma_power=1"]);
	expect(
		effectStackFilters([{ amount: 1, enabled: true, type: "sharpen" }])
	).toEqual(["unsharp=lx=3:ly=3:la=1.500"]);
	expect(
		effectStackFilters([{ amount: 0.5, enabled: true, type: "vignette" }])
	).toEqual(["vignette=angle=0.393:mode=forward"]);
	expect(
		effectStackVignetteAmount([
			{ amount: 0.3, enabled: true, type: "vignette" },
			{ amount: 0.8, enabled: false, type: "vignette" },
		])
	).toBe(0.3);
	expect(
		effectStackCss([{ amount: 0.5, enabled: true, type: "grayscale" }])
	).toEqual(["grayscale(0.5)"]);
});
