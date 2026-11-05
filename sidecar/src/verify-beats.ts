/**
 * Real-FFmpeg proof for beat detection.
 *
 * 1. `GET /assets/:id/beats` returns 128 BPM (±1) for a generated `aevalsrc`
 *    kick loop, with downbeats on the accented bar starts, and caches it.
 * 2. Kick loops at 90, 150 and 175 BPM muxed into H.264/AAC video recover their
 *    tempo through the lossy audio path.
 * 3. Detected downbeats drive `snap: "downbeat"` beat cuts on a timeline.
 * 4. On an 11-minute AAC source, `?from=&to=` detects the late span a music
 *    clip plays (past the first 10 minutes) and lands beats on the grid.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapCutsToBeats, timelineBeats } from "../../shared/beat-cuts.ts";
import { type Asset, newSegment } from "../../shared/project.ts";
import { assetBeats } from "./beats.ts";
import { probe, runMedia } from "./media.ts";
import { routes } from "./routes/beats.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

/** Kick (60 Hz thump plus 2 kHz tick) every beat, doubled on each bar start. */
function kickLoop(bpm: number, seconds: number, rate = 44_100) {
	const beat = (60 / bpm).toFixed(6);
	const bar = ((4 * 60) / bpm).toFixed(6);
	const phase = `mod(t\\,${beat})`;
	return `aevalsrc=(1+lt(mod(t\\,${bar})\\,${beat}))*(0.45*exp(-30*${phase})*sin(2*PI*60*${phase})+0.25*exp(-200*${phase})*sin(2*PI*2000*t))+0.004*(random(0)-0.5):s=${rate}:d=${seconds}`;
}

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
	store.putAnalysis({
		assetId: asset.id,
		createdAt: new Date().toISOString(),
		duration: asset.duration,
		sceneCuts: [],
		status: "completed",
		waveform: [],
	});
	return asset;
}

/** Downbeats that miss a bar start by 35 ms or more. */
function offBarDownbeats(downbeats: readonly number[], bpm: number): number[] {
	const bar = (4 * 60) / bpm;
	return downbeats.filter(
		(downbeat) =>
			Math.abs(downbeat / bar - Math.round(downbeat / bar)) * bar >= 0.035
	);
}

async function test(_name: string, run: () => Promise<void>) {
	await run();
}

