import type { Asset } from "../../../shared/project.ts";
import {
	applyReframe,
	reframeRequestSchema,
	reframeTargets,
} from "../../../shared/reframe.ts";
import {
	type ReframeStabilizeClip,
	reframeStabilizeSources,
	swapToStabilized,
} from "../../../shared/reframe-stabilize.ts";
import { trackSubjects } from "../saliency.ts";
import { stabilizeAsset } from "../stabilize.ts";
import { ConflictError } from "../store.ts";
import type { StudioRoute } from "./registry.ts";

const CONFLICT = "The project changed. Reload before reframing.";

export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "reframe",
		method: "POST",
		operation: {
			id: "video_studio_reframe",
			description:
				'Auto reframe the project to another aspect ratio ("9:16", "1:1", "4:5", "16:9", "4:3", "3:4", "2.35:1" or "21:9"). The canvas changes like POST /settings with that aspect (the short edge is kept). mode "track" follows the subject of each clip: a saliency path (frame-difference motion plus edge density, with a mild center prior) sampled at 4 fps is smoothed per shot (smoothing 0-1, default 0.5: a quadratic moving window plus a dead zone) and written as x (or y) keyframes over a fill box (x/y reach ±3, so the pan covers the whole source width for every listed aspect) and a static crop band; the last keyframe of a shot holds until the next scene cut, and the framing of the new shot starts at the cut. A mirrored clip (flipH/flipV) pans the mirrored way so the subject stays framed. mode "center" uses a centred cover crop; mode "blur-fill" fits the whole picture and sets the canvas background to a blur fill (clips off the base track get their own blur fill). Without clipIds, every video or image clip on an unlocked track whose box covers the whole canvas on both axes is reframed; picture-in-picture insets and split-screen cells are left alone. Named clips on a locked track are refused. Each reframed clip has its x, y, scale, scale X/Y and crop (including their keyframes) replaced. Tracking takes one media admission slot. Optional stabilize (low, medium or high, as POST /assets/:id/stabilize) first builds or reuses the stabilized derivative of each target video and swaps the clip onto it like swap-clip-media, so tracking and the crop run on the steadied picture; stills, nested sequences, proxies, already-stabilized media, sources over 10 minutes and multicam clips keep their media and are listed with a reason in `stabilized`. Returns the saved project, the new width and height, per clip the mode used, the pan axis and the keyframe count, and with stabilize the per-clip `stabilized` outcome (assetId or skipped). Requires the current project revision.',
			body: reframeRequestSchema,
		},
		handle: async ({
			currentProject,
			id,
			json,
			mediaSignal,
			request,
			store,
		}) => {
			const input = reframeRequestSchema.parse(await request.json());
			const original = currentProject(id, input.revision, CONFLICT);
			let project = original;
			let stabilized: ReframeStabilizeClip[] | undefined;
			if (input.stabilize) {
				const level = input.stabilize;
				const sources = reframeStabilizeSources(
					reframeTargets(project, store.assets(), input.clipIds),
					store.assets()
				);
				const derivatives = new Map<string, Asset>();
				for (const source of sources) {
					const result = await stabilizeAsset(
						store,
						source,
						{ level },
						{ signal: mediaSignal(request) }
					);
					derivatives.set(source.id, result.asset);
				}
				const swapped = swapToStabilized(
					project,
					store.assets(),
					reframeTargets(project, store.assets(), input.clipIds),
					derivatives
				);
				project = swapped.project;
				stabilized = swapped.clips;
			}
			const assets = store.assets();
			const targets = reframeTargets(project, assets, input.clipIds);
			const tracks =
				input.mode === "track"
					? await trackSubjects(store, targets, mediaSignal(request))
					: new Map();
			if (store.project(id).revision !== original.revision) {
				throw new ConflictError(CONFLICT);
			}
			const result = applyReframe(project, store.assets(), input, tracks);
			const saved = store.save(result.project);
			return json({
				clips: result.clips,
				height: saved.height,
				project: saved,
				stabilized,
				width: saved.width,
			});
		},
	},
];
