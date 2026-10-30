/**
 * Real-FFmpeg proof for AutoCut and vertical shorts (W4-G5).
 *
 * 1. A 120 BPM kick loop is beat-detected through `GET /assets/:id/beats`;
 *    `POST /auto-edit` (minimal style) cuts a red and a blue source to its
 *    bar starts. The export lasts as long as the music, each slot shows the
 *    source AutoCut placed there, the music is audible and the sources' own
 *    tones are muted.
 * 2. The smooth style in 9:16 renders a 1080x1920 export with dissolves.
 * 3. `POST /projects/:id/shorts` cuts the loud highlight of a 16:9 talk into
 *    a 9:16 short whose export is 1080x1920, lasts the highlight, and fills
 *    the frame edge to edge (no letterbox).
 * 4. A 9:16 AutoCut of a 16:9 source whose subject (a white square) stays in
 *    the left fifth of the frame follows the subject (W4-AI1 track reframe):
 *    the reply reports track mode for every clip, and the export shows
 *    the square near the centre of every slot, where a centred crop would
 *    show none of it.
 *
 * Run: `bun sidecar/src/verify-auto-edit.ts`
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Asset,
	newSegment,
	type Project,
	projectSchema,
} from "../../shared/project.ts";
import { probe, runMedia } from "./media.ts";
import { createStudioServer } from "./server.ts";
import { type RenderJob, StudioStore } from "./store.ts";

type Rgb = [number, number, number];

function verifyThat(condition: boolean, message: string): void {
	if (!condition) {
		throw new Error(`FAIL: ${message}`);
	}
}

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-autocut-"));
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

/** Generate media with FFmpeg and register it with a completed analysis. */
async function lavfi(
	name: string,
	args: string[],
	waveform: number[] = []
): Promise<Asset> {
	const file = join(directory, name);
	await runMedia(["-hide_banner", "-loglevel", "error", "-y", ...args, file]);
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
		waveform,
	});
	return asset;
}

/** Kick every beat, doubled on bar starts (as in `verify-beats.ts`). */
function kickLoop(bpm: number, seconds: number) {
	const beat = (60 / bpm).toFixed(6);
	const bar = ((4 * 60) / bpm).toFixed(6);
	const phase = `mod(t\\,${beat})`;
	return `aevalsrc=(1+lt(mod(t\\,${bar})\\,${beat}))*(0.45*exp(-30*${phase})*sin(2*PI*60*${phase})+0.25*exp(-200*${phase})*sin(2*PI*2000*t))+0.004*(random(0)-0.5):s=44100:d=${seconds}`;
}

/** A solid-colour 16:9 video with a 1 kHz tone. */
function colourVideo(colour: string, seconds: number, tone = "0.5") {
	return [
		"-f",
		"lavfi",
		"-i",
		`color=c=${colour}:s=320x180:r=25:d=${seconds}`,
		"-f",
		"lavfi",
		"-i",
		`aevalsrc=${tone}*sin(2*PI*1000*t):s=48000:d=${seconds}`,
		"-shortest",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
	];
}

async function waitForRender(project: Project): Promise<string> {
	const queued = await call<RenderJob>(`/projects/${project.id}/render`, {});
	for (let attempt = 0; attempt < 1800; attempt += 1) {
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

/** RMS level (dBFS) of the 1 kHz band (`tone`) or the whole mix. */
async function rmsLevel(
	file: string,
	start: number,
	length: number,
	band?: string
): Promise<number> {
	const filter = `${band ? `${band},` : ""}astats=metadata=1:reset=0,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`;
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
		filter,
		"-f",
		"null",
		"-",
	]);
	const levels = [
		...output.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?inf|-?[\d.]+)/g),
	].map((match) => (match[1]?.endsWith("inf") ? -200 : Number(match[1])));
	const last = levels.at(-1);
	if (last === undefined) {
		throw new Error(`astats printed no level at ${start}s.`);
	}
	return last;
}

/** One RGB frame of `file` at `time`, as a pixel sampler. */
async function frameAt(
	file: string,
	time: number,
	size: { height: number; width: number }
): Promise<(x: number, y: number) => Rgb> {
	const raw = join(directory, `frame-${crypto.randomUUID()}.rgb`);
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-ss",
		String(time),
		"-i",
		file,
		"-frames:v",
		"1",
		"-pix_fmt",
		"rgb24",
		"-f",
		"rawvideo",
		raw,
	]);
	const pixels = await readFile(raw);
	verifyThat(
		pixels.length === size.width * size.height * 3,
		`frame at ${time}s is not ${size.width}x${size.height}`
	);
	return (x, y) => {
		const offset = (y * size.width + x) * 3;
		return [
			pixels[offset] ?? 0,
			pixels[offset + 1] ?? 0,
			pixels[offset + 2] ?? 0,
		];
	};
}

const colourOf = ([r, g, b]: Rgb): "red" | "blue" | "black" | "other" => {
	if (r < 30 && g < 30 && b < 30) {
		return "black";
	}
	if (r > 150 && g < 80 && b < 80) {
		return "red";
	}
	if (b > 150 && r < 80 && g < 80) {
		return "blue";
	}
	return "other";
};

