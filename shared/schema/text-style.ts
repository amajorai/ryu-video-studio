import { z } from "zod";
import { bounded } from "./primitives.ts";

/** Bundled OFL/Apache font families; `system-sans` is the platform fallback. */
export const fontFamilySchema = z.enum([
	"system-sans",
	"inter",
	"roboto",
	"montserrat",
	"poppins",
	"oswald",
	"bebas-neue",
	"anton",
	"playfair-display",
	"merriweather",
	"source-code-pro",
	"permanent-marker",
	"lobster",
]);
export type FontFamily = z.infer<typeof fontFamilySchema>;

export const fontWeightSchema = z
	.number()
	.int()
	.min(100)
	.max(900)
	.multipleOf(100);
export const textAlignSchema = z.enum(["left", "center", "right"]);
export type TextAlign = z.infer<typeof textAlignSchema>;

export const titleAnimationInSchema = z.enum([
	"none",
	"fade",
	"slide-up",
	"slide-down",
	"slide-left",
	"slide-right",
	"pop",
	"bounce",
	"typewriter",
	"word-reveal",
	"word-highlight",
	"word-slide",
	"word-highlight-block",
	"blur-in",
	"zoom-in",
	"wave",
]);
export type TitleAnimationIn = z.infer<typeof titleAnimationInSchema>;

export const titleAnimationOutSchema = z.enum([
	"none",
	"fade",
	"slide-up",
	"slide-down",
	"slide-left",
	"slide-right",
	"pop",
	"zoom-out",
	"blur-out",
]);
export type TitleAnimationOut = z.infer<typeof titleAnimationOutSchema>;

export const titleAnimationLoopSchema = z.enum([
	"none",
	"pulse",
	"wobble",
	"wave",
	"float",
]);
export type TitleAnimationLoop = z.infer<typeof titleAnimationLoopSchema>;

/** Text fill: one color, or a left-to-right gradient from `color` to `gradientColor`. */
export const titleFillModeSchema = z.enum(["solid", "gradient"]);
export type TitleFillMode = z.infer<typeof titleFillModeSchema>;

/** Overlay lanes stack titles and graphics above the clip tracks. */
export const overlayLaneSchema = z.number().int().min(0).max(7);
export const letterSpacingSchema = bounded(-0.1, 0.5);
export const lineHeightSchema = bounded(0.8, 3);
/** Outline and shadow sizes are fractions of the canvas height. */
export const strokeFractionSchema = bounded(0, 0.02);
