import { describe, expect, test } from "bun:test";
import {
	deleteOverlay,
	duplicateOverlay,
	editOverlay,
	minOverlayDuration,
	moveOverlay,
	OVERLAY_LANE_COUNT,
	OVERLAY_TIMELINE_LIMIT,
	overlayChannelValue,
	overlayEditRequestSchema,
	overlayLaneLayout,
	overlayLaneOf,
	rebaseOverlayKeyframes,
	trimOverlay,
} from "./overlay-edits.ts";
import {
	type Avatar,
	activeCaptions,
	type Caption,
	type Graphic,
	newProject,
	type Project,
	type Title,
	validateProject,
} from "./project.ts";
import type { AdjustmentLayer } from "./schema/adjustment.ts";
import type { Keyframe } from "./schema/keyframe.ts";

function title(start: number, end: number, extra: Partial<Title> = {}): Title {
	return {
		animation: "fade",
		color: "#ffffff",
		end,
		fadeIn: 0.25,
		fadeOut: 0.25,
		fontSize: 0.06,
		id: crypto.randomUUID(),
		start,
		text: "Hello",
		x: 0.5,
		y: 0.5,
		...extra,
	};
}

function graphic(
	start: number,
	end: number,
	extra: Partial<Graphic> = {}
): Graphic {
	return {
		animation: "none",
		end,
		entryDuration: 0.35,
		fill: "#ff0000",
		height: 0.2,
		id: crypto.randomUUID(),
		opacity: 1,
		shape: "rectangle",
		start,
		stroke: "#ffffff",
		strokeWidth: 0,
		width: 0.2,
		x: 0.5,
		y: 0.5,
		...extra,
	};
}

function avatar(start: number, end: number): Avatar {
	return {
		accent: "#00ff00",
		animation: "idle",
		depth: 0.45,
		end,
		entryDuration: 0.35,
		height: 0.5,
		id: crypto.randomUUID(),
		outfit: "#0000ff",
		pose: "neutral",
		skin: "#ffcc99",
		start,
		width: 0.3,
		x: 0.5,
		y: 0.5,
	};
}

function layer(start: number, end: number): AdjustmentLayer {
	return {
		end,
		id: crypto.randomUUID(),
		label: "Grade",
		opacity: 1,
		start,
		track: 0,
	};
}

function caption(start: number, end: number, text = "one two"): Caption {
	const [first = "one", second = "two"] = text.split(" ");
	const middle = (start + end) / 2;
	return {
		end,
		id: crypto.randomUUID(),
		start,
		text,
		words: [
			{ end: middle, id: crypto.randomUUID(), start, text: first },
			{ end, id: crypto.randomUUID(), start: middle, text: second },
		],
	};
}

const keyframe = (
	time: number,
	value: number,
	property: Keyframe["property"] = "opacity"
): Keyframe => ({ id: crypto.randomUUID(), property, time, value });

function project(extra: Partial<Project> = {}): Project {
	return { ...newProject("Overlays"), ...extra };
}

