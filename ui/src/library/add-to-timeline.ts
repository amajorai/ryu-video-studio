/**
 * Library "Add" (W1-L1): append an asset, or a marked source range of it, at
 * the end of the timeline. Audio always lands on the audio track (1) and
 * video/stills on track 0, whether or not a range is marked, matching
 * "Insert at playhead".
 */
import { type Asset, newSegment } from "../../../shared/project.ts";
import { addAssetToTimeline } from "../editor/actions/placement.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import type { AssetSourceRange } from "./drag-source.ts";

/** Track a library placement uses for an asset kind. */
export function libraryTrackFor(asset: Pick<Asset, "kind">): number {
	return asset.kind === "audio" ? 1 : 0;
}

/** Append the asset (optionally only `range` of it) to the timeline. */
export function addLibraryAsset(
	runtime: EditorRuntime,
	asset: Asset,
	range?: AssetSourceRange
) {
	const { duration, project } = runtime;
	if (!(project && range)) {
		addAssetToTimeline(runtime, asset);
		return;
	}
	const segment = {
		...newSegment(asset, duration, libraryTrackFor(asset)),
		sourceIn: range.start,
		sourceOut: range.end,
	};
	runtime.edit(
		{ ...project, segments: [...project.segments, segment] },
		`Add ${asset.name}`
	);
	runtime.setSelected(segment.id);
	runtime.setTime(segment.start);
}
