import type { TimelineRange } from "../../../shared/filler-words.ts";
import type { Project } from "../../../shared/project.ts";

export const plural = (count: number, noun: string) =>
	`${count} ${noun}${count === 1 ? "" : "s"}`;

/** Seconds a set of ranges removes, rounded to milliseconds. */
export const rangesSeconds = (ranges: readonly TimelineRange[]) =>
	Math.round(
		ranges.reduce((total, range) => total + range.end - range.start, 0) * 1000
	) / 1000;

/** Track indices that hold clips, for the track filter. */
export const transcriptTracks = (project: Project) =>
	[...new Set(project.segments.map((segment) => segment.track))].sort(
		(a, b) => a - b
	);
