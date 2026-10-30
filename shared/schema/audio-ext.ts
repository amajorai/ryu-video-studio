import { z } from "zod";
import { bounded } from "./primitives.ts";

export const panSchema = bounded(-1, 1);
export const channelModeSchema = z.enum([
	"stereo",
	"mono",
	"left",
	"right",
	"swap",
]);
export type ChannelMode = z.infer<typeof channelModeSchema>;

/** Graded clip cleanup; absent controls are off. */
export const audioCleanupSchema = z
	.object({
		denoise: bounded(0, 1).optional(),
		enhance: bounded(0, 1).optional(),
		normalize: z.boolean().optional(),
		voiceIsolation: bounded(0, 1).optional(),
	})
	.strict();
export type AudioCleanup = z.infer<typeof audioCleanupSchema>;

export const audioEffectTypeSchema = z.enum([
	"pitch",
	"echo",
	"reverb",
	"eq",
	"bass-boost",
	"treble-boost",
	"telephone",
	"radio",
	"robot",
	"chorus",
	"flanger",
	"megaphone",
	"chipmunk",
	"deep-voice",
	"vibrato",
	"tremolo",
]);
export type AudioEffectType = z.infer<typeof audioEffectTypeSchema>;

export const audioEffectSchema = z
	.object({
		id: z.uuid().optional(),
		type: audioEffectTypeSchema,
		enabled: z.boolean(),
		amount: bounded(0, 1),
		semitones: bounded(-12, 12).optional(),
		gainDb: bounded(-24, 24).optional(),
		frequency: bounded(20, 20_000).optional(),
	})
	.strict();
export type AudioEffect = z.infer<typeof audioEffectSchema>;
export const MAX_AUDIO_EFFECTS = 8;

/**
 * How far and how fast a "Duck under voice" clip dips while other audio
 * plays; absent fields use `DUCK_DEFAULTS` in `shared/ducking.ts`.
 */
export const duckSettingsSchema = z
	.object({
		amountDb: bounded(3, 24).optional(),
		attackMs: bounded(5, 500).optional(),
		releaseMs: bounded(50, 2000).optional(),
	})
	.strict();
export type DuckSettings = z.infer<typeof duckSettingsSchema>;
