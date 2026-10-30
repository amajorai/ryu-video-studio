/**
 * Script to video limits and request schemas: the shared constants and zod
 * shapes behind `script-to-video.ts` and its assembler.
 */
import { z } from "zod";
import type { Project } from "./project.ts";
import {
	type CaptionChunking,
	captionChunkingSchema,
} from "./schema/caption-style.ts";
import { bounded, idSchema, timeSchema } from "./schema/primitives.ts";
import {
	type PlacedScriptAvatar,
	scriptAvatarSchema,
	scriptMusicSchema,
} from "./script-extras.ts";
import type { NarrationWord } from "./script-to-video-align.ts";

/** Longest script the planner accepts, in characters. */
export const MAX_SCRIPT_CHARS = 20_000;
/** Most scenes one script produces or one assembly places. */
export const MAX_SCRIPT_SCENES = 40;
/** Narration text per scene (the caption and TTS input). */
export const MAX_SCENE_NARRATION_CHARS = 2000;
/** Shortest narration clip the assembler places, in seconds. */
export const MIN_SCENE_SECONDS = 0.04;
/** Ken Burns zoom applied across a still, as a scale factor. */
export const KEN_BURNS_ZOOM = 1.12;
/** Ken Burns horizontal drift, in normalized frame units (±1 is half the frame). */
export const KEN_BURNS_DRIFT = 0.03;
/**
 * Smallest Ken Burns scale. A box of scale `s` centred at `x` covers the
 * frame while `|x| <= s - 1`; twice the drift keeps a margin at every
 * keyframe, and linear interpolation keeps it in between.
 */
export const KEN_BURNS_MIN_SCALE = 1 + 2 * KEN_BURNS_DRIFT;
/** Captions one project holds (the project schema bound). */
export const MAX_PROJECT_CAPTIONS = 5000;
/** Video slower than this ratio is tiled instead of slowed down. */
export const MIN_STRETCH_SPEED = 0.5;
/** Captions the assembler builds when no chunking is given. */
export const DEFAULT_SCRIPT_CHUNKING: CaptionChunking = { mode: "words" };

export const narrationText = z
	.string()
	.trim()
	.min(1)
	.max(MAX_SCENE_NARRATION_CHARS)
	.refine((value) => !value.includes("\0"), "Narration cannot contain NUL.");

/** One planned scene: what is said, what to search for, what to generate. */
export const scriptSceneSchema = z
	.object({
		narration: narrationText,
		visualQuery: z.string().trim().min(1).max(200),
		imagePrompt: z.string().trim().min(1).max(2000),
	})
	.strict();
export type ScriptScene = z.infer<typeof scriptSceneSchema>;

export const scriptPlanSchema = z
	.object({
		scenes: z.array(scriptSceneSchema).min(1).max(MAX_SCRIPT_SCENES),
	})
	.strict();
export type ScriptPlan = z.infer<typeof scriptPlanSchema>;

export const scriptTextSchema = z
	.string()
	.trim()
	.min(1, "Write a script first.")
	.max(
		MAX_SCRIPT_CHARS,
		`Keep the script under ${MAX_SCRIPT_CHARS} characters.`
	);

export const scriptAssembleSceneSchema = z
	.object({
		narrationAssetId: idSchema,
		visualAssetId: idSchema,
		text: narrationText,
	})
	.strict();

export const scriptAssembleRequestSchema = z
	.object({
		scenes: z.array(scriptAssembleSceneSchema).min(1).max(MAX_SCRIPT_SCENES),
		/** Caption grouping; defaults to the project's, else word chunks. */
		captionChunking: captionChunkingSchema.optional(),
		/** Build captions from the narration (default true). */
		captions: z.boolean().optional(),
		/** Timeline start; defaults to the end of the current edit. */
		at: timeSchema.optional(),
		/** Silence between scenes in seconds (default 0). */
		gap: bounded(0, 2).optional(),
		/** Slow zoom and drift on stills (default true). */
		kenBurns: z.boolean().optional(),
		/** How visuals fill the frame (default fill). */
		fit: z.enum(["fit", "fill"]).optional(),
		/**
		 * A local music bed scored over the assembly and ducked under the
		 * narration (see `shared/script-extras.ts`). The sidecar route adds it.
		 */
		music: scriptMusicSchema.optional(),
		/** One preset avatar presenter per scene, lip-synced by the sidecar route. */
		avatar: scriptAvatarSchema.optional(),
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type ScriptAssembleRequest = z.infer<typeof scriptAssembleRequestSchema>;
export type ScriptAssembleInput = z.input<typeof scriptAssembleRequestSchema>;

/** Measured timing for a narration asset, in source seconds. */
export interface NarrationTiming {
	/** True for word-level timing from transcription; false for estimates. */
	measured: boolean;
	words: NarrationWord[];
}

export interface ScriptAssembleOptions {
	/** Transcribed timing of a narration asset, when it has one. */
	narrationTiming?: (assetId: string) => NarrationTiming | undefined;
	newId?: () => string;
}

/** Where one scene landed on the timeline. */
export interface AssembledScriptScene {
	end: number;
	narrationClipId: string;
	start: number;
	visualClipIds: string[];
}

export interface ScriptAssembly {
	/** Presenter avatars added, one per scene (empty without `avatar`). */
	avatars: PlacedScriptAvatar[];
	/** Captions added (after chunking). */
	captions: number;
	/** Seconds of timeline the assembly occupies, including gaps. */
	duration: number;
	narrationTrack: number;
	project: Project;
	/** Existing captions removed because they overlapped the assembly. */
	replacedCaptions: number;
	scenes: AssembledScriptScene[];
	visualTrack: number;
}
