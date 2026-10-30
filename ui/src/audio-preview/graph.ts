import type { AudioProcessing } from "../../../shared/audio.ts";
import { resolveDuck } from "../../../shared/ducking.ts";
import type { Segment } from "../../../shared/project.ts";
import { createPreviewDucker, type PreviewDucker } from "./duck.ts";
import { createPreviewEffectsInsert } from "./effects.ts";
import { createPreviewMeter, type PreviewMeter } from "./meter.ts";
import { createPreviewPanInsert } from "./pan.ts";

let context: AudioContext | undefined;
let decoder: OfflineAudioContext | undefined;
let meter: PreviewMeter | null = null;
let ducker: PreviewDucker | null = null;
export function decodePreviewAudio(bytes: ArrayBuffer): Promise<AudioBuffer> {
	decoder ??= new OfflineAudioContext(1, 1, 16_000);
	return decoder.decodeAudioData(bytes);
}
const sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
let output: DynamicsCompressorNode | undefined;
export function previewAudioContext(): AudioContext {
	if (!context) {
		context = new AudioContext();
		output = context.createDynamicsCompressor();
		output.threshold.value = 20 * Math.log10(0.95);
		output.knee.value = 0;
		output.ratio.value = 20;
		output.attack.value = 0.005;
		output.release.value = 0.05;
		output.connect(context.destination);
		meter = createPreviewMeter(context, output);
		ducker = createPreviewDucker(context);
	}
	return context;
}
/** The master meter, once the preview audio context exists and metering is on. */
export function previewMasterMeter(): PreviewMeter | null {
	return meter;
}
export async function resumePreviewAudio() {
	const audio = previewAudioContext();
	if (audio.state === "suspended") {
		await audio.resume();
	}
}

export interface PreviewAudioGraph {
	dispose(): void;
	gain: GainNode;
	/**
	 * Push the clip's current settings into the effects and pan inserts;
	 * `trackPan` is the clip's track balance from the mixer (-1..1).
	 */
	update(segment: Segment, trackPan?: number): void;
}

/**
 * Per-clip chain: source, cleanup preset, effects insert, pan insert, gain,
 * duck gain, then the shared master limiter. Clips that do not duck also
 * feed the ducker's key from their gain (see `./duck.ts`).
 */
export function connectPreviewAudio(
	element: HTMLMediaElement,
	processing: AudioProcessing = "none"
): PreviewAudioGraph {
	const audio = previewAudioContext();
	let source = sources.get(element);
	if (!source) {
		source = audio.createMediaElementSource(element);
		sources.set(element, source);
	}
	const processingNodes: AudioNode[] = [];
	let current: AudioNode = source;
	if (
		processing === "denoise" ||
		processing === "normalize" ||
		processing === "voice-enhance"
	) {
		if (processing === "denoise" || processing === "voice-enhance") {
			const highpass = audio.createBiquadFilter();
			highpass.type = "highpass";
			highpass.frequency.value = processing === "denoise" ? 70 : 80;
			current.connect(highpass);
			processingNodes.push(highpass);
			current = highpass;
			const lowpass = audio.createBiquadFilter();
			lowpass.type = "lowpass";
			lowpass.frequency.value = processing === "denoise" ? 16_000 : 14_000;
			current.connect(lowpass);
			processingNodes.push(lowpass);
			current = lowpass;
		}
		const compressor = audio.createDynamicsCompressor();
		compressor.threshold.value = processing === "normalize" ? -16 : -18;
		compressor.knee.value = processing === "normalize" ? 8 : 6;
		compressor.ratio.value = processing === "normalize" ? 4 : 3;
		compressor.attack.value = 0.02;
		compressor.release.value = 0.25;
		current.connect(compressor);
		processingNodes.push(compressor);
		current = compressor;
	}
	const effects = createPreviewEffectsInsert(audio);
	current = effects.connect(current);
	const pan = createPreviewPanInsert(audio);
	current = pan.connect(current);
	const gain = audio.createGain();
	current.connect(gain);
	const duck = audio.createGain();
	gain.connect(duck);
	duck.connect(output ?? audio.destination);
	const member = { duck, tap: gain };
	return {
		gain,
		update(segment, trackPan = 0) {
			effects.update(segment);
			pan.setTrackPan(trackPan);
			pan.update(segment);
			ducker?.assign(
				member,
				segment.duckUnderVoice ? resolveDuck(segment.ducking) : null
			);
		},
		dispose() {
			source.disconnect();
			for (const node of processingNodes) {
				node.disconnect();
			}
			effects.dispose();
			pan.dispose();
			ducker?.remove(member);
			gain.disconnect();
			duck.disconnect();
		},
	};
}
