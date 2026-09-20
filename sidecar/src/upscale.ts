import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { type Asset, assetSchema } from "../../shared/project.ts";
import {
	upscaleDimensions,
	upscaleRequestSchema,
} from "../../shared/upscale.ts";
import { probe, runMedia, thumbnail } from "./media.ts";
import type { StudioStore } from "./store.ts";

/** Create an app-owned Lanczos derivative without mutating the source asset. */
export async function upscaleAsset(
	store: StudioStore,
	asset: Asset,
	input: unknown
): Promise<Asset> {
	const request = upscaleRequestSchema.parse(input);
	if (asset.kind === "audio") {
		throw new Error("Only image and video media can be upscaled.");
	}
	const dimensions = upscaleDimensions(
		asset.width,
		asset.height,
		request.factor
	);
	const id = crypto.randomUUID();
	const temporaryDirectory = join(store.directory, "media", `.upscale-${id}`);
	const output = join(
		temporaryDirectory,
		asset.kind === "image" ? "upscaled.png" : "upscaled.mp4"
	);
	await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
	try {
		const scale = `scale=${dimensions.width}:${dimensions.height}:flags=lanczos`;
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
			store.mediaPath(asset.id),
			"-vf",
			scale,
		];
		if (asset.kind === "image") {
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
		await runMedia(args);
		const info = await probe(output);
		const next = assetSchema.parse({
			...info,
			createdAt: new Date().toISOString(),
			id,
			name: request.name ?? `${asset.name} · ${request.factor}× local upscale`,
			...(asset.folder ? { folder: asset.folder } : {}),
			...(asset.origin ? { origin: asset.origin } : {}),
		});
		await rename(output, store.mediaPath(next.id));
		store.putAsset(next);
		await thumbnail(
			store.mediaPath(next.id),
			join(store.directory, "media"),
			next.id
		).catch(() => undefined);
		return next;
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}
