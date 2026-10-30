import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { z } from "zod";
import {
	type ScriptAvatarPreset,
	type ScriptMusic,
	scriptAvatarPresetSchema,
} from "../../../shared/script-extras.ts";
import {
	type SoundtrackMood,
	soundtrackMoodSchema,
} from "../../../shared/soundtrack.ts";
import {
	type StockProvider,
	stockProviderSchema,
} from "../../../shared/stock.ts";
import type { SceneDraft } from "./script-to-video-pipeline.ts";

/** English fallback until a caller passes the Companion's `tl`. */
const englishMessages: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

export type CaptionMode = "none" | "segments" | "words" | "single-word";

export const captionModeSchema = z.enum([
	"none",
	"segments",
	"words",
	"single-word",
]);
/** Music bed choice: none, a style picked from the description, or a style. */
export type MusicChoice = "none" | "auto" | SoundtrackMood;
export const musicChoiceSchema = z.union([
	z.enum(["none", "auto"]),
	soundtrackMoodSchema,
]);
export const AVATAR_LABELS = {
	corner: "Small, bottom right corner",
	"presenter-left": "Presenter on the left",
	"presenter-right": "Presenter on the right",
} as const satisfies Record<ScriptAvatarPreset, string>;
export const avatarChoiceSchema = z.union([
	z.literal("none"),
	scriptAvatarPresetSchema,
]);
export const visualSourceSchema = z.enum(["stock", "generated"]);

export const CAPTION_LABELS: Record<CaptionMode, string> = {
	none: "No captions",
	segments: "One caption per sentence group",
	"single-word": "One word at a time",
	words: "Short phrases",
};

export const PROVIDER_LABELS: Record<StockProvider, string> = {
	"archive.org": "Archive.org",
	coverr: "Coverr (node-configured)",
	nasa: "NASA Images and Video",
	"openverse.audio": "Openverse audio",
	"openverse.image": "Openverse images",
	pexels: "Pexels (node-configured)",
	pixabay: "Pixabay (node-configured)",
	"unsplash.image": "Unsplash images (node-configured)",
	"wikimedia.commons": "Wikimedia Commons",
};

export const VISUAL_PROVIDERS = stockProviderSchema.options.filter(
	(provider) => provider !== "openverse.audio"
);

export const SCRIPT_KEY = "script-to-video-script";

export const STEP_LABELS: Record<NonNullable<SceneDraft["step"]>, string> = {
	narration: "Making narration",
	transcript: "Timing words",
	visual: "Finding visual",
};

/** The music bed request for the panel's choice and description. */
export function musicSettings(
	choice: Exclude<MusicChoice, "none">,
	description: string
): ScriptMusic {
	const settings: ScriptMusic = {};
	if (choice !== "auto") {
		settings.mood = choice;
	}
	if (description.trim()) {
		settings.description = description.trim();
	}
	return settings;
}

/** Short status for a scene row. */
export function sceneStatusText(draft: SceneDraft): string {
	if (draft.status === "working") {
		return draft.step ? `${STEP_LABELS[draft.step]}…` : "Working…";
	}
	if (draft.status === "failed") {
		return `Failed${draft.step ? ` while ${STEP_LABELS[draft.step].toLowerCase()}` : ""}: ${draft.error ?? "unknown error"}`;
	}
	if (draft.status === "ready") {
		return draft.transcribed
			? "Ready · word-timed"
			: "Ready · estimated caption timing";
	}
	return "Not produced yet";
}

/** Status line after assembly, from the route's extras. */
export function assemblySummary(
	extras: Record<string, unknown>,
	tl: LiteralMessage = englishMessages
): string {
	const scenes = Array.isArray(extras.scenes) ? extras.scenes.length : 0;
	const seconds = typeof extras.duration === "number" ? extras.duration : 0;
	const captions = typeof extras.captions === "number" ? extras.captions : 0;
	const replaced =
		typeof extras.replacedCaptions === "number" ? extras.replacedCaptions : 0;
	const avatars = Array.isArray(extras.avatars) ? extras.avatars.length : 0;
	return tl(
		"Assembled {sceneCount, plural, one {# scene} other {# scenes}} ({seconds} s) with {captionCount, plural, one {{captions} caption} other {{captions} captions}}{avatarCount, plural, =0 {} one {, a presenter avatar in # scene} other {, a presenter avatar in # scenes}}{replacedCount, plural, =0 {} other {; replaced {replaced} overlapping}}. Review rights for stock media before publishing.",
		{
			avatarCount: avatars,
			captionCount: captions,
			captions: String(captions),
			replaced: String(replaced),
			replacedCount: replaced,
			sceneCount: scenes,
			seconds: seconds.toFixed(1),
		}
	);
}
