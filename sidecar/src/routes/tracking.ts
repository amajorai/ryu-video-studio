import {
	applyTrack,
	canvasFrame,
	canvasTrackPath,
	clipContent,
	sourceRegionToCanvas,
	summarizeTrack,
	trackRequestSchema,
} from "../../../shared/tracking.ts";
import { ConflictError } from "../store.ts";
import { LOST_CONFIDENCE, trackClip, trackedClip } from "../tracker.ts";
import type { StudioRoute } from "./registry.ts";

const STALE = "The project changed. Reload before tracking motion.";

export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "track",
		method: "POST",
		operation: {
			id: "video_studio_track_motion",
			description:
				'Track a subject in a video clip and make something follow it. `roi` is the subject\'s rectangle (top-left `x`/`y`, `width`/`height`) on the frame at project time `time`, as canvas fractions (or source-frame fractions with `roiSpace: "source"`). Frames from `time` to the clip end (or `duration` seconds, at most 120) are decoded in grayscale at up to 640 px and 30 fps and matched by normalized cross-correlation with a ±10% scale search and drift-guarded template updates; a lost subject holds its last position. `target: {kind: "title"|"graphic"|"clip", id}` writes `x`/`y` keyframes (plus `scale` for titles and clips, such as stickers), replacing earlier keyframes of those channels; `target: {createRegion: "blur"|"mosaic"}` adds an adjustment layer on the clip\'s track whose rectangle mask follows the subject. The path is decimated to at most 200 keyframes. Returns `target`, `keyframes`, `samples`, `lostFrames`, mean `confidence` and the tracked `range`. Revision-checked; takes one media admission slot.',
			body: trackRequestSchema,
		},
		handle: async ({
			currentProject,
			id,
			json,
			mediaSignal,
			request,
			store,
		}) => {
			const input = trackRequestSchema.parse(await request.json());
			const project = currentProject(id, input.revision, STALE);
			const run = await trackClip(store, project, input, mediaSignal(request));
			const latest = store.project(id);
			if (latest.revision !== input.revision) {
				throw new ConflictError(STALE);
			}
			const assets = store.assets();
			const { asset, segment } = trackedClip(latest, assets, input.clipId);
			const canvas = canvasFrame(latest);
			const content = clipContent(asset, canvas);
			const region =
				input.roiSpace === "source"
					? sourceRegionToCanvas(
							segment,
							content,
							canvas,
							run.sourceRegion,
							input.time - segment.start
						)
					: input.roi;
			const result = applyTrack(latest, assets, {
				path: canvasTrackPath(
					segment,
					content,
					canvas,
					run.samples,
					run.window.end
				),
				region,
				segment,
				target: input.target,
			});
			const saved = store.save(result.project);
			return json({
				...summarizeTrack(run.samples, LOST_CONFIDENCE),
				keyframes: result.keyframes,
				project: saved,
				range: {
					end: run.window.end,
					start: run.samples[0]?.time ?? run.window.start,
				},
				target: result.target,
			});
		},
	},
];