describe("moveOverlay", () => {
	test("moving a title keeps its duration and keyframes", () => {
		const item = title(1, 3, { keyframes: [keyframe(0.5, 0.4)] });
		const next = moveOverlay(project({ titles: [item] }), {
			id: item.id,
			kind: "titles",
			start: 4,
		});
		expect(next.titles[0]).toMatchObject({ end: 6, start: 4 });
		expect(next.titles[0]?.keyframes).toEqual(item.keyframes);
		expect(() => validateProject(next, [])).not.toThrow();
	});

	test("moves clamp to the start of the timeline", () => {
		const item = graphic(1, 3);
		const next = moveOverlay(project({ graphics: [item] }), {
			id: item.id,
			kind: "graphics",
			start: -5,
		});
		expect(next.graphics[0]).toMatchObject({ end: 2, start: 0 });
	});

	test("an unchanged move returns the same project", () => {
		const item = title(1, 3);
		const before = project({ titles: [item] });
		expect(moveOverlay(before, { id: item.id, kind: "titles", start: 1 })).toBe(
			before
		);
	});

	test("captions move within the active track, words included", () => {
		const legacy = caption(0, 1);
		const active = caption(2, 4);
		const other = caption(2, 4);
		const trackId = crypto.randomUUID();
		const otherTrackId = crypto.randomUUID();
		const before = project({
			captions: [legacy],
			captionTrackId: trackId,
			captionTracks: [
				{ captions: [active], id: trackId, label: "EN", language: "en" },
				{ captions: [other], id: otherTrackId, label: "FR", language: "fr" },
			],
		});
		const next = moveOverlay(before, {
			id: active.id,
			kind: "captions",
			start: 5,
		});
		const moved = activeCaptions(next)[0];
		expect(moved).toMatchObject({ end: 7, start: 5 });
		expect(moved?.words?.map((word) => [word.start, word.end])).toEqual([
			[5, 6],
			[6, 7],
		]);
		expect(next.captions).toEqual([legacy]);
		expect(next.captionTracks[1]?.captions).toEqual([other]);
		expect(() => validateProject(next, [])).not.toThrow();
	});

	test("an id on another caption track is not found", () => {
		const other = caption(2, 4);
		const trackId = crypto.randomUUID();
		const before = project({
			captionTrackId: trackId,
			captionTracks: [
				{ captions: [], id: trackId, label: "EN", language: "en" },
				{
					captions: [other],
					id: crypto.randomUUID(),
					label: "FR",
					language: "fr",
				},
			],
		});
		expect(() =>
			moveOverlay(before, { id: other.id, kind: "captions", start: 0 })
		).toThrow("Overlay item not found.");
	});

	test("moved captions stay sorted by start", () => {
		const a = caption(0, 1);
		const b = caption(2, 3);
		const next = moveOverlay(project({ captions: [a, b] }), {
			id: a.id,
			kind: "captions",
			start: 5,
		});
		expect(next.captions.map((cue) => cue.id)).toEqual([b.id, a.id]);
	});

	test("lane assignment sets the lane of titles and graphics only", () => {
		const item = title(0, 2);
		const next = moveOverlay(project({ titles: [item] }), {
			id: item.id,
			kind: "titles",
			lane: 3,
			start: 0,
		});
		expect(next.titles[0]?.lane).toBe(3);
		expect(overlayLaneOf(next.titles[0] ?? {})).toBe(3);
		const unchanged = moveOverlay(project({ titles: [item] }), {
			id: item.id,
			kind: "titles",
			lane: 0,
			start: 1,
		});
		expect("lane" in (unchanged.titles[0] ?? {})).toBe(false);
		const person = avatar(0, 2);
		expect(() =>
			moveOverlay(project({ avatars: [person] }), {
				id: person.id,
				kind: "avatars",
				lane: 1,
				start: 0,
			})
		).toThrow("Only titles and graphics sit on overlay lanes.");
		expect(() =>
			moveOverlay(project({ titles: [item] }), {
				id: item.id,
				kind: "titles",
				lane: OVERLAY_LANE_COUNT,
				start: 0,
			})
		).toThrow();
	});

	test("snapping sticks the end to a marker and keeps the duration", () => {
		const item = title(0, 2);
		const before = project({
			markers: [{ id: crypto.randomUUID(), label: "Beat", time: 5 }],
			titles: [item],
		});
		// End would land at 4.95; 0.05 s is 5 px at 100 px/s, inside 8 px.
		const next = moveOverlay(
			before,
			{ id: item.id, kind: "titles", start: 2.95 },
			{ snap: { pxPerSec: 100 } }
		);
		expect(next.titles[0]).toMatchObject({ end: 5, start: 3 });
	});

	test("snapping without a target quantizes to the frame grid", () => {
		const item = title(0, 2);
		const next = moveOverlay(
			project({ titles: [item] }),
			{ id: item.id, kind: "titles", start: 1.01 },
			{ snap: { pxPerSec: 10_000 } }
		);
		expect(next.titles[0]?.start).toBeCloseTo(1, 9);
	});

	test("an overlay never snaps to itself", () => {
		const item = graphic(0, 2);
		const next = moveOverlay(
			project({ graphics: [item] }),
			{ id: item.id, kind: "graphics", start: 0.02 },
			{ snap: { pxPerSec: 100 } }
		);
		// 0.02 s from its own old start would capture if it were a target;
		// the frame grid moves it to 0.033 instead.
		expect(next.graphics[0]?.start).toBeCloseTo(1 / 30, 9);
	});
});

