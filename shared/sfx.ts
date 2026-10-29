import { z } from "zod";

/** Procedural sound effects synthesized locally with `aevalsrc`. */
export const sfxKindSchema = z.enum([
	"whoosh",
	"riser",
	"hit",
	"impact",
	"click",
	"pop",
	"swoosh",
	"ding",
]);
export type SfxKind = z.infer<typeof sfxKindSchema>;

export const MIN_SFX_SECONDS = 0.03;
export const MAX_SFX_SECONDS = 10;
export const MAX_SFX_SEED = 2_147_483_647;

export const sfxRequestSchema = z
	.object({
		kind: sfxKindSchema,
		/** Seconds; omitted means the kind's natural length. */
		duration: z
			.number()
			.finite()
			.min(MIN_SFX_SECONDS)
			.max(MAX_SFX_SECONDS)
			.optional(),
		/** Same kind, duration and seed always produce the same sound. */
		seed: z.number().int().min(0).max(MAX_SFX_SEED).optional(),
	})
	.strict();
export type SfxRequest = z.infer<typeof sfxRequestSchema>;

export const SFX_DEFAULT_DURATIONS = {
	whoosh: 0.8,
	riser: 3,
	hit: 0.5,
	impact: 1.5,
	click: 0.05,
	pop: 0.15,
	swoosh: 0.4,
	ding: 1.5,
} as const satisfies Record<SfxKind, number>;

export const SFX_LABELS = {
	whoosh: "Whoosh",
	riser: "Riser",
	hit: "Hit",
	impact: "Impact",
	click: "Click",
	pop: "Pop",
	swoosh: "Swoosh",
	ding: "Ding",
} as const satisfies Record<SfxKind, string>;

export const DEFAULT_SFX_SEED = 1;

export const sfxDurationOf = (request: Pick<SfxRequest, "duration" | "kind">) =>
	request.duration ?? SFX_DEFAULT_DURATIONS[request.kind];
export const sfxSeedOf = (request: Pick<SfxRequest, "seed">) =>
	request.seed ?? DEFAULT_SFX_SEED;

/**
 * Synthesis parameters for one effect. Frequencies are in Hz and decays are
 * per-second exponential rates. Noise kinds pass seeded noise through a
 * swept two-pole band-pass; tonal kinds are decaying sines.
 */
export interface SfxParameters {
	/** Exponential amplitude decay rate (1/s); 0 means a swell envelope. */
	decay: number;
	duration: number;
	/** Band-pass centre at the end of the sweep (noise kinds). */
	endHz: number;
	/** Linear make-up gain applied before the limiter. */
	gain: number;
	kind: SfxKind;
	/** 0..1 share of filtered noise against the tonal part. */
	noise: number;
	/** Fraction of the duration where the sweep or swell peaks. */
	peak: number;
	/** Band-pass pole radius: closer to 1 is a narrower band. */
	resonance: number;
	/** Seed for the noise generator. */
	seed: number;
	/** Band-pass centre at the start of the sweep (noise kinds). */
	startHz: number;
	/** Tone frequency at the end; equal to `toneHz` for a steady tone. */
	toneEndHz: number;
	/** Tone frequency at the start (tonal part). */
	toneHz: number;
}

/** Small deterministic PRNG (mulberry32) so seeds give stable variations. */
function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d_2b_79_f5) >>> 0;
		let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const round = (value: number, digits = 3) => {
	const scale = 10 ** digits;
	return Math.round(value * scale) / scale;
};

type Shape = Omit<SfxParameters, "duration" | "kind" | "seed">;

