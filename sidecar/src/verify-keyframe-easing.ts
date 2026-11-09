/**
 * Real-FFmpeg proof for the keyframe engine (W1-K1).
 *
 * Renders still-image fixtures through the sidecar (`inspect-frame` for
 * single frames, plus one full export) and checks pixels:
 *
 * - opacity `hold`: full opacity until the next keyframe, then the new value;
 * - opacity `ease-in`: the eased (not linear) value at mid-interval;
 * - opacity `bezier`: the CSS curve value at mid-interval;
 * - keyframed `cropLeft`: the eased edge becomes transparent per frame;
 * - keyframed `brightness`/`exposure` (`eq` with `eval=frame`) and
 *   `temperature` (`colorbalance` stepped by `sendcmd`) match a static render
 *   of the same value.
 *
 * Run: `bun src/verify-keyframe-easing.ts`
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { animatedValue } from "../../shared/animation.ts";
import {
	type Asset,
	type Keyframe,
	newSegment,
	type Project,
	type Segment,
} from "../../shared/project.ts";
import { probe, runMedia } from "./media.ts";
import { createStudioServer } from "./server.ts";
import { type RenderJob, StudioStore } from "./store.ts";

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const WIDTH = 320;
const HEIGHT = 180;

const frameSchema = z.object({ data: z.string() });

const directory = await mkdtemp(join(tmpdir(), "ryu-keyframe-easing-"));
const store = new StudioStore(directory);
const token = crypto.randomUUID();
const app = createStudioServer({ port: 0, store, token });
const base = `http://127.0.0.1:${app.server.port}/api/video-studio`;
const headers = { authorization: `Bearer ${token}` };

function pass(message: string) {
	process.stdout.write(`PASS: ${message}\n`);
}

async function stillAsset(color: string): Promise<Asset> {
	const file = join(directory, `${color.replace("#", "")}.png`);
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=${color}:s=${WIDTH}x${HEIGHT}`,
		"-frames:v",
		"1",
		file,
	]);
	const id = crypto.randomUUID();
	await Bun.write(store.mediaPath(id), Bun.file(file));
	const asset: Asset = {
		...(await probe(file)),
		createdAt: new Date().toISOString(),
		id,
		name: `${color}.png`,
	};
	store.putAsset(asset);
	return asset;
}

/** RGB24 pixels of a PNG or a video frame at `at` seconds. */
async function pixels(file: string, at?: number): Promise<Uint8Array> {
	const raw = join(directory, `${crypto.randomUUID()}.rgb`);
	await runMedia([
		"-y",
		...(at === undefined ? [] : ["-ss", String(at)]),
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
	return new Uint8Array(await Bun.file(raw).arrayBuffer());
}

async function inspect(project: Project, time: number): Promise<Uint8Array> {
	const response = await fetch(
		`${base}/projects/${project.id}/inspect-frame?time=${time}`,
		{ headers }
	);
	ensure(response.status === 200, await response.clone().text());
	const { data } = frameSchema.parse(await response.json());
	const png = join(directory, `${crypto.randomUUID()}.png`);
	await Bun.write(png, Buffer.from(data, "base64"));
	return pixels(png);
}

/** Mean of one channel over a column band (fractions of the width). */
function channel(
	frame: Uint8Array,
	index: 0 | 1 | 2,
	from = 0.4,
	to = 0.6
): number {
	let total = 0;
	let count = 0;
	for (let y = Math.floor(HEIGHT * 0.3); y < HEIGHT * 0.7; y++) {
		for (let x = Math.floor(WIDTH * from); x < WIDTH * to; x++) {
			total += frame[(y * WIDTH + x) * 3 + index] ?? 0;
			count++;
		}
	}
	return total / count;
}

const keyframes = (frames: Omit<Keyframe, "id">[]): Keyframe[] =>
	frames.map((frame) => ({ ...frame, id: crypto.randomUUID() }));

function project(name: string, segment: Segment): Project {
	return store.save({
		...store.create(name),
		height: HEIGHT,
		segments: [segment],
		width: WIDTH,
	});
}

try {
	const red = await stillAsset("#ff0000");
	const gray = await stillAsset("#606060");
	const clip = (asset: Asset, frames: Omit<Keyframe, "id">[]): Segment => ({
		...newSegment(asset),
		keyframes: keyframes(frames),
		sourceOut: 4,
	});

	// Background level under a fully transparent clip.
	const empty = project(
		"Transparent",
		clip(red, [{ property: "opacity", time: 0, value: 0 }])
	);
	const background = channel(await inspect(empty, 1), 0);
	const alpha = (frame: Uint8Array) =>
		(channel(frame, 0) - background) / (255 - background);

	const hold = project(
		"Opacity hold",
		clip(red, [
			{ interpolation: "hold", property: "opacity", time: 0, value: 1 },
			{ property: "opacity", time: 2, value: 0.2 },
		])
	);
	for (const [time, expected] of [
		[0.5, 1],
		[1.9, 1],
		[2.5, 0.2],
		[3.5, 0.2],
	] as const) {
		const measured = alpha(await inspect(hold, time));
		ensure(
			Math.abs(measured - expected) < 0.03,
			`hold at ${time}s: alpha ${measured}, expected ${expected}`
		);
	}
	pass("opacity hold keeps full alpha until 2 s, then 0.2 (inspect-frame).");

	const easeIn = project(
		"Opacity ease-in",
		clip(red, [
			{ interpolation: "ease-in", property: "opacity", time: 0, value: 1 },
			{ property: "opacity", time: 2, value: 0.2 },
		])
	);
	const easedAlpha = alpha(await inspect(easeIn, 1));
	ensure(
		Math.abs(easedAlpha - 0.8) < 0.03,
		`ease-in midpoint alpha ${easedAlpha}, expected 0.8 (linear 0.6)`
	);
	pass(
		`opacity ease-in at mid-interval renders alpha ${easedAlpha.toFixed(3)} (eased 0.8, linear would be 0.6).`
	);

	const bezierClip = clip(red, [
		{
			bezier: [0.25, 0.1, 0.25, 1],
			interpolation: "bezier",
			property: "opacity",
			time: 0,
			value: 0,
		},
		{ property: "opacity", time: 2, value: 1 },
	]);
	const bezier = project("Opacity bezier", bezierClip);
	const bezierAlpha = alpha(await inspect(bezier, 1));
	const bezierExpected = animatedValue(bezierClip, "opacity", 1);
	ensure(
		Math.abs(bezierAlpha - bezierExpected) < 0.03,
		`bezier midpoint alpha ${bezierAlpha}, expected ${bezierExpected}`
	);
	pass(
		`opacity bezier(0.25,0.1,0.25,1) at mid-interval renders alpha ${bezierAlpha.toFixed(3)} (curve ${bezierExpected.toFixed(3)}).`
	);

	const crop = project(
		"Crop keyframes",
		clip(red, [
			{ interpolation: "ease-out", property: "cropLeft", time: 0, value: 0 },
			{ property: "cropLeft", time: 2, value: 0.5 },
		])
	);
	const cropped = await inspect(crop, 1);
	// ease-out at u = 0.5 hides 0.375 of the width (linear would be 0.25).
	const hidden =
		(channel(cropped, 0, 0.3, 0.35) - background) / (255 - background);
	const shown =
		(channel(cropped, 0, 0.4, 0.45) - background) / (255 - background);
	ensure(hidden < 0.05, `cropped band still visible: ${hidden}`);
	ensure(shown > 0.95, `visible band hidden: ${shown}`);
	const settled = await inspect(crop, 3);
	ensure(
		(channel(settled, 0, 0.45, 0.48) - background) / (255 - background) <
			0.05 &&
			(channel(settled, 0, 0.52, 0.6) - background) / (255 - background) > 0.95,
		"crop did not settle at half the width"
	);
	pass(
		"keyframed cropLeft hides the eased edge per frame (0.375 at 1 s, 0.5 after 2 s)."
	);

	const animatedColor = project(
		"Color keyframes",
		clip(gray, [
			{ interpolation: "ease-out", property: "brightness", time: 0, value: 0 },
			{ property: "brightness", time: 2, value: 0.2 },
			{ property: "exposure", time: 0, value: 0.3 },
		])
	);
	const staticColor = project("Static color", {
		...newSegment(gray),
		brightness: 0.15,
		colorGrade: { exposure: 0.3, temperature: 0, tint: 0, vibrance: 0 },
		sourceOut: 4,
	});
	const animatedFrame = await inspect(animatedColor, 1);
	const staticFrame = await inspect(staticColor, 1);
	const plainFrame = await inspect(
		project("Plain gray", { ...newSegment(gray), sourceOut: 4 }),
		1
	);
	ensure(
		channel(animatedFrame, 1) - channel(plainFrame, 1) > 20,
		"keyframed brightness did not brighten the frame"
	);
	ensure(
		Math.abs(channel(animatedFrame, 1) - channel(staticFrame, 1)) < 3,
		"keyframed brightness differs from the static render of its value"
	);
	pass(
		`keyframed brightness/exposure (eq eval=frame) at 1 s: ${channel(animatedFrame, 1).toFixed(1)} vs static ${channel(staticFrame, 1).toFixed(1)} (plain ${channel(plainFrame, 1).toFixed(1)}).`
	);

	// colorbalance rs/bs act on shadows, so use a dark source.
	const dark = await stillAsset("#282828");
	const warming = project(
		"Temperature keyframes",
		clip(dark, [
			{ property: "temperature", time: 0, value: 0 },
			{ property: "temperature", time: 2, value: 0.8 },
		])
	);
	const staticWarm = project("Static temperature", {
		...newSegment(dark),
		colorGrade: { exposure: 0, temperature: 0.4, tint: 0, vibrance: 0 },
		sourceOut: 4,
	});
	const warmFrame = await inspect(warming, 1);
	const staticWarmFrame = await inspect(staticWarm, 1);
	const coldFrame = await inspect(warming, 0);
	const warmth = (frame: Uint8Array) => channel(frame, 0) - channel(frame, 2);
	ensure(warmth(warmFrame) > 10, `no warmth at 1 s: ${warmth(warmFrame)}`);
	ensure(warmth(coldFrame) < 3, `warmth at 0 s: ${warmth(coldFrame)}`);
	for (const index of [0, 1, 2] as const) {
		const difference = Math.abs(
			channel(warmFrame, index) - channel(staticWarmFrame, index)
		);
		ensure(
			difference < 4,
			`temperature channel ${index} differs by ${difference} from the static render`
		);
	}
	pass(
		`keyframed temperature (sendcmd colorbalance) at 1 s matches static 0.4: red-blue ${warmth(warmFrame).toFixed(1)} vs ${warmth(staticWarmFrame).toFixed(1)}; 0 at 0 s.`
	);

	// Full export: the same graphs run over a timeline with fps sampling.
	const exported = store.save({
		...store.create("Keyframe export"),
		height: HEIGHT,
		segments: [
			{
				...clip(red, [
					{ interpolation: "hold", property: "opacity", time: 0, value: 1 },
					{ property: "opacity", time: 2, value: 0.2 },
					{
						interpolation: "ease-out",
						property: "cropLeft",
						time: 0,
						value: 0,
					},
					{ property: "cropLeft", time: 2, value: 0.5 },
					{ property: "temperature", time: 0, value: 0 },
					{ property: "temperature", time: 2, value: 0.6 },
				]),
			},
		],
		width: WIDTH,
	});
	const queued = (await (
		await fetch(`${base}/projects/${exported.id}/render`, {
			body: "{}",
			headers: { ...headers, "content-type": "application/json" },
			method: "POST",
		})
	).json()) as RenderJob;
	let job = queued;
	for (let attempt = 0; attempt < 600; attempt++) {
		job = store.jobs().find((value) => value.id === queued.id) ?? job;
		if (["completed", "failed"].includes(job.status)) {
			break;
		}
		await Bun.sleep(100);
	}
	ensure(job.status === "completed", job.error ?? "render timeout");
	const early = await pixels(store.renderPath(job.id), 1);
	const late = await pixels(store.renderPath(job.id), 3);
	const earlyAlpha =
		(channel(early, 0, 0.6, 0.9) - background) / (255 - background);
	const lateAlpha =
		(channel(late, 0, 0.6, 0.9) - background) / (255 - background);
	ensure(earlyAlpha > 0.9, `export alpha before the hold ends: ${earlyAlpha}`);
	ensure(
		Math.abs(lateAlpha - 0.2) < 0.06,
		`export alpha after the hold: ${lateAlpha}`
	);
	ensure(
		channel(late, 0, 0.3, 0.45) - background < 8,
		"export crop band still visible after 2 s"
	);
	pass(
		"full export renders the hold, the animated crop and stepped temperature."
	);
} finally {
	app.stop();
	store.close();
	await rm(directory, { force: true, recursive: true });
}