describe("trimOverlay", () => {
	test("trim clamps so start stays before end", () => {
		const item = title(1, 3, { fadeIn: 0, fadeOut: 0 });
		const base = project({ titles: [item] });
		const minimum = minOverlayDuration(base.fps);
		const head = trimOverlay(base, {
			edge: "start",
			id: item.id,
			kind: "titles",
			time: 10,
		});
		expect(head.titles[0]?.start).toBeCloseTo(3 - minimum, 9);
		expect(head.titles[0]?.end).toBe(3);
		const tail = trimOverlay(base, {
			edge: "end",
			id: item.id,
			kind: "titles",
			time: 0,
		});
		expect(tail.titles[0]?.start).toBe(1);
		expect(tail.titles[0]?.end).toBeCloseTo(1 + minimum, 9);
		for (const next of [head, tail]) {
			const trimmed = next.titles[0];
			expect(trimmed && trimmed.start < trimmed.end).toBe(true);
			expect(() => validateProject(next, [])).not.toThrow();
		}
	});

	test("the head never moves before zero", () => {
		const item = graphic(1, 3);
		const next = trimOverlay(project({ graphics: [item] }), {
			edge: "start",
			id: item.id,
			kind: "graphics",
			time: -2,
		});
		expect(next.graphics[0]).toMatchObject({ end: 3, start: 0 });
	});

	test("title fades shrink to fit a shorter title", () => {
		const item = title(0, 4, { fadeIn: 1.5, fadeOut: 0.5 });
		const next = trimOverlay(project({ titles: [item] }), {
			edge: "end",
			id: item.id,
			kind: "titles",
			time: 1,
		});
		const trimmed = next.titles[0];
		expect(trimmed?.fadeIn).toBeCloseTo(0.75, 5);
		expect(
			(trimmed?.fadeIn ?? 0) + (trimmed?.fadeOut ?? 0)
		).toBeLessThanOrEqual(1);
		expect(() => validateProject(next, [])).not.toThrow();
	});

	test("graphic and avatar entries fit the trimmed span", () => {
		const shape = graphic(0, 2, { entryDuration: 1 });
		const person = avatar(0, 2);
		const base = project({ avatars: [person], graphics: [shape] });
		const next = trimOverlay(
			trimOverlay(base, {
				edge: "end",
				id: shape.id,
				kind: "graphics",
				time: 0.5,
			}),
			{ edge: "end", id: person.id, kind: "avatars", time: 0.2 }
		);
		expect(next.graphics[0]?.entryDuration).toBe(0.5);
		expect(next.avatars[0]?.entryDuration).toBeCloseTo(0.2, 9);
		expect(() => validateProject(next, [])).not.toThrow();
	});

	test("head trims re-base keyframes onto the same timeline moment", () => {
		const item = graphic(0, 4, {
			keyframes: [keyframe(0, 0), keyframe(2, 1), keyframe(4, 0.5)],
		});
		const next = trimOverlay(project({ graphics: [item] }), {
			edge: "start",
			id: item.id,
			kind: "graphics",
			time: 1,
		});
		const frames = next.graphics[0]?.keyframes ?? [];
		expect(frames.map((frame) => [frame.time, frame.value])).toEqual([
			[0, 0.5],
			[1, 1],
			[3, 0.5],
		]);
		expect(() => validateProject(next, [])).not.toThrow();
	});

	test("tail trims add a boundary keyframe and drop later ones", () => {
		const frames = rebaseOverlayKeyframes(
			[keyframe(0, 0), keyframe(4, 1)],
			0,
			2
		);
		expect(frames.map((frame) => [frame.time, frame.value])).toEqual([
			[0, 0],
			[2, 0.5],
		]);
	});

	test("trims through hold and eased intervals keep every sampled value", () => {
		const curves: Partial<Keyframe>[] = [
			{ interpolation: "hold" },
			{ interpolation: "ease-in" },
			{ interpolation: "ease-out" },
			{ interpolation: "ease-in-out" },
			{ bezier: [0.2, 0.9, 0.4, 1], interpolation: "bezier" },
		];
		const cuts: [number, number][] = [
			[1, 3], // head trim through the first interval
			[0, 1.25], // tail trim through the first interval
			[0.5, 2.5], // both edges inside eased intervals
		];
		for (const curve of curves) {
			const original = [
				{ ...keyframe(0, 0), ...curve },
				{ ...keyframe(2, 1), ...curve },
				keyframe(4, 0.2),
			];
			for (const [shift, duration] of cuts) {
				const rebased = rebaseOverlayKeyframes(original, shift, duration);
				for (let i = 0; i <= 40; i++) {
					const at = (duration * i) / 40;
					expect(overlayChannelValue(rebased, at)).toBeCloseTo(
						overlayChannelValue(original, at + shift),
						3
					);
				}
			}
		}
	});

	test("a head trim inside a hold keeps the held value", () => {
		const frames = rebaseOverlayKeyframes(
			[{ ...keyframe(0, 0), interpolation: "hold" }, keyframe(2, 1)],
			1,
			3
		);
		expect(
			frames.map((frame) => [frame.time, frame.value, frame.interpolation])
		).toEqual([
			[0, 0, "hold"],
			[1, 1, undefined],
		]);
	});

	test("an ease-in tail trim stores the eased value and a re-fitted curve", () => {
		const frames = rebaseOverlayKeyframes(
			[{ ...keyframe(0, 0), interpolation: "ease-in" }, keyframe(2, 1)],
			0,
			1
		);
		expect(frames.map((frame) => [frame.time, frame.value])).toEqual([
			[0, 0],
			[1, 0.25],
		]);
		// The first half of u² rescaled to its own box is still u².
		expect(frames[0]?.interpolation).toBe("ease-in");
		expect(overlayChannelValue(frames, 0.5)).toBeCloseTo(0.0625, 6);
	});

	test("extending an item leaves keyframes where they were", () => {
		const frames = [keyframe(0, 0), keyframe(1, 1)];
		expect(rebaseOverlayKeyframes(frames, -1, 3)).toEqual(
			frames.map((frame) => ({ ...frame, time: frame.time + 1 }))
		);
	});

	test("caption head trims clamp words, and swallowed words drop alignment", () => {
		const cue = caption(0, 2);
		const base = project({ captions: [cue] });
		const clipped = trimOverlay(base, {
			edge: "start",
			id: cue.id,
			kind: "captions",
			time: 0.5,
		});
		expect(clipped.captions[0]?.words?.[0]?.start).toBe(0.5);
		expect(() => validateProject(clipped, [])).not.toThrow();
		const swallowed = trimOverlay(base, {
			edge: "start",
			id: cue.id,
			kind: "captions",
			time: 1.5,
		});
		expect(swallowed.captions[0]?.words).toBeUndefined();
		expect(swallowed.captions[0]?.text).toBe("one two");
		expect(() => validateProject(swallowed, [])).not.toThrow();
	});

	test("snapped trims stick the edge to the playhead", () => {
		const item = layer(0, 2);
		const next = trimOverlay(
			project({ adjustmentLayers: [item] }),
			{ edge: "end", id: item.id, kind: "adjustmentLayers", time: 3.04 },
			{ snap: { pxPerSec: 100, time: 3 } }
		);
		expect(next.adjustmentLayers?.[0]?.end).toBe(3);
	});
});

