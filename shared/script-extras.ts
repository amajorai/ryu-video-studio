/**
 * Script to video extras (G82): a music bed and an avatar presenter added to
 * an assembled script.
 *
 * Pure and deterministic. The music bed is a local soundtrack scored over
 * the assembled span: its style comes from `mood`, else keywords in
 * `description`, else warm; its intensity sections change at scene starts
 * and build towards the end. The clip is placed on a free audio track at the
 * assembly start, ducked under the narration. The presenter is one 2.5D
 * avatar per scene, spanning that scene's narration, positioned by a preset;
 * the sidecar then lip-syncs each one to its narration clip.
 */
import { z } from "zod";
import {
	type Asset,
	type Avatar,
	newSegment,
	type Project,
	validateProject,
} from "./project.ts";
import { bounded } from "./schema/primitives.ts";
import {
	MAX_SOUNDTRACK_SECTIONS,
	MIN_SOUNDTRACK_SECTION_SECONDS,
	SOUNDTRACK_STYLES,
	type SoundtrackMood,
	type SoundtrackSection,
	soundtrackMoodSchema,
	soundtrackSectionIssues,
} from "./soundtrack.ts";
import { soundtrackDescriptionSchema } from "./soundtrack-plan.ts";
import { firstFreeTrack } from "./track-placement.ts";

/** Music bed level under the narration (0-1 clip volume). */
export const DEFAULT_SCRIPT_MUSIC_VOLUME = 0.35;
/** Fade at each end of the music bed, in seconds (at most a quarter of it). */
export const SCRIPT_MUSIC_FADE_SECONDS = 1;
/** Section intensity at the first and last scene. */
export const SCRIPT_MUSIC_INTENSITY = { end: 0.75, start: 0.35 } as const;
/** Most avatars a project holds (the project schema bound). */
const MAX_PROJECT_AVATARS = 100;

export const scriptMusicSchema = z
	.object({
		/** Soundtrack style; wins over `description`. */
		mood: soundtrackMoodSchema.optional(),
		/** What the music should sound like; picks the style by keyword. */
		description: soundtrackDescriptionSchema.optional(),
		/** Clip volume of the bed (default 0.35). */
		volume: bounded(0, 1).optional(),
		/** Duck the bed while the narration plays (default true). */
		duck: z.boolean().optional(),
	})
	.strict();
export type ScriptMusic = z.infer<typeof scriptMusicSchema>;

export const scriptAvatarPresetSchema = z.enum([
	"presenter-right",
	"presenter-left",
	"corner",
]);
export type ScriptAvatarPreset = z.infer<typeof scriptAvatarPresetSchema>;

export const scriptAvatarSchema = z
	.object({
		preset: scriptAvatarPresetSchema,
		/** Lip-sync each avatar to its scene's narration (default true). */
		lipSync: z.boolean().optional(),
	})
	.strict();
export type ScriptAvatar = z.infer<typeof scriptAvatarSchema>;

type AvatarLook = Pick<
	Avatar,
	| "accent"
	| "animation"
	| "depth"
	| "entryDuration"
	| "height"
	| "outfit"
	| "pose"
	| "skin"
	| "width"
	| "x"
	| "y"
>;

export const SCRIPT_AVATAR_PRESETS = {
	"presenter-right": {
		accent: "#f97316",
		animation: "idle",
		depth: 0.45,
		entryDuration: 0.35,
		height: 0.64,
		outfit: "#4f46e5",
		pose: "neutral",
		skin: "#f4c7a1",
		width: 0.28,
		x: 0.62,
		y: 0.2,
	},
	"presenter-left": {
		accent: "#0ea5e9",
		animation: "idle",
		depth: 0.45,
		entryDuration: 0.35,
		height: 0.64,
		outfit: "#0f766e",
		pose: "neutral",
		skin: "#c68863",
		width: 0.28,
		x: 0.1,
		y: 0.2,
	},
	corner: {
		accent: "#eab308",
		animation: "idle",
		depth: 0.35,
		entryDuration: 0.35,
		height: 0.36,
		outfit: "#be123c",
		pose: "neutral",
		skin: "#e0ac69",
		width: 0.16,
		x: 0.8,
		y: 0.6,
	},
} satisfies Record<ScriptAvatarPreset, AvatarLook>;

