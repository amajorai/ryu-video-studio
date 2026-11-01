import { swapClipMedia } from "../../../shared/clip-edits.ts";
import {
	aiEditRequest,
	type GenerationJob,
	type GenerationProvenance,
	generationProvenance,
	referenceImageIds,
	regenerationRequest,
	requestInputImageIds,
} from "../../../shared/generation.ts";
import {
	type Asset,
	type Project,
	type Segment,
	trackSettingFor,
	validateProject,
} from "../../../shared/project.ts";
import {
	bridgeSupports,
	type GenerationServices,
	runGeneration,
	type SavedGeneration,
} from "./media-bridge.ts";

/** Seconds a video frame is held when it is edited as a still. */
export const EDIT_FRAME_HOLD_SECONDS = 2;

/** Which AI actions the inspector offers for a clip. */
export interface AiEditAvailability {
	/** Edit the clip's still image in place (image clips). */
	edit: boolean;
	/** Insert a freeze at the playhead and edit it (video clips). */
	editFrame: boolean;
	provenance?: GenerationProvenance;
	/** Re-run the request that produced the clip's media. */
	regenerate: boolean;
}

/** What AI editing applies to `segment`, given its media and generation history. */
export function aiEditAvailability(
	segment: Segment,
	assets: readonly Asset[],
	jobs: readonly GenerationJob[]
): AiEditAvailability {
	const asset = assets.find((candidate) => candidate.id === segment.assetId);
	if (!asset || asset.sequenceProjectId) {
		return { edit: false, editFrame: false, regenerate: false };
	}
	const provenance = generationProvenance(asset, jobs);
	const availability: AiEditAvailability = {
		edit: asset.kind === "image",
		editFrame: asset.kind === "video" && !segment.multicamGroupId,
		regenerate:
			Boolean(provenance) && !provenance?.task && !segment.multicamGroupId,
	};
	if (provenance) {
		availability.provenance = provenance;
	}
	return availability;
}

/** The library assets named by `ids`, in order; throws when one is missing. */
export function assetsById(
	assets: readonly Asset[],
	ids: readonly string[]
): Asset[] {
	return ids.map((id) => {
		const found = assets.find((asset) => asset.id === id);
		if (!found) {
			throw new Error(
				"An input image for this request is no longer in the library."
			);
		}
		return found;
	});
}

/**
 * Swap a timeline clip's media for `asset`, keeping its trims, transform,
 * and grade. Resolves false when the swap was refused (for example, a stale
 * revision or a clip that no longer exists).
 */
export type SwapClipMedia = (clipId: string, asset: Asset) => Promise<boolean>;

/**
 * Put still `asset` into image clip `clipId`, keeping the clip exactly as
 * authored: a still has no real source bound, so its `sourceIn`/`sourceOut`
 * (and so its length on the timeline) stay unchanged. The shared
 * `swapClipMedia` edit clamps to the replacement's nominal duration, which
 * would shorten stills longer than an uploaded image's default length.
 */
export function swapStillMedia(
	project: Project,
	assets: readonly Asset[],
	clipId: string,
	asset: Asset
): Project {
	if (asset.kind !== "image") {
		throw new Error("Only still images keep a clip's length when swapped.");
	}
	const current = project.segments.find((segment) => segment.id === clipId);
	if (!current) {
		throw new Error("Clip not found on this timeline.");
	}
	if (trackSettingFor(project, current.track).locked) {
		throw new Error("Unlock the clip track before editing its properties.");
	}
	if (current.multicamGroupId) {
		throw new Error("Ungroup the multicam session before swapping its media.");
	}
	const library = assets.some((candidate) => candidate.id === asset.id)
		? [...assets]
		: [...assets, asset];
	const previous = library.find(
		(candidate) => candidate.id === current.assetId
	);
	if (previous && previous.kind !== "image") {
		throw new Error("Only still image clips keep their length when swapped.");
	}
	return validateProject(
		{
			...project,
			segments: project.segments.map((segment) =>
				segment.id === clipId ? { ...segment, assetId: asset.id } : segment
			),
		},
		library
	);
}

/**
 * The swap AI media needs: stills replace stills without touching the
 * clip's trims; video and audio go through the shared swap-clip-media edit,
 * which keeps the slot and clamps to the new media's real length.
 */
export function swapGeneratedMedia(
	project: Project,
	assets: readonly Asset[],
	clipId: string,
	asset: Asset
): Project {
	const current = project.segments.find((segment) => segment.id === clipId);
	const previous = assets.find(
		(candidate) => candidate.id === current?.assetId
	);
	if (asset.kind === "image" && previous?.kind === "image") {
		return swapStillMedia(project, assets, clipId, asset);
	}
	const library = assets.some((candidate) => candidate.id === asset.id)
		? [...assets]
		: [...assets, asset];
	return swapClipMedia(project, library, {
		assetId: asset.id,
		clipId,
		revision: project.revision,
	});
}

/** Result of an AI edit or regeneration that saved media. */
export interface AiEditResult extends SavedGeneration {
	/** The clip that received the new media, when the swap succeeded. */
	swappedClipId?: string;
}

interface EditContext {
	assets: readonly Asset[];
	newId?: () => string;
	projectId: string;
	services: GenerationServices;
	swap: SwapClipMedia;
}

