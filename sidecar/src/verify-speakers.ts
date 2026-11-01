/**
 * Real-FFmpeg proof for speaker detection.
 *
 * 1. Mic dominance: a camera file with an embedded host mic and a separate
 *    guest lav; each word must go to the mic that is loud at that moment.
 * 2. Voice clustering: one noisy mic with a low and a high harmonic voice,
 *    placed with a source offset and 1.5x speed, must split into two speakers
 *    at the turn boundary.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Asset,
	type Caption,
	newSegment,
	type Project,
} from "../../shared/project.ts";
import { probe, runMedia } from "./media.ts";
import { detectSpeakers } from "./speaker-detect.ts";
import { StudioStore } from "./store.ts";

async function fixture(
	store: StudioStore,
	name: string,
	inputs: string[],
	output: string[]
): Promise<Asset> {
	const file = join(store.directory, `${crypto.randomUUID()}.${output.at(-1)}`);
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		...inputs,
		...output.slice(0, -1),
		file,
	]);
	const asset: Asset = {
		...(await probe(file)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name,
	};
	await Bun.write(store.mediaPath(asset.id), Bun.file(file));
	store.putAsset(asset);
	return asset;
}

function wordCaption(count: number, length: number): Caption {
	const words = Array.from({ length: count }, (_, index) => ({
		end: (index + 1) * length,
		id: crypto.randomUUID(),
		start: index * length,
		text: `w${index}`,
	}));
	return {
		end: count * length,
		id: crypto.randomUUID(),
		start: 0,
		text: words.map((word) => word.text).join(" "),
		words,
	};
}

const wordSpeakers = (project: Project) =>
	project.captions[0]?.words?.map((word) => word.speakerId) ?? [];

async function test(_name: string, run: () => Promise<void>) {
	await run();
}

await test("speaker detection labels real decoded audio", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-verify-speakers-"));
	const store = new StudioStore(directory);
	try {
		const camera = await fixture(
			store,
			"Camera",
			[
				"-f",
				"lavfi",
				"-i",
				"testsrc2=s=160x90:r=25:d=6",
				"-f",
				"lavfi",
				"-i",
				"aevalsrc=if(lt(t\\,3)\\,0.45\\,0.02)*sin(2*PI*150*t)+0.003*(random(0)-0.5):s=48000:d=6",
			],
			[
				"-c:v",
				"libx264",
				"-pix_fmt",
				"yuv420p",
				"-c:a",
				"aac",
				"-shortest",
				"mp4",
			]
		);
		const lav = await fixture(
			store,
			"Guest lav",
			[
				"-f",
				"lavfi",
				"-i",
				"aevalsrc=if(lt(t\\,3)\\,0.02\\,0.45)*sin(2*PI*230*t)+0.003*(random(0)-0.5):s=48000:d=6",
			],
			["-c:a", "pcm_s16le", "wav"]
		);
		const interview = store.save({
			...store.create("Verify mic dominance"),
			captions: [wordCaption(12, 0.5)],
			segments: [newSegment(camera, 0, 0), newSegment(lav, 0, 1)],
		});
		const dominance = await detectSpeakers(store, interview, {
			mode: "mic-dominance",
			revision: interview.revision,
		});
		const saved = store.save(dominance.project);
		const [host, guest] = saved.speakers ?? [];
		assert.equal(host?.label, "Camera");
		assert.equal(guest?.label, "Guest lav");
		assert.deepEqual(wordSpeakers(saved), [
			...new Array(6).fill(host?.id),
			...new Array(6).fill(guest?.id),
		]);
		process.stdout.write(
			`PASS: mic dominance labelled ${dominance.assigned}/${dominance.windows} words (camera mic then guest lav).\n`
		);

		const room = await fixture(
			store,
			"Room mic",
			[
				"-f",
				"lavfi",
				"-i",
				"aevalsrc=0.35*(0.6+0.4*sin(2*PI*4*t))*if(lt(t\\,7)\\,sin(2*PI*115*t)+0.5*sin(2*PI*230*t)+0.25*sin(2*PI*345*t)\\,sin(2*PI*255*t)+0.5*sin(2*PI*510*t)+0.25*sin(2*PI*765*t))+0.01*(random(0)-0.5):s=44100:d=13",
			],
			["-c:a", "libmp3lame", "-b:a", "128k", "mp3"]
		);
		// Source 1 s-13 s at 1.5x fills 0-8 s; the turn at source 7 s lands at 4 s.
		const single = store.save({
			...store.create("Verify clustering"),
			captions: [wordCaption(16, 0.5)],
			segments: [{ ...newSegment(room, 0, 0), sourceIn: 1, speed: 1.5 }],
		});
		const clustered = await detectSpeakers(store, single, {
			k: 2,
			mode: "cluster",
			revision: single.revision,
		});
		const ids = wordSpeakers(store.save(clustered.project));
		assert.equal(new Set(ids.slice(0, 8)).size, 1, "first turn is one voice");
		assert.equal(new Set(ids.slice(8)).size, 1, "second turn is one voice");
		assert.notEqual(ids[0], ids[8], "the two turns are different voices");
		process.stdout.write(
			`PASS: voice clustering split ${clustered.assigned} words into ${clustered.speakers.length} speakers at the turn (source offset 1 s, speed 1.5x).\n`
		);
	} finally {
		store.close();
		await rm(directory, { force: true, recursive: true });
	}
});