/** Words that pick a soundtrack style from a music description. */
const MOOD_KEYWORDS = {
	ambient: ["ambient", "calm", "atmospheric", "meditative", "soft", "gentle"],
	bright: ["bright", "happy", "cheerful", "playful", "sunny", "joyful"],
	cinematic: ["cinematic", "epic", "dramatic", "orchestral", "trailer"],
	corporate: ["corporate", "business", "professional", "explainer", "tech"],
	"lo-fi": ["lo-fi", "lofi", "lo fi", "chill", "study", "relaxed"],
	suspense: ["suspense", "mystery", "mysterious", "dark", "spooky", "eerie"],
	tense: ["tense", "urgent", "anxious", "thriller", "intense"],
	upbeat: ["upbeat", "energetic", "dance", "driving", "fast", "pop"],
	warm: ["warm", "acoustic", "folk", "cozy", "heartfelt", "nostalgic"],
} satisfies Record<SoundtrackMood, readonly string[]>;

const escapeRegExp = (value: string) =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The style a description names: the keyword that appears first wins, so
 * "dark and epic" is suspense. `undefined` when no keyword matches.
 */
export function musicMoodFromDescription(
	description: string | undefined
): SoundtrackMood | undefined {
	const text = description?.toLowerCase() ?? "";
	let best: { index: number; mood: SoundtrackMood } | undefined;
	for (const mood of soundtrackMoodSchema.options) {
		for (const keyword of MOOD_KEYWORDS[mood]) {
			const match = new RegExp(
				`(^|[^a-z])${escapeRegExp(keyword)}($|[^a-z])`
			).exec(text);
			if (match && (best === undefined || match.index < best.index)) {
				best = { index: match.index, mood };
			}
		}
	}
	return best?.mood;
}

/** The style of a music bed: `mood`, else the description's, else warm. */
export const scriptMusicMood = (music: ScriptMusic): SoundtrackMood =>
	music.mood ?? musicMoodFromDescription(music.description) ?? "warm";

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** Where an assembled scene sits on the timeline. */
export interface ScriptSceneWindow {
	end: number;
	start: number;
}

/**
 * Intensity sections over the assembled span (times relative to its start):
 * a section begins at each scene start, too-short sections merge into the
 * previous one, at most `MAX_SOUNDTRACK_SECTIONS` boundaries are kept
 * (evenly spaced), and intensity rises from the first scene to the last.
 */
export function scriptMusicSections(
	scenes: readonly ScriptSceneWindow[],
	duration: number
): SoundtrackSection[] {
	const at = scenes[0]?.start ?? 0;
	const span = round3(duration);
	if (span < MIN_SOUNDTRACK_SECTION_SECONDS) {
		return [];
	}
	const starts: number[] = [0];
	for (const scene of scenes.slice(1)) {
		const start = round3(scene.start - at);
		const previous = starts.at(-1) ?? 0;
		if (
			start - previous >= MIN_SOUNDTRACK_SECTION_SECONDS &&
			span - start >= MIN_SOUNDTRACK_SECTION_SECONDS
		) {
			starts.push(start);
		}
	}
	const kept =
		starts.length <= MAX_SOUNDTRACK_SECTIONS
			? starts
			: Array.from(
					{ length: MAX_SOUNDTRACK_SECTIONS },
					(_, index) =>
						starts[
							Math.round(
								(index * (starts.length - 1)) / (MAX_SOUNDTRACK_SECTIONS - 1)
							)
						] ?? 0
				);
	const last = kept.length - 1;
	const sections = kept.map((start, index) => ({
		end: kept[index + 1] ?? span,
		intensity: round3(
			last
				? SCRIPT_MUSIC_INTENSITY.start +
						((SCRIPT_MUSIC_INTENSITY.end - SCRIPT_MUSIC_INTENSITY.start) *
							index) /
							last
				: (SCRIPT_MUSIC_INTENSITY.start + SCRIPT_MUSIC_INTENSITY.end) / 2
		),
		start,
	}));
	return soundtrackSectionIssues(sections, span).length ? [] : sections;
}

/** A `POST /soundtrack` body for a music bed. */
export interface ScriptMusicBody {
	bpm: number;
	duration: number;
	mood: SoundtrackMood;
	sections?: SoundtrackSection[];
}

