import { describe, expect, test } from "bun:test";
import {
	newProject,
	newSegment,
	type Project,
	updateTrackSetting,
} from "../../../shared/project.ts";
import { createEditorStore } from "../editor/store.ts";
import { testVideo } from "../editor/test-runtime.ts";
import { handleToolClick } from "./clip-click.ts";
import {
	applyGroupDragPlan,
	clearToolDragFeedback,
	createGroupDragSession,
	dragEdgeAt,
	dragGroupIds,
	fadeFromDrag,
	fadeKneeOffset,
	fadeLabel,
	type GroupDragContext,
	MAX_DRAG_TRACK,
	nudgedStart,
	publishToolDragFeedback,
	resolveClipDrag,
	snapGroupDelta,
	TRACK_ROW_PX,
} from "./clip-drag.ts";
import { trimFeedbackStoreFor } from "./trim-feedback.ts";

const asset = testVideo("drag.mp4", 20);
const segment = { ...newSegment(asset, 2), sourceIn: 1, sourceOut: 6 };
const base = {
	assetDuration: asset.duration,
	fps: 30,
	handlesToolEdits: true,
	markers: [],
	segment,
	tool: "pointer" as const,
	zoom: 100,
};

describe("clip drag resolution", () => {
	test("edges are the outer 10px of a clip", () => {
		const bounds = { left: 100, right: 300 };
		expect(dragEdgeAt(bounds, 105)).toBe("start");
		expect(dragEdgeAt(bounds, 295)).toBe("end");
		expect(dragEdgeAt(bounds, 200)).toBe("move");
	});

	test("small travel is a click", () => {
		expect(
			resolveClipDrag({
				...base,
				origin: { edge: "move", x: 10, y: 10 },
				x: 12,
				y: 11,
			})
		).toEqual({ kind: "none" });
	});

	test("body drags move in time and across tracks, clamped", () => {
		expect(
			resolveClipDrag({
				...base,
				origin: { edge: "move", x: 0, y: 0 },
				x: 50,
				y: TRACK_ROW_PX,
			})
		).toEqual({ kind: "move", start: 2.5, track: 1 });
		expect(
			resolveClipDrag({
				...base,
				origin: { edge: "move", x: 500, y: 0 },
				x: 0,
				y: TRACK_ROW_PX * 40,
			})
		).toEqual({ kind: "move", start: 0, track: MAX_DRAG_TRACK });
	});

	test("edge drags trim and snap to frames", () => {
		const result = resolveClipDrag({
			...base,
			origin: { edge: "start", x: 0, y: 0 },
			x: 51,
			y: 0,
		});
		expect(result.kind).toBe("trim");
		if (result.kind === "trim") {
			expect(result.segment.start).toBeCloseTo(2.5, 6);
			expect(result.segment.sourceIn).toBeCloseTo(1.5, 6);
		}
	});

	test("tool drags go to the tool, including every razor gesture", () => {
		const ripple = resolveClipDrag({
			...base,
			origin: { edge: "end", x: 0, y: 0 },
			tool: "ripple",
			x: 30,
			y: 0,
		});
		expect(ripple).toMatchObject({ edge: "end", kind: "tool" });
		expect(ripple.kind === "tool" ? ripple.delta : 0).toBeCloseTo(0.3, 6);
		expect(
			resolveClipDrag({
				...base,
				origin: { edge: "move", x: 0, y: 0 },
				tool: "razor",
				x: 30,
				y: 0,
			})
		).toEqual({ delta: 0.3, edge: "move", kind: "tool" });
		expect(
			resolveClipDrag({
				...base,
				handlesToolEdits: false,
				origin: { edge: "move", x: 0, y: 0 },
				tool: "slip",
				x: 30,
				y: 0,
			}).kind
		).toBe("move");
	});

	test("keyboard nudges move one frame and stay on the timeline", () => {
		expect(nudgedStart(segment, 25, 1)).toBeCloseTo(2.04, 6);
		expect(nudgedStart({ ...segment, start: 0 }, 25, -1)).toBe(0);
	});

	test("tool clicks fall through to selection until the razor cut ships", () => {
		expect(
			handleToolClick({ at: 3, segment, shiftKey: false, tool: "razor" })
		).toBe(false);
	});
});

