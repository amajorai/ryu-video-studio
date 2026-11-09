import { describe, expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	snapTimelineTime as reexportedSnapTimelineTime,
	type Title,
} from "./project.ts";
import {
	collectSnapTargets,
	DEFAULT_SNAP_THRESHOLD_PX,
	quantizeToFrame,
	SNAP_PRIORITY,
	type SnapTarget,
	snap,
	snapTimelineTime,
} from "./timeline-snap.ts";

const asset: Asset = {
	createdAt: new Date(0).toISOString(),
	duration: 20,
	hasAudio: true,
	height: 360,
	id: crypto.randomUUID(),
	kind: "video",
	name: "clip.mp4",
	width: 640,
};

/** Clips: a 0-4 (t0), b 6-10 (t0), c 2-5 (t1); a and c are linked. */
function fixture() {
	const a = { ...newSegment(asset, 0, 0), sourceOut: 4 };
	const b = { ...newSegment(asset, 6, 0), sourceOut: 4 };
	const c = { ...newSegment(asset, 2, 1), sourceOut: 3 };
	const linkGroupId = crypto.randomUUID();
	const project: Project = {
		...newProject("Snap"),
		markers: [
			{ id: crypto.randomUUID(), label: "Hook", time: 1.5 },
			{ duration: 2, id: crypto.randomUUID(), label: "Range", time: 11 },
		],
		segments: [{ ...a, linkGroupId }, b, { ...c, linkGroupId }],
	};
	return { a, b, c, project };
}

function title(start: number, end: number): Title {
	return {
		animation: "fade",
		color: "#ffffff",
		end,
		fadeIn: 0,
		fadeOut: 0,
		fontSize: 0.08,
		id: crypto.randomUUID(),
		start,
		text: "Title",
		x: 0.5,
		y: 0.5,
	};
}

const kinds = (targets: readonly SnapTarget[]) =>
	targets.map((target) => `${target.kind}@${target.time}`);

