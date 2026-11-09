import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { type Asset, assetSchema } from "../../shared/project.ts";
import {
	MAX_THUMBNAIL_BYTES,
	MEDIA_FORMATS,
	runMedia,
	thumbnail,
} from "./media.ts";
import { type MediaOperation, withMediaOperation } from "./media-operation.ts";
import type { StudioStore } from "./store.ts";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const OPERATION_TIMEOUT_MS = 60_000;

interface FreezeOptions {
	operation?: MediaOperation;
	signal?: AbortSignal;
}

/**
 * Capture one source frame of a video asset as an app-owned PNG still. The
 * frame comes from the clip's own media, so timeline overlays (titles,
 * captions, other tracks) are never baked into the freeze.
 *
 * `attach` runs synchronously right after the still is registered and must
 * reference it (for example a revision-checked project save). When it
 * throws, the still, its file and its thumbnail are removed so a refused or
 * conflicting edit never leaves orphaned media behind.
 */
export async function captureSourceFrame<Result>(
	store: StudioStore,
	asset: Asset,
	sourceTime: number,
	attach: (still: Asset) => Result,
	options: FreezeOptions = {}
): Promise<Result> {
	if (asset.kind !== "video") {
		throw new Error("A freeze frame needs a video clip.");
	}
	if (
		!(Number.isFinite(sourceTime) && sourceTime >= 0) ||
		sourceTime > asset.duration
	) {
		throw new Error("Choose a frame inside the clip's media.");
	}
	return await withMediaOperation(
		OPERATION_TIMEOUT_MS,
		options,
		async (operation) => {
			const reservation = store.reserveMediaStorage(
				MAX_FRAME_BYTES + MAX_THUMBNAIL_BYTES
			);
			const id = crypto.randomUUID();
			const work = join(store.directory, "media", `.freeze-${id}`);
			const output = join(work, "frame.png");
			const path = store.mediaPath(id);
			let saved = false;
			try {
				await mkdir(work, { recursive: true, mode: 0o700 });
				await runMedia(
					[
						"-hide_banner",
						"-loglevel",
						"error",
						"-nostdin",
						"-y",
						"-protocol_whitelist",
						"file,pipe",
						"-format_whitelist",
						MEDIA_FORMATS,
						"-ss",
						sourceTime.toFixed(6),
						"-i",
						store.mediaPath(asset.id),
						"-map",
						"0:v:0",
						"-frames:v",
						"1",
						"-c:v",
						"png",
						"-f",
						"image2",
						output,
					],
					{
						cwd: work,
						signal: operation.signal,
						timeoutMs: operation.remainingMs(),
						outputPath: output,
						maxOutputBytes: MAX_FRAME_BYTES,
					}
				);
				operation.check();
				const size = await stat(output).then(
					(metadata) => metadata.size,
					() => 0
				);
				if (!size || size > MAX_FRAME_BYTES) {
					throw new Error(
						"No frame could be captured at this time in the clip's media."
					);
				}
				const nextInput = {
					createdAt: new Date().toISOString(),
					duration: 5,
					hasAudio: false,
					height: asset.height,
					id,
					kind: "image",
					name: `${asset.name.slice(0, 160)} · freeze ${sourceTime.toFixed(2)}s`,
					width: asset.width,
				};
				if (asset.folder) {
					Object.assign(nextInput, { folder: asset.folder });
				}
				if (asset.origin) {
					Object.assign(nextInput, { origin: asset.origin });
				}
				const still = assetSchema.parse(nextInput);
				await rename(output, path);
				await thumbnail(
					path,
					join(store.directory, "media"),
					id,
					operation.signal
				).catch(() => undefined);
				operation.check();
				store.putAsset(still);
				let result: Result;
				try {
					result = attach(still);
				} catch (error) {
					store.discardAsset(still.id);
					throw error;
				}
				reservation.commit();
				saved = true;
				return result;
			} finally {
				await rm(work, { recursive: true, force: true });
				if (!saved) {
					await Promise.all([
						rm(path, { force: true }),
						rm(join(store.directory, "media", `${id}.jpg`), { force: true }),
					]);
				}
				reservation.release();
			}
		}
	);
}