describe("group drag planning", () => {
	const video = testVideo("group.mp4", 30);
	const audio = { ...testVideo("group.wav", 30), kind: "audio" as const };
	const linkGroupId = crypto.randomUUID();
	// Track 0: picture [2, 6) linked to sound on track 1, b-roll [10, 14).
	const picture = {
		...newSegment(video, 2, 0),
		linkGroupId,
		sourceIn: 2,
		sourceOut: 6,
	};
	const sound = {
		...newSegment(audio, 2, 1),
		linkGroupId,
		sourceIn: 2,
		sourceOut: 6,
	};
	const broll = { ...newSegment(video, 10, 0), sourceIn: 2, sourceOut: 6 };
	const project: Project = {
		...newProject("Group drag"),
		segments: [picture, sound, broll],
	};
	const assets = [video, audio];
	const context: GroupDragContext = {
		assets,
		project,
		range: null,
		selectedIds: [picture.id, broll.id],
		snapEnabled: true,
		time: null,
		zoom: 100,
	};
	const pointer = { altKey: false, shiftKey: false, x: 0, y: 0 };
	const byId = (next: Project, id: string) =>
		next.segments.find((segment) => segment.id === id);

	test("a drag acts on the selection only when the anchor is in it", () => {
		expect(dragGroupIds(project, picture.id, [picture.id, broll.id])).toEqual([
			picture.id,
			broll.id,
		]);
		expect(dragGroupIds(project, sound.id, [picture.id, broll.id])).toEqual([
			sound.id,
		]);
		const locked = updateTrackSetting(project, 0, { locked: true });
		expect(dragGroupIds(locked, sound.id, [sound.id, broll.id])).toEqual([
			sound.id,
		]);
	});

	test("snapGroupDelta lets the edge nearest a target decide", () => {
		const targets = [
			{ kind: "clip-start" as const, priority: 1, time: 10 },
			{ kind: "playhead" as const, priority: 0, time: 20.05 },
		];
		const options = { enabled: true, fps: 30, pxPerSec: 100 };
		// Edges 2 and 6 moved by 3.97: the end lands 0.03 s from 10.
		expect(snapGroupDelta([2, 6], 3.97, targets, options)).toEqual({
			delta: 4,
			exact: true,
			snapTime: 10,
		});
		// The playhead outranks a nearer clip edge.
		expect(snapGroupDelta([10, 20], 0.01, targets, options).snapTime).toBe(
			20.05
		);
		expect(
			snapGroupDelta([2, 6], 3.97, targets, { ...options, enabled: false })
		).toEqual({ delta: 3.97, exact: false, snapTime: null });
	});

	test("a body drag of a selected pair plans one group move", () => {
		const session = createGroupDragSession(context, {
			anchorId: picture.id,
			edge: "move",
			originX: 0,
			originY: 0,
		});
		expect(session.plan({ ...pointer, x: 2, y: 1 })).toEqual({ kind: "none" });
		const plan = session.plan({ ...pointer, x: 150, y: TRACK_ROW_PX });
		expect(plan).toMatchObject({
			delta: 1.5,
			directIds: [picture.id, broll.id],
			kind: "move",
			trackDelta: 1,
		});
		const applied = applyGroupDragPlan(project, assets, plan, session.groupIds);
		expect(applied?.label).toBe("Move clips");
		expect(byId(applied?.project ?? project, picture.id)).toMatchObject({
			start: 3.5,
			track: 1,
		});
		expect(byId(applied?.project ?? project, broll.id)).toMatchObject({
			start: 11.5,
			track: 1,
		});
		expect(byId(applied?.project ?? project, sound.id)?.start).toBe(3.5);
	});

	test("moves snap a group edge to a neighbour and Shift suspends it", () => {
		const session = createGroupDragSession(
			{ ...context, selectedIds: [] },
			{ anchorId: broll.id, edge: "move", originX: 0, originY: 0 }
		);
		// b-roll start 10 moved by -3.97 lands 0.03 s from the picture end (6).
		const snapped = session.plan({ ...pointer, x: -397 });
		expect(snapped).toMatchObject({ delta: -4, exact: true, snapTime: 6 });
		const free = session.plan({ ...pointer, shiftKey: true, x: -397 });
		expect(free).toMatchObject({ exact: false, snapTime: null });
	});

	test("Alt on release duplicates instead of moving", () => {
		const session = createGroupDragSession(
			{ ...context, selectedIds: [] },
			{ anchorId: picture.id, edge: "move", originX: 0, originY: 0 }
		);
		const plan = session.plan({ ...pointer, altKey: true, x: 2000 });
		expect(plan.kind).toBe("duplicate");
		const applied = applyGroupDragPlan(project, assets, plan, session.groupIds);
		expect(applied?.selection).toHaveLength(2);
		expect(applied?.project.segments).toHaveLength(5);
		expect(byId(applied?.project ?? project, picture.id)?.start).toBe(2);
	});

	test("an Alt-drag never consumes its own source clips", () => {
		const session = createGroupDragSession(
			{ ...context, selectedIds: [] },
			{ anchorId: picture.id, edge: "move", originX: 0, originY: 0 }
		);
		// Straight down one row: only the picture changes track (as the
		// preview shows), so its copy would land on the original sound.
		const down = session.plan({ ...pointer, altKey: true, y: TRACK_ROW_PX });
		expect(down).toMatchObject({
			delta: 0,
			directIds: [picture.id],
			kind: "duplicate",
			trackDelta: 1,
		});
		expect(() =>
			applyGroupDragPlan(project, assets, down, session.groupIds)
		).toThrow("Drop the copy clear of the clips it duplicates.");
		// Dropped back where it started: no copy, no edit.
		const home = session.plan({ ...pointer, altKey: true, y: 10 });
		expect(home).toMatchObject({ delta: 0, kind: "duplicate", trackDelta: 0 });
		expect(
			applyGroupDragPlan(project, assets, home, session.groupIds)
		).toBeNull();
	});

	test("edge drags trim linked partners unless Alt is held", () => {
		const session = createGroupDragSession(
			{ ...context, selectedIds: [] },
			{ anchorId: picture.id, edge: "start", originX: 0, originY: 0 }
		);
		const linked = session.plan({ ...pointer, x: 50 });
		expect(linked).toMatchObject({ delta: 0.5, kind: "trim", linked: true });
		expect(linked.kind === "trim" ? linked.ids.sort() : []).toEqual(
			[picture.id, sound.id].sort()
		);
		const applied = applyGroupDragPlan(project, assets, linked, [picture.id]);
		expect(byId(applied?.project ?? project, sound.id)?.start).toBe(2.5);

		const jCut = session.plan({ ...pointer, altKey: true, x: 50 });
		expect(jCut).toMatchObject({ kind: "trim", linked: false });
		const unlinked = applyGroupDragPlan(project, assets, jCut, [picture.id]);
		expect(byId(unlinked?.project ?? project, picture.id)?.start).toBe(2.5);
		expect(byId(unlinked?.project ?? project, sound.id)?.start).toBe(2);
		expect(unlinked?.status).toContain("unlinked");
	});

	test("trims clamp at the neighbour on the same track while planning", () => {
		const session = createGroupDragSession(
			{ ...context, selectedIds: [] },
			{ anchorId: picture.id, edge: "end", originX: 0, originY: 0 }
		);
		// The picture can grow 4 s before b-roll; its audio partner has room.
		const plan = session.plan({ ...pointer, shiftKey: true, x: 900 });
		expect(plan).toMatchObject({ delta: 4, kind: "trim" });
	});

	test("a plan that changes nothing applies as null", () => {
		expect(
			applyGroupDragPlan(project, assets, { kind: "none" }, [picture.id])
		).toBeNull();
	});
});

