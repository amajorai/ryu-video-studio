import { describe, expect, test } from "bun:test";
import {
	AUDIO_EFFECT_CONTROLS,
	AUDIO_EFFECT_LABELS,
	AUDIO_EFFECT_PRESETS,
	AUDIO_EFFECT_TYPES,
	audioEffectChainFilters,
	audioEffectFilterList,
	audioEffectParams,
	audioEffectPresetStack,
	displayedSemitones,
	effectSemitones,
	newAudioEffect,
	RENDER_ONLY_AUDIO_EFFECTS,
	semitoneRange,
	stackShiftsPitch,
} from "./audio-effects.ts";
import { segmentSchema } from "./project.ts";
import {
	type AudioEffect,
	audioEffectSchema,
	MAX_AUDIO_EFFECTS,
} from "./schema/audio-ext.ts";

const withRubberband = { rubberband: true };
const withoutRubberband = { rubberband: false };
const effect = (
	type: AudioEffect["type"],
	extra: Partial<AudioEffect> = {}
): AudioEffect => ({ amount: 0.5, enabled: true, type, ...extra });

describe("audio effect filters", () => {
	test("every type yields filters at a moderate amount", () => {
		for (const type of AUDIO_EFFECT_TYPES) {
			const filters = audioEffectFilterList(
				newAudioEffect(type),
				withRubberband
			);
			expect(filters.length).toBeGreaterThan(0);
			expect(AUDIO_EFFECT_LABELS[type]).toBeString();
			expect(AUDIO_EFFECT_CONTROLS[type]).toBeArray();
		}
	});

	test("filter strings follow the documented recipes", () => {
		const cases: [AudioEffect, string[]][] = [
			[effect("echo"), ["aecho=0.8:0.8:260:0.5"]],
			[
				effect("reverb", { amount: 1 }),
				["aecho=0.8:0.68:37|53|79|113|167:0.5|0.42|0.34|0.27|0.2"],
			],
			[
				effect("eq", { frequency: 250, gainDb: -6 }),
				["equalizer=f=250:t=q:w=1:g=-6"],
			],
			[effect("bass-boost", { gainDb: 6 }), ["bass=g=6:f=100"]],
			[effect("treble-boost"), ["treble=g=6:f=3000"]],
			[
				effect("telephone"),
				[
					"highpass=f=325",
					"highpass=f=325",
					"lowpass=f=3400",
					"lowpass=f=3400",
				],
			],
			[
				effect("radio"),
				[
					"highpass=f=500",
					"highpass=f=500",
					"lowpass=f=4500",
					"lowpass=f=4500",
					"acrusher=bits=12:mode=log:aa=1:mix=0.45",
				],
			],
			[
				effect("robot"),
				["afftfilt=real='hypot(re,im)':imag='0':win_size=512:overlap=0.75"],
			],
			[effect("chorus"), ["chorus=0.6:0.9:50|60:0.375|0.3:0.25|0.4:2|2.3"]],
			[effect("flanger"), ["flanger=delay=0:depth=5.5:regen=25:speed=0.5"]],
			[
				effect("megaphone"),
				[
					"highpass=f=600",
					"lowpass=f=3000",
					"acrusher=bits=8:mode=log:aa=1:mix=0.5",
					"volume=1.5",
				],
			],
			[effect("vibrato"), ["vibrato=f=6:d=0.5"]],
			[effect("tremolo"), ["tremolo=f=6.5:d=0.6"]],
		];
		for (const [input, expected] of cases) {
			expect(audioEffectFilterList(input, withRubberband)).toEqual(expected);
		}
	});

	test("pitch uses rubberband when present and a retimed resample otherwise", () => {
		expect(
			audioEffectFilterList(effect("pitch", { semitones: 12 }), withRubberband)
		).toEqual(["rubberband=pitch=2"]);
		expect(
			audioEffectFilterList(effect("chipmunk"), withoutRubberband)
		).toEqual([
			"aresample=48000",
			"asetrate=71919",
			"aresample=48000",
			"atempo=0.6674",
		]);
		expect(audioEffectFilterList(effect("deep-voice"), withRubberband)).toEqual(
			["rubberband=pitch=0.6674"]
		);
		expect(
			audioEffectFilterList(effect("pitch", { semitones: 0 }), withRubberband)
		).toEqual([]);
	});

	test("disabled and neutral effects add nothing", () => {
		expect(
			audioEffectFilterList(effect("echo", { enabled: false }), withRubberband)
		).toEqual([]);
		expect(
			audioEffectFilterList(effect("eq", { gainDb: 0 }), withRubberband)
		).toEqual([]);
		expect(audioEffectChainFilters(undefined, withRubberband)).toEqual([]);
	});

	test("the chain keeps stack order and the stack limit", () => {
		expect(
			audioEffectChainFilters(
				[effect("vibrato"), effect("tremolo")],
				withRubberband
			)
		).toEqual(["vibrato=f=6:d=0.5", "tremolo=f=6.5:d=0.6"]);
		const long = Array.from({ length: MAX_AUDIO_EFFECTS + 2 }, () =>
			effect("tremolo")
		);
		expect(audioEffectChainFilters(long, withRubberband)).toHaveLength(
			MAX_AUDIO_EFFECTS
		);
	});
});

