import { describe, expect, test } from "bun:test";
import {
	newProject,
	newSegment,
	type Project,
	segmentDuration,
	updateTrackSetting,
} from "../../../../shared/project.ts";
import { createTestRuntime, lastStatus, testVideo } from "../test-runtime.ts";
import {
	applyAssetDrop,
	dropAssetOnTimeline,
	selectionToNewTrack,
} from "./placement.ts";

const spans = (project: Project | null, track: number) =>
	(project?.segments ?? [])
		.filter((segment) => segment.track === track)
		.map((segment) => [
			Number(segment.start.toFixed(6)),
			Number((segment.start + segmentDuration(segment)).toFixed(6)),
		]);

function setup() {
	const existing = testVideo("existing.mp4", 10);
	const dropped = testVideo("dropped.mp4", 2);
	const project: Project = {
		...newProject("Drops"),
		segments: [newSegment(existing, 0, 1)],
	};
	const runtime = createTestRuntime(project, [existing, dropped]);
	return { dropped, existing, project, runtime };
}

describe("library drops", () => {
	test("a plain drop overwrites in one undo step and selects the clip", () => {
		const { dropped, runtime } = setup();
		expect(
			dropAssetOnTimeline(runtime, dropped, {
				at: 3,
				mode: "overwrite",
				track: 1,
			})
		).toBe(true);
		expect(spans(runtime.project, 1)).toEqual([
			[0, 3],
			[3, 5],
			[5, 10],
		]);
		expect(runtime.calls.filter(([name]) => name === "edit")).toEqual([
			["edit", "Place dropped.mp4"],
		]);
		expect(runtime.selectedSegment?.assetId).toBe(dropped.id);
		expect(runtime.time).toBe(3);
		runtime.undo();
		expect(spans(runtime.project, 1)).toEqual([[0, 10]]);
	});

	test("Cmd/Ctrl drops ripple-insert, and past the end fall back to overwrite", () => {
		const { dropped, existing, project } = setup();
		const assets = [existing, dropped];
		const inserted = applyAssetDrop(project, assets, dropped, {
			at: 3,
			mode: "insert",
			track: 1,
		});
		expect(spans(inserted.project, 1)).toEqual([
			[0, 3],
			[3, 5],
			[5, 12],
		]);
		expect(
			inserted.project.segments.find((s) => s.id === inserted.clipId)?.assetId
		).toBe(dropped.id);
		const appended = applyAssetDrop(project, assets, dropped, {
			at: 12,
			mode: "insert",
			track: 0,
		});
		expect(spans(appended.project, 0)).toEqual([[12, 14]]);
		const ranged = applyAssetDrop(project, assets, existing, {
			at: 0,
			mode: "overwrite",
			sourceIn: 2,
			sourceOut: 4,
			track: 0,
		});
		expect(spans(ranged.project, 0)).toEqual([[0, 2]]);
	});

	test("refused drops report why and leave the timeline alone", () => {
		const { dropped, project } = setup();
		const runtime = createTestRuntime(
			updateTrackSetting(project, 1, { locked: true }),
			[dropped]
		);
		expect(
			dropAssetOnTimeline(runtime, dropped, { at: 3, mode: "insert", track: 1 })
		).toBe(false);
		expect(lastStatus(runtime)).toBe(
			"Unlock the target track before placing clips."
		);
		expect(runtime.calls.some(([name]) => name === "edit")).toBe(false);
		const empty = createTestRuntime(null, [dropped]);
		expect(
			dropAssetOnTimeline(empty, dropped, {
				at: 0,
				mode: "overwrite",
				track: 0,
			})
		).toBe(false);
	});
});

describe("move or duplicate to a new track", () => {
	test("moves the selection up one undo step at a time", () => {
		const { existing, runtime } = setup();
		const clip = runtime.project?.segments[0];
		runtime.setSelected(clip?.id ?? null);
		selectionToNewTrack(runtime, false);
		expect(spans(runtime.project, 2)).toEqual([[0, 10]]);
		expect(runtime.selectedIds).toEqual([clip?.id ?? ""]);
		expect(lastStatus(runtime)).toBe("Moved 1 clip 1 track up.");
		selectionToNewTrack(runtime, true);
		expect(spans(runtime.project, 3)).toEqual([[0, 10]]);
		expect(runtime.selectedSegment?.track).toBe(3);
		expect(runtime.selectedSegment?.assetId).toBe(existing.id);
		expect(runtime.calls.filter(([name]) => name === "edit")).toEqual([
			["edit", "Move to new track"],
			["edit", "Duplicate to new track"],
		]);
	});

	test("asks for a selection first", () => {
		const { runtime } = setup();
		selectionToNewTrack(runtime, false);
		expect(lastStatus(runtime)).toBe("Select clips to move to a new track.");
	});
});
