import { z } from "zod";

/**
 * Soundtrack styles. `warm`, `bright` and `tense` are the original moods and
 * keep their exact score when requested without layers or sections.
 */
export const soundtrackMoodSchema = z.enum([
	"warm",
	"bright",
	"tense",
	"ambient",
	"cinematic",
	"lo-fi",
	"upbeat",
	"corporate",
	"suspense",
]);
export type SoundtrackMood = z.infer<typeof soundtrackMoodSchema>;
/** Planner vocabulary: a style is a mood. */
export const soundtrackStyleSchema = soundtrackMoodSchema;
export type SoundtrackStyle = SoundtrackMood;

/**
 * Instrument layers synthesized with `aevalsrc`. `pluck` is the original
 * re-struck chord; the others are the planner's band.
 */
export const soundtrackLayerSchema = z.enum([
	"pluck",
	"pad",
	"bass",
	"arpeggio",
	"kick",
	"hat",
	"snare",
]);
export type SoundtrackLayer = z.infer<typeof soundtrackLayerSchema>;

export const MAX_SOUNDTRACK_SECTIONS = 24;
export const MIN_SOUNDTRACK_SECTION_SECONDS = 0.5;

export const soundtrackSectionSchema = z
	.object({
		start: z.number().finite().min(0).max(7200),
		end: z.number().finite().min(0).max(7200),
		/** 0 is a sparse bed, 1 is the full band at full level. */
		intensity: z.number().finite().min(0).max(1),
	})
	.strict();
export type SoundtrackSection = z.infer<typeof soundtrackSectionSchema>;

const SECTION_EPSILON = 1e-6;

/** Problems with a section list against a soundtrack duration, if any. */
export function soundtrackSectionIssues(
	sections: readonly SoundtrackSection[],
	duration: number
): string[] {
	const issues: string[] = [];
	let previousEnd = 0;
	for (const [index, section] of sections.entries()) {
		if (section.end - section.start < MIN_SOUNDTRACK_SECTION_SECONDS) {
			issues.push(
				`Section ${index + 1} must last at least ${MIN_SOUNDTRACK_SECTION_SECONDS} seconds.`
			);
		}
		if (section.start < previousEnd - SECTION_EPSILON) {
			issues.push(`Section ${index + 1} overlaps the previous section.`);
		}
		if (section.end > duration + SECTION_EPSILON) {
			issues.push(`Section ${index + 1} ends after the soundtrack.`);
		}
		previousEnd = Math.max(previousEnd, section.end);
	}
	return issues;
}

export const soundtrackRequestSchema = z
	.object({
		bpm: z.number().finite().min(60).max(180).default(96),
		/**
		 * Time in seconds of one downbeat. Bars are phased so a bar starts
		 * there (and every bar length before and after it); omitted means bars
		 * start at time 0.
		 */
		downbeatOffset: z.number().finite().min(0).max(7200).optional(),
		duration: z.number().finite().min(0.5).max(7200),
		/** Layers to play; omitted means the style's default band. */
		layers: z.array(soundtrackLayerSchema).min(1).max(7).optional(),
		mood: soundtrackMoodSchema.default("warm"),
		/** Ordered intensity sections; uncovered time plays at intensity 0.5. */
		sections: z
			.array(soundtrackSectionSchema)
			.min(1)
			.max(MAX_SOUNDTRACK_SECTIONS)
			.optional(),
	})
	.strict()
	.superRefine((request, context) => {
		for (const message of soundtrackSectionIssues(
			request.sections ?? [],
			request.duration
		)) {
			context.addIssue({ code: "custom", message, path: ["sections"] });
		}
	});
export type SoundtrackRequest = z.infer<typeof soundtrackRequestSchema>;

export const SOUNDTRACK_BEATS_PER_BAR = 4;
const PHASE_EPSILON = 1e-6;

/** Bar length in seconds at a tempo. */
export const soundtrackBarSeconds = (bpm: number) =>
	(60 / bpm) * SOUNDTRACK_BEATS_PER_BAR;