describe("audio effect parameters", () => {
	test("semitones follow the pitch family conventions", () => {
		expect(effectSemitones(effect("chipmunk"))).toBe(7);
		expect(effectSemitones(effect("chipmunk", { semitones: -3 }))).toBe(3);
		expect(effectSemitones(effect("deep-voice", { semitones: 4 }))).toBe(-4);
		expect(effectSemitones(effect("pitch", { semitones: -2 }))).toBe(-2);
		expect(effectSemitones(effect("echo"))).toBe(0);
		expect(stackShiftsPitch([effect("chipmunk")])).toBe(true);
		expect(stackShiftsPitch([effect("chipmunk", { enabled: false })])).toBe(
			false
		);
		expect(stackShiftsPitch([effect("pitch", { semitones: 0 })])).toBe(false);
	});

	test("editor semitone ranges match what renders", () => {
		expect(semitoneRange("chipmunk")).toEqual({ max: 12, min: 0 });
		expect(semitoneRange("deep-voice")).toEqual({ max: 0, min: -12 });
		expect(semitoneRange("pitch")).toEqual({ max: 12, min: -12 });
		expect(displayedSemitones(effect("chipmunk", { semitones: -5 }))).toBe(5);
		expect(displayedSemitones(effect("deep-voice", { semitones: 5 }))).toBe(-5);
		expect(displayedSemitones(effect("pitch", { semitones: 30 }))).toBe(12);
	});

	test("amount is offered only where the parameters read it", () => {
		for (const type of ["chipmunk", "deep-voice", "pitch"] as const) {
			expect(AUDIO_EFFECT_CONTROLS[type]).not.toContain("amount");
			const low = audioEffectParams(effect(type, { amount: 0, semitones: 3 }));
			const high = audioEffectParams(effect(type, { amount: 1, semitones: 3 }));
			expect(low).toEqual(high);
		}
		for (const type of ["eq", "bass-boost", "treble-boost"] as const) {
			expect(AUDIO_EFFECT_CONTROLS[type]).not.toContain("amount");
			const added = newAudioEffect(type);
			expect(audioEffectParams({ ...added, amount: 0 })).toEqual(
				audioEffectParams({ ...added, amount: 1 })
			);
		}
		expect(AUDIO_EFFECT_CONTROLS.echo).toContain("amount");
	});

	test("amount scales parameters monotonically", () => {
		const low = audioEffectParams(effect("echo", { amount: 0 }));
		const high = audioEffectParams(effect("echo", { amount: 1 }));
		if (low.type !== "echo" || high.type !== "echo") {
			throw new Error("expected echo parameters");
		}
		expect(low.delayMs).toBe(60);
		expect(high.delayMs).toBe(460);
		expect(high.decay).toBeGreaterThan(low.decay);
	});

	test("render-only effects are the ones WebAudio cannot reproduce", () => {
		expect([...RENDER_ONLY_AUDIO_EFFECTS].sort()).toEqual([
			"chipmunk",
			"deep-voice",
			"pitch",
			"robot",
		]);
	});
});

describe("presets", () => {
	test("every preset is a valid clip stack", () => {
		for (const preset of AUDIO_EFFECT_PRESETS) {
			const stack = audioEffectPresetStack(preset.id);
			expect(stack).toBeDefined();
			expect(
				segmentSchema.shape.audioEffects.parse(stack)?.length
			).toBeLessThanOrEqual(MAX_AUDIO_EFFECTS);
			for (const item of stack ?? []) {
				expect(audioEffectSchema.parse(item)).toEqual(item);
			}
		}
		expect(audioEffectPresetStack("missing")).toBeUndefined();
	});

	test("preset stacks are copies", () => {
		const first = audioEffectPresetStack("phone-call");
		if (first?.[0]) {
			first[0].amount = 0;
		}
		expect(audioEffectPresetStack("phone-call")?.[0]?.amount).toBe(0.6);
	});

	test("new effects parse against the strict schema", () => {
		for (const type of AUDIO_EFFECT_TYPES) {
			expect(audioEffectSchema.parse(newAudioEffect(type)).type).toBe(type);
		}
	});
});
