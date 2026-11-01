import { z } from "zod";
import { MAX_TRACK_INDEX } from "../limits.ts";
import {
	type Asset,
	newSegment,
	type Project,
	type Segment,
	segmentDuration,
	trackSettingFor,
} from "../project.ts";
import type { ClipAnimation } from "../schema/transition.ts";

/** Seconds a newly placed sticker stays on screen. */
export const STICKER_CLIP_SECONDS = 4;
/** Scale of a newly placed sticker relative to the canvas fit. */
export const STICKER_CLIP_SCALE = 0.35;

export const STICKER_TRACKS_BUSY_MESSAGE =
	"Every track is busy at the playhead. Free a track or move the playhead, then add the sticker again.";

export const STICKER_ANIMATION_PRESETS = [
	"none",
	"pop",
	"fade",
	"bounce",
	"zoom",
	"slide-up",
	"spin",
	"float",
] as const;
export type StickerAnimationPreset = (typeof STICKER_ANIMATION_PRESETS)[number];
export const stickerAnimationPresetSchema = z.enum(STICKER_ANIMATION_PRESETS);

/** Longest a placed sticker may stay on screen, in seconds. */
export const STICKER_MAX_SECONDS = 600;

export const STICKER_ANIMATION_LABELS: Readonly<
	Record<StickerAnimationPreset, string>
> = {
	bounce: "Bounce in, fade out",
	fade: "Fade in and out",
	float: "Pop in, float, fade out",
	none: "No animation",
	pop: "Pop in, fade out",
	"slide-up": "Slide up in and out",
	spin: "Spin in and out",
	zoom: "Zoom in and out",
};

/** In/out clip animation (V10 `animation` fields) for a preset. */
export function stickerAnimation(
	preset: StickerAnimationPreset
): ClipAnimation | undefined {
	switch (preset) {
		case "none":
			return;
		case "pop":
			return { in: "pop", inDuration: 0.4, out: "fade", outDuration: 0.3 };
		case "fade":
			return { in: "fade", inDuration: 0.4, out: "fade", outDuration: 0.4 };
		case "bounce":
			return { in: "bounce", inDuration: 0.6, out: "fade", outDuration: 0.3 };
		case "zoom":
			return { in: "zoom", inDuration: 0.4, out: "zoom", outDuration: 0.4 };
		case "slide-up":
			return {
				in: "slide-up",
				inDuration: 0.5,
				out: "slide-up",
				outDuration: 0.5,
			};
		case "spin":
			return { in: "spin", inDuration: 0.5, out: "spin", outDuration: 0.5 };
		case "float":
			return {
				in: "pop",
				inDuration: 0.4,
				loop: "float",
				loopPeriod: 2,
				out: "fade",
				outDuration: 0.3,
			};
		default:
			return;
	}
}

const overlaps = (segment: Segment, start: number, end: number) =>
	segment.start < end - 1e-6 &&
	segment.start + segmentDuration(segment) > start + 1e-6;

/**
 * The track a sticker spanning `[start, start + duration)` goes on: the
 * lowest unlocked track with no clip in that span that is above every visual
 * (non-audio) clip there, so the sticker draws on top. Track 0 (the main
 * track) is never used. Null when every track is taken.
 */
export function stickerTrack(
	project: Pick<Project, "segments" | "trackSettings">,
	assets: readonly Pick<Asset, "id" | "kind">[],
	start: number,
	duration: number
): number | null {
	const end = start + duration;
	const kinds = new Map(assets.map((asset) => [asset.id, asset.kind]));
	const occupied = new Set<number>();
	let topVisual = 0;
	for (const segment of project.segments) {
		if (!overlaps(segment, start, end)) {
			continue;
		}
		occupied.add(segment.track);
		if (kinds.get(segment.assetId) !== "audio") {
			topVisual = Math.max(topVisual, segment.track);
		}
	}
	for (let track = topVisual + 1; track <= MAX_TRACK_INDEX; track += 1) {
		if (!(occupied.has(track) || trackSettingFor(project, track).locked)) {
			return track;
		}
	}
	return null;
}

/** Body of `POST /projects/:id/stickers` (agents place bundled stickers). */
export const stickerPlacementRequestSchema = z
	.object({
		/** Seconds on screen; defaults to `STICKER_CLIP_SECONDS`. */
		duration: z.number().finite().min(0.1).max(STICKER_MAX_SECONDS).optional(),
		/** In/out animation preset; defaults to "none". */
		preset: stickerAnimationPresetSchema.optional(),
		revision: z.number().int().nonnegative(),
		/** Catalog id from `GET /stickers`, for example `emoji-1f600`. */
		stickerId: z.string().regex(/^[a-z0-9-]+$/, "Invalid sticker id."),
		/** Project time the sticker starts at; defaults to 0. */
		time: z.number().finite().min(0).optional(),
	})
	.strict();
export type StickerPlacementRequest = z.infer<
	typeof stickerPlacementRequestSchema
>;

/**
 * Add an imported sticker image as a clip at `time` on the first free track
 * above the picture, scaled down and with the chosen animation preset.
 */
export function placeSticker(
	project: Project,
	assets: readonly Pick<Asset, "id" | "kind">[],
	asset: Asset,
	time: number,
	preset: StickerAnimationPreset = "none",
	duration: number = STICKER_CLIP_SECONDS
): { project: Project; segment: Segment } {
	if (asset.kind !== "image") {
		throw new Error("Stickers are placed as image clips.");
	}
	const start = Math.max(0, Number.isFinite(time) ? time : 0);
	const seconds =
		Number.isFinite(duration) && duration > 0
			? Math.min(duration, STICKER_MAX_SECONDS)
			: STICKER_CLIP_SECONDS;
	const track = stickerTrack(project, [...assets, asset], start, seconds);
	if (track === null) {
		throw new Error(STICKER_TRACKS_BUSY_MESSAGE);
	}
	const segment: Segment = {
		...newSegment(asset, start, track),
		scale: STICKER_CLIP_SCALE,
		sourceOut: seconds,
	};
	const animation = stickerAnimation(preset);
	if (animation) {
		segment.animation = animation;
	}
	return {
		project: { ...project, segments: [...project.segments, segment] },
		segment,
	};
}
