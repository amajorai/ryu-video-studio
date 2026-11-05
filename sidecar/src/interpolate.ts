import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import {
	assertDerivableVideo,
	assertInterpolationBounds,
	boundedInterpolationFilter,
	type DerivativeFilterSupport,
	defaultInterpolateMode,
	findDerivative,
	type InterpolateMethod,
	type InterpolateMode,
	interpolateFilter,
	interpolateRequestSchema,
} from "../../shared/derivatives.ts";
import type { Asset } from "../../shared/project.ts";
import {
	DERIVATIVE_MAX_OUTPUT_BYTES,
	derivativeFilterSupport,
	derivativeVideoArgs,
	onceInflight,
	probeVideoStreamGeometry,
	storeDerivative,
} from "./derivative-encode.ts";
import { runMedia } from "./media.ts";
import { type MediaOperation, withMediaOperation } from "./media-operation.ts";
import type { StudioStore } from "./store.ts";

const OPERATION_TIMEOUT_MS = 60 * 60_000;

type InterpolateInput = z.input<typeof interpolateRequestSchema>;

export interface InterpolateResult {
	asset: Asset;
	created: boolean;
	method: InterpolateMethod;
	/** The mode actually rendered (optical flow falls back to blend). */
	mode: InterpolateMode;
}

interface InterpolateOptions {
	operation?: MediaOperation;
	signal?: AbortSignal;
	/** Filter support override (tests). */
	support?: DerivativeFilterSupport;
}

/**
 * Create (or reuse) a derivative of a video resampled to `fps` with
 * synthesized in-between frames: `minterpolate` motion compensation for
 * optical flow, `framerate` frame blending otherwise. The input tail is
 * padded and the output trimmed so the video stream keeps the source video
 * duration and timebase.
 */
export async function interpolateAsset(
	store: StudioStore,
	asset: Asset,
	input: InterpolateInput,
	options: InterpolateOptions = {}
): Promise<InterpolateResult> {
	const request = interpolateRequestSchema.parse(input);
	assertDerivableVideo(asset, "interpolated");
	assertInterpolationBounds(asset.duration, request.fps);
	const support = options.support ?? (await derivativeFilterSupport());
	const plan = interpolateFilter(
		request.fps,
		request.mode ?? defaultInterpolateMode(support),
		support
	);
	const spec = {
		fps: request.fps,
		kind: "interpolate",
		mode: plan.mode,
	} as const;
	const existing = findDerivative(store.assets(), asset.id, spec);
	if (existing && !request.name) {
		return {
			asset: existing,
			created: false,
			method: plan.method,
			mode: plan.mode,
		};
	}
	const key = `${store.directory}\u0000interpolate\u0000${asset.id}\u0000${request.fps}\u0000${plan.mode}\u0000${request.name ?? ""}`;
	const result = await onceInflight(key, () =>
		withMediaOperation(OPERATION_TIMEOUT_MS, options, async (operation) => {
			const source = store.mediaPath(asset.id);
			const size = await stat(source).then(
				(metadata) => metadata.size,
				() => 0
			);
			const ratio = Math.max(
				1,
				request.fps / Math.max(1, asset.frameRate ?? request.fps)
			);
			const reservation = store.reserveMediaStorage(
				Math.min(
					DERIVATIVE_MAX_OUTPUT_BYTES,
					Math.ceil(size * ratio * 2) + 64 * 1024 * 1024
				)
			);
			const id = crypto.randomUUID();
			const work = join(store.directory, "media", `.interpolate-${id}`);
			const output = join(work, "interpolated.mp4");
			try {
				await mkdir(work, { recursive: true, mode: 0o700 });
				const stream = await probeVideoStreamGeometry(
					source,
					asset,
					operation.signal
				);
				operation.check();
				const bounded = boundedInterpolationFilter(plan.filter, {
					duration: stream.duration,
					fps: asset.frameRate ?? request.fps,
				});
				const filter = `${bounded},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`;
				await runMedia(
					derivativeVideoArgs(source, output, filter, asset.hasAudio),
					{
						cwd: work,
						maxOutputBytes: DERIVATIVE_MAX_OUTPUT_BYTES,
						outputPath: output,
						signal: operation.signal,
						timeoutMs: operation.remainingMs(),
					}
				);
				operation.check();
				const next = await storeDerivative(
					store,
					asset,
					spec,
					output,
					operation,
					{
						id,
						name: request.name,
					}
				);
				reservation.commit();
				return next;
			} finally {
				await rm(work, { recursive: true, force: true });
				reservation.release();
			}
		})
	);
	return {
		asset: result.asset,
		created: result.created,
		method: plan.method,
		mode: plan.mode,
	};
}