describe("delete and duplicate", () => {
	test("delete removes only the named item", () => {
		const keep = title(0, 1);
		const drop = title(1, 2);
		const next = deleteOverlay(project({ titles: [keep, drop] }), {
			id: drop.id,
			kind: "titles",
		});
		expect(next.titles).toEqual([keep]);
		expect(() => deleteOverlay(next, { id: drop.id, kind: "titles" })).toThrow(
			"Overlay item not found."
		);
	});

	test("duplicate places a copy right after the original with fresh ids", () => {
		const item = graphic(1, 3, {
			keyframes: [keyframe(1, 0.5)],
			lane: 2,
		});
		const { id, project: next } = duplicateOverlay(
			project({ graphics: [item] }),
			{ id: item.id, kind: "graphics" }
		);
		const copy = next.graphics.find((candidate) => candidate.id === id);
		expect(id).not.toBe(item.id);
		expect(copy).toMatchObject({ end: 5, lane: 2, start: 3 });
		expect(copy?.keyframes?.[0]?.id).not.toBe(item.keyframes?.[0]?.id);
		expect(next.graphics).toHaveLength(2);
		expect(() => validateProject(next, [])).not.toThrow();
	});

	test("duplicate at a time re-times caption words", () => {
		const cue = caption(0, 2);
		const { id, project: next } = duplicateOverlay(
			project({ captions: [cue] }),
			{ id: cue.id, kind: "captions" },
			10
		);
		const copy = next.captions.find((candidate) => candidate.id === id);
		expect(copy?.words?.map((word) => word.start)).toEqual([10, 11]);
		expect(copy?.words?.[0]?.id).not.toBe(cue.words?.[0]?.id);
		expect(() => validateProject(next, [])).not.toThrow();
	});

	test("duplicate refuses to run past two hours", () => {
		const item = title(7000, 7199);
		expect(() =>
			duplicateOverlay(project({ titles: [item] }), {
				id: item.id,
				kind: "titles",
			})
		).toThrow("two-hour");
	});

	test("avatars and adjustment layers duplicate with fresh ids", () => {
		const person = {
			...avatar(0, 2),
			rigKeyframes: [
				{
					id: crypto.randomUUID(),
					property: "head" as const,
					time: 1,
					value: 10,
				},
			],
		};
		const grade = layer(0, 2);
		const base = project({ adjustmentLayers: [grade], avatars: [person] });
		const first = duplicateOverlay(base, { id: person.id, kind: "avatars" });
		const second = duplicateOverlay(first.project, {
			id: grade.id,
			kind: "adjustmentLayers",
		});
		expect(second.project.avatars[1]?.rigKeyframes?.[0]?.id).not.toBe(
			person.rigKeyframes[0]?.id
		);
		expect(second.project.adjustmentLayers?.[1]).toMatchObject({
			end: 4,
			start: 2,
		});
		expect(() => validateProject(second.project, [])).not.toThrow();
	});
});

