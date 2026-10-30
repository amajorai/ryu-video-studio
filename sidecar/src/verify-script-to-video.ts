/**
 * Real-FFmpeg proof for script to video (W4-G4).
 *
 * Two narrated scenes are assembled through `POST /projects/:id/script-assemble`
 * and exported through the render queue:
 *
 * - scene 1: a 2 s narration tone over a red still (Ken Burns), with a saved
 *   word transcript, so its captions take measured word timing;
 * - 0.5 s gap;
 * - scene 2: a quiet 1.5 s narration over a 1 s blue video whose own loud
 *   tone must be muted, slowed to cover the narration.
 *
 * Checks: export duration, the visual on screen in each window (black in
 * the gap), narration loud in scene 1 and silent in the gap, the visual's
 * own audio muted in scene 2, and burned-in captions in scene 1.
 *
 * Music bed and presenter (G82): two 2 s scenes of a 2.5 kHz narration tone
 * with a 1 s gap are assembled with `music` (warm, scored locally) and an
 * `avatar` preset. Checks: the bed is placed and ducked, its low band (below
 * 600 Hz, where the narration tone has no energy) is audible in the gap and
 * at least 3 dB lower under the narration than in a duck-off control, the
 * avatars carry lip-sync mouth keyframes, and the presenter changes the
 * pixels in its preset box against the control.
 *
 * Run: `bun sidecar/src/verify-script-to-video.ts`
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	type Asset,
	activeCaptions,
	type Project,
	projectSchema,
} from "../../shared/project.ts";
import type {
	ScriptAvatarPreset,
	ScriptMusic,
} from "../../shared/script-extras.ts";
import { probe, runMedia } from "./media.ts";
import { createStudioServer } from "./server.ts";
import { type RenderJob, StudioStore } from "./store.ts";

type Rgb = [number, number, number];

function verifyThat(condition: boolean, message: string): void {
	if (!condition) {
		throw new Error(`FAIL: ${message}`);
	}
}

const WIDTH = 320;
const HEIGHT = 180;
const directory = await mkdtemp(join(tmpdir(), "ryu-verify-script-"));
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

async function lavfi(file: string, args: string[]): Promise<Asset> {
	const path = join(directory, file);
	await runMedia(["-hide_banner", "-loglevel", "error", "-y", ...args, path]);
	return importMedia(path);
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

/** RMS level (dBFS) of `file` over `[start, start + length]`. */
async function rmsLevel(
	file: string,
	start: number,
	length: number,
	filters = ""
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
		`${filters}astats=metadata=1:reset=0,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`,
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
	time: number
): Promise<(x: number, y: number) => Rgb> {
	const raw = join(directory, `frame-${time}.rgb`);
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
		pixels.length === WIDTH * HEIGHT * 3,
		`frame at ${time}s is not ${WIDTH}x${HEIGHT}`
	);
	return (x, y) => {
		const offset = (y * WIDTH + x) * 3;
		return [
			pixels[offset] ?? 0,
			pixels[offset + 1] ?? 0,
			pixels[offset + 2] ?? 0,
		];
	};
}