await test("beat detection on real decoded audio", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-verify-beats-"));
	const store = new StudioStore(directory);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0, routes });
	try {
		const kick = await fixture(
			store,
			"Kick 128",
			["-f", "lavfi", "-i", kickLoop(128, 20)],
			["-c:a", "pcm_s16le", "wav"]
		);
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/assets/${kick.id}/beats`,
			{ headers: { authorization: `Bearer ${token}` } }
		);
		assert.equal(response.status, 200);
		const body = (await response.json()) as {
			bpm: number;
			beats: number[];
			downbeats: number[];
			confidence: number;
		};
		assert.ok(Math.abs(body.bpm - 128) <= 1, `bpm ${body.bpm} is 128 ±1`);
		assert.ok(body.downbeats.length >= 3, "found several downbeats");
		assert.deepEqual(offBarDownbeats(body.downbeats, 128), []);
		assert.equal(store.analysis(kick.id)?.beats?.bpm, body.bpm, "cached");
		process.stdout.write(
			`PASS: GET /assets/:id/beats → ${body.bpm} BPM, ${body.beats.length} beats, ${body.downbeats.length} downbeats on bar starts, confidence ${body.confidence}.\n`
		);

		for (const bpm of [90, 150, 175]) {
			const video = await fixture(
				store,
				`Video ${bpm}`,
				[
					"-f",
					"lavfi",
					"-i",
					"testsrc2=s=160x90:r=25:d=16",
					"-f",
					"lavfi",
					"-i",
					kickLoop(bpm, 16, 48_000),
				],
				[
					"-c:v",
					"libx264",
					"-pix_fmt",
					"yuv420p",
					"-c:a",
					"aac",
					"-b:a",
					"128k",
					"-shortest",
					"mp4",
				]
			);
			const result = await assetBeats(store, video);
			assert.equal(result.source, "detected");
			assert.ok("bpm" in result.body);
			const detected = result.body;
			if ("bpm" in detected) {
				assert.ok(
					Math.abs(detected.bpm - bpm) <= 1,
					`bpm ${detected.bpm} is ${bpm} ±1 through AAC`
				);
				assert.ok(detected.downbeats.length >= 3, "found several downbeats");
				assert.deepEqual(offBarDownbeats(detected.downbeats, bpm), []);
				process.stdout.write(
					`PASS: H.264/AAC video at ${bpm} BPM → ${detected.bpm} BPM, ${detected.downbeats.length} downbeats on bar starts.\n`
				);
			}
		}

		// Three 3 s shots cut at 3 s and 6 s; a 128 BPM bar is 1.875 s, so with
		// downbeat snapping the edits roll to the bar starts at 3.75 s and 5.625 s.
		const shots = await fixture(
			store,
			"Shots",
			["-f", "lavfi", "-i", "testsrc2=s=160x90:r=25:d=12"],
			["-c:v", "libx264", "-pix_fmt", "yuv420p", "mp4"]
		);
		const music = newSegment(kick, 0, 1);
		const clips = [0, 3, 6].map((start) => ({
			...newSegment(shots, start, 0),
			sourceIn: start + 1,
			sourceOut: start + 4,
		}));
		const project = store.save({
			...store.create("Verify downbeat cuts"),
			segments: [...clips, music],
		});
		const cached = store.analysis(kick.id)?.beats;
		assert.ok(cached);
		const next = snapCutsToBeats(project, store.assets(), {
			beats: timelineBeats(music, cached.beats),
			downbeats: timelineBeats(music, cached.downbeats),
			mode: "snap-edits",
			revision: project.revision,
			snap: "downbeat",
			tolerance: 1,
			track: 0,
		});
		const starts = next.segments
			.filter((segment) => segment.track === 0)
			.map((segment) => segment.start)
			.sort((a, b) => a - b);
		assert.ok(Math.abs((starts[1] ?? 0) - 3.75) < 0.05, `cut at ${starts[1]}`);
		assert.ok(Math.abs((starts[2] ?? 0) - 5.625) < 0.05, `cut at ${starts[2]}`);
		process.stdout.write(
			`PASS: snap: "downbeat" rolled the 3 s and 6 s edits to ${starts[1]}s and ${starts[2]}s (bar starts 3.75 s and 5.625 s).\n`
		);

		// 11 minutes of 120 BPM AAC: the clip's span starts after 10 minutes.
		const long = await fixture(
			store,
			"Long 120",
			["-f", "lavfi", "-i", kickLoop(120, 660, 22_050)],
			["-c:a", "aac", "-b:a", "96k", "m4a"]
		);
		const late = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/assets/${long.id}/beats?from=620&to=650`,
			{ headers: { authorization: `Bearer ${token}` } }
		);
		assert.equal(late.headers.get("x-video-studio-beat-source"), "detected");
		const window = (await late.json()) as {
			analyzedDuration: number;
			analyzedFrom?: number;
			beats: number[];
			bpm: number;
		};
		assert.ok(Math.abs(window.bpm - 120) <= 1, `bpm ${window.bpm} is 120 ±1`);
		const span = window.beats.filter((beat) => beat >= 620 && beat <= 650);
		assert.ok(span.length >= 58, `${span.length} beats in 620-650 s`);
		const offGrid = span.filter(
			(beat) => Math.abs(beat / 0.5 - Math.round(beat / 0.5)) * 0.5 >= 0.035
		);
		assert.deepEqual(offGrid, []);
		process.stdout.write(
			`PASS: ?from=620&to=650 on an 11-minute AAC source analyzed ${window.analyzedFrom ?? 0}-${(window.analyzedFrom ?? 0) + window.analyzedDuration} s → ${window.bpm} BPM, ${span.length} on-grid beats in the clip span.
`
		);
	} finally {
		app.stop();
		store.close();
		await rm(directory, { force: true, recursive: true });
	}
});
