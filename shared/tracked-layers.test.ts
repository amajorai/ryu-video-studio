import { describe, expect, test } from "bun:test";
import { editAdjustmentLayers } from "./adjustment.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
	validateProject,
} from "./project.ts";
import { speedRamp } from "./speed-ramp.ts";
import { followTrackedLayers, sourceTimeAt } from "./tracked-layers.ts";
import { applyTrack, type CanvasTrackPoint } from "./tracking.ts";
import { trimEdit } from "./trim-modes.ts";

const source: Asset = {
	createdAt: new Date(0).toISOString(),
	duration: 20,
	hasAudio: false,
	height: 1080,
	id: crypto.randomUUID(),
	kind: "video",
	name: "subject.mp4",
	width: 1920,
};

/** The subject moves right between 2 s and 8 s of the clip. */
const path: CanvasTrackPoint[] = Array.from({ length: 61 }, (_, index) => ({
	scale: 1,
	time: 2 + index * 0.1,
	x: 0.3 + 0.004 * index,
	y: 0.5,
}));

/** A 0–10 s clip with a tracked blur over its 2–8 s. */
function trackedScene() {
	const clip: Segment = { ...newSegment(source, 0), sourceOut: 10 };
	const project: Project = validateProject(
		{ ...newProject("Tracked"), segments: [clip] },
		[source]
	);
	const tracked = applyTrack(project, [source], {
		path,
		region: { height: 0.2, width: 0.1, x: 0.25, y: 0.4 },
		segment: clip,
		target: { createRegion: "blur" },
	});
	const layer = tracked.project.adjustmentLayers?.[0];
	if (!layer) {
		throw new Error("no region layer");
	}
	return { clip, layer, project: tracked.project };
}

function regionOf(project: Project) {
	const layer = project.adjustmentLayers?.[0];
	if (!layer) {
		throw new Error("no region layer");
	}
	return layer;
}

function clipOf(project: Project, id: string) {
	const clip = project.segments.find((segment) => segment.id === id);
	if (!clip) {
		throw new Error("no clip");
	}
	return clip;
}

describe("tracked region layers follow their clip", () => {
	test("a region records the source moments it covers", () => {
		const { clip, layer } = trackedScene();
		expect(layer.follows).toEqual({
			assetId: source.id,
			clipId: clip.id,
			sourceEnd: 8,
			sourceStart: 2,
		});
	});

	test("a ripple head trim moves the region with the clip's content", () => {
		const { clip, layer, project } = trackedScene();
		const trimmed = trimEdit(project, [source], {
			clipId: clip.id,
			delta: 1,
			edge: "start",
			mode: "ripple",
			revision: project.revision,
		});
		const after = clipOf(trimmed.project, clip.id);
		expect(after).toMatchObject({ sourceIn: 1, start: 0 });
		const moved = regionOf(trimmed.project);
		// Source 2 s now plays at timeline 1 s: the mask stays on its subject.
		expect(sourceTimeAt(after, moved.start)).toBeCloseTo(2, 6);
		expect(moved.start).toBeCloseTo(1, 6);
		expect(moved.end).toBeCloseTo(7, 6);
		expect(moved.keyframes).toEqual(layer.keyframes);
	});

	test("a head trim past the tracked start cuts the region at the clip", () => {
		const { clip, project } = trackedScene();
		const trimmed = trimEdit(project, [source], {
			clipId: clip.id,
			delta: 3,
			edge: "start",
			mode: "ripple",
			revision: project.revision,
		});
		const moved = regionOf(trimmed.project);
		expect(moved.start).toBe(0);
		expect(moved.end).toBeCloseTo(5, 6);
		for (const frame of moved.keyframes ?? []) {
			expect(frame.time).toBeGreaterThanOrEqual(0);
			expect(frame.time).toBeLessThanOrEqual(5 + 1e-6);
		}
	});

	test("a slip moves the region opposite the source shift", () => {
		const { clip, project } = trackedScene();
		const slipped = trimEdit(project, [source], {
			clipId: clip.id,
			delta: 1,
			mode: "slip",
			revision: project.revision,
		});
		const after = clipOf(slipped.project, clip.id);
		const moved = regionOf(slipped.project);
		expect(sourceTimeAt(after, moved.start)).toBeCloseTo(2, 6);
		expect(sourceTimeAt(after, moved.end)).toBeCloseTo(8, 6);
	});

	test("a speed ramp places the region where its moments now play", () => {
		const { clip, project } = trackedScene();
		const ramped = speedRamp(project, [source], {
			clipId: clip.id,
			preset: "hero",
			revision: project.revision,
		});
		const moved = regionOf(ramped);
		const playing = (time: number) =>
			ramped.segments.find(
				(segment) =>
					segment.start <= time + 1e-6 &&
					time <=
						segment.start +
							(segment.sourceOut - segment.sourceIn) / segment.speed +
							1e-6
			);
		const first = playing(moved.start);
		const last = playing(moved.end);
		expect(first && sourceTimeAt(first, moved.start)).toBeCloseTo(2, 3);
		expect(last && sourceTimeAt(last, moved.end)).toBeCloseTo(8, 3);
		expect(ramped.segments.some((s) => s.id === moved.follows?.clipId)).toBe(
			true
		);
	});

	test("a layer moved by hand stops following", () => {
		const { layer, project } = trackedScene();
		const edited = editAdjustmentLayers(project, [source], {
			action: "update",
			layer: { start: 3 },
			layerId: layer.id,
			revision: project.revision,
		});
		expect(edited.layer?.follows).toBeUndefined();
		const relabeled = editAdjustmentLayers(project, [source], {
			action: "update",
			layer: { label: "Face" },
			layerId: layer.id,
			revision: project.revision,
		});
		expect(relabeled.layer?.follows).toEqual(layer.follows);
	});

	test("edits that do not move the content leave the region alone", () => {
		const { project } = trackedScene();
		expect(followTrackedLayers(project, project)).toBe(project);
	});
});