const shapes: Record<SfxKind, (random: () => number) => Shape> = {
	whoosh: (random) => ({
		decay: 0,
		endHz: 500 + random() * 400,
		gain: 3.2,
		noise: 1,
		peak: 0.45 + random() * 0.15,
		resonance: 0.985,
		startHz: 250 + random() * 200,
		toneHz: 0,
		toneEndHz: 0,
	}),
	swoosh: (random) => ({
		decay: 0,
		endHz: 900 + random() * 500,
		gain: 3,
		noise: 1,
		peak: 0.3 + random() * 0.15,
		resonance: 0.975,
		startHz: 2800 + random() * 1600,
		toneHz: 0,
		toneEndHz: 0,
	}),
	riser: (random) => ({
		decay: 0,
		endHz: 5000 + random() * 2500,
		gain: 2.4,
		noise: 0.65,
		peak: 0.94,
		resonance: 0.99,
		startHz: 300 + random() * 200,
		toneHz: 110 + random() * 40,
		toneEndHz: 880 + random() * 240,
	}),
	hit: (random) => ({
		decay: 9 + random() * 4,
		endHz: 1500,
		gain: 1.6,
		noise: 0.35,
		peak: 0,
		resonance: 0.9,
		startHz: 2500 + random() * 1500,
		toneHz: 180 + random() * 80,
		toneEndHz: 120 + random() * 40,
	}),
	impact: (random) => ({
		decay: 3.2 + random() * 1.2,
		endHz: 300,
		gain: 1.8,
		noise: 0.3,
		peak: 0,
		resonance: 0.93,
		startHz: 1200 + random() * 600,
		toneHz: 90 + random() * 30,
		toneEndHz: 38 + random() * 8,
	}),
	click: (random) => ({
		decay: 160 + random() * 60,
		endHz: 4000,
		gain: 1.4,
		noise: 0.2,
		peak: 0,
		resonance: 0.8,
		startHz: 4000,
		toneHz: 2200 + random() * 1600,
		toneEndHz: 2200 + random() * 1600,
	}),
	pop: (random) => ({
		decay: 32 + random() * 12,
		endHz: 800,
		gain: 1.5,
		noise: 0,
		peak: 0,
		resonance: 0.8,
		startHz: 800,
		toneHz: 650 + random() * 300,
		toneEndHz: 180 + random() * 80,
	}),
	ding: (random) => ({
		decay: 2.8 + random() * 1.2,
		endHz: 2000,
		gain: 1.2,
		noise: 0,
		peak: 0,
		resonance: 0.8,
		startHz: 2000,
		toneHz: 880 + random() * 440,
		toneEndHz: 880 + random() * 440,
	}),
};

/** Deterministic synthesis parameters for a validated request. */
export function sfxParameters(input: z.input<typeof sfxRequestSchema>) {
	const request = sfxRequestSchema.parse(input);
	const seed = sfxSeedOf(request);
	const kindIndex = sfxKindSchema.options.indexOf(request.kind);
	const random = seededRandom(seed * 31 + kindIndex);
	const shape = shapes[request.kind](random);
	// The tone of a steady kind does not glide: one draw sets both ends.
	const steady = request.kind === "click" || request.kind === "ding";
	const parameters: SfxParameters = {
		decay: round(shape.decay),
		duration: round(sfxDurationOf(request), 4),
		endHz: round(shape.endHz, 1),
		gain: shape.gain,
		kind: request.kind,
		noise: shape.noise,
		peak: round(shape.peak),
		resonance: shape.resonance,
		seed,
		startHz: round(shape.startHz, 1),
		toneHz: round(shape.toneHz, 1),
		toneEndHz: round(steady ? shape.toneHz : shape.toneEndHz, 1),
	};
	return parameters;
}

/** Prompt for a generated sound effect of `kind`, refined by `description`. */
export function sfxGenerationPrompt(input: {
	description?: string;
	duration: number;
	kind: SfxKind;
}): string {
	const description = input.description?.trim();
	const subject =
		description || `${SFX_LABELS[input.kind].toLowerCase()} sound effect`;
	return `${subject}, ${input.duration.toFixed(1)} seconds, clean, no music, no speech.`.slice(
		0,
		8000
	);
}
