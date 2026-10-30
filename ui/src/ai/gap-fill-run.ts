import {
	gapFillFrameTimes,
	gapFillGenerationRequest,
	gapFillNeighbors,
} from "../../../shared/gap-fill.ts";
import type { Asset, Project } from "../../../shared/project.ts";
import {
	bridgeSupports,
	type GenerationServices,
	runGeneration,
	type SavedGeneration,
} from "./media-bridge.ts";

/** Capture the composited timeline frame at `time` as a library still. */
export type CaptureFrame = (time: number, name: string) => Promise<Asset>;

/** Body of `POST /projects/:id/gap-fill`, without the revision. */
export interface GapFillPlacement {
	afterClipId: string;
	assetId: string;
}

/**
 * Place the bridge through the gap-fill route. Resolves the new clip's id,
 * or undefined when the edit was refused (for example, a stale revision).
 */
export type PlaceGapFill = (
	placement: GapFillPlacement
) => Promise<string | undefined>;

export interface GapFillRunResult extends SavedGeneration {
	/** The captured outgoing and incoming frames, in that order. */
	frames: [Asset, Asset];
	/** The bridge clip, when it was placed. */
	placedClipId?: string;
}

export interface GapFillRunContext {
	assets: readonly Asset[];
	capture: CaptureFrame;
	clipId: string;
	direction?: string;
	model?: string;
	newId?: () => string;
	place: PlaceGapFill;
	/** The saved timeline the frames are captured from. */
	project: Project;
	provider?: string;
	services: GenerationServices;
}

/** The capture-frame route caps asset names at this many characters. */
export const MAX_CAPTURE_NAME_LENGTH = 200;

/**
 * Library name for a captured neighbour frame. The project title is trimmed
 * so the whole name fits the capture-frame route's name limit.
 */
export function gapFillFrameName(
	title: string,
	side: "incoming" | "outgoing"
): string {
	const suffix = ` gap fill ${side} frame`;
	const room = MAX_CAPTURE_NAME_LENGTH - suffix.length;
	return `${title.trim().slice(0, room).trimEnd()}${suffix}`.trim();
}

/**
 * AI transition gap fill: capture the outgoing clip's last frame and the
 * incoming clip's first frame, ask the host image model for a still that
 * bridges them (both frames as `input_images`), save it to the library, and
 * place it between the clips with dissolves and a Ken Burns push.
 *
 * Everything that can refuse predictably (no following clip, no image
 * bridge, the project budget) is checked before frames are captured, so a
 * refusal adds nothing to the library.
 */
export async function runGapFill(
	context: GapFillRunContext
): Promise<GapFillRunResult> {
	const neighbors = gapFillNeighbors(
		context.project,
		context.assets,
		context.clipId
	);
	if (!bridgeSupports(context.services.bridge, "image")) {
		throw new Error(
			"Generation is unavailable in this host. Open the app in Ryu with media permissions and a configured image model."
		);
	}
	await context.services.admit(context.project.id, "image");
	const times = gapFillFrameTimes(neighbors, context.project.fps);
	const previousFrame = await context.capture(
		times.previous,
		gapFillFrameName(context.project.title, "outgoing")
	);
	const nextFrame = await context.capture(
		times.next,
		gapFillFrameName(context.project.title, "incoming")
	);
	const generation = gapFillGenerationRequest({
		direction: context.direction,
		id: (context.newId ?? crypto.randomUUID.bind(crypto))(),
		model: context.model,
		nextFrameAssetId: nextFrame.id,
		previousFrameAssetId: previousFrame.id,
		projectId: context.project.id,
		provider: context.provider,
	});
	const saved = await runGeneration(context.services, generation, [
		previousFrame,
		nextFrame,
	]);
	const placedClipId = await context.place({
		afterClipId: context.clipId,
		assetId: saved.asset.id,
	});
	const result: GapFillRunResult = {
		...saved,
		frames: [previousFrame, nextFrame],
	};
	if (placedClipId) {
		result.placedClipId = placedClipId;
	}
	return result;
}
