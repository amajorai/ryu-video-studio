import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Asset } from "../../shared/project.ts";
import { soundtrackRequestSchema } from "../../shared/soundtrack.ts";
import { importMediaAsset } from "./import-media.ts";
import { probe, runMedia, thumbnail } from "./media.ts";
import type { StudioStore } from "./store.ts";

const frequencies: Record<
	"warm" | "bright" | "tense",
	readonly [number, number, number]
> = {
	bright: [261.63, 329.63, 392],
	tense: [196, 233.08, 293.66],
	warm: [220, 277.18, 329.63],
};

/** Create a bounded local score so projects can prototype a soundtrack offline. */
export async function generateSoundtrack(
	store: StudioStore,
	input: unknown
): Promise<Asset> {
	const request = soundtrackRequestSchema.parse(input);
	const directory = join(store.directory, "soundtracks");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const output = join(directory, `${crypto.randomUUID()}.wav`);
	const [first, second, third] = frequencies[request.mood];
	try {
		await runMedia(
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostdin",
				"-y",
				"-f",
				"lavfi",
				"-i",
				`sine=frequency=${first}:sample_rate=48000:duration=${request.duration}`,
				"-f",
				"lavfi",
				"-i",
				`sine=frequency=${second}:sample_rate=48000:duration=${request.duration}`,
				"-f",
				"lavfi",
				"-i",
				`sine=frequency=${third}:sample_rate=48000:duration=${request.duration}`,
				"-filter_complex",
				`[0:a]volume=0.28[a0];[1:a]volume=0.18[a1];[2:a]volume=0.14[a2];[a0][a1][a2]amix=inputs=3:duration=longest:normalize=0,volume=0.75,afade=t=in:st=0:d=${Math.min(0.4, request.duration / 4)},afade=t=out:st=${Math.max(0, request.duration - Math.min(0.6, request.duration / 3))}:d=${Math.min(0.6, request.duration / 3)},atempo=1`,
				"-t",
				String(request.duration),
				"-ar",
				"48000",
				"-ac",
				"2",
				output,
			],
			{ timeoutMs: 120_000 }
		);
		const asset = await importMediaAsset(
			store,
			{
				name: `Local ${request.mood} soundtrack ${request.bpm} BPM.wav`,
				source: { path: output },
			},
			{ probe, thumbnail }
		);
		return asset;
	} finally {
		await rm(output, { force: true });
	}
}
