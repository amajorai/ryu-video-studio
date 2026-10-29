import { RENDERABLE_EXPORT_CODECS } from "../../../shared/project.ts";
import { exportContainerSchema } from "../../../shared/schema/export.ts";
import { ffmpegCapabilities } from "../ffmpeg-capabilities.ts";
import { bundledFontsDirectory } from "../fonts.ts";
import { bundledVoiceModelPath } from "../render-stages/audio-environment.ts";
import type { StudioRoute } from "./registry.ts";

export const routes: StudioRoute[] = [
	{
		scope: "root",
		path: "capabilities",
		method: "GET",
		operation: {
			id: "video_studio_capabilities",
			description:
				"Read renderer availability, the export video codecs (codecs: h264, h265, prores, h265-10bit, prores-4444, vp9) and containers (formats: mp4, mov, webm, gif, wav, mp3, aac, png-sequence, jpeg-sequence), media limits, which optional FFmpeg filters and encoders this node provides (filters, encoders, x265TenBit), and whether the bundled title fonts and RNNoise voice isolation model are available (bundledAssets: {fonts, voiceIsolationModel}; both ship inside the sidecar binary), and the at-rest sealing state of the app's content store (sealing). Features that need a missing filter, encoder or asset are unavailable; without the fonts, exported titles use system fonts.",
		},
		handle: async ({ json, store, uploadLimits }) => {
			const probed = await ffmpegCapabilities();
			return json({
				renderer: probed.renderer,
				maxMediaBytes: uploadLimits.maxMediaBytes,
				chunkSize: uploadLimits.chunkSize,
				codecs: [...RENDERABLE_EXPORT_CODECS],
				formats: [...exportContainerSchema.options],
				maxDuration: 7200,
				filters: probed.filters,
				encoders: probed.encoders,
				x265TenBit: probed.x265TenBit,
				bundledAssets: {
					fonts: bundledFontsDirectory() !== null,
					voiceIsolationModel: bundledVoiceModelPath() !== null,
				},
				sealing: { ...store.seal.health() },
			});
		},
	},
];
