import { z } from "zod";

export const audioPlaybackSchema = z
	.object({
		sourceOut: z.number().finite().min(0).max(7200),
		speed: z.number().finite().min(0.25).max(4),
		offset: z.number().finite().min(0).max(7200),
	})
	.strict();
export type AudioPlayback = z.infer<typeof audioPlaybackSchema>;

export const audioProcessingSchema = z.enum([
	"denoise",
	"none",
	"normalize",
	"voice-enhance",
]);
export type AudioProcessing = z.infer<typeof audioProcessingSchema>;

export function audioProcessingFilters(processing: AudioProcessing): string[] {
	switch (processing) {
		case "denoise":
			return ["highpass=f=70", "lowpass=f=16000", "afftdn=nr=18:nf=-35"];
		case "normalize":
			return ["loudnorm=I=-16:TP=-1.5:LRA=11"];
		case "voice-enhance":
			return [
				"highpass=f=80",
				"lowpass=f=14000",
				"afftdn=nr=12",
				"acompressor=threshold=-18dB:ratio=3:attack=20:release=250",
			];
		default:
			return ["anull"];
	}
}

/** atempo changes samples even at 1x, so normal playback must bypass it. */
export function audioTempoFilters(speed: number): string[] {
	if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) {
		throw new Error("Invalid audio speed.");
	}
	if (speed === 1) {
		return ["anull"];
	}
	const filters: string[] = [];
	let remaining = speed;
	while (remaining > 2) {
		filters.push("atempo=2");
		remaining /= 2;
	}
	while (remaining < 0.5) {
		filters.push("atempo=0.5");
		remaining /= 0.5;
	}
	filters.push(`atempo=${remaining}`);
	return filters;
}
