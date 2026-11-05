import { describe, expect, test } from "bun:test";
import { buildRender } from "../sidecar/src/render.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Segment,
	splitSegment,
	trackSettingFor,
} from "./project.ts";
import {
	applyRevealTransition,
	clipMotion,
	clipMotionAt,
	cutNear,
	cutPredecessor,
	DEFAULT_EXIT_DURATION,
	entryOpacity,
	entryScale,
	entryShift,
	exitDurationOf,
	exitFades,
} from "./transitions.ts";

const asset: Asset = {
	id: crypto.randomUUID(),
	kind: "video",
	name: "Clip",
	duration: 4,
	width: 320,
	height: 180,
	hasAudio: false,
	createdAt: new Date().toISOString(),
};
test("entry transitions use timeline seconds in all four directions", () => {
	for (const [kind, axis, sign] of [
		["slide-left", "x", 1],
		["slide-right", "x", -1],
		["slide-up", "y", 1],
		["slide-down", "y", -1],
	] as const) {
		const clip = {
			...newSegment(asset),
			speed: 2,
			entryTransition: kind,
			entryDuration: 1,
		};
		expect(entryShift(clip, 0, axis)).toBe(sign);
		expect(entryShift(clip, 0.25, axis)).toBe(sign * 0.75);
		expect(entryShift(clip, 1, axis)).toBeCloseTo(0);
		expect(entryShift(clip, 3, axis)).toBeCloseTo(0);
	}
});
test("splitting during a slide preserves position on both sides of the cut", () => {
	const clip = {
		...newSegment(asset, 2),
		entryTransition: "slide-left" as const,
		entryDuration: 2,
	};
	const [left, right] = splitSegment(clip, 2.5);
	expect(entryShift(left, 0.49, "x")).toBe(entryShift(clip, 0.49, "x"));
	expect(entryShift(right, 0, "x")).toBe(entryShift(clip, 0.5, "x"));
	expect(entryShift(right, 0.75, "x")).toBe(entryShift(clip, 1.25, "x"));
	expect(entryShift({ ...clip, entryDuration: 0 }, 0, "x")).toBe(0);
});

test("crossfade and zoom transitions use the same bounded entry clock", () => {
	const crossfade = {
		...newSegment(asset),
		entryDuration: 1,
		entryTransition: "crossfade" as const,
	};
	expect(entryOpacity(crossfade, 0)).toBe(0);
	expect(entryOpacity(crossfade, 0.5)).toBe(0.5);
	expect(entryOpacity(crossfade, 1)).toBe(1);
	const zoomIn = { ...crossfade, entryTransition: "zoom-in" as const };
	const zoomOut = { ...crossfade, entryTransition: "zoom-out" as const };
	expect(entryScale(zoomIn, 0)).toBeCloseTo(0.85);
	expect(entryScale(zoomIn, 1)).toBeCloseTo(1);
	expect(entryScale(zoomOut, 0)).toBeCloseTo(1.15);
	expect(entryScale(zoomOut, 1)).toBeCloseTo(1);
});

test("FFmpeg graph emits crossfade and zoom entry effects", () => {
	const crossfade = {
		...newSegment(asset),
		entryDuration: 1,
		entryTransition: "crossfade" as const,
	};
	const zoom = {
		...newSegment(asset, 1),
		entryDuration: 1,
		entryTransition: "zoom-in" as const,
	};
	const args = buildRender(
		{ ...newProject("Transition graph"), segments: [crossfade, zoom] },
		[asset],
		(id) => `/tmp/${id}`
	);
	const filter = args[args.indexOf("-filter_complex") + 1] ?? "";
	expect(filter).toContain("fade=t=in:st=0:d=1:alpha=1");
	expect(filter).toContain("0.85+0.15*clip");
});

const still: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 5,
	hasAudio: false,
	height: 180,
	id: "00000000-0000-4000-8000-0000000000c1",
	kind: "image",
	name: "Card",
	width: 320,
};
const footage: Asset = {
	...asset,
	duration: 10,
	id: "00000000-0000-4000-8000-0000000000c2",
};

/** Two clips cut at 4 s on track 0: A plays source 0–4, B plays source 3–7. */
function cut(media: Asset = footage) {
	const a = { ...newSegment(media, 0), sourceIn: 0, sourceOut: 4 };
	const b = { ...newSegment(media, 4), sourceIn: 3, sourceOut: 7 };
	const project = { ...newProject("Cut"), segments: [a, b] };
	return { a, b, project };
}
const byId = (project: { segments: Segment[] }, id: string) => {
	const found = project.segments.find((segment) => segment.id === id);
	if (!found) {
		throw new Error("clip missing");
	}
	return found;
};

