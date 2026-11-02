/**
 * Preview audio effects insert. Sits between the cleanup chain and the pan
 * insert and approximates the rendered effect stack with WebAudio nodes:
 * biquads for EQ and band effects, a single delay tap for echo (matching
 * `aecho`'s feed-forward tap and gains), a convolver with
 * a generated impulse for reverb, LFO-modulated delays for chorus, flanger and
 * vibrato, and an LFO-driven gain for tremolo. Pitch and robot are render only.
 * Parameters come from `audioEffectParams`, shared with the render stage.
 */
import {
	audioEffectParams,
	RENDER_ONLY_AUDIO_EFFECTS,
} from "../../../shared/audio-effects.ts";
import type { Segment } from "../../../shared/project.ts";
import {
	type AudioEffect,
	MAX_AUDIO_EFFECTS,
} from "../../../shared/schema/audio-ext.ts";

/** A section of the per-clip preview graph that can be reconfigured in place. */
export interface PreviewAudioInsert {
	/** Wire `input` through the insert and return its output node. */
	connect(input: AudioNode): AudioNode;
	/**
	 * Disconnect the insert's own nodes. The caller owns `input` and disconnects
	 * it; dispose never detaches it, so it is safe after upstream teardown.
	 */
	dispose(): void;
	/** Apply the clip's current settings. Called on every preview sync, so keep it cheap. */
	update(segment: Segment): void;
}

/** One WebAudio stage of the preview effect chain. */
export type PreviewEffectStage =
	| {
			kind: "filter";
			type: "highpass" | "lowpass" | "lowshelf" | "highshelf" | "peaking";
			frequency: number;
			gain: number;
			q: number;
	  }
	| {
			kind: "echo";
			/** Seconds before the single repeat. */
			delay: number;
			/** Gain of the direct signal. */
			dry: number;
			/** Gain of the one delayed repeat. */
			wet: number;
	  }
	| { kind: "reverb"; seconds: number; wet: number }
	| {
			kind: "modulated-delay";
			/** Centre delay in seconds. */
			delay: number;
			/** LFO swing in seconds. */
			depth: number;
			feedback: number;
			rate: number;
			/** 1 = wet only (vibrato); below 1 mixes the dry signal back in. */
			wet: number;
	  }
	| { kind: "tremolo"; depth: number; rate: number }
	| { kind: "gain"; value: number };

/**
 * WebAudio measures highpass/lowpass Q in dB, so FFmpeg's Butterworth
 * `highpass`/`lowpass` (linear Q 0.707) is 20·log10(√½) ≈ -3.01 dB here;
 * a linear 0.707 would read as +0.707 dB and add a resonant peak.
 */
export const BUTTERWORTH_Q_DB = 20 * Math.log10(Math.SQRT1_2);
/** WebAudio shelves ignore Q (they use a fixed slope); kept for clarity. */
const SHELF_Q = Math.SQRT1_2;

/**
 * The render's `aecho=0.8:0.8:...` gains: the input is scaled by in_gain, one
 * tap of the raw input is added at `decay`, and the sum is scaled by out_gain.
 */
const ECHO_IN_GAIN = 0.8;
const ECHO_OUT_GAIN = 0.8;

function bandStages(band: {
	highpass: number;
	lowpass: number;
	stages: number;
}): PreviewEffectStage[] {
	const repeat = (type: "highpass" | "lowpass", frequency: number) =>
		Array.from(
			{ length: band.stages },
			(): PreviewEffectStage => ({
				frequency,
				gain: 0,
				kind: "filter",
				q: BUTTERWORTH_Q_DB,
				type,
			})
		);
	return [
		...repeat("highpass", band.highpass),
		...repeat("lowpass", band.lowpass),
	];
}

