/**
 * Pure edits for the inspector's audio controls. Each returns the clip patch
 * to send through `onChange` (which becomes a `clip-properties` style edit).
 */
import { newAudioEffect } from "../../../../shared/audio-effects.ts";
import type { Segment } from "../../../../shared/project.ts";
import {
	type AudioCleanup,
	type AudioEffect,
	type AudioEffectType,
	MAX_AUDIO_EFFECTS,
} from "../../../../shared/schema/audio-ext.ts";
import { audioCleanupOf } from "../../../../shared/schema/defaults.ts";

type AudioPatch = Partial<
	Pick<Segment, "audioCleanup" | "audioEffects" | "audioProcessing">
>;

/**
 * Change one cleanup control. The first graded edit of a clip that still uses
 * a legacy preset starts from that preset's graded values. Every cleanup patch
 * also clears the legacy `audioProcessing` preset: the render ignores it once
 * `audioCleanup` exists, but the preview graph still reads it, so leaving it set
 * would preview processing the export no longer has.
 */
export function cleanupPatch(
	segment: Pick<Segment, "audioCleanup" | "audioProcessing">,
	change: AudioCleanup
): AudioPatch {
	return {
		audioCleanup: { ...audioCleanupOf(segment), ...change },
		audioProcessing: "none",
	};
}

/** Named cleanup starting points shown above the sliders. */
export const CLEANUP_PRESETS = {
	off: { denoise: 0, enhance: 0, normalize: false, voiceIsolation: 0 },
	podcast: { denoise: 0.4, enhance: 0.6, normalize: true, voiceIsolation: 0 },
	"noisy-room": {
		denoise: 0.7,
		enhance: 0.4,
		normalize: true,
		voiceIsolation: 0.8,
	},
	music: { denoise: 0, enhance: 0, normalize: true, voiceIsolation: 0 },
} as const satisfies Record<string, Required<AudioCleanup>>;
export type CleanupPresetId = keyof typeof CLEANUP_PRESETS;

/** Apply a named cleanup preset, clearing the legacy preset like `cleanupPatch`. */
export function cleanupPresetPatch(id: CleanupPresetId): AudioPatch {
	return { audioCleanup: { ...CLEANUP_PRESETS[id] }, audioProcessing: "none" };
}

const stackOf = (segment: Pick<Segment, "audioEffects">) =>
	segment.audioEffects ?? [];

/** Append an effect, refusing past the stack limit. */
export function addEffect(
	segment: Pick<Segment, "audioEffects">,
	type: AudioEffectType
): AudioPatch | null {
	const stack = stackOf(segment);
	if (stack.length >= MAX_AUDIO_EFFECTS) {
		return null;
	}
	return { audioEffects: [...stack, newAudioEffect(type)] };
}

export function updateEffect(
	segment: Pick<Segment, "audioEffects">,
	index: number,
	change: Partial<AudioEffect>
): AudioPatch {
	return {
		audioEffects: stackOf(segment).map((effect, position) =>
			position === index ? { ...effect, ...change } : effect
		),
	};
}

export function removeEffect(
	segment: Pick<Segment, "audioEffects">,
	index: number
): AudioPatch {
	return {
		audioEffects: stackOf(segment).filter((_, position) => position !== index),
	};
}

/** Move an effect one slot up (-1) or down (+1); out-of-range moves are no-ops. */
export function moveEffect(
	segment: Pick<Segment, "audioEffects">,
	index: number,
	direction: -1 | 1
): AudioPatch {
	const stack = [...stackOf(segment)];
	const target = index + direction;
	const moving = stack[index];
	const other = stack[target];
	if (!(moving && other)) {
		return { audioEffects: stack };
	}
	stack[index] = other;
	stack[target] = moving;
	return { audioEffects: stack };
}
