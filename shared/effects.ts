import { z } from "zod";

export const visualEffectSchema = z.enum([
	"none",
	"blur",
	"grayscale",
	"sepia",
]);
export type VisualEffect = z.infer<typeof visualEffectSchema>;

export const effectTypeSchema = z.enum([
	"blur",
	"grayscale",
	"sepia",
	"sharpen",
	"vignette",
]);
export const effectSchema = z
	.object({
		amount: z.number().finite().min(0).max(1).default(1),
		enabled: z.boolean().default(true),
		type: effectTypeSchema,
	})
	.strict();
export const effectStackSchema = z.array(effectSchema).max(8).default([]);
export type Effect = z.infer<typeof effectSchema>;

export function visualEffectFilters(effect: VisualEffect): string[] {
	switch (effect) {
		case "blur":
			return ["boxblur=luma_radius=2:luma_power=1"];
		case "grayscale":
			return ["hue=s=0"];
		case "sepia":
			return [
				"colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131",
			];
		default:
			return ["null"];
	}
}

export function effectStackFilters(effects: readonly Effect[]): string[] {
	return effects.flatMap((effect) => {
		if (!effect.enabled || effect.amount <= 0) {
			return [];
		}
		switch (effect.type) {
			case "blur":
				return [
					`boxblur=luma_radius=${(1 + effect.amount * 4).toFixed(2)}:luma_power=1`,
				];
			case "grayscale":
				return [`hue=s=${(1 - effect.amount).toFixed(3)}`];
			case "sharpen":
				return [`unsharp=lx=3:ly=3:la=${(effect.amount * 1.5).toFixed(3)}`];
			case "vignette":
				return [
					`vignette=angle=${((Math.PI / 4) * effect.amount).toFixed(3)}:mode=forward`,
				];
			case "sepia":
				return [
					"colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131",
				];
		}
	});
}

export function effectStackCss(effects: readonly Effect[]): string[] {
	return effects.flatMap((effect) => {
		if (!effect.enabled || effect.amount <= 0) {
			return [];
		}
		switch (effect.type) {
			case "blur":
				return [`blur(${(effect.amount * 2).toFixed(2)}px)`];
			case "grayscale":
				return [`grayscale(${effect.amount})`];
			case "sepia":
				return [`sepia(${effect.amount})`];
			case "sharpen":
				return [`contrast(${(1 + effect.amount * 0.08).toFixed(3)})`];
			case "vignette":
				return [];
		}
	});
}

/** Return the strongest enabled vignette for the local preview overlay. */
export function effectStackVignetteAmount(effects: readonly Effect[]): number {
	return effects.reduce(
		(amount, effect) =>
			effect.enabled && effect.type === "vignette"
				? Math.max(amount, effect.amount)
				: amount,
		0
	);
}
