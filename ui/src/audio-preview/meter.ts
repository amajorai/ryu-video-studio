/**
 * Preview level metering. The master output is created in `./graph.ts`; this
 * taps it with one AnalyserNode per channel and reports peak and RMS. A clip
 * indicator latches once any sample peaks above -0.1 dBFS and stays lit
 * until `resetClip()`.
 */
import { channelLevel, isClipping } from "../../../shared/decibels.ts";

export interface PreviewMeterReading {
	/** Whether each channel has clipped since the last reset. */
	clipped: readonly boolean[];
	/** Peak level per channel, linear 0..1. */
	peak: readonly number[];
	/** RMS level per channel, linear 0..1. */
	rms: readonly number[];
}

export interface PreviewMeter {
	dispose(): void;
	/**
	 * The master output this meter taps. Sources that should reach the
	 * speakers through the master limiter (and show on the meter) connect here.
	 */
	readonly master: AudioNode;
	read(): PreviewMeterReading;
	/** Clear the latched clip indicators. */
	resetClip(): void;
}

/** Channels the meter reports (the preview master is stereo). */
export const METER_CHANNELS = 2;
/** Samples per analysis block: about 43 ms at 48 kHz, longer than one 30 fps frame. */
export const METER_BLOCK = 2048;

/**
 * Level of each channel's latest block, folding new clips into `latched`.
 * Pure so tests can run it on known buffers.
 */
export function meterReadingFromBlocks(
	blocks: readonly ArrayLike<number>[],
	latched: readonly boolean[] = []
): PreviewMeterReading {
	const levels = blocks.map((block) => channelLevel(block));
	return {
		clipped: levels.map(
			(level, channel) => Boolean(latched[channel]) || isClipping(level.peak)
		),
		peak: levels.map((level) => level.peak),
		rms: levels.map((level) => level.rms),
	};
}

/**
 * Attach a meter to the master output, or null when the context cannot
 * create analysers. Metering is passive: analysers are sinks, so nothing
 * reaches the speakers through them.
 */
export function createPreviewMeter(
	audio: AudioContext,
	master: AudioNode
): PreviewMeter | null {
	if (
		typeof audio.createAnalyser !== "function" ||
		typeof audio.createChannelSplitter !== "function"
	) {
		return null;
	}
	try {
		const splitter = audio.createChannelSplitter(METER_CHANNELS);
		const analysers = Array.from({ length: METER_CHANNELS }, (_, channel) => {
			const analyser = audio.createAnalyser();
			analyser.fftSize = METER_BLOCK;
			analyser.smoothingTimeConstant = 0;
			splitter.connect(analyser, channel);
			return analyser;
		});
		master.connect(splitter);
		const blocks = analysers.map(() => new Float32Array(METER_BLOCK));
		let latched: readonly boolean[] = analysers.map(() => false);
		return {
			master,
			read() {
				for (const [channel, analyser] of analysers.entries()) {
					const block = blocks[channel];
					if (block) {
						analyser.getFloatTimeDomainData(block);
					}
				}
				const reading = meterReadingFromBlocks(blocks, latched);
				latched = reading.clipped;
				return reading;
			},
			resetClip() {
				latched = analysers.map(() => false);
			},
			dispose() {
				try {
					master.disconnect(splitter);
				} catch {
					// Already disconnected: the master was torn down first.
				}
				splitter.disconnect();
				for (const analyser of analysers) {
					analyser.disconnect();
				}
			},
		};
	} catch {
		// Metering must never break playback.
		return null;
	}
}