function effectStages(effect: AudioEffect): PreviewEffectStage[] {
	const params = audioEffectParams(effect);
	switch (params.type) {
		case "echo":
			return [
				{
					delay: params.delayMs / 1000,
					dry: ECHO_IN_GAIN * ECHO_OUT_GAIN,
					kind: "echo",
					wet: params.decay * ECHO_OUT_GAIN,
				},
			];
		case "reverb":
			return [
				{
					kind: "reverb",
					seconds: 0.6 + (params.wet - 0.2) * 2.5,
					wet: params.wet,
				},
			];
		case "eq":
			return params.gainDb === 0
				? []
				: [
						{
							frequency: params.frequency,
							gain: params.gainDb,
							kind: "filter",
							q: 1,
							type: "peaking",
						},
					];
		case "bass-boost":
		case "treble-boost":
			return params.gainDb === 0
				? []
				: [
						{
							frequency: params.frequency,
							gain: params.gainDb,
							kind: "filter",
							q: SHELF_Q,
							type: params.type === "bass-boost" ? "lowshelf" : "highshelf",
						},
					];
		case "telephone":
		case "radio":
			return bandStages(params.band);
		case "megaphone":
			return [...bandStages(params.band), { kind: "gain", value: params.gain }];
		case "chorus":
			return [
				{
					delay: (params.delaysMs[0] ?? 50) / 1000,
					depth: (params.depthsMs[0] ?? 2) / 1000,
					feedback: 0,
					kind: "modulated-delay",
					rate: params.speedsHz[0] ?? 0.25,
					wet: 0.5,
				},
			];
		case "flanger":
			return [
				{
					delay: 0.002 + params.depthMs / 2000,
					depth: params.depthMs / 2000,
					feedback: params.regen / 100,
					kind: "modulated-delay",
					rate: params.speedHz,
					wet: 0.5,
				},
			];
		case "vibrato":
			return [
				{
					delay: 0.005,
					depth: params.depth * 0.004,
					feedback: 0,
					kind: "modulated-delay",
					rate: params.frequency,
					wet: 1,
				},
			];
		case "tremolo":
			return [{ depth: params.depth, kind: "tremolo", rate: params.frequency }];
		default:
			return [];
	}
}

/** The preview stages for a clip's stack; disabled and render-only effects are skipped. */
export function previewEffectStages(
	effects: readonly AudioEffect[] | undefined
): PreviewEffectStage[] {
	return (effects ?? [])
		.slice(0, MAX_AUDIO_EFFECTS)
		.filter(
			(effect) => effect.enabled && !RENDER_ONLY_AUDIO_EFFECTS.has(effect.type)
		)
		.flatMap(effectStages);
}

/** Deterministic decaying-noise impulse (a small LCG, so previews are repeatable). */
export function reverbImpulse(
	audio: BaseAudioContext,
	seconds: number
): AudioBuffer {
	const length = Math.max(1, Math.round(audio.sampleRate * seconds));
	const buffer = audio.createBuffer(2, length, audio.sampleRate);
	let seed = 0x9e_37_79_b9;
	for (let channel = 0; channel < 2; channel++) {
		const data = buffer.getChannelData(channel);
		for (let index = 0; index < length; index++) {
			seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
			const noise = seed / 0x80_00_00_00 - 1;
			data[index] = noise * (1 - index / length) ** 3;
		}
	}
	return buffer;
}

interface BuiltStage {
	input: AudioNode;
	nodes: AudioNode[];
	oscillators: OscillatorNode[];
	output: AudioNode;
}

/** A dry path plus a wet path summed into one output gain. */
function mixed(
	audio: BaseAudioContext,
	wetAmount: number,
	wetPath: (input: AudioNode) => { nodes: AudioNode[]; output: AudioNode }
): Pick<BuiltStage, "input" | "nodes" | "output"> {
	const input = audio.createGain();
	const output = audio.createGain();
	const dry = audio.createGain();
	dry.gain.value = 1 - wetAmount;
	const wet = audio.createGain();
	wet.gain.value = wetAmount;
	input.connect(dry);
	dry.connect(output);
	const path = wetPath(input);
	path.output.connect(wet);
	wet.connect(output);
	return { input, nodes: [input, dry, wet, output, ...path.nodes], output };
}

