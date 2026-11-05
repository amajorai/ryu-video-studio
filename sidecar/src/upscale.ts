import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import {
	type DerivativeFilterSupport,
	derivativeName,
	enhanceUpscaleFilter,
	MAX_DERIVATIVE_SECONDS,
} from "../../shared/derivatives.ts";
import { type Asset, assetSchema } from "../../shared/project.ts";
import {
	upscaleDimensions,
	upscaleEdgeLimit,
	upscaleRequestSchema,
} from "../../shared/upscale.ts";
import {
	DERIVATIVE_MAX_OUTPUT_BYTES,
	derivativeFilterSupport,
	probeVideoStreamGeometry,
} from "./derivative-encode.ts";
import { MAX_THUMBNAIL_BYTES, probe, runMedia, thumbnail } from "./media.ts";
import { withMediaOperation } from "./media-operation.ts";
import type { StudioStore } from "./store.ts";

type UpscaleInput = z.input<typeof upscaleRequestSchema>;

/** Headroom reserved on top of the estimated derivative size. */
const RESERVATION_HEADROOM_BYTES = 64 * 1024 * 1024;

/**
 * Storage to admit before rendering: the source grown by the pixel factor
 * (PNG stills compress worse than their sources), capped at the encode limit.
 */
export function upscaleReservationBytes(
	sourceBytes: number,
	factor: number,
	kind: "image" | "video"
): number {
	const growth = factor * factor * (kind === "image" ? 8 : 2);
	return Math.min(
		DERIVATIVE_MAX_OUTPUT_BYTES,
		Math.ceil(Math.max(0, sourceBytes) * growth) + RESERVATION_HEADROOM_BYTES
	);
}

/**
 * Create an app-owned Lanczos derivative without mutating the source asset.
 * With `enhance`, the resize is wrapped in a denoise and a sharpen pass, the
 * edge bound rises to the canvas limit, and the asset is tagged
 * `derivation: "enhance"` with a link to its source.
 */
export async function upscaleAsset(
	store: StudioStore,
	asset: Asset,
	input: UpscaleInput,
	options: { signal?: AbortSignal; support?: DerivativeFilterSupport } = {}
): Promise<Asset> {
	const request = upscaleRequestSchema.parse(input);
	if (asset.kind === "audio") {
		throw new Error("Only image and video media can be upscaled.");
	}
	if (
		request.enhance &&
		asset.kind === "video" &&
		!(asset.duration > 0 && asset.duration <= MAX_DERIVATIVE_SECONDS)
	) {
		throw new Error(
			`Media up to ${MAX_DERIVATIVE_SECONDS / 60} minutes long can be enhanced.`
		);
	}
	const kind = asset.kind;
	const support = request.enhance
		? (options.support ?? (await derivativeFilterSupport()))
		: undefined;
	return await withMediaOperation(30 * 60_000, options, async (operation) => {
		const source = store.mediaPath(asset.id);
		// FFmpeg autorotates portrait footage, so size the output from the
		// displayed frame rather than the coded one.
		const frame =
			kind === "video"
				? await probeVideoStreamGeometry(source, asset, operation.signal)
				: asset;
		operation.check();
		const dimensions = upscaleDimensions(
			frame.width,
			frame.height,
			request.factor,
			upscaleEdgeLimit(request.enhance)
		);
		const scale = support
			? enhanceUpscaleFilter(dimensions, kind, support)
			: `scale=${dimensions.width}:${dimensions.height}:flags=lanczos`;
		const sourceBytes = await stat(source).then(
			(metadata) => metadata.size,
			() => 0
		);
		// Claim an asset slot and the estimated size before encoding; the exact
		// output size is admitted once it is known.
		const estimatedBytes = upscaleReservationBytes(
			sourceBytes,
			request.factor,
			kind
		);
		let reservation = store.reserveMediaStorage(estimatedBytes);
		const id = crypto.randomUUID();
		const temporaryDirectory = join(store.directory, "media", `.upscale-${id}`);
		const output = join(
			temporaryDirectory,
			asset.kind === "image" ? "upscaled.png" : "upscaled.mp4"
		);
		try {
			// Cap the encode by the remaining quota (this reservation included).
			const maxOutputBytes = Math.min(
				DERIVATIVE_MAX_OUTPUT_BYTES,
				store.mediaStorageHeadroom() + estimatedBytes
			);
			if (maxOutputBytes <= 0) {
				throw new Error("Media storage quota reached.");
			}
			await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
			const args = [
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostdin",
				"-y",
				"-protocol_whitelist",
				"file,pipe",
				"-format_whitelist",
				"mov,matroska,webm,mp4,png_pipe,jpeg_pipe,webp_pipe,bmp_pipe",
				"-i",
				source,
				"-vf",
				scale,
			];
			if (kind === "image") {
				args.push("-frames:v", "1", "-c:v", "png", output);
			} else {
				args.push(
					"-map",
					"0:v:0",
					"-map",
					"0:a?",
					"-c:v",
					"libx264",
					"-preset",
					"medium",
					"-crf",
					"18",
					"-pix_fmt",
					"yuv420p",
					"-c:a",
					"aac",
					"-b:a",
					"192k",
					"-movflags",
					"+faststart",
					output
				);
			}
			await runMedia(args, {
				signal: operation.signal,
				timeoutMs: operation.remainingMs(),
				outputPath: output,
				maxOutputBytes,
			});
			operation.check();
			const outputBytes = (await stat(output)).size;
			reservation.release();
			reservation = store.reserveMediaStorage(
				outputBytes + MAX_THUMBNAIL_BYTES
			);
			const info = await probe(output, operation.signal);
			operation.check();
			const nextInput: Record<string, unknown> = {
				...info,
				createdAt: new Date().toISOString(),
				id,
				name:
					request.name ??
					(request.enhance
						? derivativeName(asset.name, {
								factor: request.factor,
								kind: "enhance",
							})
						: `${asset.name} · ${request.factor}× local upscale`),
			};
			if (request.enhance) {
				nextInput.derivation = "enhance";
				nextInput.derivedFromAssetId = asset.id;
			}
			if (asset.folder) {
				Object.assign(nextInput, { folder: asset.folder });
			}
			if (asset.origin) {
				Object.assign(nextInput, { origin: asset.origin });
			}
			const next = assetSchema.parse(nextInput);
			await rename(output, store.mediaPath(next.id));
			store.putAsset(next);
			await thumbnail(
				store.mediaPath(next.id),
				join(store.directory, "media"),
				next.id,
				operation.signal
			).catch(() => undefined);
			reservation.commit();
			operation.check();
			return next;
		} finally {
			reservation.release();
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	});
}
