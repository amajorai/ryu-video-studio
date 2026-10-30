import {
	renderRequestSchema,
	requiredEncoders,
} from "../../../shared/render-options.ts";
import { ffmpegCapabilities } from "../ffmpeg-capabilities.ts";
import { planExport } from "../render-queue.ts";
import type { StudioRoute } from "./registry.ts";

/**
 * Encoders the plan needs that this FFmpeg build lacks, plus 10-bit HEVC,
 * which needs a libx265 built with high bit depth. When FFmpeg cannot be
 * probed at all, nothing is reported here and the render reports its own
 * failure, as it always has.
 */
async function missingEncoders(
	encoders: readonly string[],
	tenBit: boolean
): Promise<string[]> {
	const capabilities = await ffmpegCapabilities();
	if (!capabilities.renderer) {
		return [];
	}
	const available: Record<string, boolean> = capabilities.encoders;
	const missing = encoders.filter((encoder) => available[encoder] === false);
	if (tenBit && !capabilities.x265TenBit) {
		missing.push("libx265 (10-bit)");
	}
	return missing;
}

export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "render",
		method: "POST",
		operation: {
			id: "video_studio_render",
			description:
				"Render the saved timeline. An empty body exports the whole timeline with the project codec and export settings. Optional body: revision (refuse unless current), range {start,end} in timeline seconds, audioOnly (WAV, MP3 or AAC), codec (h264, h265, h265-10bit, prores, prores-4444, vp9), overrides (any export setting: container mp4/mov/webm/gif/wav/mp3/aac/png-sequence/jpeg-sequence, includeAudio, alpha, rateControl crf/cbr/vbr, crf, bitrateKbps, audioBitrateKbps, encoderPreset, outputWidth+outputHeight, gifFps, gifWidth, hdr auto/off, platformPreset youtube-1080p/youtube-4k/youtube-shorts/instagram-reels/tiktok/x/linkedin/podcast-audio), outputResolution (720p, 1080p, 2k or 4k: scales the canvas short side to 720, 1080, 1440 or 2160 px and keeps its aspect, replacing a stored or preset size; not combinable with outputWidth+outputHeight) and saveAsAsset (import the result into the library). Formats whose encoder this FFmpeg build lacks are refused. Approval gates are enforced. Poll the returned job ID; the job's export field lists the file type, warnings and preset metadata.",
			body: renderRequestSchema,
		},
		handle: async ({
			currentProject,
			id,
			json,
			optionalBody,
			queue,
			request,
			store,
		}) => {
			const body = renderRequestSchema.parse(await optionalBody(request));
			const project =
				body.revision === undefined
					? store.project(id)
					: currentProject(
							id,
							body.revision,
							"The project changed since this export was requested. Export the current revision."
						);
			const { plan } = planExport(project, store.assets(), body);
			const missing = await missingEncoders(
				requiredEncoders(plan),
				plan.videoCodec === "h265-10bit"
			);
			if (missing.length) {
				throw new Error(
					`This FFmpeg build cannot encode ${plan.file.label}: missing ${missing.join(", ")}.`
				);
			}
			return json(queue.start(project, body), 202);
		},
	},
];