async function saveAndSwap(
	context: EditContext,
	clipId: string,
	run: () => Promise<SavedGeneration>
): Promise<AiEditResult> {
	const saved = await run();
	const swapped = await context.swap(clipId, saved.asset);
	return swapped ? { ...saved, swappedClipId: clipId } : saved;
}

/**
 * Edit an image clip's still with an image model: the clip's own image is
 * sent first in `input_images`, followed by up to four library references.
 * The result is saved to the library and swapped into the clip.
 */
export async function aiEditClip(
	context: EditContext & {
		model?: string;
		prompt: string;
		provider?: string;
		purpose?: "ai-edit" | "edit-frame";
		referenceIds?: readonly string[];
		segment: Segment;
	}
): Promise<AiEditResult> {
	const source = context.assets.find(
		(asset) => asset.id === context.segment.assetId
	);
	if (source?.kind !== "image") {
		throw new Error("AI edit works on still image clips.");
	}
	if (!context.prompt.trim()) {
		throw new Error("Describe the change you want before editing.");
	}
	const references = referenceImageIds(
		context.assets,
		context.referenceIds ?? [],
		source.id
	);
	const generation = aiEditRequest({
		id: (context.newId ?? crypto.randomUUID.bind(crypto))(),
		model: context.model,
		projectId: context.projectId,
		prompt: context.prompt.trim(),
		provider: context.provider,
		purpose: context.purpose ?? "ai-edit",
		referenceAssetIds: references,
		sourceAssetId: source.id,
	});
	return await saveAndSwap(context, context.segment.id, () =>
		runGeneration(
			context.services,
			generation,
			assetsById(context.assets, requestInputImageIds(generation))
		)
	);
}

/** Re-run the request that produced a clip's media and swap the new result in. */
export async function regenerateClip(
	context: EditContext & {
		jobs: readonly GenerationJob[];
		segment: Segment;
	}
): Promise<AiEditResult> {
	const asset = context.assets.find(
		(candidate) => candidate.id === context.segment.assetId
	);
	const provenance = asset
		? generationProvenance(asset, context.jobs)
		: undefined;
	if (!(asset && provenance)) {
		throw new Error("This clip's media has no generation request to repeat.");
	}
	const generation = regenerationRequest(provenance, {
		assetId: asset.id,
		id: (context.newId ?? crypto.randomUUID.bind(crypto))(),
		projectId: context.projectId,
	});
	return await saveAndSwap(context, context.segment.id, () =>
		runGeneration(
			context.services,
			generation,
			assetsById(context.assets, requestInputImageIds(generation))
		)
	);
}

/**
 * The freeze still a freeze-frame edit inserted: the one new segment whose
 * media did not appear on the timeline before. Split pieces of existing clips
 * also get new ids but keep their media, so they are not mistaken for it.
 */
export function insertedStillSegment(
	before: Pick<Project, "segments">,
	after: Pick<Project, "segments">
): Segment | undefined {
	const ids = new Set(before.segments.map((segment) => segment.id));
	const media = new Set(before.segments.map((segment) => segment.assetId));
	const inserted = after.segments.filter(
		(segment) => !(ids.has(segment.id) || media.has(segment.assetId))
	);
	return inserted.length === 1 ? inserted[0] : undefined;
}

/** The freeze still a freeze-frame edit inserted, with its library asset. */
export interface InsertedStill {
	assets: readonly Asset[];
	segment: Segment;
}

/**
 * "Edit frame as still": freeze the video clip at the playhead (the freeze
 * inherits the clip's transform and grade), then AI-edit that still and
 * swap the result into the freeze. The budget is preflighted first so a
 * refusal leaves the timeline untouched; when the model fails after the
 * freeze, the error says the freeze stays as an ordinary, undoable still.
 */
export async function editFrameAsStill(
	context: EditContext & {
		freeze: () => Promise<InsertedStill | undefined>;
		model?: string;
		prompt: string;
		provider?: string;
		referenceIds?: readonly string[];
		segment: Segment;
	}
): Promise<AiEditResult> {
	const source = context.assets.find(
		(asset) => asset.id === context.segment.assetId
	);
	if (source?.kind !== "video") {
		throw new Error("Edit frame as still works on video clips.");
	}
	if (!context.prompt.trim()) {
		throw new Error("Describe the change you want before editing.");
	}
	if (!bridgeSupports(context.services.bridge, "image")) {
		throw new Error(
			"Generation is unavailable in this host. Open the app in Ryu with media permissions and a configured model."
		);
	}
	// Everything that can refuse predictably is checked before the freeze
	// changes the timeline: references, and the project budget.
	referenceImageIds(context.assets, context.referenceIds ?? []);
	await context.services.admit(context.projectId, "image");
	const still = await context.freeze();
	if (!still) {
		throw new Error("The freeze frame could not be added at the playhead.");
	}
	try {
		return await aiEditClip({
			...context,
			assets: still.assets,
			purpose: "edit-frame",
			segment: still.segment,
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : "AI edit failed.";
		throw new Error(
			`${reason} The ${EDIT_FRAME_HOLD_SECONDS}s freeze frame stays on the timeline as a plain still; undo to remove it.`
		);
	}
}
