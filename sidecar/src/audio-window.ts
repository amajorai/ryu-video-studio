import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	type AudioPlayback,
	audioPlaybackSchema,
	audioTempoFilters,
} from "../../shared/audio.ts";
import type { Asset } from "../../shared/project.ts";
import { TRANSCRIPT_WINDOW_SECONDS } from "../../shared/transcript.ts";
import { MEDIA_FORMATS, runMedia } from "./media.ts";
import type { StudioStore } from "./store.ts";

let inFlight = 0;
export async function extractAudioWindow(
	store: StudioStore,
	asset: Asset,
	start: number,
	playback?: AudioPlayback
) {
	if (!asset.hasAudio || start < 0 || start >= asset.duration) {
		throw new Error("Choose a valid source audio range.");
	}
	if (playback) {
		audioPlaybackSchema.parse(playback);
		if (
			playback.sourceOut <= start ||
			playback.sourceOut > asset.duration + 0.05 ||
			playback.offset >= (playback.sourceOut - start) / playback.speed
		) {
			throw new Error("Choose a valid playback audio window.");
		}
	}
	if (inFlight >= 2) {
		throw new Error(
			"Two audio windows are already being prepared. Retry shortly."
		);
	}
	inFlight++;
	const duration = Math.min(
		TRANSCRIPT_WINDOW_SECONDS,
		playback
			? (playback.sourceOut - start) / playback.speed - playback.offset
			: asset.duration - start
	);
	const sourceDuration = playback ? playback.sourceOut - start : duration;
	let directory: string | undefined;
	try {
		directory = await mkdtemp(join(store.directory, "audio-window-"));
		const path = join(directory, "window.wav");
		await runMedia(
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostdin",
				"-y",
				"-protocol_whitelist",
				"file,pipe",
				"-format_whitelist",
				MEDIA_FORMATS,
				"-ss",
				String(start),
				"-t",
				String(sourceDuration),
				"-i",
				store.mediaPath(asset.id),
				...(playback
					? [
							"-af",
							`${audioTempoFilters(playback.speed).join(",")},apad=pad_dur=1,atrim=start=${playback.offset}:duration=${duration},asetpts=PTS-STARTPTS`,
						]
					: []),
				"-t",
				String(duration),
				"-vn",
				"-ac",
				"1",
				"-ar",
				"16000",
				"-c:a",
				"pcm_s16le",
				path,
			],
			{ timeoutMs: 30_000 }
		);
		const file = Bun.file(path);
		if (file.size > 1_000_000) {
			throw new Error("Prepared audio exceeds the window limit.");
		}
		return {
			start,
			duration,
			dataUrl: `data:audio/wav;base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`,
		};
	} finally {
		inFlight--;
		if (directory) {
			await rm(directory, { recursive: true, force: true });
		}
	}
}