describe("collectSnapTargets", () => {
	test("lists playhead, I/O, markers, and clip edges in a stable order", () => {
		const { project } = fixture();
		const targets = collectSnapTargets(project, {
			range: { end: 8, start: 1 },
			time: 3.25,
		});
		expect(kinds(targets)).toEqual([
			"playhead@3.25",
			"range-in@1",
			"range-out@8",
			"marker@1.5",
			"marker@11",
			"marker-end@13",
			"clip-start@0",
			"clip-end@4",
			"clip-start@6",
			"clip-end@10",
			"clip-start@2",
			"clip-end@5",
		]);
		expect(
			collectSnapTargets(project, { range: { end: 8, start: 1 } })
		).toEqual(collectSnapTargets(project, { range: { end: 8, start: 1 } }));
	});

	test("skips an empty I/O range and a missing playhead", () => {
		const { project } = fixture();
		const targets = collectSnapTargets(project, {
			range: { end: 2, start: 2 },
			time: null,
		});
		expect(targets.some((target) => target.kind === "playhead")).toBe(false);
		expect(targets.some((target) => target.kind.startsWith("range"))).toBe(
			false
		);
	});

	test("excludes the dragged clip and, by default, its linked partner", () => {
		const { a, b, c, project } = fixture();
		const ids = (targets: readonly SnapTarget[]) =>
			new Set(targets.flatMap((target) => (target.id ? [target.id] : [])));
		const linked = ids(
			collectSnapTargets(project, { exclude: new Set([a.id]) })
		);
		expect(linked.has(a.id)).toBe(false);
		expect(linked.has(c.id)).toBe(false);
		expect(linked.has(b.id)).toBe(true);
		const unlinked = ids(
			collectSnapTargets(project, {
				exclude: new Set([a.id]),
				excludeLinked: false,
			})
		);
		expect(unlinked.has(a.id)).toBe(false);
		expect(unlinked.has(c.id)).toBe(true);
	});

	test("includes the selected clip's keyframes only when asked", () => {
		const { project } = fixture();
		const owner = project.segments[1];
		if (!owner) {
			throw new Error("fixture clip missing");
		}
		const keyed: Project = {
			...project,
			segments: project.segments.map((segment) =>
				segment.id === owner.id
					? {
							...segment,
							keyframes: [
								{
									id: crypto.randomUUID(),
									property: "opacity",
									time: 1,
									value: 1,
								},
								{ id: crypto.randomUUID(), property: "x", time: 1, value: 0 },
								{
									id: crypto.randomUUID(),
									property: "x",
									time: 3.5,
									value: 0.2,
								},
								{ id: crypto.randomUUID(), property: "x", time: 9, value: 0.2 },
							],
						}
					: segment
			),
		};
		const keyframeTimes = (options: Parameters<typeof collectSnapTargets>[1]) =>
			collectSnapTargets(keyed, options)
				.filter((target) => target.kind === "keyframe")
				.map((target) => target.time);
		expect(keyframeTimes({ keyframeOwnerId: owner.id })).toEqual([]);
		expect(
			keyframeTimes({ includeKeyframes: true, keyframeOwnerId: owner.id })
		).toEqual([7, 9.5]);
		expect(
			keyframeTimes({
				exclude: new Set([owner.id]),
				includeKeyframes: true,
				keyframeOwnerId: owner.id,
			})
		).toEqual([]);
	});

	test("never offers a dragged marker as its own target", () => {
		const { project } = fixture();
		const [hook, range] = project.markers;
		if (!(hook && range)) {
			throw new Error("fixture markers missing");
		}
		const targets = collectSnapTargets(project, {
			exclude: new Set([hook.id, range.id]),
		});
		expect(targets.some((target) => target.kind.startsWith("marker"))).toBe(
			false
		);
		const result = snap(1.55, targets, { fps: 30, pxPerSec: 100 });
		expect(result.target).toBeUndefined();
		expect(result.time).toBeCloseTo(47 / 30, 9);
		const others = collectSnapTargets(project, {
			exclude: new Set([hook.id]),
		});
		expect(kinds(others.filter((target) => target.id === range.id))).toEqual([
			"marker@11",
			"marker-end@13",
		]);
	});

	test("never offers a dragged keyframe as its own target", () => {
		const { project } = fixture();
		const owner = project.segments[1];
		if (!owner) {
			throw new Error("fixture clip missing");
		}
		const dragged = {
			id: crypto.randomUUID(),
			property: "x" as const,
			time: 1,
			value: 0,
		};
		const sibling = {
			id: crypto.randomUUID(),
			property: "opacity" as const,
			time: 1,
			value: 1,
		};
		const later = {
			id: crypto.randomUUID(),
			property: "x" as const,
			time: 2.5,
			value: 0.4,
		};
		const keyed: Project = {
			...project,
			segments: project.segments.map((segment) =>
				segment.id === owner.id
					? { ...segment, keyframes: [dragged, sibling, later] }
					: segment
			),
		};
		const collect = (excluded: string[]) =>
			collectSnapTargets(keyed, {
				exclude: new Set(excluded),
				includeKeyframes: true,
				keyframeOwnerId: owner.id,
			}).filter((target) => target.kind === "keyframe");
		const withoutLater = collect([later.id]);
		expect(withoutLater.map((target) => target.id)).toEqual([dragged.id]);
		const result = snap(8.55, withoutLater, { fps: 30, pxPerSec: 100 });
		expect(result.target).toBeUndefined();
		// Dedupe runs after exclusion: the sibling at the same time survives.
		expect(collect([dragged.id]).map((target) => target.id)).toEqual([
			sibling.id,
			later.id,
		]);
		const remaining = collect([dragged.id, sibling.id]);
		expect(remaining.map((target) => target.time)).toEqual([8.5]);
	});

	test("includes overlay bounds and keyframes of a selected title", () => {
		const { project } = fixture();
		const lower = {
			...title(12, 15),
			keyframes: [
				{
					id: crypto.randomUUID(),
					property: "opacity" as const,
					time: 0.5,
					value: 1,
				},
			],
		};
		const withTitle: Project = { ...project, titles: [lower] };
		const targets = collectSnapTargets(withTitle, {
			includeKeyframes: true,
			keyframeOwnerId: lower.id,
		});
		expect(kinds(targets).slice(-3)).toEqual([
			"keyframe@12.5",
			"overlay-start@12",
			"overlay-end@15",
		]);
		expect(
			collectSnapTargets(withTitle, { includeOverlays: false }).some((target) =>
				target.kind.startsWith("overlay")
			)
		).toBe(false);
		expect(
			collectSnapTargets(withTitle, { exclude: new Set([lower.id]) }).some(
				(target) => target.id === lower.id
			)
		).toBe(false);
	});

	test("covers captions on the active caption track and adjustment layers", () => {
		const { project } = fixture();
		const trackId = crypto.randomUUID();
		const layerId = crypto.randomUUID();
		const withOverlays: Project = {
			...project,
			adjustmentLayers: [
				{
					end: 18,
					id: layerId,
					label: "Grade",
					opacity: 1,
					start: 16,
					track: 0,
				},
			],
			captionTrackId: trackId,
			captions: [{ end: 1, id: crypto.randomUUID(), start: 0.5, text: "base" }],
			captionTracks: [
				{
					captions: [
						{ end: 3.75, id: crypto.randomUUID(), start: 3.5, text: "active" },
					],
					id: trackId,
					label: "EN",
					language: "en",
				},
			],
		};
		const overlayTimes = collectSnapTargets(withOverlays)
			.filter((target) => target.kind.startsWith("overlay"))
			.map((target) => target.time);
		expect(overlayTimes).toEqual([16, 18, 3.5, 3.75]);
	});
});

