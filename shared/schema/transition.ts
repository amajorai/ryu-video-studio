import { z } from "zod";
import { bounded } from "./primitives.ts";

/** Motion transitions at a clip edge (entry, and the mirrored exit). */
export const edgeTransitionSchema = z.enum([
	"none",
	"crossfade",
	"zoom-in",
	"zoom-out",
	"slide-left",
	"slide-right",
	"slide-up",
	"slide-down",
]);
export type EdgeTransition = z.infer<typeof edgeTransitionSchema>;

/** Reveal transitions applied to an incoming clip over its predecessor. */
export const revealTransitionSchema = z.enum([
	"dissolve",
	"fade-black",
	"fade-white",
	"wipe-left",
	"wipe-right",
	"wipe-up",
	"wipe-down",
	"slide-left",
	"slide-right",
	"slide-up",
	"slide-down",
	"push-left",
	"push-right",
	"circle-open",
	"circle-close",
	"rect-open",
	"radial",
	"diag-tl",
	"diag-br",
	"barn-h",
	"barn-v",
	"iris",
	"zoom",
	"blur",
]);
export type RevealTransition = z.infer<typeof revealTransitionSchema>;

export const transitionInSchema = z
	.object({
		type: revealTransitionSchema,
		duration: bounded(0.04, 5),
		softness: bounded(0, 1),
	})
	.strict();
export type TransitionIn = z.infer<typeof transitionInSchema>;

const clipAnimationMoveValues = [
	"fade",
	"pop",
	"bounce",
	"spin",
	"zoom",
	"slide-left",
	"slide-right",
	"slide-up",
	"slide-down",
	"blur",
] as const;
export const clipAnimationInSchema = z.enum(clipAnimationMoveValues);
export const clipAnimationOutSchema = z.enum(clipAnimationMoveValues);
export const clipAnimationLoopSchema = z.enum([
	"none",
	"pulse",
	"wobble",
	"float",
	"spin",
	"shake",
]);

export const clipAnimationSchema = z
	.object({
		in: clipAnimationInSchema.optional(),
		out: clipAnimationOutSchema.optional(),
		loop: clipAnimationLoopSchema.optional(),
		inDuration: bounded(0, 5).optional(),
		outDuration: bounded(0, 5).optional(),
		loopPeriod: bounded(0.2, 10).optional(),
	})
	.strict();
export type ClipAnimation = z.infer<typeof clipAnimationSchema>;

export const frameInterpolationSchema = z.enum([
	"none",
	"blend",
	"optical-flow",
]);
export type FrameInterpolation = z.infer<typeof frameInterpolationSchema>;