describe("overlayLaneLayout", () => {
	test("explicit lanes are kept and the rest pack into free rows", () => {
		const a = title(0, 4);
		const b = title(1, 3);
		const c = title(5, 6);
		const pinned = title(0, 6, { lane: 2 });
		const layout = overlayLaneLayout(
			project({ titles: [pinned, c, b, a] }),
			"titles"
		);
		const rows = Object.fromEntries(
			layout.items.map((item) => [item.id, item.row])
		);
		expect(rows).toEqual({ [a.id]: 0, [b.id]: 1, [c.id]: 0, [pinned.id]: 2 });
		expect(layout.rows).toBe(3);
	});

	test("overlapping items on the same explicit lane are drawn on separate rows", () => {
		const first = title(0, 4, { lane: 0 });
		const second = title(1, 3, { lane: 0 });
		const later = title(5, 6, { lane: 0 });
		const layout = overlayLaneLayout(
			project({ titles: [second, later, first] }),
			"titles"
		);
		const rows = Object.fromEntries(
			layout.items.map((item) => [item.id, item.row])
		);
		expect(rows).toEqual({ [first.id]: 0, [later.id]: 0, [second.id]: 1 });
		expect(layout.rows).toBe(2);
	});

	test("an empty kind still has one row", () => {
		expect(overlayLaneLayout(project(), "adjustmentLayers")).toEqual({
			items: [],
			kind: "adjustmentLayers",
			rows: 1,
		});
	});

	test("captions read from the active track", () => {
		const cue = caption(0, 1);
		const trackId = crypto.randomUUID();
		const layout = overlayLaneLayout(
			project({
				captions: [caption(3, 4)],
				captionTrackId: trackId,
				captionTracks: [
					{ captions: [cue], id: trackId, label: "EN", language: "en" },
				],
			}),
			"captions"
		);
		expect(layout.items.map((item) => item.id)).toEqual([cue.id]);
	});
});

