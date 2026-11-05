import { mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import {
	analysisSize,
	assertDerivableVideo,
	type DerivativeFilterSupport,
	estimateTranslation,
	findDerivative,
	type GrayFrame,
	STABILIZE_LEVELS,
	type StabilizeLevel,
	type StabilizeMethod,
	stabilizeCorrections,
	stabilizeCropCommands,
	stabilizeCropWindow,
	stabilizeMethod,
	stabilizeRequestSchema,
	translateAnalysisFilter,
	translateApplyFilter,
	type Vector,
	vidstabDetectFilter,
	vidstabTransformFilter,
} from "../../shared/derivatives.ts";
import type { Asset } from "../../shared/project.ts";
import {
	analysisArgs,
	DERIVATIVE_MAX_OUTPUT_BYTES,
	derivativeFilterSupport,
	derivativeVideoArgs,
	grayFramesArgs,
	onceInflight,
	probeVideoStreamGeometry,
	type StoredDerivative,
	storeDerivative,
} from "./derivative-encode.ts";
import { runMedia } from "./media.ts";
import { type MediaOperation, withMediaOperation } from "./media-operation.ts";
import type { StudioStore } from "./store.ts";

const OPERATION_TIMEOUT_MS = 60 * 60_000;
/** Frame rate assumed when the probe could not measure one. */
const FALLBACK_FPS = 30;
/** Largest frame-to-frame shift the tracker searches, as a frame fraction. */
const MAX_SHIFT_FRACTION = 0.12;

type StabilizeInput = z.input<typeof stabilizeRequestSchema>;

export interface StabilizeResult {
	asset: Asset;
	created: boolean;
	method: StabilizeMethod;
}

interface StabilizeOptions {
	operation?: MediaOperation;
	signal?: AbortSignal;
	/** Filter support override (tests). */
	support?: DerivativeFilterSupport;
}

/**
 * Create (or reuse) a stabilized derivative of a video. With libvidstab the
 * two passes are `vidstabdetect` then `vidstabtransform`; otherwise the
 * built-in tracker measures global translation on small grayscale frames,
 * smooths the camera path, and moves a zoomed crop per frame. The source is
 * never modified.
 */
export async function stabilizeAsset(
	store: StudioStore,
	asset: Asset,
	input: StabilizeInput,
	options: StabilizeOptions = {}
): Promise<StabilizeResult> {
	const request = stabilizeRequestSchema.parse(input);
	assertDerivableVideo(asset, "stabilized");
	if (asset.width < 16 || asset.height < 16) {
		throw new Error("Stabilize needs video at least 16 pixels on each side.");
	}
	const support = options.support ?? (await derivativeFilterSupport());
	const method = stabilizeMethod(support);
	const spec = { kind: "stabilize", level: request.level } as const;
	const existing = findDerivative(store.assets(), asset.id, spec);
	if (existing && !request.name) {
		return { asset: existing, created: false, method };
	}
	const key = `${store.directory}\u0000stabilize\u0000${asset.id}\u0000${request.level}\u0000${request.name ?? ""}`;
	const result = await onceInflight(key, () =>
		withMediaOperation(OPERATION_TIMEOUT_MS, options, (operation) =>
			render(store, asset, request.level, method, operation, request.name)
		)
	);
	return { asset: result.asset, created: result.created, method };
}

async function render(
	store: StudioStore,
	asset: Asset,
	level: StabilizeLevel,
	method: StabilizeMethod,
	operation: MediaOperation,
	name: string | undefined
): Promise<StoredDerivative> {
	const source = store.mediaPath(asset.id);
	const size = await stat(source).then(
		(metadata) => metadata.size,
		() => 0
	);
	const fps = asset.frameRate ?? FALLBACK_FPS;
	// Probe sizes are coded sizes; FFmpeg autorotates portrait phone footage,
	// so the tracker's fixed crop and analysis scale use the displayed size.
	const frame =
		method === "translate"
			? await probeVideoStreamGeometry(source, asset, operation.signal)
			: asset;
	operation.check();
	const analysis = analysisSize(frame.width, frame.height);
	const analysisBytes =
		method === "translate"
			? Math.ceil(asset.duration * fps + 2) * analysis.width * analysis.height
			: 0;
	const reservation = store.reserveMediaStorage(
		Math.min(
			DERIVATIVE_MAX_OUTPUT_BYTES,
			size * 3 + analysisBytes + 64 * 1024 * 1024
		)
	);
	const id = crypto.randomUUID();
	const work = join(store.directory, "media", `.stabilize-${id}`);
	const output = join(work, "stabilized.mp4");
	const run = (args: string[], outputPath?: string) =>
		runMedia(args, {
			cwd: work,
			signal: operation.signal,
			timeoutMs: operation.remainingMs(),
			...(outputPath
				? { maxOutputBytes: DERIVATIVE_MAX_OUTPUT_BYTES, outputPath }
				: {}),
		});
	try {
		await mkdir(work, { recursive: true, mode: 0o700 });
		let filter: string;
		if (method === "vidstab") {
			await run(analysisArgs(source, vidstabDetectFilter(level)));
			operation.check();
			filter = `${vidstabTransformFilter(level)},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`;
		} else {
			const frames = join(work, "analysis.gray");
			await run(
				grayFramesArgs(source, translateAnalysisFilter(fps, analysis), frames),
				frames
			);
			operation.check();
			const motions = await measureMotion(frames, analysis, operation);
			await rm(frames, { force: true });
			const crop = stabilizeCropWindow(frame.width, frame.height, level);
			const scale = frame.width / analysis.width;
			const corrections = stabilizeCorrections(
				motions,
				STABILIZE_LEVELS[level].smoothing,
				{ x: crop.marginX / scale, y: crop.marginY / scale }
			);
			await writeFile(
				join(work, "crop.cmd"),
				stabilizeCropCommands(corrections, {
					fps,
					marginX: crop.marginX,
					marginY: crop.marginY,
					scale,
				}),
				{ mode: 0o600 }
			);
			filter = translateApplyFilter({
				fps,
				height: frame.height,
				level,
				width: frame.width,
			});
		}
		await run(
			derivativeVideoArgs(source, output, filter, asset.hasAudio),
			output
		);
		operation.check();
		const next = await storeDerivative(
			store,
			asset,
			{ kind: "stabilize", level },
			output,
			operation,
			{ id, name }
		);
		reservation.commit();
		return next;
	} finally {
		await rm(work, { recursive: true, force: true });
		reservation.release();
	}
}

/**
 * Frame-to-frame translation for every analysis frame, streaming the raw
 * file one frame at a time so memory stays bounded.
 */
async function measureMotion(
	path: string,
	size: { height: number; width: number },
	operation: MediaOperation
): Promise<Vector[]> {
	const frameBytes = size.width * size.height;
	const maxShift = Math.max(2, size.width * MAX_SHIFT_FRACTION);
	const handle = await open(path, "r");
	try {
		const { size: total } = await handle.stat();
		const count = Math.floor(total / frameBytes);
		const motions: Vector[] = [];
		let previous: GrayFrame | undefined;
		for (let index = 0; index < count; index++) {
			if (index % 64 === 0) {
				operation.check();
			}
			const data = new Uint8Array(frameBytes);
			await handle.read(data, 0, frameBytes, index * frameBytes);
			const frame: GrayFrame = { data, height: size.height, width: size.width };
			motions.push(
				previous
					? estimateTranslation(previous, frame, maxShift)
					: { x: 0, y: 0 }
			);
			previous = frame;
		}
		if (!motions.length) {
			throw new Error("Stabilize could not read any video frames.");
		}
		return motions;
	} finally {
		await handle.close();
	}
}
