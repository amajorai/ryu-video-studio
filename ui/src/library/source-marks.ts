/**
 * Source in/out marks set in the library before placing media (W1-L1). The
 * marked range feeds the tile's drag payload, "Add" and "Insert at
 * playhead". Pure: marks clamp into the media and never cross.
 */
import type { Asset } from "../../../shared/project.ts";
import type { AssetSourceRange } from "./drag-source.ts";

export interface SourceMarks {
	in?: number;
	out?: number;
}

/** Shortest range a pair of marks may describe (one frame at 25 fps). */
export const MIN_MARKED_DURATION = 0.04;

/** Media kinds whose source range can be marked (stills have no timeline). */
export function canMarkSource(asset: Pick<Asset, "kind">): boolean {
	return asset.kind !== "image";
}

const clampTime = (time: number, duration: number) =>
	Math.round(Math.min(Math.max(0, time), Math.max(0, duration)) * 1000) / 1000;

/**
 * Set the in mark. An out mark at or before the new in point (less than one
 * minimum range after it) is cleared, like an NLE source monitor.
 */
export function markSourceIn(
	marks: SourceMarks,
	time: number,
	asset: Pick<Asset, "duration">
): SourceMarks {
	const point = clampTime(time, asset.duration - MIN_MARKED_DURATION);
	if (marks.out !== undefined && marks.out - point < MIN_MARKED_DURATION) {
		return { in: point };
	}
	return { ...marks, in: point };
}

/** Set the out mark; an in mark at or after it is cleared. */
export function markSourceOut(
	marks: SourceMarks,
	time: number,
	asset: Pick<Asset, "duration">
): SourceMarks {
	const point = Math.max(MIN_MARKED_DURATION, clampTime(time, asset.duration));
	if (marks.in !== undefined && point - marks.in < MIN_MARKED_DURATION) {
		return { out: point };
	}
	return { ...marks, out: point };
}

/**
 * The marked source range, or `undefined` when nothing is marked (place the
 * whole asset). A lone in mark runs to the end; a lone out mark from 0.
 */
export function markedRange(
	marks: SourceMarks,
	asset: Pick<Asset, "duration" | "kind">
): AssetSourceRange | undefined {
	if (
		!canMarkSource(asset) ||
		(marks.in === undefined && marks.out === undefined)
	) {
		return;
	}
	const start = clampTime(marks.in ?? 0, asset.duration);
	const end = clampTime(marks.out ?? asset.duration, asset.duration);
	return end - start >= MIN_MARKED_DURATION ? { end, start } : undefined;
}
