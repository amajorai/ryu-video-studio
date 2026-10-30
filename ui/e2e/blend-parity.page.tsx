/**
 * Browser side of the blend compositor parity spec. `window.blendParity`
 * loads a scene from the host (`blend-parity.host.ts`), mounts the
 * preview's `PreviewBlendCompositor` on the scene's real media elements,
 * waits for a complete frame and compares its pixels with the server's
 * `inspect-frame` export of the same project and time.
 *
 * `window.blendStageParity` mounts the whole `PreviewStage` instead (its
 * `PreviewMediaLayer` elements register themselves with the compositor),
 * plays an animated scene with the playhead advancing every frame, records
 * what each playback frame drew, then compares the frame at the scene time
 * with the export.
 */
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Asset, Project } from "../../shared/project.ts";
import { PreviewMediaRegistry } from "../src/preview/compositor/media-registry.ts";
import { compositorPlan } from "../src/preview/compositor/plan.ts";
import { PreviewBlendCompositor } from "../src/preview/PreviewBlendCompositor.tsx";
import { PreviewStage } from "../src/preview/PreviewStage.tsx";

interface Scene {
	assets: Asset[];
	project: Project;
	time: number;
}

export interface ParityResult {
	/** Share of channel values more than 16 steps off. */
	farShare: number;
	gaps: string[];
	height: number;
	/** PNG data URLs of the compositor frame and of the per-pixel difference (×8). */
	images?: { actual: string; difference: string };
	/** Largest channel difference away from clip, crop and mask edges. */
	interiorMax: number;
	/** 99th percentile channel difference away from edges. */
	interiorP99: number;
	/** Share of pixels counted as interior. */
	interiorShare: number;
	/** Largest channel difference anywhere (layer edges included). */
	max: number;
	/** Mean absolute channel difference, in 8-bit steps. */
	mean: number;
	/** 99th percentile channel difference. */
	p99: number;
	width: number;
}

async function loadImage(src: string): Promise<HTMLImageElement> {
	const image = new Image();
	image.src = src;
	await image.decode();
	return image;
}

function pixelsOf(
	source: CanvasImageSource,
	width: number,
	height: number
): Uint8ClampedArray {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context) {
		throw new Error("2D canvas is unavailable.");
	}
	context.drawImage(source, 0, 0, width, height);
	return context.getImageData(0, 0, width, height).data;
}

/** The absolute difference, amplified 8×, as a PNG data URL. */
function differenceImage(
	actual: Uint8ClampedArray,
	expected: Uint8ClampedArray,
	width: number,
	height: number
): string {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d");
	if (!context) {
		return "";
	}
	const image = context.createImageData(width, height);
	for (let index = 0; index < image.data.length; index++) {
		image.data[index] =
			index % 4 === 3
				? 255
				: Math.min(
						255,
						8 * Math.abs((actual[index] ?? 0) - (expected[index] ?? 0))
					);
	}
	context.putImageData(image, 0, 0);
	return canvas.toDataURL("image/png");
}

