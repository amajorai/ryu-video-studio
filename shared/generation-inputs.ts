/**
 * Bounded media extracts sent to generation models as reference inputs.
 *
 * The host bridge carries inputs inline as `data:` URIs (40 MiB of wire
 * characters for one request), so the sidecar prepares small, predictable
 * files instead of sending library media as it is:
 *
 * - **clip**: a source range of at most `MAX_INPUT_CLIP_SECONDS`, scaled to at
 *   most 720 lines, H.264 CRF 28, AAC audio when the source has any;
 * - **frame**: one exact source frame as PNG (or a JPEG for vision models);
 * - **audio**: a source range as AAC in MP4, for lip-sync and avatars.
 *
 * Each extract is size-checked so a request is refused locally, with a
 * reason, before anything is sent to the host.
 */
import { z } from "zod";
import type { Asset } from "./project.ts";

/** Longest clip sent as `input_video`. */
export const MAX_INPUT_CLIP_SECONDS = 10;
/** Tallest clip sent as `input_video` (and widest for portrait sources). */
export const MAX_INPUT_CLIP_LINES = 720;
/** H.264 constant-quality level for input clips. */
export const INPUT_CLIP_CRF = 28;
/**
 * Largest encoded extract. Base64 grows it by a third; two inputs (a clip
 * and its audio) then stay inside the bridge's 40 MiB request budget.
 */
export const MAX_INPUT_CLIP_BYTES = 24 * 1024 * 1024;
/** Longest audio sent as `input_audio`. */
export const MAX_INPUT_AUDIO_SECONDS = 120;
export const MAX_INPUT_AUDIO_BYTES = 6 * 1024 * 1024;
/** Largest still sent as an input frame. */
export const MAX_INPUT_FRAME_BYTES = 12 * 1024 * 1024;
/** Shots keyframes sent to vision models are this tall (or wide). */
export const KEYFRAME_EDGE = 384;
/** Inputs older than this are discarded even when never read. */
export const GENERATION_INPUT_TTL_MS = 15 * 60_000;

const seconds = z.number().finite().min(0).max(86_400);

export const generationInputRequestSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("clip"),
			start: seconds,
			end: seconds,
			/** Keep the source audio track (lip-sync wants the picture only). */
			audio: z.boolean().default(true),
		})
		.strict(),
	z
		.object({
			kind: z.literal("frame"),
			/** Zero-based source frame index at the asset's frame rate. */
			frame: z.number().int().min(0).max(100_000_000),
			format: z.enum(["png", "jpeg"]).default("png"),
		})
		.strict(),
	z
		.object({
			kind: z.literal("audio"),
			start: seconds,
			end: seconds,
		})
		.strict(),
]);
export type GenerationInputRequest = z.infer<
	typeof generationInputRequestSchema
>;
export type GenerationInputRequestInput = z.input<
	typeof generationInputRequestSchema
>;

/** A prepared extract; read its bytes with `GET /generation-inputs/:id/data`. */
export const generationInputSchema = z
	.object({
		id: z.uuid(),
		mediaType: z.enum(["video/mp4", "image/png", "image/jpeg", "audio/mp4"]),
		size: z.number().int().positive(),
		/** Source seconds covered (clips and audio), or the frame's time. */
		start: z.number().finite().min(0),
		end: z.number().finite().min(0),
		width: z.number().int().min(0).optional(),
		height: z.number().int().min(0).optional(),
		/** The exact frame index extracted (frames only). */
		frame: z.number().int().min(0).optional(),
	})
	.strict();
export type GenerationInput = z.infer<typeof generationInputSchema>;

/** Frame rate used to address frames of `asset` (30 when unknown). */
export function assetFrameRate(asset: Pick<Asset, "frameRate">): number {
	const rate = asset.frameRate;
	return rate && Number.isFinite(rate) && rate > 0 ? rate : 30;
}

/** Number of whole frames in `asset`'s video. */
export function assetFrameCount(
	asset: Pick<Asset, "duration" | "frameRate">
): number {
	return Math.max(1, Math.round(asset.duration * assetFrameRate(asset)));
}

/** Tolerance so a time that lands on a frame edge picks that frame. */
const EDGE = 1e-6;

/** Index of the frame shown at source time `time`. */
export function frameAtTime(
	asset: Pick<Asset, "duration" | "frameRate">,
	time: number
): number {
	const index = Math.floor(time * assetFrameRate(asset) + EDGE);
	return Math.min(assetFrameCount(asset) - 1, Math.max(0, index));
}

/** Index of the last frame shown before source time `end`. */
export function lastFrameBefore(
	asset: Pick<Asset, "duration" | "frameRate">,
	end: number
): number {
	const index = Math.ceil(end * assetFrameRate(asset) - EDGE) - 1;
	return Math.min(assetFrameCount(asset) - 1, Math.max(0, index));
}

/**
 * Seek time that makes FFmpeg's accurate seek output exactly frame `index`:
 * a quarter frame before its presentation time, so rounding in the
 * container timebase can never land on the previous or next frame.
 */
export function frameSeekTime(
	asset: Pick<Asset, "frameRate">,
	index: number
): number {
	return Math.max(0, (index - 0.25) / assetFrameRate(asset));
}

/**
 * The clip range actually sent: clamped to the media and capped at
 * `MAX_INPUT_CLIP_SECONDS` from its start. Throws when nothing is left.
 */
export function boundedClipRange(
	asset: Pick<Asset, "duration">,
	start: number,
	end: number,
	maxSeconds = MAX_INPUT_CLIP_SECONDS
): { end: number; start: number; truncated: boolean } {
	const from = Math.max(0, Math.min(start, asset.duration));
	const wanted = Math.min(end, asset.duration);
	const to = Math.min(wanted, from + maxSeconds);
	if (!(to - from >= 0.1)) {
		throw new Error("Choose at least 0.1 s of the clip to send.");
	}
	return { end: to, start: from, truncated: to < wanted - 1e-6 };
}

/**
 * Even output size that fits `MAX_INPUT_CLIP_LINES` on the short side and
 * keeps the aspect ratio; sources already small enough keep their size.
 */
export function boundedClipSize(
	width: number,
	height: number,
	maxLines = MAX_INPUT_CLIP_LINES
): { height: number; width: number } {
	const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
	if (!(width > 0 && height > 0)) {
		return { height: maxLines, width: even((maxLines * 16) / 9) };
	}
	const short = Math.min(width, height);
	const scale = short > maxLines ? maxLines / short : 1;
	return { height: even(height * scale), width: even(width * scale) };
}