describe("exit transitions", () => {
	test("exits default their duration and mirror the entry set at the clip end", () => {
		const clip = { ...newSegment(footage), sourceOut: 4 };
		expect(exitDurationOf(clip)).toBe(0);
		const slide = { ...clip, exitTransition: "slide-left" as const };
		expect(exitDurationOf(slide)).toBe(DEFAULT_EXIT_DURATION);
		expect(clipMotionAt(slide, 3).shiftX).toBeCloseTo(0);
		expect(clipMotionAt(slide, 4).shiftX).toBeCloseTo(-1);
		expect(
			clipMotionAt({ ...clip, exitTransition: "slide-up" }, 4).shiftY
		).toBeCloseTo(-1);
		const fade = {
			...clip,
			exitDuration: 1,
			exitTransition: "crossfade" as const,
		};
		expect(exitFades(fade)).toBe(true);
		expect(clipMotionAt(fade, 3.5).opacity).toBeCloseTo(0.5);
		const shrink = {
			...clip,
			exitDuration: 1,
			exitTransition: "zoom-in" as const,
		};
		expect(clipMotionAt(shrink, 4).scale).toBeCloseTo(0.85);
		expect(exitFades(shrink)).toBe(false);
		expect(exitFades({ ...shrink, exitTransition: "zoom-out" })).toBe(true);
		expect(exitDurationOf({ ...clip, exitTransition: "none" })).toBe(0);
	});

	test("an unset exit duration never exceeds a clip shorter than the default", () => {
		const short = {
			...newSegment(still),
			exitTransition: "crossfade" as const,
			sourceOut: 0.3,
		};
		expect(exitDurationOf(short)).toBeCloseTo(0.3);
		expect(clipMotionAt(short, 0).opacity).toBeCloseTo(1);
		const project = { ...newProject("Short"), segments: [short] };
		const args = buildRender(project, [still], (id) => `/tmp/${id}`);
		const filter = args[args.indexOf("-filter_complex") + 1] ?? "";
		expect(filter).toContain("fade=t=out:st=0:d=0.3:alpha=1");
		expect(filter).not.toContain("(-");
	});
});

describe("clip motion", () => {
	test("combines reveal, exit and animation curves", () => {
		const clip: Segment = {
			...newSegment(footage),
			animation: { loop: "pulse" },
			sourceOut: 4,
			transitionIn: { duration: 1, softness: 0, type: "zoom" },
		};
		const start = clipMotionAt(clip, 0);
		expect(start.scale).toBeCloseTo(0.6);
		expect(start.opacity).toBe(0);
		expect(clipMotionAt(clip, 1).opacity).toBe(1);
		const wipe = {
			...clip,
			animation: undefined,
			transitionIn: { duration: 1, softness: 0, type: "wipe-left" as const },
		};
		// Shaped reveals are per-pixel, never part of the whole-frame alpha.
		expect(clipMotionAt(wipe, 0.2).opacity).toBe(1);
		const legacy = { ...newSegment(footage), sourceOut: 4 };
		expect(clipMotion(legacy, 4)).toEqual({
			blur: 0,
			opacity: 1,
			rotation: 0,
			scale: 1,
			shiftX: 0,
			shiftY: 0,
		});
	});
});