async function waitForFrame(
	canvas: HTMLCanvasElement,
	ready: (state: string | undefined) => boolean = (state) => state === "drawn"
): Promise<void> {
	const deadline = performance.now() + 15_000;
	while (!ready(canvas.dataset.compositorFrame)) {
		if (performance.now() > deadline) {
			throw new Error(
				`The compositor did not draw (state: ${canvas.dataset.compositorFrame ?? "none"}).`
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function blendParity(mode: string): Promise<ParityResult> {
	const scene = (await (await fetch(`/scene/${mode}`)).json()) as Scene;
	const { project } = scene;
	// Normal stacks preview through CSS; `always` still proves the shader.
	const plan = compositorPlan(project, scene.assets, scene.time, {
		always: true,
	});
	if (!plan.active) {
		return {
			farShare: 1,
			gaps: plan.gaps.length > 0 ? plan.gaps : ["inactive"],
			height: 0,
			interiorMax: 255,
			interiorP99: 255,
			interiorShare: 0,
			max: 255,
			mean: 255,
			p99: 255,
			width: 0,
		};
	}
	const registry = new PreviewMediaRegistry();
	for (const segment of project.segments) {
		registry.register(segment.id, await loadImage(`/media/${segment.assetId}`));
	}
	const host = document.createElement("div");
	host.style.cssText = `position:relative;width:${project.width}px;height:${project.height}px`;
	document.body.replaceChildren(host);
	let unavailable: string | null = null;
	const root = createRoot(host);
	root.render(
		<PreviewBlendCompositor
			onUnavailable={(message) => {
				unavailable = message;
			}}
			plan={plan}
			playing={false}
			registry={registry}
			zIndex={1}
		/>
	);
	const canvas = await new Promise<HTMLCanvasElement>((resolve) => {
		const find = () => {
			const element = host.querySelector("canvas");
			if (element) {
				resolve(element);
			} else {
				requestAnimationFrame(find);
			}
		};
		find();
	});
	await waitForFrame(canvas);
	if (unavailable) {
		throw new Error(unavailable);
	}
	const reference = await loadImage(`/reference/${mode}`);
	const { height, width } = project;
	const actual = pixelsOf(canvas, width, height);
	const expected = pixelsOf(reference, width, height);
	const images = {
		actual: canvas.toDataURL("image/png"),
		difference: differenceImage(actual, expected, width, height),
	};
	root.unmount();
	return {
		...differenceStats(actual, expected, width, height),
		gaps: [],
		height,
		images,
		width,
	};
}

/** The 99th percentile of a histogram of channel differences. */
function percentile99(histogram: readonly number[], count: number): number {
	let seen = 0;
	for (const [difference, amount] of histogram.entries()) {
		seen += amount;
		if (seen >= count * 0.99) {
			return difference;
		}
	}
	return 255;
}

/**
 * Whether the reference is smooth around a pixel: no neighbour channel is
 * more than `EDGE_STEP` away. Clip, crop and mask edges are not smooth; the
 * interior metrics skip them because the two resamplers place an edge's
 * partial pixels differently.
 */
const EDGE_STEP = 24;
function smoothAt(
	reference: Uint8ClampedArray,
	width: number,
	height: number,
	x: number,
	y: number
): boolean {
	const centre = (y * width + x) * 4;
	for (let dy = -1; dy <= 1; dy++) {
		for (let dx = -1; dx <= 1; dx++) {
			const nx = Math.min(width - 1, Math.max(0, x + dx));
			const ny = Math.min(height - 1, Math.max(0, y + dy));
			const other = (ny * width + nx) * 4;
			for (let channel = 0; channel < 3; channel++) {
				const step = Math.abs(
					(reference[centre + channel] ?? 0) - (reference[other + channel] ?? 0)
				);
				if (step > EDGE_STEP) {
					return false;
				}
			}
		}
	}
	return true;
}

function differenceStats(
	actual: Uint8ClampedArray,
	expected: Uint8ClampedArray,
	width: number,
	height: number
): Omit<ParityResult, "gaps" | "height" | "images" | "width"> {
	const all = new Array<number>(256).fill(0);
	const interior = new Array<number>(256).fill(0);
	let total = 0;
	let max = 0;
	let interiorMax = 0;
	let count = 0;
	let interiorCount = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const smooth = smoothAt(expected, width, height, x, y);
			for (let channel = 0; channel < 3; channel++) {
				const index = (y * width + x) * 4 + channel;
				const difference = Math.abs(
					(actual[index] ?? 0) - (expected[index] ?? 0)
				);
				all[difference] = (all[difference] ?? 0) + 1;
				total += difference;
				max = Math.max(max, difference);
				count++;
				if (smooth) {
					interior[difference] = (interior[difference] ?? 0) + 1;
					interiorMax = Math.max(interiorMax, difference);
					interiorCount++;
				}
			}
		}
	}
	const far = all.slice(17).reduce((sum, amount) => sum + amount, 0);
	return {
		farShare: far / count,
		interiorMax,
		interiorP99: percentile99(interior, interiorCount),
		interiorShare: interiorCount / count,
		max,
		mean: total / count,
		p99: percentile99(all, count),
	};
}

const nextFrame = () =>
	new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Seconds of playback before the scene time, and the frames they span. */
const ADVANCE_SECONDS = 0.5;
const ADVANCE_FRAMES = 30;

export interface StageParityResult extends ParityResult {
	/** `data-compositor-frame` after each playback frame while the playhead advanced. */
	advancing: string[];
	/** Whether the canvas was visible after each of those frames. */
	advancingShown: boolean[];
	/** The canvas z-index inside the stage. */
	zIndex: number;
}

async function blendStageParity(): Promise<StageParityResult> {
	const scene = (await (await fetch("/scene/stage")).json()) as Scene;
	const { assets, project } = scene;
	const plan = compositorPlan(project, assets, scene.time);
	const empty = {
		advancing: [],
		advancingShown: [],
		farShare: 1,
		height: 0,
		interiorMax: 255,
		interiorP99: 255,
		interiorShare: 0,
		max: 255,
		mean: 255,
		p99: 255,
		width: 0,
		zIndex: 0,
	};
	if (!plan.active) {
		return {
			...empty,
			gaps: plan.gaps.length > 0 ? plan.gaps : ["inactive"],
		};
	}
	const sources = Object.fromEntries(
		assets.map((asset) => [asset.id, `/media/${asset.id}`])
	);
	const host = document.createElement("div");
	host.style.cssText = `position:relative;width:${project.width}px;height:${project.height}px`;
	document.body.replaceChildren(host);
	const errors: string[] = [];
	const root = createRoot(host);
	const renderAt = (time: number) =>
		flushSync(() =>
			root.render(
				<PreviewStage
					assets={assets}
					onError={(message) => errors.push(message)}
					playing
					project={project}
					sources={sources}
					time={time}
				/>
			)
		);
	const start = scene.time - ADVANCE_SECONDS;
	renderAt(start);
	const canvas = await new Promise<HTMLCanvasElement>((resolve) => {
		const find = () => {
			const element = host.querySelector<HTMLCanvasElement>(
				'[data-testid="preview-blend-compositor"]'
			);
			if (element) {
				resolve(element);
			} else {
				requestAnimationFrame(find);
			}
		};
		find();
	});
	// Media and the first mask load while the playhead waits.
	await waitForFrame(canvas, (state) => state === "drawn");
	const advancing: string[] = [];
	const advancingShown: boolean[] = [];
	for (let step = 1; step <= ADVANCE_FRAMES; step++) {
		renderAt(start + (ADVANCE_SECONDS * step) / ADVANCE_FRAMES);
		// One playhead step per animation frame, like playback: the
		// compositor's loop (registered first) draws this frame, then this
		// callback reads what it drew before the next step.
		await nextFrame();
		advancing.push(canvas.dataset.compositorFrame ?? "none");
		advancingShown.push(canvas.style.visibility !== "hidden");
	}
	// Still playing at the scene time: wait for the exact mask.
	await waitForFrame(canvas);
	if (errors.length > 0) {
		throw new Error(errors.join("\n"));
	}
	const reference = await loadImage("/reference/stage");
	const { height, width } = project;
	const actual = pixelsOf(canvas, width, height);
	const expected = pixelsOf(reference, width, height);
	const images = {
		actual: canvas.toDataURL("image/png"),
		difference: differenceImage(actual, expected, width, height),
	};
	const zIndex = Number(canvas.style.zIndex);
	root.unmount();
	return {
		...differenceStats(actual, expected, width, height),
		advancing,
		advancingShown,
		gaps: [],
		height,
		images,
		width,
		zIndex,
	};
}

declare global {
	interface Window {
		blendParity: typeof blendParity;
		blendParityWebGl2: () => boolean;
		blendStageParity: typeof blendStageParity;
	}
}

window.blendParity = blendParity;
window.blendStageParity = blendStageParity;
window.blendParityWebGl2 = () =>
	document.createElement("canvas").getContext("webgl2") !== null;