describe("fade knees", () => {
	const asset = testVideo("fade.mp4", 20);
	const clip = { ...newSegment(asset, 0), sourceOut: 4, fadeOut: 1 };

	test("dragging a knee is frame-quantized and bounded by the other fade", () => {
		expect(fadeFromDrag(clip, "in", 0, 51, 100, 30)).toBeCloseTo(0.5, 6);
		expect(fadeFromDrag(clip, "in", 0, 900, 100, 30)).toBe(3);
		expect(fadeFromDrag(clip, "in", 0.5, -900, 100, 30)).toBe(0);
		// The fade-out knee grows leftward.
		expect(fadeFromDrag(clip, "out", 1, -100, 100, 30)).toBe(2);
		expect(fadeFromDrag(clip, "out", 1, 100, 100, 30)).toBe(0);
	});

	test("knees sit at the ramp end, clear of the trim handles", () => {
		expect(fadeKneeOffset("in", 0, 400, 100)).toBe(15);
		expect(fadeKneeOffset("in", 1, 400, 100)).toBe(100);
		expect(fadeKneeOffset("out", 1, 400, 100)).toBe(300);
		expect(fadeKneeOffset("out", 9, 400, 100)).toBe(15);
		expect(fadeLabel("in", 0.5)).toBe("Fade in 0.50 s");
	});
});