describe("applying a reveal transition to a cut", () => {
	test("extends the incoming head left like a roll and keeps the program length", () => {
		const { a, b, project } = cut();
		const next = applyRevealTransition(project, [footage], b.id, {
			duration: 1,
			softness: 0,
			type: "wipe-left",
		});
		const incoming = byId(next, b.id);
		expect(incoming.start).toBe(3);
		expect(incoming.sourceIn).toBe(2);
		expect(incoming.sourceOut).toBe(7);
		expect(incoming.transitionIn?.type).toBe("wipe-left");
		expect(byId(next, a.id)).toEqual(a);
	});

	test("an existing overlap is reused and only the shortfall is added", () => {
		const { a, b, project } = cut();
		const overlapped = {
			...project,
			segments: [a, { ...b, sourceIn: 2.5, start: 3.5 }],
		};
		const next = applyRevealTransition(overlapped, [footage], b.id, {
			duration: 0.5,
			softness: 0,
			type: "dissolve",
		});
		expect(byId(next, b.id).start).toBe(3.5);
		const longer = applyRevealTransition(next, [footage], b.id, {
			duration: 1.5,
			softness: 0,
			type: "dissolve",
		});
		expect(byId(longer, b.id).start).toBe(2.5);
		expect(byId(longer, b.id).transitionIn?.duration).toBe(1.5);
	});

	test("falls back to the outgoing tail when the incoming has no head media", () => {
		const { a, b, project } = cut();
		const atZero = {
			...project,
			segments: [a, { ...b, sourceIn: 0, sourceOut: 4 }],
		};
		const next = applyRevealTransition(atZero, [footage], b.id, {
			duration: 1,
			softness: 0,
			type: "dissolve",
		});
		expect(byId(next, b.id).start).toBe(4);
		expect(byId(next, a.id).sourceOut).toBe(5);
	});

	test("stills extend without source limits and keep keyframes in place", () => {
		const { a, b, project } = cut(still);
		const keyed = {
			...b,
			keyframes: [
				{ id: crypto.randomUUID(), property: "x" as const, time: 0, value: 0 },
				{ id: crypto.randomUUID(), property: "x" as const, time: 2, value: 1 },
			],
			sourceIn: 0,
		};
		const next = applyRevealTransition(
			{ ...project, segments: [a, keyed] },
			[still],
			b.id,
			{ duration: 1, softness: 0, type: "dissolve" }
		);
		const incoming = byId(next, b.id);
		expect(incoming.start).toBe(3);
		expect(incoming.sourceOut).toBe(8);
		// The keyframe at the old start (t=0) now sits 1 s into the clip.
		expect(
			incoming.keyframes.some((frame) => frame.time === 1 && frame.value === 0)
		).toBe(true);
		expect(
			incoming.keyframes.some((frame) => frame.time === 3 && frame.value === 1)
		).toBe(true);
	});

	test("refuses without enough media on either side, without a predecessor, or on a locked track", () => {
		const { a, b, project } = cut();
		const tight = {
			...project,
			segments: [
				{ ...a, sourceOut: 10, sourceIn: 6 },
				{ ...b, sourceIn: 0, sourceOut: 4 },
			],
		};
		expect(() =>
			applyRevealTransition(tight, [footage], b.id, {
				duration: 1,
				softness: 0,
				type: "dissolve",
			})
		).toThrow(/extra media/);
		const alone = { ...project, segments: [b] };
		expect(() =>
			applyRevealTransition(alone, [footage], b.id, {
				duration: 1,
				softness: 0,
				type: "dissolve",
			})
		).toThrow(/right after another clip/);
		const locked = {
			...project,
			trackSettings: [{ ...trackSettingFor(project, 0), locked: true }],
		};
		expect(() =>
			applyRevealTransition(locked, [footage], b.id, {
				duration: 1,
				softness: 0,
				type: "dissolve",
			})
		).toThrow(/Unlock/);
	});

	test("a push pairs the outgoing exit, and changing or removing it clears the pair", () => {
		const { a, b, project } = cut();
		const pushed = applyRevealTransition(project, [footage], b.id, {
			duration: 1,
			softness: 0,
			type: "push-left",
		});
		expect(byId(pushed, a.id).exitTransition).toBe("slide-left");
		expect(byId(pushed, a.id).exitDuration).toBe(1);
		const wiped = applyRevealTransition(pushed, [footage], b.id, {
			duration: 1,
			softness: 0,
			type: "wipe-up",
		});
		expect(byId(wiped, a.id).exitTransition).toBeUndefined();
		expect("exitDuration" in byId(wiped, a.id)).toBe(false);
		const removed = applyRevealTransition(
			applyRevealTransition(project, [footage], b.id, {
				duration: 1,
				softness: 0,
				type: "push-right",
			}),
			[footage],
			b.id,
			null
		);
		expect("transitionIn" in byId(removed, b.id)).toBe(false);
		expect(byId(removed, a.id).exitTransition).toBeUndefined();
		// The overlap stays: the incoming clip covers the outgoing tail.
		expect(byId(removed, b.id).start).toBe(3);
	});

	test("linked visual partners extend; linked audio stays at the cut without same-track overlap", () => {
		const { a, b, project } = cut();
		const group = "00000000-0000-4000-8000-0000000000e1";
		const sound: Asset = {
			...footage,
			hasAudio: true,
			id: crypto.randomUUID(),
			kind: "audio",
		};
		const audio = {
			...b,
			assetId: sound.id,
			id: crypto.randomUUID(),
			linkGroupId: group,
			track: 1,
		};
		const linked = {
			...project,
			segments: [a, { ...b, linkGroupId: group }, audio],
		};
		const next = applyRevealTransition(linked, [footage, sound], b.id, {
			duration: 1,
			softness: 0,
			type: "dissolve",
		});
		// The visual moves start and sourceIn together, so it stays in sync.
		expect(byId(next, b.id).start).toBe(3);
		expect(byId(next, audio.id)).toEqual(audio);
	});

	test("linked A/V on both sides never stacks audio on one track", () => {
		const { a, b, project } = cut();
		const sound: Asset = {
			...footage,
			hasAudio: true,
			id: "00000000-0000-4000-8000-0000000000c3",
			kind: "audio",
		};
		const groupA = "00000000-0000-4000-8000-0000000000e2";
		const groupB = "00000000-0000-4000-8000-0000000000e3";
		const audioA = {
			...a,
			assetId: sound.id,
			id: crypto.randomUUID(),
			linkGroupId: groupA,
			track: 1,
		};
		const audioB = {
			...b,
			assetId: sound.id,
			id: crypto.randomUUID(),
			linkGroupId: groupB,
			track: 1,
		};
		const linked = {
			...project,
			segments: [
				{ ...a, linkGroupId: groupA },
				{ ...b, linkGroupId: groupB },
				audioA,
				audioB,
			],
		};
		for (const media of [
			linked,
			// Tail fallback: B has no head media, so A (and only its visual) grows.
			{
				...linked,
				segments: linked.segments.map((segment) =>
					segment.linkGroupId === groupB
						? { ...segment, sourceIn: 0, sourceOut: 4 }
						: segment
				),
			},
		]) {
			const next = applyRevealTransition(media, [footage, sound], b.id, {
				duration: 1,
				softness: 0,
				type: "dissolve",
			});
			const audioTrack = next.segments
				.filter((segment) => segment.track === 1)
				.sort((x, y) => x.start - y.start);
			for (let index = 1; index < audioTrack.length; index += 1) {
				const previous = audioTrack[index - 1] as Segment;
				const current = audioTrack[index] as Segment;
				expect(
					previous.start + (previous.sourceOut - previous.sourceIn)
				).toBeLessThanOrEqual(current.start + 1e-9);
			}
		}
	});

	test("refuses when a linked visual partner sits on a locked track", () => {
		const { a, b, project } = cut();
		const sound: Asset = {
			...footage,
			hasAudio: true,
			id: "00000000-0000-4000-8000-0000000000c4",
			kind: "audio",
		};
		const group = "00000000-0000-4000-8000-0000000000e4";
		const overlay = {
			...b,
			id: crypto.randomUUID(),
			linkGroupId: group,
			track: 2,
		};
		const audio = {
			...b,
			assetId: sound.id,
			id: crypto.randomUUID(),
			linkGroupId: group,
			track: 1,
		};
		const linked = {
			...project,
			segments: [a, { ...b, linkGroupId: group }, overlay, audio],
		};
		const lockedOverlay = {
			...linked,
			trackSettings: [{ ...trackSettingFor(linked, 2), locked: true }],
		};
		expect(() =>
			applyRevealTransition(lockedOverlay, [footage, sound], b.id, {
				duration: 1,
				softness: 0,
				type: "dissolve",
			})
		).toThrow(/Unlock/);
		// A locked audio track is fine: linked audio is never edited.
		const lockedAudio = {
			...linked,
			trackSettings: [{ ...trackSettingFor(linked, 1), locked: true }],
		};
		const next = applyRevealTransition(lockedAudio, [footage, sound], b.id, {
			duration: 1,
			softness: 0,
			type: "dissolve",
		});
		expect(byId(next, audio.id)).toEqual(audio);
		expect(byId(next, overlay.id).start).toBe(3);
	});

	test("the incoming clip follows its predecessor in the segment array", () => {
		const { a, b, project } = cut();
		const unsorted = { ...project, segments: [b, a] };
		const next = applyRevealTransition(unsorted, [footage], b.id, {
			duration: 1,
			softness: 0,
			type: "dissolve",
		});
		const ids = next.segments.map((segment) => segment.id);
		expect(ids.indexOf(b.id)).toBeGreaterThan(ids.indexOf(a.id));
		// Already in order: untouched.
		const sorted = applyRevealTransition(project, [footage], b.id, {
			duration: 1,
			softness: 0,
			type: "dissolve",
		});
		expect(sorted.segments.map((segment) => segment.id)).toEqual([a.id, b.id]);
	});

	test("cut lookup finds the predecessor and the nearest cut", () => {
		const { a, b, project } = cut();
		expect(cutPredecessor(project, b)?.id).toBe(a.id);
		expect(cutPredecessor(project, a)).toBeUndefined();
		expect(cutNear(project, 0, 4.1, 0.2)?.incoming.id).toBe(b.id);
		expect(cutNear(project, 0, 4.5, 0.2)).toBeUndefined();
		expect(cutNear(project, 1, 4, 0.2)).toBeUndefined();
	});
});
