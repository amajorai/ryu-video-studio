/**
 * Real-FFmpeg proof for track sync lock (W1-T5).
 *
 * A dialogue clip sits on track 0 and a music bed on track 2. The bed is
 * silent for two seconds and then plays a 1 kHz tone. After a one-second
 * ripple delete at 0.5 s:
 *
 * - with the music track's sync lock off, the bed keeps its timing, so the
 *   tone still starts at 2.0 s in the render;
 * - with the default sync lock, the bed ripples with the dialogue and the tone
 *   starts at 1.0 s (the control).
 *
 * Loudness is read with FFmpeg `astats` over short windows of the render.
 * Run: `bun sidecar/src/verify-sync-lock.ts`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Asset,
	newSegment,
	type Project,
	trackSettingFor,
} from "../../shared/project.ts";
import { probe, runMedia } from "./media.ts";
import { createStudioServer } from "./server.ts";
import { type RenderJob, StudioStore } from "./store.ts";

/** Fail the verification with `message` unless `condition` holds. */
function verifyThat(condition: boolean, message: string): void {
	if (!condition) {
		throw new Error(`FAIL: ${message}`);
	}
}

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-sync-lock-"));
const store = new StudioStore(directory);
const token = crypto.randomUUID();
const app = createStudioServer({ port: 0, store, token });

async function call<Result>(path: string, body?: unknown): Promise<Result> {
	const response = await fetch(
		`http://127.0.0.1:${app.server.port}/api/video-studio${path}`,
		{
			body: body === undefined ? undefined : JSON.stringify(body),
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			method: body === undefined ? "GET" : "POST",
		}
	);
	const value = (await response.json()) as Result;
	if (!response.ok) {
		throw new Error(`${path} ${response.status}: ${JSON.stringify(value)}`);
	}
	return value;
}

async function importMedia(file: string): Promise<Asset> {
	const id = crypto.randomUUID();
	const media = await probe(file);
	await Bun.write(store.mediaPath(id), Bun.file(file));
	const asset: Asset = {
		...media,
		createdAt: new Date().toISOString(),
		id,
		name: file.split("/").at(-1) ?? "media",
	};
	store.putAsset(asset);
	return asset;
}

async function waitForRender(project: Project): Promise<string> {
	const queued = await call<RenderJob>(`/projects/${project.id}/render`, {});
	for (let attempt = 0; attempt < 600; attempt += 1) {
		const job = store.jobs().find((candidate) => candidate.id === queued.id);
		if (job?.status === "completed") {
			return store.renderPath(job.id);
		}
		if (job?.status === "failed") {
			throw new Error(`Render failed: ${job.error ?? "unknown error"}`);
		}
		await Bun.sleep(100);
	}
	throw new Error("Render timed out.");
}

/** Overall RMS level (dBFS) of `file` between `start` and `start + length`. */
async function rmsLevel(
	file: string,
	start: number,
	length: number
): Promise<number> {
	const output = await runMedia([
		"-hide_banner",
		"-ss",
		String(start),
		"-t",
		String(length),
		"-i",
		file,
		"-vn",
		"-af",
		"astats=metadata=1:reset=0,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
		"-f",
		"null",
		"-",
	]);
	const levels = [
		...output.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?inf|-?[\d.]+)/g),
	].map((match) => (match[1]?.endsWith("inf") ? -200 : Number(match[1])));
	const last = levels.at(-1);
	if (last === undefined) {
		throw new Error(`astats printed no level for ${start}s.`);
	}
	return last;
}

const LOUD = -30;
const QUIET = -60;

try {
	const dialogueFile = join(directory, "dialogue.mp4");
	const musicFile = join(directory, "music.wav");
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		"color=gray:s=320x180:d=4:r=30",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		dialogueFile,
	]);
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=1000:duration=2:sample_rate=48000,adelay=2000,apad=whole_dur=4",
		"-ac",
		"1",
		"-c:a",
		"pcm_s16le",
		musicFile,
	]);
	const dialogue = await importMedia(dialogueFile);
	const music = await importMedia(musicFile);
	verifyThat(!dialogue.hasAudio, "dialogue fixture must be silent");

	const scenario = async (syncLocked: boolean) => {
		const created = store.create(`Sync lock ${syncLocked ? "on" : "off"}`);
		let project = store.save({
			...created,
			height: 180,
			segments: [
				{ ...newSegment(dialogue, 0, 0), sourceOut: 4 },
				{ ...newSegment(music, 0, 2), sourceOut: 4 },
			],
			width: 320,
		});
		if (!syncLocked) {
			project = await call<Project>(`/projects/${project.id}/tracks`, {
				revision: project.revision,
				syncLocked: false,
				track: 2,
			});
			verifyThat(
				trackSettingFor(project, 2).syncLocked === false,
				"the tracks route must store syncLocked: false"
			);
		}
		project = await call<Project>(`/projects/${project.id}/ripple-delete`, {
			end: 1.5,
			revision: project.revision,
			start: 0.5,
		});
		const bed = project.segments.filter((segment) => segment.track === 2);
		return { bed, render: await waitForRender(project) };
	};

	const unlocked = await scenario(false);
	const bedTiming = JSON.stringify(
		unlocked.bed.map((segment) => [segment.start, segment.sourceIn])
	);
	verifyThat(
		bedTiming === "[[0,0]]",
		`the unsynced bed keeps one unshifted clip, got ${bedTiming}`
	);
	const unlockedEarly = await rmsLevel(unlocked.render, 1.2, 0.6);
	const unlockedLate = await rmsLevel(unlocked.render, 2.2, 0.6);
	verifyThat(
		unlockedEarly < QUIET,
		`sync lock off: 1.2-1.8 s should be silent, got ${unlockedEarly} dB`
	);
	verifyThat(
		unlockedLate > LOUD,
		`sync lock off: 2.2-2.8 s should carry the tone, got ${unlockedLate} dB`
	);
	process.stdout.write(
		`PASS: sync lock off keeps the music unshifted (1.2-1.8 s ${unlockedEarly.toFixed(1)} dB, 2.2-2.8 s ${unlockedLate.toFixed(1)} dB).\n`
	);

	const locked = await scenario(true);
	const lockedEarly = await rmsLevel(locked.render, 1.2, 0.6);
	verifyThat(
		lockedEarly > LOUD,
		`sync lock on: the rippled tone should start at 1 s, got ${lockedEarly} dB`
	);
	process.stdout.write(
		`PASS: default sync lock ripples the music (1.2-1.8 s ${lockedEarly.toFixed(1)} dB).\n`
	);
} finally {
	app.stop();
	store.close();
	await rm(directory, { force: true, recursive: true });
}
