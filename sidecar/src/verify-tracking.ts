/**
 * Real-FFmpeg proof for motion tracking (W4-M4).
 *
 * 1. A 640x360 H.264 fixture moves a textured 48 px patch along a curved
 *    path (whole-pixel positions, so the truth is exact) next to a static
 *    textured control patch.
 * 2. `trackClip` decodes the clip and tracks the patch: every sample is
 *    within 2 px of the truth and no frame is lost.
 * 3. `POST /projects/:id/track` makes a title follow the patch; its `x`/`y`
 *    keyframes land within 2 px of the truth.
 * 4. A mosaic region follows the patch; a rendered frame is pixelated over
 *    the moving patch and untouched over the static control patch.
 *
 * Run: `bun src/verify-tracking.ts`
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Asset,
	type Keyframe,
	newSegment,
	type Project,
	titleSchema,
} from "../../shared/project.ts";
import { probe, runMedia } from "./media.ts";
import { buildRender } from "./render.ts";
import { routes } from "./routes/tracking.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";
import { trackClip } from "./tracker.ts";

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const WIDTH = 640;
const HEIGHT = 360;
const PATCH = 48;
const SECONDS = 4;
const CONTROL = { x: 520, y: 40 };
/** Moving patch top-left: a rightward drift with a vertical wave. */
const patchX = (t: number) => Math.floor(60 + 90 * t);
const patchY = (t: number) => Math.floor(150 + 70 * Math.sin(1.4 * t));
const xExpression = "60+90*t";
const yExpression = "150+70*sin(1.4*t)";

function noise(seed: number): Uint8Array {
	let state = seed;
	return new Uint8Array(64).map(() => {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
		return 25 + (state % 206);
	});
}

async function patchPng(directory: string, name: string, seed: number) {
	const raw = join(directory, `${name}.gray`);
	const png = join(directory, `${name}.png`);
	await Bun.write(raw, noise(seed));
	await runMedia([
		"-y",
		"-f",
		"rawvideo",
		"-pix_fmt",
		"gray",
		"-s",
		"8x8",
		"-i",
		raw,
		"-vf",
		`scale=${PATCH}:${PATCH}:flags=neighbor`,
		png,
	]);
	return png;
}

/** Gray frame of `file` at `seconds` (decoded at full size). */
async function grayFrame(file: string, seconds: number, directory: string) {
	const raw = join(directory, `frame-${seconds}-${crypto.randomUUID()}.gray`);
	await runMedia([
		"-y",
		"-ss",
		seconds.toFixed(4),
		"-i",
		file,
		"-frames:v",
		"1",
		"-vf",
		`scale=${WIDTH}:${HEIGHT},format=gray`,
		"-f",
		"rawvideo",
		raw,
	]);
	const pixels = new Uint8Array(await readFile(raw));
	ensure(pixels.length === WIDTH * HEIGHT, "frame size");
	return pixels;
}

