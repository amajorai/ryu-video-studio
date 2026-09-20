import { z } from "zod";
import type { Project } from "./project.ts";

export const reorderTracksRequestSchema = z
	.object({
		order: z.array(z.number().int().min(0).max(15)).min(1).max(16),
		revision: z.number().int().nonnegative(),
	})
	.strict();

/** Returns visible lanes in their current bottom-to-top order. */
export function trackOrderFor(
	project: Pick<Project, "segments" | "trackSettings">
): number[] {
	const highestTrack = Math.max(
		2,
		...project.segments.map((segment) => segment.track),
		...project.trackSettings.map((setting) => setting.track)
	);
	return Array.from(
		{ length: Math.min(16, highestTrack + 1) },
		(_, track) => track
	);
}

export function reorderTracks(project: Project, order: number[]): Project {
	const current = trackOrderFor(project);
	if (
		order.length !== current.length ||
		new Set(order).size !== order.length ||
		order.some((track) => !current.includes(track))
	) {
		throw new Error(
			`Track order must be a permutation of ${current.join(", ")}.`
		);
	}
	const nextTrack = new Map(order.map((track, index) => [track, index]));
	return {
		...project,
		segments: project.segments.map((segment) => ({
			...segment,
			track: nextTrack.get(segment.track) ?? segment.track,
		})),
		trackSettings: project.trackSettings
			.map((setting) => ({
				...setting,
				track: nextTrack.get(setting.track) ?? setting.track,
			}))
			.sort((a, b) => a.track - b.track),
	};
}