/** The `POST /soundtrack` body for a music bed under an assembly. */
export function scriptMusicRequest(
	assembly: { duration: number; scenes: readonly ScriptSceneWindow[] },
	music: ScriptMusic
): ScriptMusicBody {
	const duration = round3(assembly.duration);
	if (duration < MIN_SOUNDTRACK_SECTION_SECONDS) {
		throw new Error("The assembly is too short for a music bed.");
	}
	const mood = scriptMusicMood(music);
	const body: ScriptMusicBody = {
		bpm: SOUNDTRACK_STYLES[mood].bpm,
		duration,
		mood,
	};
	const sections = scriptMusicSections(assembly.scenes, duration);
	if (sections.length) {
		body.sections = sections;
	}
	return body;
}

/** A placed music bed. */
export interface PlacedScriptMusic {
	clipId: string;
	project: Project;
	track: number;
}

export interface PlaceScriptMusicInput {
	/** Duck the bed under the narration (default true). */
	duck?: boolean;
	duration: number;
	start: number;
	/** Clip volume (default `DEFAULT_SCRIPT_MUSIC_VOLUME`). */
	volume?: number;
}

/**
 * Put a music bed at `start` on the first audio track (from track 1) that is
 * free for the whole span, trimmed to `duration`, faded at both ends and
 * ducked under other audio unless `duck` is false.
 */
export function placeScriptMusic(
	project: Project,
	assets: readonly Asset[],
	asset: Asset,
	input: PlaceScriptMusicInput
): PlacedScriptMusic {
	if (asset.kind !== "audio") {
		throw new Error("The music bed must be an audio asset.");
	}
	const length = Math.min(asset.duration, input.duration);
	if (!(length > 0)) {
		throw new Error("The music bed is empty.");
	}
	const library = assets.some((item) => item.id === asset.id)
		? [...assets]
		: [...assets, asset];
	const track = firstFreeTrack(project, input.start, input.start + length, {
		assets: library,
		from: 1,
		kind: "audio",
	});
	if (track === undefined) {
		throw new Error("No free audio track can hold the music bed.");
	}
	const fade = round3(Math.min(SCRIPT_MUSIC_FADE_SECONDS, length / 4));
	const clip = {
		...newSegment(asset, input.start, track),
		duckUnderVoice: input.duck ?? true,
		fadeIn: fade,
		fadeOut: fade,
		sourceIn: 0,
		sourceOut: length,
		volume: input.volume ?? DEFAULT_SCRIPT_MUSIC_VOLUME,
	};
	return {
		clipId: clip.id,
		project: validateProject(
			{ ...project, segments: [...project.segments, clip] },
			library
		),
		track,
	};
}

/** An avatar placed for one scene, with the narration clip that voices it. */
export interface PlacedScriptAvatar {
	avatarId: string;
	narrationClipId: string;
}

/** Presenter avatars added to a project. */
export interface PlacedScriptAvatars {
	avatars: PlacedScriptAvatar[];
	project: Project;
}

/**
 * One preset avatar per scene, spanning that scene's narration. Throws when
 * the project would exceed its avatar limit.
 */
export function placeScriptAvatars(
	project: Project,
	scenes: readonly (ScriptSceneWindow & { narrationClipId: string })[],
	preset: ScriptAvatarPreset,
	newId: () => string = () => crypto.randomUUID()
): PlacedScriptAvatars {
	if (project.avatars.length + scenes.length > MAX_PROJECT_AVATARS) {
		throw new Error(
			`The project can hold ${MAX_PROJECT_AVATARS} avatars; remove some before adding a presenter.`
		);
	}
	const look = SCRIPT_AVATAR_PRESETS[preset];
	const placed: PlacedScriptAvatar[] = [];
	const avatars: Avatar[] = scenes.map((scene) => {
		const id = newId();
		placed.push({ avatarId: id, narrationClipId: scene.narrationClipId });
		const length = scene.end - scene.start;
		return {
			...look,
			end: round3(scene.end),
			entryDuration: Math.min(look.entryDuration, round3(length / 2)),
			id,
			start: round3(scene.start),
		};
	});
	return {
		avatars: placed,
		project: { ...project, avatars: [...project.avatars, ...avatars] },
	};
}
