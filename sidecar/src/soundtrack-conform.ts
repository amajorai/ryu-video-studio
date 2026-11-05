// Fitting generated music and sound effects to the timeline (trim, fade,
// limit), on the shared local audio synthesis budget in `soundtrack.ts`.
import type { Asset } from "../../shared/project.ts";
import {
	type ConformGeneratedAudioInput,
	conformGeneratedAudioRequestSchema,
} from "../../shared/soundtrack.ts";
import { MEDIA_FORMATS } from "./media.ts";
import { synthesisTimeoutMs, synthesizeAudioAsset } from "./soundtrack.ts";
import type { StudioStore } from "./store.ts";

/** FFmpeg arguments that trim, fade and limit generated audio to WAV. */
export function conformAudioArgs(
	source: string,
	output: string,
	duration: number,
	fadeOut: number,
	available: number
): string[] {
	const length = Math.min(duration, available);
	const fade = Math.min(fadeOut, length / 2);
	const filters = [
		"aresample=48000",
		"alimiter=limit=0.89:level=false",
		...(fade > 0
			? [
					`afade=t=out:st=${Math.max(0, length - fade).toFixed(6)}:d=${fade.toFixed(6)}`,
				]
			: []),
	];
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-y",
		"-protocol_whitelist",
		"file,pipe",
		"-format_whitelist",
		MEDIA_FORMATS,
		"-i",
		source,
		"-map",
		"0:a:0",
		"-vn",
		"-t",
		length.toFixed(6),
		"-af",
		filters.join(","),
		"-ar",
		"48000",
		"-ac",
		"2",
		output,
	];
}

/**
 * Fit a generated music or sound-effect asset to the timeline (G74): trim it
 * to `duration`, fade the tail, and limit peaks. The new asset keeps the
 * model provenance (`generation`) so the credits report names the provider
 * and model; the original generated file stays in the library.
 */
export async function conformGeneratedAudio(
	store: StudioStore,
	input: ConformGeneratedAudioInput,
	folder: "soundtracks" | "sfx",
	options: { signal?: AbortSignal } = {}
): Promise<Asset> {
	const request = conformGeneratedAudioRequestSchema.parse(input);
	const source = store.assets().find((asset) => asset.id === request.assetId);
	if (!source) {
		throw new Error("The generated audio is no longer in the library.");
	}
	if (source.kind !== "audio" || !source.generation) {
		throw new Error("Only generated audio can be fitted to the timeline.");
	}
	const conformed = await synthesizeAudioAsset(
		store,
		{
			args: (output) =>
				conformAudioArgs(
					store.mediaPath(source.id),
					output,
					request.duration,
					request.fadeOut,
					source.duration
				),
			folder,
			name: `${source.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 170)} · fitted.wav`,
			timeoutMs: synthesisTimeoutMs(
				Math.min(request.duration, source.duration)
			),
		},
		options
	);
	const stamped = {
		...conformed,
		derivedFromAssetId: source.id,
		generation: source.generation,
	};
	store.upsertAsset(stamped);
	return stamped;
}