describe("snap", () => {
	const at = (
		time: number,
		kind: SnapTarget["kind"],
		id?: string
	): SnapTarget => ({
		id,
		kind,
		priority: SNAP_PRIORITY[kind],
		time,
	});

	test("the playhead outranks a nearer clip edge", () => {
		const result = snap(5.02, [at(5, "clip-end"), at(5.08, "playhead")], {
			fps: 30,
			pxPerSec: 100,
		});
		expect(result.target?.kind).toBe("playhead");
		expect(result.time).toBe(5.08);
	});

	test("edit points outrank keyframes and overlays", () => {
		const result = snap(
			2,
			[at(2, "keyframe"), at(2.01, "overlay-start"), at(2.05, "marker")],
			{ fps: 30, pxPerSec: 100 }
		);
		expect(result.target?.kind).toBe("marker");
	});

	test("the nearest target wins within one tier, then the earliest listed", () => {
		const nearest = snap(3, [at(3.05, "clip-start"), at(2.98, "clip-end")], {
			fps: 30,
			pxPerSec: 100,
		});
		expect(nearest.time).toBe(2.98);
		const tie = snap(
			3,
			[at(3.02, "clip-start", "a"), at(2.98, "clip-end", "b")],
			{
				fps: 30,
				pxPerSec: 100,
			}
		);
		expect(tie.target?.id).toBe("a");
	});

	test("the threshold is in pixels and scales with zoom", () => {
		const targets = [at(10, "clip-start")];
		expect(DEFAULT_SNAP_THRESHOLD_PX).toBe(8);
		// 100 px/s: 8 px is 0.08 s.
		expect(
			snap(10.07, targets, { fps: 30, pxPerSec: 100 }).target
		).toBeDefined();
		expect(
			snap(10.09, targets, { fps: 30, pxPerSec: 100 }).target
		).toBeUndefined();
		// 20 px/s: 8 px is 0.4 s.
		expect(snap(10.35, targets, { fps: 30, pxPerSec: 20 }).time).toBe(10);
		// 400 px/s: 8 px is 0.02 s.
		expect(
			snap(10.03, targets, { fps: 30, pxPerSec: 400 }).target
		).toBeUndefined();
		expect(
			snap(10.03, targets, { fps: 30, pxPerSec: 400, thresholdPx: 16 }).time
		).toBe(10);
	});

	test("falls back to the frame grid, including NTSC 29.97", () => {
		const none = snap(1, [], { fps: 29.97, pxPerSec: 100 });
		expect(none.target).toBeUndefined();
		expect(none.time).toBe(30 / 29.97);
		expect(quantizeToFrame(1.0005, 29.97)).toBe(30 / 29.97);
		expect(quantizeToFrame(10, 29.97) * 29.97).toBeCloseTo(300, 9);
		expect(quantizeToFrame(0.016, 59.94)).toBe(1 / 59.94);
		expect(quantizeToFrame(0.016, 23.976)).toBe(0);
	});

	test("a target keeps its exact off-grid time", () => {
		expect(
			snap(1.51, [at(1.505, "marker")], { fps: 30, pxPerSec: 100 }).time
		).toBe(1.505);
	});

	test("never returns a negative time", () => {
		expect(snap(-0.4, [], { fps: 30, pxPerSec: 100 }).time).toBe(0);
		expect(quantizeToFrame(-2, 25)).toBe(0);
		expect(quantizeToFrame(1.234, 0)).toBe(1.234);
	});

	test("zero or negative zoom disables target capture", () => {
		expect(
			snap(2, [at(2.01, "clip-end")], { fps: 30, pxPerSec: 0 }).target
		).toBeUndefined();
	});

	test("end-to-end: a dragged edge snaps to a neighbour edge within 8 px", () => {
		const { a, b, project } = fixture();
		const targets = collectSnapTargets(project, { exclude: new Set([b.id]) });
		// Dragging b's start 7 px right of a's end at 100 px/s.
		const result = snap(4.07, targets, { fps: 30, pxPerSec: 100 });
		expect(result.target).toMatchObject({
			id: a.id,
			kind: "clip-end",
			time: 4,
		});
		// 9 px away it only quantizes.
		expect(
			snap(4.09, targets, { fps: 30, pxPerSec: 100 }).target
		).toBeUndefined();
	});
});

describe("snapTimelineTime", () => {
	const markers = [
		{ id: crypto.randomUUID(), label: "Hook", time: 2 },
		{ id: crypto.randomUUID(), label: "End", time: 4.5 },
	];

	test("keeps the legacy frame-then-marker semantics", () => {
		expect(snapTimelineTime(1.96, 30, markers)).toBe(2);
		expect(snapTimelineTime(4.43, 30, markers)).toBe(4.5);
		expect(snapTimelineTime(3.1, 30, markers)).toBeCloseTo(3.1, 6);
		expect(snapTimelineTime(9.99, 24, markers, 0.5)).toBe(240 / 24);
		expect(snapTimelineTime(4.2, 30, markers, 0.5)).toBe(4.5);
		expect(snapTimelineTime(-1, 30, [])).toBe(0);
	});

	test("picks the earliest listed marker on an exact tie", () => {
		const tied = [
			{ id: crypto.randomUUID(), label: "Late", time: 3.1 },
			{ id: crypto.randomUUID(), label: "Early", time: 2.9 },
		];
		expect(snapTimelineTime(3, 30, tied)).toBe(3.1);
	});

	test("is still re-exported from project.ts", () => {
		expect(reexportedSnapTimelineTime).toBe(snapTimelineTime);
	});
});