/**
 * Seconds to add to the score clock so its bar grid lands on
 * `downbeatOffset`: in `[0, bar)`, and 0 when no offset is requested or the
 * offset is already on the grid from time 0.
 */
export function soundtrackClockLead(
	request: Pick<SoundtrackRequest, "bpm" | "downbeatOffset">
): number {
	if (request.downbeatOffset === undefined) {
		return 0;
	}
	const bar = soundtrackBarSeconds(request.bpm);
	const phase = request.downbeatOffset % bar;
	const lead = (bar - phase) % bar;
	return lead < PHASE_EPSILON || bar - lead < PHASE_EPSILON ? 0 : lead;
}

/** State of a soundtrack rendered in the background (`POST /soundtrack` 202). */
export const soundtrackJobSchema = z
	.object({
		id: z.uuid(),
		status: z.enum(["running", "done", "failed"]),
		createdAt: z.string(),
		/** The saved audio asset once `status` is `done`. */
		asset: z.json().optional(),
		error: z.object({ code: z.string(), message: z.string() }).optional(),
	})
	.strict();
export type SoundtrackJob = z.infer<typeof soundtrackJobSchema>;

export interface SoundtrackStyleDefinition {
	/** Default tempo a planner should start from. */
	bpm: number;
	label: string;
	layers: readonly SoundtrackLayer[];
	/** Chord-root ratios for a four-bar progression. */
	progression: readonly [number, number, number, number];
	/** Triad voicing in Hz. */
	voices: readonly [number, number, number];
}

const semitone = (steps: number) => Number((2 ** (steps / 12)).toFixed(4));
const progressionOf = (
	steps: readonly [number, number, number, number]
): SoundtrackStyleDefinition["progression"] => [
	semitone(steps[0]),
	semitone(steps[1]),
	semitone(steps[2]),
	semitone(steps[3]),
];
/** The original I–vi–IV–V style loop, kept with its published constants. */
const legacyProgression = [1, 0.8409, 0.6674, 0.7492] as const;

export const SOUNDTRACK_STYLES = {
	warm: {
		bpm: 96,
		label: "Warm",
		layers: ["pluck"],
		progression: legacyProgression,
		voices: [220, 277.18, 329.63],
	},
	bright: {
		bpm: 112,
		label: "Bright",
		layers: ["pluck"],
		progression: legacyProgression,
		voices: [261.63, 329.63, 392],
	},
	tense: {
		bpm: 84,
		label: "Tense",
		layers: ["pluck"],
		progression: legacyProgression,
		voices: [196, 233.08, 293.66],
	},
	ambient: {
		bpm: 70,
		label: "Ambient",
		layers: ["pad", "arpeggio"],
		progression: progressionOf([0, -4, -7, -2]),
		voices: [220, 261.63, 329.63],
	},
	cinematic: {
		bpm: 90,
		label: "Cinematic",
		layers: ["pad", "bass", "arpeggio", "kick", "snare"],
		progression: progressionOf([0, -4, 3, -2]),
		voices: [146.83, 174.61, 220],
	},
	"lo-fi": {
		bpm: 80,
		label: "Lo-fi",
		layers: ["pad", "bass", "kick", "hat", "snare"],
		progression: progressionOf([0, -3, 5, -2]),
		voices: [261.63, 329.63, 392],
	},
	upbeat: {
		bpm: 124,
		label: "Upbeat",
		layers: ["pad", "bass", "arpeggio", "kick", "hat", "snare"],
		progression: progressionOf([0, -5, -3, -7]),
		voices: [293.66, 369.99, 440],
	},
	corporate: {
		bpm: 110,
		label: "Corporate",
		layers: ["pad", "bass", "arpeggio", "kick", "hat"],
		progression: progressionOf([0, -5, -3, -7]),
		voices: [261.63, 329.63, 392],
	},
	suspense: {
		bpm: 72,
		label: "Suspense",
		layers: ["pad", "bass", "hat"],
		progression: progressionOf([0, -1, 0, 1]),
		voices: [196, 233.08, 277.18],
	},
} as const satisfies Record<SoundtrackMood, SoundtrackStyleDefinition>;

