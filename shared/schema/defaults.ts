/**
 * Accessors for optional schema fields. New fields are stored without
 * defaults so legacy projects round-trip byte-identically; every reader
 * resolves the effective value here instead of repeating the fallback.
 */
import type { AudioProcessing } from "../audio.ts";
import type { Project, Segment, TrackSetting } from "../project.ts";
import { styleProfileConfig } from "../styles.ts";
import type { AudioCleanup } from "./audio-ext.ts";
import type { CanvasBackground } from "./background.ts";
import type { BlendMode } from "./blend.ts";
import type { CaptionStyle } from "./caption-style.ts";
import type { ExportSettings } from "./export.ts";
import type { CustomFont } from "./font.ts";
import type { Keyframe, KeyframeInterpolation } from "./keyframe.ts";

/** Copy only the keys whose value is defined, so overlays never erase defaults. */
function definedFields<T extends object>(value: T | undefined): Partial<T> {
	const fields: Partial<T> = {};
	if (!value) {
		return fields;
	}
	for (const key of Object.keys(value) as (keyof T)[]) {
		if (value[key] !== undefined) {
			fields[key] = value[key];
		}
	}
	return fields;
}

export const blendModeOf = (layer: { blendMode?: BlendMode }): BlendMode =>
	layer.blendMode ?? "normal";

/** Horizontal stretch applied on top of `scale` (1 = none). */
export const scaleXOf = (segment: Pick<Segment, "scaleX">): number =>
	segment.scaleX ?? 1;
/** Vertical stretch applied on top of `scale` (1 = none). */
export const scaleYOf = (segment: Pick<Segment, "scaleY">): number =>
	segment.scaleY ?? 1;

/** Tracks are sync-locked unless explicitly unlocked. */
export const syncLockedOf = (setting: Pick<TrackSetting, "syncLocked">) =>
	setting.syncLocked ?? true;
export const trackHiddenOf = (setting: Pick<TrackSetting, "hidden">) =>
	setting.hidden ?? false;
export const trackGainOf = (setting: Pick<TrackSetting, "gainDb">): number =>
	setting.gainDb ?? 0;
export const trackPanOf = (setting: Pick<TrackSetting, "pan">): number =>
	setting.pan ?? 0;

/** `atempo` keeps pitch, so clips preserve pitch unless told otherwise. */
export const preservePitchOf = (segment: Pick<Segment, "preservePitch">) =>
	segment.preservePitch ?? true;

export const interpolationOf = (
	keyframe: Pick<Keyframe, "interpolation">
): KeyframeInterpolation => keyframe.interpolation ?? "linear";

export type ResolvedAudioCleanup = Required<AudioCleanup>;

const cleanupOff: ResolvedAudioCleanup = {
	denoise: 0,
	enhance: 0,
	normalize: false,
	voiceIsolation: 0,
};

const legacyCleanup: Record<AudioProcessing, Partial<ResolvedAudioCleanup>> = {
	denoise: { denoise: 0.6 },
	none: {},
	normalize: { normalize: true },
	"voice-enhance": { denoise: 0.4, enhance: 0.6 },
};

/**
 * The effective cleanup chain. An explicit `audioCleanup` wins; otherwise the
 * legacy `audioProcessing` preset maps onto the graded controls.
 */
export function audioCleanupOf(
	segment: Pick<Segment, "audioCleanup" | "audioProcessing">
): ResolvedAudioCleanup {
	if (segment.audioCleanup) {
		return { ...cleanupOff, ...definedFields(segment.audioCleanup) };
	}
	return {
		...cleanupOff,
		...legacyCleanup[segment.audioProcessing ?? "none"],
	};
}

export type ResolvedExportSettings = ExportSettings &
	Required<
		Pick<
			ExportSettings,
			"alpha" | "audioBitrateKbps" | "hdr" | "includeAudio" | "rateControl"
		>
	>;

type LegacyPreset = Project["exportPreset"];

const h264Crf: Record<LegacyPreset, number> = {
	master: 20,
	review: 26,
	social: 21,
};
const h265Crf: Record<LegacyPreset, number> = {
	master: 24,
	review: 30,
	social: 25,
};
const x26xPreset: Record<LegacyPreset, ExportSettings["encoderPreset"]> = {
	master: "fast",
	review: "veryfast",
	social: "medium",
};

/**
 * Export settings derived from the legacy `exportPreset`/`exportCodec`
 * (matching the current encoder arguments), overlaid with any explicit
 * `exportSettings`.
 */
export function exportSettingsOf(
	project: Pick<Project, "exportCodec" | "exportPreset" | "exportSettings">
): ResolvedExportSettings {
	const codec = project.exportCodec;
	const preset = project.exportPreset;
	const prores = codec === "prores" || codec === "prores-4444";
	const derived: ResolvedExportSettings = {
		container: prores ? "mov" : codec === "vp9" ? "webm" : "mp4",
		includeAudio: true,
		alpha: codec === "prores-4444",
		rateControl: "crf",
		audioBitrateKbps: 192,
		hdr: "off",
	};
	if (!prores) {
		derived.crf =
			codec === "h265" || codec === "h265-10bit"
				? h265Crf[preset]
				: h264Crf[preset];
		derived.encoderPreset = x26xPreset[preset];
	}
	return { ...derived, ...definedFields(project.exportSettings) };
}

/** Every caption style field resolved; the optional font sources stay nullable. */
export type ResolvedCaptionStyle = Required<
	Omit<CaptionStyle, "customFont" | "systemFont">
> & { customFont: CustomFont | null; systemFont: string | null };

/** The built-in burned-in caption look (white bold text, thin black outline). */
export function captionStyleOf(
	project: Pick<Project, "captionStyle" | "height">
): ResolvedCaptionStyle {
	return {
		presetId: "classic",
		fontFamily: "system-sans",
		customFont: null,
		systemFont: null,
		fontSize: 0.045,
		fontWeight: 700,
		uppercase: false,
		color: "#ffffff",
		highlightColor: "#ffd43b",
		outlineColor: "#000000",
		// The legacy ASS style draws a 2px outline at the project resolution.
		outlineWidth: Math.min(0.02, 2 / project.height),
		shadowDepth: 0,
		backgroundColor: "#000000",
		backgroundOpacity: 0,
		positionX: 0.5,
		positionY: 0.92,
		maxLines: 3,
		wordAnimation: "highlight",
		...definedFields(project.captionStyle),
	};
}

/** The canvas fill: an explicit background, or the style profile color. */
export function backgroundOf(
	project: Pick<Project, "background" | "styleProfile">
): CanvasBackground {
	return (
		project.background ?? {
			color: styleProfileConfig(project.styleProfile).background,
			type: "color",
		}
	);
}