/** Mean absolute horizontal gradient inside a box (texture energy). */
function energy(pixels: Uint8Array, x: number, y: number, size: number) {
	let total = 0;
	let count = 0;
	for (let row = y + 4; row < y + size - 4; row++) {
		for (let col = x + 4; col < x + size - 5; col++) {
			total += Math.abs(
				(pixels[row * WIDTH + col + 1] ?? 0) - (pixels[row * WIDTH + col] ?? 0)
			);
			count++;
		}
	}
	return total / count;
}

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-tracking-"));
const store = new StudioStore(directory);
const token = crypto.randomUUID();
const app = createStudioServer({ port: 0, routes, store, token });
try {
	const moving = await patchPng(directory, "moving", 4242);
	const control = await patchPng(directory, "control", 777);
	const file = join(directory, "fixture.mp4");
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=c=0x4a5a6a:s=${WIDTH}x${HEIGHT}:r=30:d=${SECONDS}`,
		"-loop",
		"1",
		"-i",
		moving,
		"-loop",
		"1",
		"-i",
		control,
		"-filter_complex",
		`[0][2]overlay=x=${CONTROL.x}:y=${CONTROL.y}:format=rgb:shortest=1[base];[base][1]overlay=x='${xExpression}':y='${yExpression}':format=rgb:shortest=1,format=yuv420p`,
		"-c:v",
		"libx264",
		"-crf",
		"12",
		"-t",
		String(SECONDS),
		file,
	]);
	const asset: Asset = {
		...(await probe(file)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name: "fixture.mp4",
	};
	await Bun.write(store.mediaPath(asset.id), Bun.file(file));
	store.putAsset(asset);

	const created = store.create("Tracking proof");
	const clip = { ...newSegment(asset, 0), sourceOut: SECONDS - 0.1 };
	const label = titleSchema.parse({
		color: "#ffffff",
		end: SECONDS - 0.1,
		fadeIn: 0,
		fadeOut: 0,
		fontSize: 0.05,
		id: crypto.randomUUID(),
		start: 0,
		text: "Tag",
		x: (patchX(0) + PATCH / 2) / WIDTH,
		y: (patchY(0) - 10) / HEIGHT,
	});
	let project = store.save({
		...created,
		height: HEIGHT,
		segments: [clip],
		titles: [label],
		width: WIDTH,
	});
	const roi = {
		height: PATCH / HEIGHT,
		width: PATCH / WIDTH,
		x: patchX(0) / WIDTH,
		y: patchY(0) / HEIGHT,
	};

	// 2. Raw tracker accuracy on every analysed frame.
	const started = performance.now();
	const run = await trackClip(
		store,
		project,
		{ clipId: clip.id, roi, time: 0 },
		new AbortController().signal
	);
	const elapsed = performance.now() - started;
	let worst = 0;
	for (const sample of run.samples) {
		const truthX = patchX(sample.time) + PATCH / 2;
		const truthY = patchY(sample.time) + PATCH / 2;
		const error = Math.hypot(
			sample.x * WIDTH - truthX,
			sample.y * HEIGHT - truthY
		);
		worst = Math.max(worst, error);
	}
	console.log(
		`tracked ${run.samples.length} frames at ${run.analysis.width}x${run.analysis.height} ${run.analysis.fps} fps in ${elapsed.toFixed(0)} ms; worst error ${worst.toFixed(2)} px`
	);
	ensure(run.samples.length >= 110, "about 30 fps of samples");
	ensure(worst < 2, `worst tracking error ${worst} px`);
	ensure(
		run.samples.every((sample) => sample.confidence > 0.8),
		"no weak frames"
	);

	const call = async (body: unknown) => {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/track`,
			{
				body: JSON.stringify(body),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		const payload = (await response.json()) as {
			keyframes: number;
			lostFrames: number;
			project: Project;
		};
		ensure(response.status === 200, JSON.stringify(payload).slice(0, 400));
		return payload;
	};

	// 3. A title follows the subject.
	const titled = await call({
		clipId: clip.id,
		revision: project.revision,
		roi,
		target: { id: label.id, kind: "title" },
		time: 0,
	});
	project = titled.project;
	const frames = project.titles[0]?.keyframes ?? [];
	const channel = (property: Keyframe["property"]) =>
		frames.filter((frame) => frame.property === property);
	// Past the last analysed sample the path holds its position until the
	// clip ends, so the truth there is the subject at that sample.
	const lastSample = run.samples.at(-1)?.time ?? 0;
	const heldTime = (time: number) => Math.min(time, lastSample);
	let titleWorst = 0;
	for (const frame of channel("x")) {
		const truth = label.x + (patchX(heldTime(frame.time)) - patchX(0)) / WIDTH;
		titleWorst = Math.max(titleWorst, Math.abs(frame.value - truth) * WIDTH);
	}
	for (const frame of channel("y")) {
		const truth = label.y + (patchY(heldTime(frame.time)) - patchY(0)) / HEIGHT;
		titleWorst = Math.max(titleWorst, Math.abs(frame.value - truth) * HEIGHT);
	}
	console.log(
		`title: ${titled.keyframes} keyframes, worst ${titleWorst.toFixed(2)} px`
	);
	ensure(titled.lostFrames === 0, "no lost frames");
	ensure(titled.keyframes <= 200, "keyframe budget");
	ensure(titleWorst < 2, `title keyframes off by ${titleWorst} px`);

	// 4. A mosaic region follows the subject in a real render.
	const mosaic = await call({
		clipId: clip.id,
		revision: project.revision,
		roi,
		target: { createRegion: "mosaic" },
		time: 0,
	});
	project = { ...mosaic.project, titles: [] };
	const at = 2.5;
	const png = join(directory, "render.png");
	await runMedia(
		[
			...buildRender(
				project,
				[asset],
				(id) => store.mediaPath(id),
				undefined,
				[],
				at
			),
			png,
		],
		{ cwd: directory }
	);
	const rendered = await grayFrame(png, 0, directory);
	const original = await grayFrame(file, at, directory);
	const box = { x: patchX(at), y: patchY(at) };
	const before = energy(original, box.x, box.y, PATCH);
	const after = energy(rendered, box.x, box.y, PATCH);
	const controlBefore = energy(original, CONTROL.x, CONTROL.y, PATCH);
	const controlAfter = energy(rendered, CONTROL.x, CONTROL.y, PATCH);
	console.log(
		`mosaic texture: subject ${before.toFixed(1)} -> ${after.toFixed(1)}, control ${controlBefore.toFixed(1)} -> ${controlAfter.toFixed(1)}`
	);
	ensure(after < before * 0.6, "the subject is pixelated");
	ensure(
		Math.abs(controlAfter - controlBefore) < controlBefore * 0.1,
		"the control patch is untouched"
	);
	console.log("verify-tracking: ok");
} finally {
	app.stop();
	store.close();
	await rm(directory, { force: true, recursive: true });
}
