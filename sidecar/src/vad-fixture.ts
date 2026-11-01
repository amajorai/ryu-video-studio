/**
 * Speech-like `aevalsrc` fixtures for VAD tests and `verify-vad.ts`: voiced
 * harmonic bursts with 4 Hz syllable modulation over faint noise, separated
 * by pauses at known times.
 */
import { join } from "node:path";
import type { Asset } from "../../shared/project.ts";
import { probe, runMedia } from "./media.ts";
import type { StudioStore } from "./store.ts";

/** Speech bursts `[start, end]` in seconds; the gaps between are the pauses. */
export const VAD_FIXTURE_SPEECH: readonly [number, number][] = [
	[0, 1.2],
	[1.7, 2.6],
	[3.4, 4.9],
	[6.1, 7],
];
export const VAD_FIXTURE_DURATION = 7;
export const VAD_FIXTURE_PAUSES: readonly [number, number][] =
	VAD_FIXTURE_SPEECH.slice(1).map(([start], index) => [
		VAD_FIXTURE_SPEECH[index]?.[1] ?? 0,
		start,
	]);

/** The `aevalsrc` expression for the fixture (commas escaped for lavfi). */
export function speechFixtureExpression(
	speech: readonly [number, number][] = VAD_FIXTURE_SPEECH
): string {
	const gate = speech
		.map(([start, end]) => `between(t\\,${start}\\,${end - 0.0001})`)
		.join("+");
	const voice =
		"(sin(2*PI*140*t)+0.4*sin(2*PI*280*t)+0.25*sin(2*PI*420*t)+0.15*sin(2*PI*560*t))";
	const syllable = "(0.55+0.45*sin(2*PI*4*t))";
	return `(${gate})*0.35*${syllable}*${voice}+0.003*(random(0)*2-1)`;
}

/** Write a fixture as a source asset in `store` (video with audio when `video`). */
export async function speechFixtureAsset(
	store: StudioStore,
	options: {
		duration?: number;
		name?: string;
		speech?: readonly [number, number][];
		video?: boolean;
	} = {}
): Promise<Asset> {
	const duration = options.duration ?? VAD_FIXTURE_DURATION;
	const extension = options.video ? "mov" : "wav";
	const file = join(store.directory, `${crypto.randomUUID()}.${extension}`);
	const audio = [
		"-f",
		"lavfi",
		"-i",
		`aevalsrc=${speechFixtureExpression(options.speech)}:s=48000:d=${duration}`,
	];
	const video = options.video
		? ["-f", "lavfi", "-i", `color=c=gray:s=64x36:r=10:d=${duration}`]
		: [];
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		...audio,
		...video,
		...(options.video
			? ["-map", "1:v", "-map", "0:a", "-c:v", "mjpeg", "-c:a", "pcm_s16le"]
			: ["-c:a", "pcm_s16le"]),
		"-t",
		String(duration),
		file,
	]);
	const asset: Asset = {
		...(await probe(file)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name: options.name ?? "Speech fixture",
	};
	await Bun.write(store.mediaPath(asset.id), Bun.file(file));
	store.putAsset(asset);
	return asset;
}