describe("tool drag two-up feedback (W1-T12)", () => {
	test("a slip drag publishes its proposal and drag kind; release clears both", () => {
		const project: Project = {
			...newProject("Slip feedback"),
			segments: [segment],
		};
		const store = createEditorStore();
		const runtime = { project, store };
		const input = {
			...base,
			origin: { edge: "move" as const, x: 200, y: 10 },
			tool: "slip" as const,
			x: 250,
			y: 10,
		};
		expect(publishToolDragFeedback(runtime, input)).toBe(true);
		expect(store.getState().drag).toMatchObject({
			ids: [segment.id],
			kind: "slip",
		});
		expect(trimFeedbackStoreFor(store).get()).toMatchObject({
			clipId: segment.id,
			mode: "slip",
		});
		// Below the drag threshold nothing is proposed.
		expect(publishToolDragFeedback(runtime, { ...input, x: 201 })).toBe(false);
		expect(trimFeedbackStoreFor(store).get()).toBeNull();
		publishToolDragFeedback(runtime, input);
		clearToolDragFeedback(store);
		expect(store.getState().drag).toBeNull();
		expect(trimFeedbackStoreFor(store).get()).toBeNull();
	});

	test("pointer and slide drags never feed the viewer", () => {
		const project: Project = {
			...newProject("No feedback"),
			segments: [segment],
		};
		const store = createEditorStore();
		const input = {
			...base,
			origin: { edge: "move" as const, x: 200, y: 10 },
			x: 260,
			y: 10,
		};
		expect(publishToolDragFeedback({ project, store }, input)).toBe(false);
		expect(
			publishToolDragFeedback(
				{ project, store },
				{ ...input, tool: "slide" as const }
			)
		).toBe(false);
		expect(store.getState().drag).toBeNull();
	});
});

