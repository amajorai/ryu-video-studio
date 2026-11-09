/**
 * What one chunk window of a long export (`render-chunks.ts`) renders: the
 * overlays it keeps, the clips it draws and where each clip that crosses
 * the window start begins decoding.
 */
import { fpsRational, framesToTime } from "../../shared/frame-rate.ts";
import {
	type Asset,
	type Project,
	type Segment,
	segmentDuration,
} from "../../shared/project.ts";
import {
	clipSourceOffset,
	clipTimeAtSourceOffset,
	hasSpeedCurve,
} from "../../shared/speed-curve.ts";
import type { RenderWindow } from "./render-chunks.ts";

/**
 * Source seconds a clip that crosses a window start is decoded before that
 * start, so seek accuracy and frame-rate rounding never touch the first
 * frame of the window.
 */
export const CHUNK_SEEK_PREROLL = 1;

interface Timed {
	end: number;
	start: number;
}

function overlaps(item: Timed, start: number, end: number): boolean {
	return item.start <= end && item.end >= start;
}

/**
 * The project as a window's overlay stages see it: titles, graphics,
 * avatars, stage objects and adjustment layers outside the window (with one
 * frame of slack on each side) are left out. Clips stay, because the reveal
 * stage reads each clip's predecessor; the orchestrator filters the clips it
 * draws itself.
 */
export function windowedProject(
	project: Project,
	window: RenderWindow
): Project {
	const slack = 1 / Math.max(1, project.fps);
	const start = framesToTime(window.startFrame, project.fps) - slack;
	const end =
		framesToTime(window.startFrame + window.frames, project.fps) + slack;
	const keep = <Item extends Timed>(items: readonly Item[]) =>
		items.filter((item) => overlaps(item, start, end));
	const scoped: Project = {
		...project,
		avatars: keep(project.avatars),
		graphics: keep(project.graphics),
		spatialObjects: keep(project.spatialObjects),
		titles: keep(project.titles),
	};
	if (project.adjustmentLayers) {
		scoped.adjustmentLayers = keep(project.adjustmentLayers);
	}
	return scoped;
}

/** Window seconds as `{ start, end }` on the timeline clock. */
export function windowSeconds(
	window: RenderWindow,
	fps: number
): { end: number; start: number } {
	return {
		end: framesToTime(window.startFrame + window.frames, fps),
		start: framesToTime(window.startFrame, fps),
	};
}

/** Whether a clip has any frame inside the window (inclusive edges). */
export function segmentInWindow(
	segment: Segment,
	window: RenderWindow,
	fps: number
): boolean {
	const { end, start } = windowSeconds(window, fps);
	const slack = 1 / Math.max(1, fps) / 2;
	return (
		segment.start <= end + slack &&
		segment.start + segmentDuration(segment) >= start - slack
	);
}

/**
 * Timeline seconds a clip's decode may skip at a window start: everything
 * before the window except `CHUNK_SEEK_PREROLL` source seconds. Zero for
 * clips that start inside the window or within the preroll of its start.
 */
export function windowSkip(
	segment: Segment,
	window: RenderWindow,
	fps: number
): number {
	const { start } = windowSeconds(window, fps);
	const before = start - segment.start;
	const skip = before - CHUNK_SEEK_PREROLL / segment.speed;
	return skip > 0 ? Number(skip.toFixed(6)) : 0;
}

/** `sourceIn` this close to a source frame (seconds) counts as on it. */
const SOURCE_GRID_EXACT = 2e-6;
/**
 * `sourceIn` closer than this to a source frame (but not on it) leaves the
 * first decoded frame to timestamp rounding, so the clip is not skipped.
 */
const SOURCE_GRID_AMBIGUOUS = 0.0015;

/** How a window render opens a clip that crosses its start. */
export interface WindowSeek {
	/** Input `-ss` in source seconds: half a source frame before `frame`. */
	seek: number;
	/**
	 * Clip seconds of the first decoded frame (source frames past the clip's
	 * first frame, over the speed). Never more than `windowSkip`.
	 */
	skip: number;
	/**
	 * `setpts` term that adds back the skipped source frames in the stream
	 * timebase, rounded per frame the way a muxer stamps them, so
	 * `(PTS-STARTPTS+ticks)/speed` equals the one-pass `(PTS-STARTPTS)/speed`
	 * frame for frame.
	 */
	ticks: string;
}

/**
 * Where a window render may start decoding a clip that crosses its start,
 * keeping the one-pass frame phase. The one-pass render places the first
 * source frame at or after `sourceIn` at clip time 0; the window seeks half a
 * source frame before a later source frame, so that frame is the first one
 * decoded whatever the seek rounding, and shifts it by the exact number of
 * source frames between the two. That needs the source frame grid: assets
 * without a probed frame rate, with an irregular rate (a variable-rate
 * average), or whose `sourceIn` sits within rounding of a source frame are
 * not skipped (`undefined`), and decode from the clip start instead. A
 * speed-curved clip skips to the curve-mapped source moment of the window
 * start (`clipSourceOffset`), and its first decoded frame lands at the clip
 * time the curve gives the skipped source.
 */
export function windowSeek(
	segment: Segment,
	asset: Pick<Asset, "frameRate" | "kind"> | undefined,
	window: RenderWindow,
	fps: number
): WindowSeek | undefined {
	if (asset?.kind !== "video" || asset.frameRate === undefined) {
		return;
	}
	const curved = hasSpeedCurve(segment);
	// Source seconds past `sourceIn` the decode may skip: the curve-mapped
	// source moment of the window start, less the preroll.
	const sourceTarget = curved
		? clipSourceOffset(
				segment,
				windowSeconds(window, fps).start - segment.start
			) - CHUNK_SEEK_PREROLL
		: windowSkip(segment, window, fps) * segment.speed;
	if (sourceTarget <= 0) {
		return;
	}
	const rate = fpsRational(asset.frameRate);
	if (!(rate.ntsc || rate.den <= 2)) {
		return;
	}
	const perSecond = rate.num / rate.den;
	const inFrames = segment.sourceIn * perSecond;
	const nearest = Math.round(inFrames);
	const offGrid = Math.abs(inFrames - nearest) / perSecond;
	if (offGrid > SOURCE_GRID_EXACT && offGrid < SOURCE_GRID_AMBIGUOUS) {
		return;
	}
	const first = offGrid <= SOURCE_GRID_EXACT ? nearest : Math.ceil(inFrames);
	const frame = Math.floor((segment.sourceIn + sourceTarget) * perSecond);
	const skipped = frame - first;
	if (skipped <= 0) {
		return;
	}
	const skippedSource = (skipped * rate.den) / rate.num;
	const at = (index: number) => `round(${index}*${rate.den}/(${rate.num}*TB))`;
	return {
		seek: Number((((frame - 0.5) * rate.den) / rate.num).toFixed(6)),
		// The curve's remap reads source seconds from the first decoded frame,
		// so the skipped frames land where the one-pass mapping puts them.
		skip: curved
			? clipTimeAtSourceOffset(segment, skippedSource)
			: skippedSource / segment.speed,
		ticks: `${at(frame)}-${at(first)}`,
	};
}