/** Layers a request plays, in a stable order without duplicates. */
export function soundtrackLayersOf(
	request: Pick<SoundtrackRequest, "layers" | "mood">
): SoundtrackLayer[] {
	const wanted = new Set<SoundtrackLayer>(
		request.layers ?? SOUNDTRACK_STYLES[request.mood].layers
	);
	return soundtrackLayerSchema.options.filter((layer) => wanted.has(layer));
}

/** Intensity at which each layer starts to enter the mix. */
export const SOUNDTRACK_LAYER_THRESHOLDS = {
	pluck: 0,
	pad: 0,
	bass: 0.2,
	kick: 0.35,
	arpeggio: 0.45,
	hat: 0.55,
	snare: 0.7,
} as const satisfies Record<SoundtrackLayer, number>;

/** Intensity for uncovered time when a request has sections. */
export const SOUNDTRACK_DEFAULT_INTENSITY = 0.5;

/**
 * Intensity breakpoints for a section list: `[time, value]` pairs where the
 * level changes, starting with the value at time 0.
 */
export function soundtrackIntensitySteps(
	sections: readonly SoundtrackSection[]
): [number, number][] {
	const steps: [number, number][] = [];
	let current = SOUNDTRACK_DEFAULT_INTENSITY;
	const change = (time: number, value: number) => {
		if (value === current) {
			return;
		}
		if (time <= SECTION_EPSILON && steps.length === 0) {
			current = value;
			return;
		}
		steps.push([time, value]);
		current = value;
	};
	const first = sections[0];
	const initial =
		first && first.start <= SECTION_EPSILON
			? first.intensity
			: SOUNDTRACK_DEFAULT_INTENSITY;
	current = initial;
	for (const [index, section] of sections.entries()) {
		change(section.start, section.intensity);
		const next = sections[index + 1];
		if (!next || next.start > section.end + SECTION_EPSILON) {
			change(section.end, SOUNDTRACK_DEFAULT_INTENSITY);
		}
	}
	return [[0, initial], ...steps];
}

/**
 * Soundtrack sources. `procedural` is the local score above (the default,
 * and the fallback when no audio model is configured); `generate` asks the
 * host's `media.audio` bridge for music from a cloud model.
 */
export const soundtrackSourceSchema = z.enum(["procedural", "generate"]);
export type SoundtrackSource = z.infer<typeof soundtrackSourceSchema>;

/** Longest generated music request; cloud music models cap far lower. */
export const MAX_GENERATED_MUSIC_SECONDS = 180;

/** Prompt for generated music in the chosen style, tempo and length. */
export function soundtrackGenerationPrompt(input: {
	bpm: number;
	description?: string;
	duration: number;
	mood: SoundtrackMood;
}): string {
	const style = SOUNDTRACK_STYLES[input.mood].label.toLowerCase();
	const lines = [
		`Instrumental ${style} background music for a video, about ${Math.round(input.bpm)} BPM, ${Math.round(input.duration)} seconds long.`,
		"No vocals. Leave room for narration and end cleanly.",
	];
	const description = input.description?.trim();
	if (description) {
		lines.push(`Direction: ${description}`);
	}
	return lines.join(" ").slice(0, 8000);
}

/**
 * Fit generated audio to the timeline: trim to `duration`, fade the tail,
 * and limit peaks, keeping the model provenance on the new asset.
 */
export const conformGeneratedAudioRequestSchema = z
	.object({
		/** The generated audio asset (from `media.audio`). */
		assetId: z.uuid(),
		/** Seconds to keep from the start. */
		duration: z.number().finite().min(0.03).max(7200),
		/** Seconds of fade-out at the end. */
		fadeOut: z.number().finite().min(0).max(10).default(1),
	})
	.strict();
export type ConformGeneratedAudioInput = z.input<
	typeof conformGeneratedAudioRequestSchema
>;
