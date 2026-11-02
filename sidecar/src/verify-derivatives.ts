/**
 * Real-FFmpeg proof for media derivatives (W2-M2).
 *
 * 1. Stabilize: a still testsrc frame moved by a per-frame jittering crop
 *    (a shaky camera) is stabilized at the medium level, once with the
 *    built-in tracker and, when FFmpeg has libvidstab, once with vidstab.
 *    The mean inter-frame difference of the centre region drops by ≥30%.
 * 2. Interpolate: a 10 fps clip becomes a 30 fps derivative with blending
 *    and with optical flow (minterpolate, when available); duration and
 *    audio are kept.
 * 3. Smooth slow motion: a 0.5x clip in a 30 fps project is swapped onto a
 *    60 fps interpolated derivative through the route, keeping speed and
 *    its source range.
 * 4. Enhanced upscale: a still is denoised, Lanczos-resized and sharpened
 *    into a `derivation: "enhance"` asset at twice its size.
 *
 * Run: `bun src/verify-derivatives.ts`
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DerivativeFilterSupport } from "../../shared/derivatives.ts";
import {
	type Asset,
	assetSchema,
	newSegment,
	projectSchema,
} from "../../shared/project.ts";
import { probeDerivativeFilterSupport } from "./derivative-encode.ts";
import { interpolateAsset } from "./interpolate.ts";
import { probe, runMedia } from "./media.ts";
import { routes } from "./routes/derivatives.ts";
import { createStudioServer } from "./server.ts";
import { stabilizeAsset } from "./stabilize.ts";
import { StudioStore } from "./store.ts";
import { upscaleAsset } from "./upscale.ts";

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const quiet = ["-hide_banner", "-loglevel", "error", "-y"];

/** Mean luma difference between consecutive frames of the centre 60%. */
async function frameDifferenceEnergy(path: string): Promise<number> {
	const output = await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-i",
		path,
		"-vf",
		"crop=iw*0.6:ih*0.6,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
		"-f",
		"null",
		"-",
	]);
	const values = [...output.matchAll(/YAVG=([\d.]+)/g)].map((match) =>
		Number(match[1])
	);
	ensure(values.length > 10, "Frame difference measurement found no frames.");
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function addAsset(
	store: StudioStore,
	path: string,
	name: string
): Promise<Asset> {
	const asset = assetSchema.parse({
		...(await probe(path)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name,
	});
	await Bun.write(store.mediaPath(asset.id), Bun.file(path));
	store.putAsset(asset);
	return asset;
}

async function videoDuration(path: string): Promise<number> {
	const output = await runMedia(
		[
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=duration",
			"-of",
			"csv=p=0",
			path,
		],
		{ probe: true }
	);
	return Number(output.trim());
}

async function frameCount(path: string): Promise<number> {
	const output = await runMedia(
		[
			"-v",
			"error",
			"-count_frames",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=nb_read_frames",
			"-of",
			"csv=p=0",
			path,
		],
		{ probe: true }
	);
	return Number(output.trim());
}

async function verifyStabilize(
	store: StudioStore,
	work: string,
	support: DerivativeFilterSupport
) {
	const still = join(work, "still.png");
	const shaky = join(work, "shaky.mp4");
	await runMedia([
		...quiet,
		"-f",
		"lavfi",
		"-i",
		"testsrc=s=704x416:r=1:d=1",
		"-frames:v",
		"1",
		still,
	]);
	await runMedia([
		...quiet,
		"-loop",
		"1",
		"-framerate",
		"30",
		"-i",
		still,
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=330:duration=4",
		"-t",
		"4",
		"-vf",
		"crop=w=640:h=360:x='32+10*sin(n*1.7)+6*sin(n*0.9)':y='28+8*cos(n*2.3)+5*sin(n*1.1)',format=yuv420p",
		"-c:v",
		"libx264",
		"-crf",
		"16",
		"-c:a",
		"aac",
		"-shortest",
		shaky,
	]);
	const source = await addAsset(store, shaky, "Shaky testsrc");
	const before = await frameDifferenceEnergy(shaky);
	const methods: DerivativeFilterSupport[] = [{ ...support, vidstab: false }];
	if (support.vidstab) {
		methods.push(support);
	}
	for (const override of methods) {
		const result = await stabilizeAsset(
			store,
			source,
			{ level: "medium", name: `stabilized ${override.vidstab}` },
			{ support: override }
		);
		ensure(result.created, "Stabilize reused instead of rendering.");
		ensure(
			result.asset.derivation === "stabilize" &&
				result.asset.derivedFromAssetId === source.id,
			"The stabilized asset lost its derivation."
		);
		ensure(
			result.asset.width === 640 && result.asset.height === 360,
			"Stabilize changed the frame size."
		);
		ensure(result.asset.hasAudio, "Stabilize dropped the audio.");
		ensure(
			Math.abs(result.asset.duration - source.duration) < 0.1,
			"Stabilize changed the duration."
		);
		const after = await frameDifferenceEnergy(store.mediaPath(result.asset.id));
		const reduction = 1 - after / before;
		console.log(
			`stabilize (${result.method}): frame-difference energy ${before.toFixed(2)} -> ${after.toFixed(2)} (${(reduction * 100).toFixed(1)}% lower)`
		);
		ensure(
			reduction >= 0.3,
			`Stabilize (${result.method}) reduced inter-frame motion by only ${(reduction * 100).toFixed(1)}%.`
		);
	}
	const reused = await stabilizeAsset(
		store,
		source,
		{ level: "low" },
		{
			support: { ...support, vidstab: false },
		}
	);
	const again = await stabilizeAsset(
		store,
		source,
		{ level: "low" },
		{
			support: { ...support, vidstab: false },
		}
	);
	ensure(
		reused.created && !again.created && again.asset.id === reused.asset.id,
		"A second stabilize at the same level did not reuse the derivative."
	);
}

async function verifyInterpolate(
	store: StudioStore,
	work: string,
	support: DerivativeFilterSupport
) {
	const path = join(work, "ten-fps.mp4");
	await runMedia([
		...quiet,
		"-f",
		"lavfi",
		"-i",
		"testsrc2=s=320x180:r=10:d=2",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:duration=2",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-shortest",
		path,
	]);
	const source = await addAsset(store, path, "Ten fps");
	const modes = ["blend", "optical-flow"] as const;
	for (const mode of modes) {
		const result = await interpolateAsset(
			store,
			source,
			{ fps: 30, mode },
			{ support }
		);
		const output = store.mediaPath(result.asset.id);
		const frames = await frameCount(output);
		console.log(
			`interpolate ${mode} (${result.method}): ${result.asset.frameRate} fps, ${frames} frames, ${result.asset.duration.toFixed(3)} s`
		);
		ensure(result.asset.derivation === "interpolate", "Lost derivation.");
		ensure(
			Math.abs((result.asset.frameRate ?? 0) - 30) < 0.01,
			`Interpolation produced ${result.asset.frameRate} fps.`
		);
		const sourceVideo = await videoDuration(store.mediaPath(source.id));
		const outputVideo = await videoDuration(output);
		ensure(frames === 60, `Expected 60 frames, got ${frames}.`);
		ensure(
			Math.abs(outputVideo - sourceVideo) <= 1 / 30 + 1e-6,
			`Video stream lasts ${outputVideo} s, source video ${sourceVideo} s.`
		);
		ensure(result.asset.hasAudio, "Interpolation dropped the audio.");
		ensure(
			Math.abs(result.asset.duration - source.duration) < 0.15,
			"Interpolation changed the duration."
		);
		if (mode === "optical-flow") {
			ensure(
				result.method === (support.minterpolate ? "minterpolate" : "framerate"),
				"Optical flow did not follow minterpolate availability."
			);
		}
	}
	return source;
}

async function verifySmoothSlowMotion(store: StudioStore, source: Asset) {
	const segment = {
		...newSegment(source, 0),
		frameInterpolation: "blend" as const,
		sourceIn: 0.5,
		sourceOut: 1.5,
		speed: 0.5,
	};
	const created = store.create("Smooth slow motion");
	const project = store.save({ ...created, segments: [segment] });
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, routes, store, token });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/smooth-slow-motion`,
			{
				body: JSON.stringify({
					clipId: segment.id,
					revision: project.revision,
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		ensure(
			response.status === 200,
			`smooth-slow-motion answered ${response.status}: ${await response.clone().text()}`
		);
		const saved = projectSchema.parse(await response.json());
		const clip = saved.segments[0];
		ensure(clip, "The clip disappeared.");
		const derivative = store
			.assets()
			.find((asset) => asset.id === clip.assetId);
		ensure(
			derivative?.derivation === "interpolate" &&
				derivative.derivedFromAssetId === source.id &&
				Math.abs((derivative.frameRate ?? 0) - 60) < 0.01,
			"The clip was not swapped onto a 60 fps interpolated derivative."
		);
		ensure(
			clip.speed === 0.5 && clip.sourceIn === 0.5 && clip.sourceOut === 1.5,
			"Smooth slow motion changed the clip timing."
		);
		console.log(
			`smooth slow motion: clip now on ${derivative.name} (${derivative.frameRate} fps) at ${clip.speed}x`
		);
	} finally {
		app.stop();
	}
}

async function verifyEnhance(
	store: StudioStore,
	work: string,
	support: DerivativeFilterSupport
) {
	const path = join(work, "small.png");
	await runMedia([
		...quiet,
		"-f",
		"lavfi",
		"-i",
		"testsrc2=s=160x90:r=1:d=1",
		"-frames:v",
		"1",
		path,
	]);
	const source = await addAsset(store, path, "Small still");
	const next = await upscaleAsset(
		store,
		source,
		{ enhance: true, factor: 2 },
		{ support }
	);
	ensure(
		next.width === 320 && next.height === 180,
		`Enhanced upscale is ${next.width}x${next.height}.`
	);
	ensure(
		next.derivation === "enhance" && next.derivedFromAssetId === source.id,
		"Enhanced upscale lost its derivation."
	);
	console.log(`enhance: ${next.name} ${next.width}x${next.height}`);
}

const work = await mkdtemp(join(tmpdir(), "ryu-verify-derivatives-"));
const store = new StudioStore(join(work, "store"));
try {
	const support = await probeDerivativeFilterSupport();
	console.log(`filter support: ${JSON.stringify(support)}`);
	await verifyStabilize(store, work, support);
	const tenFps = await verifyInterpolate(store, work, support);
	await verifySmoothSlowMotion(store, tenFps);
	await verifyEnhance(store, work, support);
	console.log("verify-derivatives: ok");
} finally {
	store.close();
	await rm(work, { force: true, recursive: true });
}
