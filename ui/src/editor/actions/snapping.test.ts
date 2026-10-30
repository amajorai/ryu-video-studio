import { describe, expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
} from "../../../../shared/project.ts";
import { ACTION_HANDLERS, runAction } from "../../shortcuts/registry.ts";
import { createTestRuntime, testVideo } from "../test-runtime.ts";
import {
	clearSnapGuide,
	createDragSnapper,
	snapDragTime,
	toggleSnapping,
} from "./snapping.ts";

/** Clip a on 0-4 (track 0), clip b on 6-10 (track 0), linked c 6-10 (track 1). */
function setup() {
	const asset: Asset = testVideo("snap.mp4", 20);
	const a = { ...newSegment(asset, 0, 0), sourceOut: 4 };
	const linkGroupId = crypto.randomUUID();
	const b = { ...newSegment(asset, 6, 0), linkGroupId, sourceOut: 4 };
	const c = { ...newSegment(asset, 6, 1), linkGroupId, sourceOut: 4 };
	const project: Project = { ...newProject("Snap"), segments: [a, b, c] };
	const runtime = createTestRuntime(project, [asset]);
	runtime.zoom = 100;
	runtime.time = 12;
	runtime.range = { end: 0, start: 0 };
	runtime.refresh();
	return { a, b, c, runtime };
}

const lastStatus = (runtime: ReturnType<typeof setup>["runtime"]) =>
	runtime.calls.filter(([name]) => name === "setStatus").at(-1)?.[1];

describe("snapping toggle", () => {
	test("N-toggle flips store.snapEnabled and clears the guide", () => {
		const { runtime } = setup();
		runtime.store.setState({ snapGuideTime: 4 });
		toggleSnapping(runtime);
		expect(runtime.store.getState()).toMatchObject({
			snapEnabled: false,
			snapGuideTime: null,
		});
		expect(lastStatus(runtime)).toBe("Snapping off.");
		toggleSnapping(runtime);
		expect(runtime.store.getState().snapEnabled).toBe(true);
		expect(lastStatus(runtime)).toBe("Snapping on.");
	});

	test("the snapping.toggle action is registered and runnable", () => {
		const { runtime } = setup();
		expect(ACTION_HANDLERS["snapping.toggle"]).toBeDefined();
		expect(runAction("snapping.toggle", runtime)).toBe(true);
		expect(runtime.store.getState().snapEnabled).toBe(false);
	});
});