interface AutoCutReply {
	beatSource: string;
	duration: number;
	placements: { assetId: string; duration: number; start: number }[];
	project: unknown;
	reframe: { clipId: string; keyframes: number; mode: string }[];
	slots: { end: number; start: number }[];
	transitions: number;
}

const results: string[] = [];
try {
	const music = await lavfi("music.wav", [
		"-f",
		"lavfi",
		"-i",
		kickLoop(120, 12),
		"-c:a",
		"pcm_s16le",
	]);
	const beats = await call<{ bpm: number; downbeats: number[] }>(
		`/assets/${music.id}/beats`
	);
	verifyThat(Math.abs(beats.bpm - 120) <= 1, `music is 120 BPM (${beats.bpm})`);
	const red = await lavfi("red.mp4", colourVideo("red", 20));
	const blue = await lavfi("blue.mp4", colourVideo("blue", 20));

	// 1. Minimal style, 16:9: hard cuts on bar starts.
	const minimal = await call<AutoCutReply>("/auto-edit", {
		aspect: "16:9",
		assetIds: [red.id, blue.id],
		duration: 30,
		musicAssetId: music.id,
		style: "minimal",
	});
	verifyThat(minimal.beatSource === "detected", "beats were detected");
	verifyThat(
		Math.abs(minimal.duration - music.duration) < 0.05,
		`edit lasts the music (${minimal.duration}s)`
	);
	const bar = 2;
	for (const slot of minimal.slots.slice(1)) {
		const offBar = Math.abs(slot.start / bar - Math.round(slot.start / bar));
		verifyThat(offBar * bar < 0.06, `cut at ${slot.start}s is on a bar start`);
	}
	verifyThat(
		new Set(minimal.placements.map((placement) => placement.assetId)).size ===
			2,
		"both sources are used"
	);
	const minimalProject = projectSchema.parse(minimal.project);
	const minimalFile = await waitForRender(minimalProject);
	const minimalProbe = await probe(minimalFile);
	verifyThat(
		Math.abs(minimalProbe.duration - minimal.duration) < 0.15,
		`export lasts ${minimalProbe.duration}s`
	);
	const landscape = { height: 1080, width: 1920 };
	for (const placement of minimal.placements) {
		const sample = await frameAt(
			minimalFile,
			placement.start + placement.duration / 2,
			landscape
		);
		const expected = placement.assetId === red.id ? "red" : "blue";
		const seen = colourOf(sample(960, 540));
		verifyThat(
			seen === expected,
			`slot at ${placement.start}s shows ${expected} (saw ${seen})`
		);
	}
	const mix = await rmsLevel(minimalFile, 1, 8);
	const tone = await rmsLevel(
		minimalFile,
		1,
		8,
		"bandpass=f=1000:width_type=q:w=8"
	);
	verifyThat(mix > -40, `music is audible (${mix.toFixed(1)} dBFS)`);
	verifyThat(tone < -45, `source tones are muted (${tone.toFixed(1)} dBFS)`);
	results.push(
		`PASS: AutoCut minimal: ${minimal.slots.length} slots on 2 s bars, ${minimalProbe.duration.toFixed(2)} s export, each slot shows its placed source, music ${mix.toFixed(1)} dBFS, source tone ${tone.toFixed(1)} dBFS.`
	);

	// 2. Smooth style, 9:16 with dissolves.
	const smooth = await call<AutoCutReply>("/auto-edit", {
		aspect: "9:16",
		assetIds: [red.id, blue.id],
		duration: 8,
		musicAssetId: music.id,
		style: "smooth",
	});
	verifyThat(smooth.transitions > 0, "smooth style adds transitions");
	const smoothFile = await waitForRender(projectSchema.parse(smooth.project));
	const smoothProbe = await probe(smoothFile);
	verifyThat(
		smoothProbe.width === 1080 && smoothProbe.height === 1920,
		`smooth export is 1080x1920 (${smoothProbe.width}x${smoothProbe.height})`
	);
	verifyThat(
		Math.abs(smoothProbe.duration - 8) < 0.15,
		`smooth export lasts 8 s (${smoothProbe.duration})`
	);
	const vertical = { height: 1920, width: 1080 };
	const firstSlot = smooth.placements[0];
	if (firstSlot) {
		const sample = await frameAt(smoothFile, firstSlot.duration / 3, vertical);
		const expected = firstSlot.assetId === red.id ? "red" : "blue";
		verifyThat(
			colourOf(sample(10, 960)) === expected,
			"vertical AutoCut fills the frame edge to edge"
		);
	}
	results.push(
		`PASS: AutoCut smooth 9:16: ${smooth.transitions} dissolve/blur transitions, ${smoothProbe.width}x${smoothProbe.height}, ${smoothProbe.duration.toFixed(2)} s.`
	);

	// 3. Shorts: the loud burst of a 16:9 talk becomes a 9:16 short.
	const loud = Array.from({ length: 60 }, (_, index) =>
		index >= 20 && index < 32 ? 0.9 : 0.05
	);
	const talk = await lavfi(
		"talk.mp4",
		colourVideo("red", 60, "if(between(t\\,20\\,32)\\,0.6\\,0.02)"),
		loud
	);
	const created = store.create("Talk");
	const source = store.save({
		...created,
		segments: [{ ...newSegment(talk, 0, 0), sourceOut: talk.duration }],
	});
	const shorts = await call<{
		shorts: { end: number; project: unknown; start: number }[];
	}>(`/projects/${source.id}/shorts`, {
		count: 1,
		maxSeconds: 12,
		minSeconds: 8,
		revision: source.revision,
	});
	const short = shorts.shorts[0];
	verifyThat(short !== undefined, "one short was created");
	if (short) {
		verifyThat(
			short.start >= 15 && short.end <= 37,
			`the short covers the loud burst (${short.start}-${short.end}s)`
		);
		const shortProject = projectSchema.parse(short.project);
		verifyThat(
			shortProject.exportSettings?.platformPreset === "youtube-shorts",
			"the short stores the Shorts publish preset"
		);
		const shortFile = await waitForRender(shortProject);
		const shortProbe = await probe(shortFile);
		verifyThat(
			shortProbe.width === 1080 && shortProbe.height === 1920,
			`short export is 1080x1920 (${shortProbe.width}x${shortProbe.height})`
		);
		verifyThat(
			Math.abs(shortProbe.duration - (short.end - short.start)) < 0.15,
			`short lasts its highlight (${shortProbe.duration}s)`
		);
		const sample = await frameAt(shortFile, 1, vertical);
		for (const [x, y] of [
			[4, 960],
			[1075, 960],
			[540, 4],
			[540, 1915],
		] as const) {
			verifyThat(
				colourOf(sample(x, y)) === "red",
				`short fills the frame at ${x},${y}`
			);
		}
		const level = await rmsLevel(shortFile, 0.5, 2);
		verifyThat(level > -25, `short keeps the loud audio (${level.toFixed(1)})`);
		results.push(
			`PASS: shorts: highlight ${short.start}-${short.end}s → ${shortProbe.width}x${shortProbe.height}, ${shortProbe.duration.toFixed(2)} s, filled edge to edge, audio ${level.toFixed(1)} dBFS, preset youtube-shorts.`
		);
	}
	// 4. AutoCut follows the subject when it changes the aspect.
	const subject = await lavfi(
		"subject.mp4",
		[
			"-f",
			"lavfi",
			"-i",
			"color=c=0x202020:s=320x180:r=25:d=10",
			"-f",
			"lavfi",
			"-i",
			"color=c=white:s=30x30:r=25:d=10",
			"-f",
			"lavfi",
			"-i",
			"aevalsrc=0.3*sin(2*PI*440*t):s=48000:d=10",
			"-filter_complex",
			"[0][1]overlay=x='20+6*t':y=75:shortest=1[v]",
			"-map",
			"[v]",
			"-map",
			"2:a",
			"-shortest",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
		],
		Array.from({ length: 10 }, () => 0.3)
	);
	const followed = await call<AutoCutReply>("/auto-edit", {
		aspect: "9:16",
		assetIds: [subject.id],
		duration: 6,
		style: "minimal",
	});
	verifyThat(
		followed.reframe.length > 0 &&
			followed.reframe.every((clip) => clip.mode === "track"),
		`every AutoCut clip follows its subject (${JSON.stringify(followed.reframe)})`
	);
	const followedFile = await waitForRender(
		projectSchema.parse(followed.project)
	);
	const centres: string[] = [];
	for (const placement of followed.placements) {
		const time = placement.start + placement.duration / 2;
		const sample = await frameAt(followedFile, time, vertical);
		let count = 0;
		let sumX = 0;
		for (let y = 0; y < vertical.height; y += 4) {
			for (let x = 0; x < vertical.width; x += 4) {
				const [r, g, b] = sample(x, y);
				if (r > 200 && g > 200 && b > 200) {
					count++;
					sumX += x;
				}
			}
		}
		const centre = count ? sumX / count / vertical.width : -1;
		verifyThat(
			count > 500,
			`the subject is in the 9:16 frame at ${time.toFixed(2)}s (${count} bright samples)`
		);
		verifyThat(
			Math.abs(centre - 0.5) < 0.2,
			`the subject is near the centre at ${time.toFixed(2)}s (${centre.toFixed(3)})`
		);
		centres.push(centre.toFixed(2));
	}
	results.push(
		`PASS: AutoCut 9:16 follows the subject: ${followed.reframe.length} tracked clips (${followed.reframe.map((clip) => clip.keyframes).join("/")} pan keyframes), square centred at ${centres.join(", ")} of the width.`
	);
	process.stdout.write(`${results.join("\n")}\n`);
} finally {
	app.stop();
	store.close();
	await rm(directory, { force: true, recursive: true });
}
