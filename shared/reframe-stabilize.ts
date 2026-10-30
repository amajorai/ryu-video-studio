/**
 * Auto reframe with image stabilization: before tracking, each target video
 * clip is moved onto a stabilized derivative of its media (the Media tools
 * "Stabilize" derivative, reused when it already exists), the way
 * `swap-clip-media` swaps a clip, so the subject path and the crop are
 * computed on the steadied picture. Stills, nested sequences, proxies,
 * media that is already stabilized, sources longer than the derivative limit
 * and multicam-grouped clips keep their media and are reported as skipped.
 */
import { swapClipMedia } from "./clip-edits.ts";
import { MAX_DERIVATIVE_SECONDS } from "./derivatives.ts";
import type { Asset, Project, Segment } from "./project.ts";

/** One target clip's stabilization outcome. */
export interface ReframeStabilizeClip {
	/** The stabilized derivative the clip now plays. */
	assetId?: string;
	clipId: string;
	/** Why the clip kept its media. */
	skipped?: string;
}

/** The project with target clips on stabilized media, and each outcome. */
export interface ReframeStabilizeResult {
	clips: ReframeStabilizeClip[];
	project: Project;
}

/** Why a clip's media cannot be stabilized for a reframe, if it cannot. */
export function reframeStabilizeSkip(
	segment: Pick<Segment, "multicamGroupId">,
	asset: Asset | undefined
): string | undefined {
	if (asset?.kind !== "video") {
		return "Only video is stabilized.";
	}
	if (asset.derivation === "stabilize") {
		return "Already stabilized.";
	}
	if (asset.sequenceProjectId) {
		return "Nested sequences are not stabilized.";
	}
	if (asset.derivation === "proxy") {
		return "Preview proxies are not stabilized.";
	}
	if (!(asset.duration > 0) || asset.duration > MAX_DERIVATIVE_SECONDS) {
		return `Only media up to ${MAX_DERIVATIVE_SECONDS / 60} minutes is stabilized.`;
	}
	if (asset.width < 16 || asset.height < 16) {
		return "The video is too small to stabilize.";
	}
	if (segment.multicamGroupId) {
		return "Multicam clips keep their media.";
	}
	return undefined;
}

/** Distinct source media of `targets` that a reframe stabilizes. */
export function reframeStabilizeSources(
	targets: readonly Segment[],
	assets: readonly Asset[]
): Asset[] {
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	const sources = new Map<string, Asset>();
	for (const segment of targets) {
		const asset = byId.get(segment.assetId);
		if (asset && !reframeStabilizeSkip(segment, asset)) {
			sources.set(asset.id, asset);
		}
	}
	return [...sources.values()];
}

/**
 * Swap each target clip onto the stabilized derivative of its media.
 * `derivatives` maps a source asset id to its derivative; clips without one
 * keep their media and are reported with the reason.
 */
export function swapToStabilized(
	project: Project,
	assets: readonly Asset[],
	targets: readonly Segment[],
	derivatives: ReadonlyMap<string, Asset>
): ReframeStabilizeResult {
	const library = [...assets];
	for (const derivative of derivatives.values()) {
		if (!library.some((asset) => asset.id === derivative.id)) {
			library.push(derivative);
		}
	}
	const byId = new Map(library.map((asset) => [asset.id, asset]));
	const clips: ReframeStabilizeClip[] = [];
	let next = project;
	for (const segment of targets) {
		const skipped = reframeStabilizeSkip(segment, byId.get(segment.assetId));
		const derivative = derivatives.get(segment.assetId);
		if (skipped || !derivative) {
			clips.push({
				clipId: segment.id,
				skipped: skipped ?? "No stabilized media was made.",
			});
			continue;
		}
		next = swapClipMedia(next, library, {
			assetId: derivative.id,
			clipId: segment.id,
			revision: next.revision,
		});
		clips.push({ assetId: derivative.id, clipId: segment.id });
	}
	return { clips, project: next };
}
