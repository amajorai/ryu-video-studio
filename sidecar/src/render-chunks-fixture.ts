/** Test support: timelines and sources shared by the chunked-render tests. */
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
} from "../../shared/project.ts";
import { resolveRenderPlan } from "../../shared/render-options.ts";

export function video(id: string, duration = 4000): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration,
		hasAudio: true,
		height: 360,
		id,
		kind: "video",
		name: `${id}.mp4`,
		width: 640,
	};
}

export const SOURCE = video("00000000-0000-4000-8000-000000000001");
export const LONG = video("00000000-0000-4000-8000-000000000002");
/** The long source with a probed 24 fps grid, in a 30 fps project. */
export const LONG_24 = { ...LONG, frameRate: 24 };

export function clip(index: number, start: number, length: number, track = 0) {
	return {
		...newSegment(SOURCE, start, track),
		id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
		sourceIn: 0,
		sourceOut: length,
	};
}

/** `count` back-to-back clips of `length` seconds on track 0. */
export function timeline(count: number, length: number, extra: Segment[] = []) {
	const project: Project = {
		...newProject("Chunk test"),
		height: 180,
		segments: [
			...Array.from({ length: count }, (_, index) =>
				clip(index, Number((index * length).toFixed(6)), length)
			),
			...extra,
		],
		width: 320,
	};
	return project;
}

export const mediaPath = (id: string) => `/media/${id}.mp4`;

export function planOf(project: Project, options = {}) {
	return resolveRenderPlan(project, options, {
		timelineDuration: Math.max(
			...project.segments.map((s) => s.start + s.sourceOut - s.sourceIn)
		),
	});
}
