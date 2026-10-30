import { z } from "zod";

/**
 * Layer compositing modes; `normal` is the existing alpha-over composite.
 * `hue`, `saturation`, `color` and `luminosity` are the non-separable
 * component modes (`componentBlendOf` in `shared/blend.ts`).
 */
export const blendModeSchema = z.enum([
	"normal",
	"multiply",
	"screen",
	"overlay",
	"darken",
	"lighten",
	"color-dodge",
	"color-burn",
	"hard-light",
	"soft-light",
	"difference",
	"exclusion",
	"add",
	"subtract",
	"linear-light",
	"pin-light",
	"hue",
	"saturation",
	"color",
	"luminosity",
]);
export type BlendMode = z.infer<typeof blendModeSchema>;
