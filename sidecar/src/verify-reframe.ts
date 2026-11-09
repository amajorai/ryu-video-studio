/**
 * Real-FFmpeg proof for auto reframe (W4-AI1). A 16:9 clip shows a white
 * square crossing a dark frame. It is tracked from real decoded frames
 * (`trackSubjects`), reframed to 9:16 (`applyReframe`), and single frames
 * are rendered through `buildRender`: the square must stay near the centre
 * of the vertical frame, while a plain centre crop loses it at the ends.
 * Blur-fill mode must show the whole picture over a filled canvas. A second
 * square that sweeps from the left edge to the right edge must stay in the
 * 9:16 frame for the whole sweep (the pan covers the full source width), and a
 * 4:3 reframe must keep the canvas even and the square in frame.
 *
 * Run: `bun src/verify-reframe.ts`
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSegment, type Project } from "../../shared/project.ts";
import {
	applyReframe,
	type ReframeAspect,
	type ReframeMode,
} from "../../shared/reframe.ts";
import { probe, runMedia } from "./media.ts";
import { buildRender } from "./render.ts";
import { trackSubjects } from "./saliency.ts";
import { StudioStore } from "./store.ts";

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-reframe-"));
const store = new StudioStore(directory);
const results: string[] = [];
try {
	const source = join(directory, "square.mp4");
	// Square centre x = 80 + 40t px of 320 (0.25 → 0.625 of the width).
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-y",
		"-f",
		"lavfi",
		"-i",
		"color=c=0x202020:s=320x180:d=3:r=25",
		"-f",
		"lavfi",
		"-i",
		"color=c=white:s=30x30:d=3:r=25",
		"-filter_complex",
		"[0][1]overlay=x='65+40*t':y=75:shortest=1",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		source,
	]);
	const asset = {
		...(await probe(source)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name: "square.mp4",
	};
	await Bun.write(store.mediaPath(asset.id), Bun.file(source));
	store.putAsset(asset);
	const created = store.create("Reframe proof");
	const segment = newSegment(asset);
	const project = store.save({
		...created,
		height: 180,
		segments: [segment],
		width: 320,
	});

	// A square sweeping edge to edge: centre x = 20 + 90t px of 320
	// (0.06 → 0.91 of the width over 3 s).
	const edgeSource = join(directory, "edge.mp4");
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-y",
		"-f",
		"lavfi",
		"-i",
		"color=c=0x202020:s=320x180:d=3:r=25",
		"-f",
		"lavfi",
		"-i",
		"color=c=white:s=30x30:d=3:r=25",
		"-filter_complex",
		"[0][1]overlay=x='5+90*t':y=75:shortest=1",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		edgeSource,
	]);
	const edgeAsset = {
		...(await probe(edgeSource)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name: "edge.mp4",
	};
	await Bun.write(store.mediaPath(edgeAsset.id), Bun.file(edgeSource));
	store.putAsset(edgeAsset);
	const edgeCreated = store.create("Reframe edge proof");
	const edgeProject = store.save({
		...edgeCreated,
		height: 180,
		segments: [newSegment(edgeAsset)],
		width: 320,
	});
	const sourceOf = (target: Project) =>
		target.segments[0]?.assetId === edgeAsset.id ? edgeSource : source;

	async function reframed(
		mode: ReframeMode,
		base: Project = project,
		aspect: ReframeAspect = "9:16"
	): Promise<Project> {
		const tracks =
			mode === "track" ? await trackSubjects(store, base.segments) : new Map();
		return applyReframe(
			base,
			[edgeAsset, asset].filter((item) =>
				base.segments.some((clip) => clip.assetId === item.id)
			),
			{ aspect, mode, revision: base.revision, smoothing: 0.3 },
			tracks
		).project;
	}

	/** Bright-pixel bounds and centroid of a rendered frame. */
	async function brightShape(
		target: Project,
		time: number,
		name: string
	): Promise<{ centerX: number; count: number; darkRows: number }> {
		const png = join(directory, `${name}.png`);
		await runMedia(
			[
				...buildRender(
					target,
					[asset, edgeAsset],
					() => sourceOf(target),
					undefined,
					[],
					time
				),
				png,
			],
			{ cwd: directory }
		);
		const raw = join(directory, `${name}.gray`);
		await runMedia([
			"-y",
			"-i",
			png,
			"-pix_fmt",
			"gray",
			"-f",
			"rawvideo",
			raw,
		]);
		const pixels = await readFile(raw);
		ensure(
			pixels.length === target.width * target.height,
			`${name}: frame is not ${target.width}x${target.height}`
		);
		let count = 0;
		let sumX = 0;
		let darkRows = 0;
		for (let y = 0; y < target.height; y++) {
			let rowMax = 0;
			for (let x = 0; x < target.width; x++) {
				const value = pixels[y * target.width + x] ?? 0;
				rowMax = Math.max(rowMax, value);
				if (value > 200) {
					count++;
					sumX += x + 0.5;
				}
			}
			if (rowMax < 4) {
				darkRows++;
			}
		}
		return {
			centerX: count ? sumX / count / target.width : -1,
			count,
			darkRows,
		};
	}

	const tracked = await reframed("track");
	ensure(tracked.width === 180 && tracked.height === 320, "canvas is not 9:16");
	const clip = tracked.segments[0];
	ensure(clip?.fit === "fill", "tracked clip is not fill");
	ensure(
		clip.keyframes.filter((frame) => frame.property === "x").length >= 2,
		"tracked clip has no pan keyframes"
	);
	for (const time of [0.3, 1.5, 2.7]) {
		const shape = await brightShape(tracked, time, `track-${time}`);
		ensure(shape.count > 200, `track ${time}s: the square left the frame`);
		ensure(
			Math.abs(shape.centerX - 0.5) < 0.15,
			`track ${time}s: square centre at ${shape.centerX.toFixed(3)} of the width`
		);
	}
	results.push("track mode keeps the moving square centred in 9:16");

	const centered = await reframed("center");
	const early = await brightShape(centered, 0.3, "center-0.3");
	ensure(
		early.count === 0 || Math.abs(early.centerX - 0.5) > 0.3,
		"center crop unexpectedly framed the square at the start"
	);
	results.push("a plain centre crop loses the square (control)");

	const blurred = await reframed("blur-fill");
	ensure(blurred.background?.type === "blur", "blur-fill set no blur canvas");
	const fitted = await brightShape(blurred, 1.5, "blur-1.5");
	ensure(fitted.count > 0, "blur-fill lost the square");
	ensure(
		fitted.darkRows === 0,
		"blur-fill left black bars above or below the picture"
	);
	results.push("blur-fill fits the whole picture over a blur canvas");

	const edge = await reframed("track", edgeProject);
	for (const time of [0.2, 1.5, 2.8]) {
		const shape = await brightShape(edge, time, `edge-${time}`);
		ensure(shape.count > 200, `edge ${time}s: the square left the frame`);
		ensure(
			Math.abs(shape.centerX - 0.5) < 0.3,
			`edge ${time}s: square centre at ${shape.centerX.toFixed(3)} of the width`
		);
	}
	results.push(
		"a subject sweeping edge to edge stays in the 9:16 frame (full-width pan)"
	);

	const classic = await reframed("track", edgeProject, "4:3");
	ensure(
		classic.width === 240 && classic.height === 180,
		`4:3 canvas is ${classic.width}x${classic.height}`
	);
	const classicShape = await brightShape(classic, 2.8, "classic-2.8");
	ensure(classicShape.count > 200, "4:3: the square left the frame");
	results.push("a 4:3 reframe keeps an even canvas and the subject in frame");

	for (const line of results) {
		console.info(`ok - ${line}`);
	}
} finally {
	store.close();
	await rm(directory, { force: true, recursive: true });
}
