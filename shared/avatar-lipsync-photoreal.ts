import { z } from "zod";
import { segmentProjectEnd } from "./avatar-lipsync-source.ts";
import { type Asset, idSchema, type Project, type Segment } from "./project.ts";
import { studioError } from "./studio-error.ts";

/**
 * Photoreal (cloud) lip-sync and talking avatars (G80). The local vector
 * avatar above stays the default; this mode sends real footage to a cloud
 * model, so it needs the sender to confirm the people shown agreed.
 *
 * - `lipsync`: the picture clip (`input_video`) is re-timed to the audio
 *   clip (`input_audio`) over the range where both play, at most 10 s.
 * - `avatar`: one still or frame of the picture clip (`input_images[0]`) is
 *   animated to speak the audio clip, at most 60 s.
 *
 * The result goes back on the picture clip's track over the same range,
 * muted, so the narration or TTS clip stays the audio.
 */
export const photorealModeSchema = z.enum(["lipsync", "avatar"]);
export type PhotorealMode = z.infer<typeof photorealModeSchema>;

/** Longest photoreal range per mode, in seconds. */
export const PHOTOREAL_MAX_SECONDS: Record<PhotorealMode, number> = {
	avatar: 60,
	lipsync: 10,
};

export const photorealInputsRequestSchema = z
	.object({
		mode: photorealModeSchema,
		/** The clip whose picture is sent (a video for lip-sync). */
		pictureClipId: idSchema,
		/** The narration or TTS clip whose audio is sent. */
		audioClipId: idSchema,
		/** The sender confirmed the people shown agreed to this use. */
		consent: z.literal("subjects-agreed"),
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type PhotorealInputsRequest = z.infer<
	typeof photorealInputsRequestSchema
>;

/** What a photoreal request sends and where its result goes. */
export interface PhotorealPlan {
	audio: { assetId: string; end: number; start: number };
	/** Timeline seconds the result covers. */
	duration: number;
	mode: PhotorealMode;
	picture: {
		assetId: string;
		end: number;
		/** Zero-based source frame for avatars (the frame at the range start). */
		frame: number;
		kind: Asset["kind"];
		start: number;
	};
	/** Timeline second the result starts at, on the picture clip's track. */
	start: number;
	track: number;
	/** True when the overlap was longer than the mode allows. */
	truncated: boolean;
}

/**
 * Plan a photoreal request from a picture clip and the audio clip that
 * plays over it. Throws with an editor-facing reason when they do not
 * overlap, play at another speed, or the picture cannot be sent.
 */
export function photorealPlan(
	project: Pick<Project, "segments">,
	assets: readonly Asset[],
	input: Pick<PhotorealInputsRequest, "audioClipId" | "mode" | "pictureClipId">
): PhotorealPlan {
	const clip = (id: string, label: string) => {
		const segment = project.segments.find((item) => item.id === id);
		const asset = segment
			? assets.find((item) => item.id === segment.assetId)
			: undefined;
		if (!(segment && asset)) {
			throw studioError((text) => new Error(text), "avatar.clip-missing", {
				label,
			});
		}
		if (segment.speed !== 1 || segment.speedCurve) {
			throw new Error(
				`Set the ${label} clip to 100% speed before sending it to a photoreal model.`
			);
		}
		return { asset, segment };
	};
	const picture = clip(input.pictureClipId, "picture");
	const audio = clip(input.audioClipId, "audio");
	if (picture.asset.kind === "audio") {
		throw new Error("Choose a video or still clip for the picture.");
	}
	if (input.mode === "lipsync" && picture.asset.kind !== "video") {
		throw new Error(
			"Lip-sync needs a video clip of the speaker; use a talking avatar for a still."
		);
	}
	if (!(audio.asset.kind === "audio" || audio.asset.hasAudio)) {
		throw new Error("The audio clip has no sound to speak.");
	}
	const pictureEnd = segmentProjectEnd(picture.segment);
	const audioEnd = segmentProjectEnd(audio.segment);
	const start = Math.max(picture.segment.start, audio.segment.start);
	const overlapEnd = Math.min(pictureEnd, audioEnd);
	if (!(overlapEnd - start >= 0.1)) {
		throw new Error("The audio clip does not play over the picture clip.");
	}
	const end = Math.min(overlapEnd, start + PHOTOREAL_MAX_SECONDS[input.mode]);
	const source = (segment: Segment) => ({
		end: segment.sourceIn + (end - segment.start),
		start: segment.sourceIn + (start - segment.start),
	});
	const pictureRange = source(picture.segment);
	const rate =
		picture.asset.frameRate && picture.asset.frameRate > 0
			? picture.asset.frameRate
			: 30;
	return {
		audio: { assetId: audio.asset.id, ...source(audio.segment) },
		duration: end - start,
		mode: input.mode,
		picture: {
			assetId: picture.asset.id,
			...pictureRange,
			frame:
				picture.asset.kind === "video"
					? Math.floor(pictureRange.start * rate + 1e-6)
					: 0,
			kind: picture.asset.kind,
		},
		start,
		track: picture.segment.track,
		truncated: end < overlapEnd - 1e-6,
	};
}
