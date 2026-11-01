/**
 * Browser preview copies of transparent derivatives (AI matte, cutout).
 *
 * Those derivatives are ProRes 4444 (`yuva444p10le`) so the renderer and
 * exports keep their alpha, but browsers cannot decode ProRes, and the
 * generic H.264 preview proxy has no alpha channel. Like a Lottie master
 * (`lottie-encode.ts`), each one gets a VP9 WebM copy with alpha
 * (`yuva420p`), registered as its `derivation: "proxy"`. Chromium-based
 * webviews decode VP9 alpha natively; the render never reads this copy.
 *
 * The copy is best effort: when this FFmpeg has no `libvpx-vp9` or the
 * encode fails, the derivative is kept without it and the editor says the
 * preview cannot show its transparency (`alphaPreviewMissing` in the UI).
 */
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { type Asset, assetSchema } from "../../shared/project.ts";
import { MEDIA_FORMATS, probe, runMedia } from "./media.ts";
import type { MediaOperation } from "./media-operation.ts";
import type { StudioStore } from "./store.ts";

/** Hard cap on one preview copy. */
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024 * 1024;
const PREVIEW_OVERHEAD_BYTES = 16 * 1024 * 1024;
/** Short GOP so the preview seeks quickly. */
const PREVIEW_GOP = 12;
const DEFAULT_FRAME_RATE = 30;

/** FFmpeg arguments that copy an alpha master to VP9 WebM with alpha. */
export function alphaPreviewArgs(source: string, output: string): string[] {
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-y",
		"-protocol_whitelist",
		"file,pipe",
		"-format_whitelist",
		MEDIA_FORMATS,
		"-i",
		source,
		"-map",
		"0:v:0",
		// VP9 4:2:0 needs even dimensions.
		"-vf",
		"scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuva420p",
		"-c:v",
		"libvpx-vp9",
		"-pix_fmt",
		"yuva420p",
		"-b:v",
		"0",
		"-crf",
		"32",
		"-deadline",
		"realtime",
		"-cpu-used",
		"8",
		"-row-mt",
		"1",
		"-auto-alt-ref",
		"0",
		"-g",
		String(PREVIEW_GOP),
		"-an",
		"-sn",
		"-dn",
		"-f",
		"webm",
		output,
	];
}

/** Upper bound for the preview copy of `master`, in bytes. */
export function alphaPreviewBudget(
	master: Pick<Asset, "duration" | "frameRate" | "height" | "width">
): number {
	const frames = Math.ceil(
		Math.max(0, master.duration) * (master.frameRate ?? DEFAULT_FRAME_RATE)
	);
	return Math.min(
		MAX_PREVIEW_BYTES,
		Math.ceil((Math.max(1, frames) * master.width * master.height) / 2) +
			PREVIEW_OVERHEAD_BYTES
	);
}

/**
 * Encode and register the VP9 alpha preview copy of `master` (already in
 * the store), writing the temporary file in the caller's `workDirectory`
 * (which the caller removes). Returns it, or `undefined` when no copy could
 * be made; the master is never touched.
 */
export async function encodeAlphaPreview(
	store: StudioStore,
	master: Asset,
	options: {
		encoders: Readonly<Partial<Record<string, boolean>>>;
		operation: MediaOperation;
		workDirectory: string;
	}
): Promise<Asset | undefined> {
	const { encoders, operation } = options;
	if (master.kind !== "video" || !encoders["libvpx-vp9"]) {
		return;
	}
	const id = crypto.randomUUID();
	const output = join(options.workDirectory, `alpha-preview-${id}.webm`);
	const budget = alphaPreviewBudget(master);
	let reservation: ReturnType<StudioStore["reserveMediaStorage"]> | undefined;
	try {
		reservation = store.reserveMediaStorage(budget);
		await runMedia(alphaPreviewArgs(store.mediaPath(master.id), output), {
			maxOutputBytes: budget,
			outputPath: output,
			signal: operation.signal,
			timeoutMs: operation.remainingMs(),
		});
		operation.check();
		const info = await probe(output, operation.signal);
		operation.check();
		if (info.kind !== "video") {
			return;
		}
		const preview = assetSchema.parse({
			...info,
			createdAt: new Date().toISOString(),
			derivation: "proxy",
			derivedFromAssetId: master.id,
			id,
			name: `${master.name} (preview)`.slice(0, 200),
		});
		await rename(output, store.mediaPath(preview.id));
		store.putAsset(preview);
		reservation.commit();
		return preview;
	} catch {
		return;
	} finally {
		reservation?.release();
		await rm(output, { force: true });
	}
}