const dominant = ([r, g, b]: Rgb): "red" | "blue" | "black" | "other" => {
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

const results: string[] = [];
try {
	const voiceOne = await lavfi("voice-1.wav", [
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:duration=2:sample_rate=48000",
		"-ac",
		"1",
		"-c:a",
		"pcm_s16le",
	]);
	const voiceTwo = await lavfi("voice-2.wav", [
		"-f",
		"lavfi",
		"-i",
		"aevalsrc=0.01*sin(2*PI*660*t):s=48000:d=1.5",
		"-c:a",
		"pcm_s16le",
	]);
	const still = await lavfi("still.png", [
		"-f",
		"lavfi",
		"-i",
		"color=c=0xd02020:s=640x360",
		"-frames:v",
		"1",
	]);
	const clip = await lavfi("clip.mp4", [
		"-f",
		"lavfi",
		"-i",
		`color=c=0x2020d0:s=${WIDTH}x${HEIGHT}:r=30:d=1`,
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=1000:duration=1:sample_rate=48000",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-shortest",
	]);
	verifyThat(clip.hasAudio, "the scene 2 video fixture must carry audio");

	// A saved word transcript for scene 1's narration (source seconds).
	const begun = store.beginTranscript(voiceOne);
	const word = (start: number, end: number, text: string) => ({
		end,
		id: crypto.randomUUID(),
		start,
		text,
	});
	store.appendTranscript(
		voiceOne.id,
		begun.revision,
		0,
		[word(0.1, 1.9, "bright red square glows")],
		"windows",
		[
			word(0.1, 0.5, "bright"),
			word(0.6, 0.9, "red"),
			word(1.0, 1.4, "square"),
			word(1.5, 1.9, "glows"),
		]
	);

	const created = store.save({
		...store.create("Script to video proof"),
		height: HEIGHT,
		width: WIDTH,
	});
	const assembled = await call<Record<string, unknown>>(
		`/projects/${created.id}/script-assemble`,
		{
			captionChunking: { maxWords: 2, mode: "words" },
			gap: 0.5,
			revision: created.revision,
			scenes: [
				{
					narrationAssetId: voiceOne.id,
					text: "Bright red square glows.",
					visualAssetId: still.id,
				},
				{
					narrationAssetId: voiceTwo.id,
					text: "A quiet blue ending.",
					visualAssetId: clip.id,
				},
			],
		}
	);
	const project = projectSchema.parse(assembled.project);
	const captions = activeCaptions(project);
	verifyThat(
		captions[0]?.text === "Bright red" &&
			Math.abs((captions[0]?.start ?? 0) - 0.1) < 1e-9 &&
			Math.abs((captions[0]?.end ?? 0) - 0.9) < 1e-9,
		`scene 1 captions take measured timing, got ${JSON.stringify(captions[0])}`
	);
	results.push(
		`assembled ${project.segments.length} clips and ${captions.length} captions over ${assembled.duration}s`
	);

	const render = await waitForRender(project);
	const media = await probe(render);
	verifyThat(
		Math.abs(media.duration - 4) < 0.1,
		`export lasts the narration plus the gap (4 s), got ${media.duration}`
	);
	results.push(`export duration ${media.duration.toFixed(3)} s`);

	for (const [time, expected] of [
		[0.3, "red"],
		[1.6, "red"],
		[2.25, "black"],
		[2.8, "blue"],
		[3.8, "blue"],
	] as const) {
		const sample = await frameAt(render, time);
		const center = sample(WIDTH / 2, HEIGHT / 3);
		verifyThat(
			dominant(center) === expected,
			`frame at ${time}s should be ${expected}, got rgb(${center.join(",")})`
		);
	}
	results.push("visuals: red still, black gap, blue video in their windows");

	// The Ken Burns drift must never uncover an edge of the still.
	for (const time of [0, 1, 1.95]) {
		const sample = await frameAt(render, time);
		for (const [x, y] of [
			[0, HEIGHT / 3],
			[WIDTH - 1, HEIGHT / 3],
			[WIDTH / 2, 0],
		] as const) {
			const edge = sample(x, y);
			verifyThat(
				dominant(edge) === "red",
				`still edge (${x},${y}) at ${time}s should be red, got rgb(${edge.join(",")})`
			);
		}
	}
	results.push("Ken Burns still covers the frame edges at start, middle, end");

	const lightPixels = (sample: (x: number, y: number) => Rgb) => {
		let count = 0;
		for (let y = Math.floor(HEIGHT * 0.6); y < HEIGHT; y += 1) {
			for (let x = 0; x < WIDTH; x += 1) {
				const [r, g, b] = sample(x, y);
				if (g > 140 && b > 140 && r > 140) {
					count += 1;
				}
			}
		}
		return count;
	};
	const bright = lightPixels(await frameAt(render, 0.7));
	// Control: the same scenes assembled without captions.
	const control = store.save({
		...store.create("Script to video control"),
		height: HEIGHT,
		width: WIDTH,
	});
	const uncaptioned = await call<Record<string, unknown>>(
		`/projects/${control.id}/script-assemble`,
		{
			captions: false,
			gap: 0.5,
			revision: control.revision,
			scenes: [
				{
					narrationAssetId: voiceOne.id,
					text: "Bright red square glows.",
					visualAssetId: still.id,
				},
			],
		}
	);
	const controlProject = projectSchema.parse(uncaptioned.project);
	verifyThat(
		activeCaptions(controlProject).length === 0,
		"captions: false adds no captions"
	);
	const plain = lightPixels(
		await frameAt(await waitForRender(controlProject), 0.7)
	);
	verifyThat(
		bright > 30 && plain <= 2,
		`scene 1 shows burned-in caption text (${bright} light pixels; ${plain} without captions)`
	);
	results.push(
		`caption text: ${bright} light pixels in the lower frame, ${plain} without captions`
	);

	const narration = await rmsLevel(render, 0.4, 1.2);
	const gap = await rmsLevel(render, 2.1, 0.3);
	const sceneTwo = await rmsLevel(render, 2.7, 1);
	verifyThat(narration > -30, `scene 1 narration is audible (${narration} dB)`);
	verifyThat(gap < -60, `the gap is silent (${gap} dB)`);
	verifyThat(
		sceneTwo < -30,
		`scene 2's video audio is muted under its quiet narration (${sceneTwo} dB)`
	);
	results.push(
		`audio RMS: scene 1 ${narration.toFixed(1)} dB, gap ${gap.toFixed(1)} dB, scene 2 ${sceneTwo.toFixed(1)} dB`
	);
	// Music bed and presenter avatar.
	const presenterVoice = await lavfi("voice-presenter.wav", [
		"-f",
		"lavfi",
		"-i",
		"aevalsrc=0.3*sin(2*PI*2500*t):s=48000:d=2",
		"-c:a",
		"pcm_s16le",
	]);
	const extrasScenes = [
		{
			narrationAssetId: presenterVoice.id,
			text: "Music under the presenter.",
			visualAssetId: still.id,
		},
		{
			narrationAssetId: presenterVoice.id,
			text: "And a second scene.",
			visualAssetId: still.id,
		},
	];
	const assembleExtras = async (
		title: string,
		extras: { avatar?: { preset: ScriptAvatarPreset }; music: ScriptMusic }
	) => {
		const target = store.save({
			...store.create(title),
			height: HEIGHT,
			width: WIDTH,
		});
		const assembledExtras = await call<unknown>(
			`/projects/${target.id}/script-assemble`,
			{
				captions: false,
				gap: 1,
				kenBurns: false,
				revision: target.revision,
				scenes: extrasScenes,
				...extras,
			}
		);
		return z
			.object({ music: z.unknown(), project: z.unknown() })
			.parse(assembledExtras);
	};
	const withExtras = await assembleExtras("Script extras proof", {
		avatar: { preset: "presenter-right" },
		music: { mood: "warm", volume: 1 },
	});
	const duckOff = await assembleExtras("Script extras control", {
		music: { duck: false, mood: "warm", volume: 1 },
	});
	const extrasProject = projectSchema.parse(withExtras.project);
	const music = z
		.object({ clipId: z.string(), status: z.string() })
		.parse(withExtras.music);
	const bed = extrasProject.segments.find(
		(segment) => segment.id === music.clipId
	);
	verifyThat(
		music.status === "placed" && bed?.duckUnderVoice === true,
		`the music bed is placed and ducked, got ${JSON.stringify(music)}`
	);
	verifyThat(
		Math.abs((bed?.sourceOut ?? 0) - 5) < 0.01 && bed?.start === 0,
		"the bed spans the assembly (5 s from 0)"
	);
	const mouths = extrasProject.avatars.map((avatar) =>
		(avatar.rigKeyframes ?? []).filter(
			(keyframe) => keyframe.property === "mouth"
		)
	);
	verifyThat(
		mouths.length === 2 &&
			mouths.every(
				(keys) =>
					keys.length >= 2 &&
					Math.max(...keys.map((key) => key.value)) >
						Math.min(...keys.map((key) => key.value)) + 0.2
			),
		`each presenter has a moving lip-synced mouth, got ${mouths.map((keys) => keys.length).join(", ")} keyframes`
	);
	results.push(
		`presenters: ${mouths.map((keys) => keys.length).join(" + ")} mouth keyframes`
	);
	const extrasRender = await waitForRender(extrasProject);
	const controlRender = await waitForRender(
		projectSchema.parse(duckOff.project)
	);
	const lowBand = "lowpass=f=600,lowpass=f=600,lowpass=f=600,";
	const bedInGap = await rmsLevel(extrasRender, 2.3, 0.4, lowBand);
	const ducked = await rmsLevel(extrasRender, 0.6, 1, lowBand);
	const unducked = await rmsLevel(controlRender, 0.6, 1, lowBand);
	verifyThat(bedInGap > -45, `the music bed plays in the gap (${bedInGap} dB)`);
	verifyThat(
		unducked - ducked >= 3,
		`the bed ducks under the narration (${ducked} dB ducked, ${unducked} dB without ducking)`
	);
	results.push(
		`music bed low band: gap ${bedInGap.toFixed(1)} dB, under narration ${ducked.toFixed(1)} dB ducked vs ${unducked.toFixed(1)} dB control`
	);
	const presenter = await frameAt(extrasRender, 1);
	const plainFrame = await frameAt(controlRender, 1);
	let changed = 0;
	for (let y = Math.floor(HEIGHT * 0.25); y < HEIGHT * 0.8; y += 2) {
		for (let x = Math.floor(WIDTH * 0.64); x < WIDTH * 0.88; x += 2) {
			const [r, g, b] = presenter(x, y);
			const [r0, g0, b0] = plainFrame(x, y);
			if (Math.abs(r - r0) + Math.abs(g - g0) + Math.abs(b - b0) > 60) {
				changed += 1;
			}
		}
	}
	verifyThat(
		changed > 100,
		`the presenter is drawn in its preset box (${changed} changed samples)`
	);
	results.push(`presenter avatar: ${changed} changed samples in its box`);

	for (const line of results) {
		process.stdout.write(`ok  ${line}\n`);
	}
	process.stdout.write("verify-script-to-video: PASS\n");
} finally {
	app.stop();
	store.close();
	await rm(directory, { force: true, recursive: true });
}