describe("drag snapper", () => {
	test("snaps a dragged clip start to a neighbour edge within 8 px", () => {
		const { a, b, runtime } = setup();
		const snapper = createDragSnapper(runtime, { exclude: [b.id] });
		const result = snapper(4.07);
		expect(result.time).toBe(4);
		expect(result.target).toMatchObject({ id: a.id, kind: "clip-end" });
		expect(runtime.store.getState().snapGuideTime).toBe(4);
	});

	test("misses beyond 8 px, quantizes to frames, and hides the guide", () => {
		const { b, runtime } = setup();
		const snapper = createDragSnapper(runtime, { exclude: [b.id] });
		snapper(4.07);
		const result = snapper(4.5);
		expect(result.target).toBeUndefined();
		expect(result.time).toBe(Math.round(4.5 * 30) / 30);
		expect(runtime.store.getState().snapGuideTime).toBeNull();
	});

	test("the threshold follows the timeline zoom", () => {
		const { b, runtime } = setup();
		runtime.zoom = 20;
		expect(createDragSnapper(runtime, { exclude: [b.id] })(4.35).time).toBe(4);
		runtime.zoom = 400;
		expect(
			createDragSnapper(runtime, { exclude: [b.id] })(4.035).target
		).toBeUndefined();
	});

	test("the dragged clip's linked partner is not a target", () => {
		const { b, runtime } = setup();
		const snapper = createDragSnapper(runtime, { exclude: [b.id] });
		// c (linked to b) starts at 6; only the playhead at 12 and a are left.
		expect(snapper(6.02).target).toBeUndefined();
	});

	test("Shift suspends snapping for the move", () => {
		const { b, runtime } = setup();
		const snapper = createDragSnapper(runtime, { exclude: [b.id] });
		const result = snapper(4.07, { shiftKey: true });
		expect(result.target).toBeUndefined();
		expect(result.time).toBe(Math.round(4.07 * 30) / 30);
		expect(runtime.store.getState().snapGuideTime).toBeNull();
	});

	test("with snapping off only frame quantization applies", () => {
		const { b, runtime } = setup();
		runtime.store.setState({ snapEnabled: false });
		const snapper = createDragSnapper(runtime, { exclude: [b.id] });
		expect(snapper(4.07).target).toBeUndefined();
		expect(runtime.store.getState().snapGuideTime).toBeNull();
	});

	test("the playhead wins over a clip edge in range", () => {
		const { b, runtime } = setup();
		runtime.time = 4.05;
		expect(createDragSnapper(runtime, { exclude: [b.id] })(4.02)).toMatchObject(
			{
				target: { kind: "playhead" },
				time: 4.05,
			}
		);
	});

	test("keyframes of the selected clip are opt-in targets", () => {
		const { a, b, runtime } = setup();
		const project = runtime.project;
		if (!project) {
			throw new Error("project missing");
		}
		runtime.project = {
			...project,
			segments: project.segments.map((segment) =>
				segment.id === a.id
					? {
							...segment,
							keyframes: [
								{
									id: crypto.randomUUID(),
									property: "opacity",
									time: 2.5,
									value: 1,
								},
							],
						}
					: segment
			),
		};
		runtime.store.setState({
			selection: { overlayIds: [], primaryId: a.id, segmentIds: [a.id] },
		});
		runtime.refresh();
		expect(
			createDragSnapper(runtime, { exclude: [b.id] })(2.52).target
		).toBeUndefined();
		expect(
			createDragSnapper(runtime, { exclude: [b.id], includeKeyframes: true })(
				2.52
			).target?.kind
		).toBe("keyframe");
	});

	test("snapDragTime is a one-shot snap that leaves no guide behind", () => {
		const { runtime } = setup();
		expect(snapDragTime(runtime, 10.05)).toBe(10);
		expect(runtime.store.getState().snapGuideTime).toBeNull();
		runtime.store.setState({ snapGuideTime: 3 });
		expect(snapDragTime(runtime, 10.05)).toBe(10);
		expect(runtime.store.getState().snapGuideTime).toBe(3);
	});

	test("snapDragTime honours Shift and the snapping toggle", () => {
		const { runtime } = setup();
		expect(snapDragTime(runtime, 10.05, { shiftKey: true })).toBe(
			Math.round(10.05 * 30) / 30
		);
		runtime.store.setState({ snapEnabled: false });
		expect(snapDragTime(runtime, 10.05)).toBe(Math.round(10.05 * 30) / 30);
	});

	test("clearSnapGuide hides the indicator after a drag", () => {
		const { b, runtime } = setup();
		createDragSnapper(runtime, { exclude: [b.id] })(4.07);
		expect(runtime.store.getState().snapGuideTime).toBe(4);
		clearSnapGuide(runtime);
		expect(runtime.store.getState().snapGuideTime).toBeNull();
	});

	test("excludeLinked: false keeps the linked partner as a target (Alt drag)", () => {
		const { b, c, runtime } = setup();
		const snapper = createDragSnapper(runtime, {
			exclude: [b.id],
			excludeLinked: false,
		});
		expect(snapper(6.02).target).toMatchObject({
			id: c.id,
			kind: "clip-start",
		});
	});

	test("includeOverlays: false drops overlay bounds", () => {
		const { b, runtime } = setup();
		const project = runtime.project;
		if (!project) {
			throw new Error("project missing");
		}
		runtime.project = {
			...project,
			titles: [
				{
					animation: "fade",
					color: "#ffffff",
					end: 17,
					fadeIn: 0,
					fadeOut: 0,
					fontSize: 0.08,
					id: crypto.randomUUID(),
					start: 15,
					text: "Lower third",
					x: 0.5,
					y: 0.5,
				},
			],
		};
		runtime.refresh();
		expect(
			createDragSnapper(runtime, { exclude: [b.id] })(15.05).target?.kind
		).toBe("overlay-start");
		expect(
			createDragSnapper(runtime, { exclude: [b.id], includeOverlays: false })(
				15.05
			).target
		).toBeUndefined();
	});

	test("keyframeOwnerId overrides the selection as keyframe owner", () => {
		const { a, b, runtime } = setup();
		const project = runtime.project;
		if (!project) {
			throw new Error("project missing");
		}
		runtime.project = {
			...project,
			segments: project.segments.map((segment) =>
				segment.id === a.id
					? {
							...segment,
							keyframes: [
								{
									id: crypto.randomUUID(),
									property: "opacity",
									time: 2.5,
									value: 1,
								},
							],
						}
					: segment
			),
		};
		runtime.refresh();
		expect(runtime.selectedId).toBeNull();
		expect(
			createDragSnapper(runtime, { exclude: [b.id], includeKeyframes: true })(
				2.52
			).target
		).toBeUndefined();
		expect(
			createDragSnapper(runtime, {
				exclude: [b.id],
				includeKeyframes: true,
				keyframeOwnerId: a.id,
			})(2.52).target?.kind
		).toBe("keyframe");
	});

	test("without a project it only quantizes", () => {
		const runtime = createTestRuntime(null);
		runtime.zoom = 100;
		expect(snapDragTime(runtime, 1.01)).toBe(1);
	});
});