function buildStage(
	audio: BaseAudioContext,
	stage: PreviewEffectStage
): BuiltStage {
	switch (stage.kind) {
		case "filter": {
			const filter = audio.createBiquadFilter();
			filter.type = stage.type;
			filter.frequency.value = stage.frequency;
			filter.Q.value = stage.q;
			filter.gain.value = stage.gain;
			return {
				input: filter,
				nodes: [filter],
				oscillators: [],
				output: filter,
			};
		}
		case "gain": {
			const gain = audio.createGain();
			gain.gain.value = stage.value;
			return { input: gain, nodes: [gain], oscillators: [], output: gain };
		}
		case "echo": {
			// Feed-forward, like the render: one repeat, no feedback loop.
			const input = audio.createGain();
			const dry = audio.createGain();
			dry.gain.value = stage.dry;
			const delay = audio.createDelay(1);
			delay.delayTime.value = stage.delay;
			const wet = audio.createGain();
			wet.gain.value = stage.wet;
			const output = audio.createGain();
			input.connect(dry);
			dry.connect(output);
			input.connect(delay);
			delay.connect(wet);
			wet.connect(output);
			return {
				input,
				nodes: [input, dry, delay, wet, output],
				oscillators: [],
				output,
			};
		}
		case "reverb":
			return {
				...mixed(audio, stage.wet, (input) => {
					const convolver = audio.createConvolver();
					convolver.buffer = reverbImpulse(audio, stage.seconds);
					input.connect(convolver);
					return { nodes: [convolver], output: convolver };
				}),
				oscillators: [],
			};
		case "modulated-delay": {
			const oscillator = audio.createOscillator();
			oscillator.frequency.value = stage.rate;
			const swing = audio.createGain();
			swing.gain.value = stage.depth;
			const built = mixed(audio, stage.wet, (input) => {
				const delay = audio.createDelay(0.1);
				delay.delayTime.value = stage.delay;
				oscillator.connect(swing);
				swing.connect(delay.delayTime);
				input.connect(delay);
				const nodes: AudioNode[] = [delay, swing];
				if (stage.feedback > 0) {
					const feedback = audio.createGain();
					feedback.gain.value = stage.feedback;
					delay.connect(feedback);
					feedback.connect(delay);
					nodes.push(feedback);
				}
				return { nodes, output: delay };
			});
			oscillator.start();
			return { ...built, oscillators: [oscillator] };
		}
		default: {
			// Gain swings between 1 - depth and 1 around its base value.
			const gain = audio.createGain();
			gain.gain.value = 1 - stage.depth / 2;
			const oscillator = audio.createOscillator();
			oscillator.frequency.value = stage.rate;
			const swing = audio.createGain();
			swing.gain.value = stage.depth / 2;
			oscillator.connect(swing);
			swing.connect(gain.gain);
			oscillator.start();
			return {
				input: gain,
				nodes: [gain, swing],
				oscillators: [oscillator],
				output: gain,
			};
		}
	}
}

export function createPreviewEffectsInsert(
	audio: BaseAudioContext
): PreviewAudioInsert {
	const output = audio.createGain();
	let input: AudioNode | undefined;
	let built: BuiltStage[] = [];
	let signature = "[]";

	/** Drop the built stages; only the rebuild path detaches `input`. */
	const releaseStages = () => {
		for (const stage of built) {
			for (const oscillator of stage.oscillators) {
				oscillator.stop();
				oscillator.disconnect();
			}
			for (const node of stage.nodes) {
				node.disconnect();
			}
		}
		built = [];
	};

	/**
	 * Rebuild path: the input's edge to the first stage (or the output) is
	 * known to exist here, so the targeted disconnect cannot throw.
	 */
	const rewire = () => {
		input?.disconnect(built[0]?.input ?? output);
		releaseStages();
	};

	const wire = (stages: PreviewEffectStage[]) => {
		built = stages.map((stage) => buildStage(audio, stage));
		let current = input;
		for (const stage of built) {
			current?.connect(stage.input);
			current = stage.output;
		}
		current?.connect(output);
	};

	return {
		connect(node) {
			input = node;
			node.connect(output);
			return output;
		},
		dispose() {
			// The upstream owner disconnects `input` itself (graph.ts does before
			// calling this), and a targeted `disconnect(node)` on an edge that no
			// longer exists throws InvalidAccessError, so only own nodes are touched.
			releaseStages();
			output.disconnect();
			input = undefined;
		},
		update(segment) {
			const stages = previewEffectStages(segment.audioEffects);
			const next = JSON.stringify(stages);
			if (next === signature) {
				return;
			}
			rewire();
			signature = next;
			wire(stages);
		},
	};
}