describe("ripple mode pointer edits", () => {
	// Two adjacent 4 s clips at 0 and 4, as in the ripple-mode report.
	const media = testVideo("ripple.mp4", 20);
	const first = { ...newSegment(media, 0, 0), sourceOut: 4 };
	const second = { ...newSegment(media, 4, 0), sourceIn: 4, sourceOut: 8 };
	const rippleProject: Project = {
		...newProject("Ripple"),
		segments: [first, second],
	};
	const rippleContext: GroupDragContext = {
		assets: [media],
		project: rippleProject,
		range: null,
		rippleMode: true,
		selectedIds: [],
		snapEnabled: false,
		time: null,
		zoom: 100,
	};
	const at = (project: Project | undefined, id: string) =>
		project?.segments.find((segment) => segment.id === id);
	const still = { altKey: false, shiftKey: false };

	test("trimming an end closes the gap: the next clip follows", () => {
		const session = createGroupDragSession(rippleContext, {
			anchorId: first.id,
			edge: "end",
			originX: 400,
			originY: 0,
		});
		const plan = session.plan({ ...still, x: 313, y: 0 });
		const applied = applyGroupDragPlan(
			rippleProject,
			[media],
			plan,
			session.groupIds,
			{ ripple: true }
		);
		expect(applied?.label).toBe("Ripple trim clip");
		const trimmedEnd = at(applied?.project, first.id)?.sourceOut ?? 0;
		// 87 px at 100 px/s, on the 30 fps frame grid.
		expect(trimmedEnd).toBeCloseTo(3.13, 2);
		expect(at(applied?.project, second.id)?.start).toBeCloseTo(trimmedEnd, 6);
	});

	test("trimming a start closes the gap without leaving it before the clip", () => {
		const session = createGroupDragSession(rippleContext, {
			anchorId: second.id,
			edge: "start",
			originX: 400,
			originY: 0,
		});
		const plan = session.plan({ ...still, x: 487, y: 0 });
		const applied = applyGroupDragPlan(
			rippleProject,
			[media],
			plan,
			session.groupIds,
			{ ripple: true }
		);
		const trimmed = at(applied?.project, second.id);
		expect(trimmed?.start).toBeCloseTo(4, 6);
		expect(trimmed?.sourceIn).toBeCloseTo(4.87, 2);
	});

	test("ripple trims may extend into the next clip, which moves right", () => {
		const shorter = {
			...rippleProject,
			segments: [
				{ ...first, sourceOut: 3 },
				{ ...second, start: 3 },
			],
		};
		const session = createGroupDragSession(
			{ ...rippleContext, project: shorter },
			{ anchorId: first.id, edge: "end", originX: 300, originY: 0 }
		);
		const plan = session.plan({ ...still, x: 350, y: 0 });
		expect(plan).toMatchObject({ delta: 0.5, kind: "trim" });
		const applied = applyGroupDragPlan(
			shorter,
			[media],
			plan,
			session.groupIds,
			{
				ripple: true,
			}
		);
		expect(at(applied?.project, second.id)?.start).toBeCloseTo(3.5, 6);
	});

	test("moving the last clip right keeps the track gapless", () => {
		const session = createGroupDragSession(rippleContext, {
			anchorId: second.id,
			edge: "move",
			originX: 500,
			originY: 0,
		});
		const plan = session.plan({ ...still, x: 700, y: 0 });
		const applied = applyGroupDragPlan(
			rippleProject,
			[media],
			plan,
			session.groupIds,
			{ ripple: true }
		);
		expect(applied?.label).toBe("Ripple move clip");
		expect(at(applied?.project, second.id)?.start).toBe(4);
	});

	test("moving the first clip after the second swaps them with no gap", () => {
		const session = createGroupDragSession(rippleContext, {
			anchorId: first.id,
			edge: "move",
			originX: 100,
			originY: 0,
		});
		// Dropped past the middle of the second clip (6.5 s): it goes after it.
		const plan = session.plan({ ...still, x: 750, y: 0 });
		const applied = applyGroupDragPlan(
			rippleProject,
			[media],
			plan,
			session.groupIds,
			{ ripple: true }
		);
		expect(at(applied?.project, second.id)?.start).toBe(0);
		expect(at(applied?.project, first.id)?.start).toBe(4);
		expect(applied?.project.segments).toHaveLength(2);
	});

	test("without ripple mode a trim leaves the gap", () => {
		const session = createGroupDragSession(
			{ ...rippleContext, rippleMode: false },
			{ anchorId: first.id, edge: "end", originX: 400, originY: 0 }
		);
		const plan = session.plan({ ...still, x: 313, y: 0 });
		const applied = applyGroupDragPlan(
			rippleProject,
			[media],
			plan,
			session.groupIds
		);
		expect(at(applied?.project, second.id)?.start).toBe(4);
	});
});
