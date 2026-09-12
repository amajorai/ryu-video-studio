import type { AudioProcessing } from "../../shared/audio.ts";

let context: AudioContext | undefined;
let decoder: OfflineAudioContext | undefined;
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
	}
	return context;
}
export async function resumePreviewAudio() {
	const audio = previewAudioContext();
	if (audio.state === "suspended") {
		await audio.resume();
	}
}
export function connectPreviewAudio(
	element: HTMLMediaElement,
	processing: AudioProcessing = "none"
) {
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
	const gain = audio.createGain();
	current.connect(gain);
	gain.connect(output ?? audio.destination);
	return {
		gain,
		dispose() {
			source.disconnect();
			for (const node of processingNodes) {
				node.disconnect();
			}
			gain.disconnect();
		},
	};
}