describe("editOverlay", () => {
	test("dragging a title on its lane updates start and end", () => {
		const item = title(1, 3);
		const result = editOverlay(project({ titles: [item] }), [], {
			id: item.id,
			kind: "titles",
			lane: 1,
			op: "move",
			start: 2.5,
		});
		expect(result.id).toBe(item.id);
		expect(result.project.titles[0]).toMatchObject({
			end: 4.5,
			lane: 1,
			start: 2.5,
		});
	});

	test("moves to the two-hour limit clamp and validate for any duration", () => {
		for (const duration of [0.1, 1 / 3, 0.7, 1.1, 2.2, 1 / 7]) {
			const item = title(0, duration, { fadeIn: 0, fadeOut: 0 });
			const base = validateProject(project({ titles: [item] }), []);
			const result = editOverlay(base, [], {
				id: item.id,
				kind: "titles",
				op: "move",
				start: OVERLAY_TIMELINE_LIMIT,
			});
			const moved = result.project.titles[0];
			expect(moved?.end).toBeLessThanOrEqual(OVERLAY_TIMELINE_LIMIT);
			expect(moved?.start).toBeCloseTo(OVERLAY_TIMELINE_LIMIT - duration, 5);
			expect(moved && moved.end - moved.start >= duration - 1e-12).toBeTruthy();
		}
	});

	test("duplicates placed at the two-hour limit clamp and validate", () => {
		for (const duration of [1 / 3, 0.7, 2.2]) {
			const item = title(0, duration, { fadeIn: 0, fadeOut: 0 });
			const base = validateProject(project({ titles: [item] }), []);
			const result = editOverlay(base, [], {
				at: OVERLAY_TIMELINE_LIMIT - duration,
				id: item.id,
				kind: "titles",
				op: "duplicate",
			});
			const copy = result.project.titles.find(
				(candidate) => candidate.id === result.id
			);
			expect(copy?.end).toBeLessThanOrEqual(OVERLAY_TIMELINE_LIMIT);
		}
	});

	test("a move or trim that changes nothing returns the input project", () => {
		const item = title(0, 2);
		const base = validateProject(project({ titles: [item] }), []);
		const ref = { id: item.id, kind: "titles" as const };
		expect(
			editOverlay(base, [], { ...ref, op: "move", start: 0 }).project
		).toBe(base);
		expect(
			editOverlay(base, [], { ...ref, edge: "end", op: "trim", time: 2 })
				.project
		).toBe(base);
	});

	test("delete returns no id and duplicate returns the copy", () => {
		const item = title(1, 3);
		const base = project({ titles: [item] });
		expect(
			editOverlay(base, [], { id: item.id, kind: "titles", op: "delete" })
		).toEqual({ project: { ...base, titles: [] } });
		const copy = editOverlay(base, [], {
			at: 10,
			id: item.id,
			kind: "titles",
			op: "duplicate",
		});
		expect(copy.project.titles.find((t) => t.id === copy.id)?.start).toBe(10);
	});

	test("the request contract is strict and needs a revision", () => {
		const id = crypto.randomUUID();
		expect(
			overlayEditRequestSchema.safeParse({
				id,
				kind: "titles",
				op: "move",
				start: 1,
			}).success
		).toBe(false);
		expect(
			overlayEditRequestSchema.safeParse({
				extra: true,
				id,
				kind: "titles",
				op: "delete",
				revision: 1,
			}).success
		).toBe(false);
		expect(
			overlayEditRequestSchema.safeParse({
				edge: "middle",
				id,
				kind: "titles",
				op: "trim",
				revision: 1,
				time: 1,
			}).success
		).toBe(false);
		expect(
			overlayEditRequestSchema.safeParse({
				edge: "end",
				id,
				kind: "captions",
				op: "trim",
				revision: 1,
				snap: { pxPerSec: 80 },
				time: 1,
			}).success
		).toBe(true);
	});
});
