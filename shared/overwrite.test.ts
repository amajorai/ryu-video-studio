import { describe, expect, test } from "bun:test";
import { animatedValue } from "./animation.ts";
import { insertClips } from "./insert.ts";
import {
	overwriteClips,
	overwriteImpacts,
	overwriteRequest,
	overwriteRequestSchema,
} from "./overwrite.ts";
import {
	type Asset,
	avatarSchema,
	newProject,
	newSegment,
	type Project,
	type Segment,
	segmentDuration,
	updateTrackSetting,
} from "./project.ts";

function asset(kind: Asset["kind"] = "video", duration = 10): Asset {
	return {
		id: crypto.randomUUID(),
		name: kind,
		kind,
		duration,
		width: kind === "audio" ? 0 : 640,
		height: kind === "audio" ? 0 : 360,
		hasAudio: kind !== "image",
		createdAt: new Date().toISOString(),
	};
}

function clip(source: Asset, start: number, track = 0): Segment {
	return newSegment(source, start, track);
}

const spans = (project: Project, track: number) =>
	project.segments
		.filter((segment) => segment.track === track)
		.map((segment) => [
			Number(segment.start.toFixed(6)),
			Number((segment.start + segmentDuration(segment)).toFixed(6)),
		]);

describe("overwriteClips", () => {
	test("overwriting the middle of a clip splits it around the new clip", () => {
		const base = asset("video", 10);
		const dropped = asset("video", 2);
		const project = newProject("Overwrite");
		const existing = clip(base, 0);
		existing.fadeOut = 1;
		project.segments = [existing];
		const { newIds, project: next } = overwriteClips(
			project,
			[base, dropped],
			[{ assetId: dropped.id, sourceIn: 0, speed: 1, volume: 1 }],
			{ at: 3, track: 0 }
		);
		expect(spans(next, 0)).toEqual([
			[0, 3],
			[3, 5],
			[5, 10],
		]);
		const [head, placed, tail] = next.segments;
		expect(head?.id).toBe(existing.id);
		expect(head?.fadeOut).toBe(0);
		expect(placed?.id).toBe(newIds[0]);
		expect(placed?.assetId).toBe(dropped.id);
		expect(tail?.sourceIn).toBeCloseTo(5);
		expect(tail?.fadeOut).toBe(1);
		expect(next.revision).toBe(project.revision);
	});

	test("overwriting across two clips trims both and removes covered ones", () => {
		const base = asset("video", 4);
		const dropped = asset("video", 6);
		const project = newProject("Across");
		const first = clip(base, 0);
		const covered = clip(base, 4);
		covered.sourceOut = 1;
		const last = clip(base, 5);
		project.segments = [first, covered, last];
		const next = overwriteClips(
			project,
			[base, dropped],
			[{ assetId: dropped.id, sourceIn: 1, sourceOut: 5, speed: 1, volume: 1 }],
			{ at: 2, track: 0 }
		).project;
		expect(spans(next, 0)).toEqual([
			[0, 2],
			[2, 6],
			[6, 9],
		]);
		expect(next.segments.some((segment) => segment.id === covered.id)).toBe(
			false
		);
		// The tail of the last clip keeps its id when its head was trimmed.
		expect(next.segments.at(-1)?.sourceIn).toBeCloseTo(1);
	});

	test("other tracks and later clips never move", () => {
		const base = asset("video", 4);
		const project = newProject("Static");
		const other = clip(base, 1, 1);
		const later = clip(base, 8, 0);
		project.segments = [clip(base, 0), later, other];
		const next = overwriteClips(
			project,
			[base],
			[{ assetId: base.id, sourceIn: 0, sourceOut: 2, speed: 1, volume: 1 }],
			{ at: 2, track: 0 }
		).project;
		expect(next.segments.find((s) => s.id === other.id)).toEqual(other);
		expect(next.segments.find((s) => s.id === later.id)).toEqual(later);
	});

	test("linked audio partners are cut over the same range and regrouped", () => {
		const video = asset("video", 10);
		const audio = asset("audio", 10);
		const dropped = asset("image", 5);
		const project = newProject("Linked");
		const group = crypto.randomUUID();
		project.segments = [
			{ ...clip(video, 0, 0), linkGroupId: group },
			{ ...clip(audio, 0, 1), linkGroupId: group },
		];
		const next = overwriteClips(
			project,
			[video, audio, dropped],
			[{ assetId: dropped.id, sourceIn: 0, sourceOut: 2, speed: 1, volume: 1 }],
			{ at: 4, track: 0 }
		).project;
		expect(spans(next, 1)).toEqual([
			[0, 4],
			[6, 10],
		]);
		const heads = next.segments.filter((segment) => segment.start === 0);
		const tails = next.segments.filter((segment) => segment.start === 6);
		expect(new Set(heads.map((segment) => segment.linkGroupId))).toEqual(
			new Set([group])
		);
		expect(tails).toHaveLength(2);
		expect(tails[0]?.linkGroupId).toBeDefined();
		expect(tails[0]?.linkGroupId).not.toBe(group);
		expect(tails[0]?.linkGroupId).toBe(tails[1]?.linkGroupId);
	});

	test("a link group losing its audio is dissolved", () => {
		const video = asset("video", 10);
		const audio = asset("audio", 3);
		const dropped = asset("video", 10);
		const project = newProject("Dissolve");
		const group = crypto.randomUUID();
		project.segments = [
			{ ...clip(video, 0, 0), linkGroupId: group },
			{ ...clip(audio, 4, 1), linkGroupId: group },
		];
		const next = overwriteClips(
			project,
			[video, audio, dropped],
			[{ assetId: dropped.id, sourceIn: 0, sourceOut: 5, speed: 1, volume: 1 }],
			{ at: 3, track: 0 }
		).project;
		expect(spans(next, 1)).toEqual([]);
		expect(next.segments.every((segment) => !segment.linkGroupId)).toBe(true);
	});

	test("slivers under the split minimum are trimmed instead of split", () => {
		const base = asset("video", 4);
		const project = newProject("Sliver");
		const left = clip(base, 0);
		const right = clip(base, 4.97);
		project.segments = [left, right];
		const next = overwriteClips(
			project,
			[base],
			[{ assetId: base.id, sourceIn: 0, sourceOut: 1, speed: 1, volume: 1 }],
			{ at: 3.99, track: 0 }
		).project;
		expect(spans(next, 0)).toEqual([
			[0, 3.99],
			[3.99, 4.99],
			[4.99, 8.97],
		]);
		expect(next.segments[0]?.id).toBe(left.id);
		expect(next.segments[2]?.id).toBe(right.id);
	});

	test("a dropped clip that only touches a neighbour leaves it alone", () => {
		const base = asset("video", 4);
		const project = newProject("Touch");
		const before = clip(base, 0);
		project.segments = [before];
		const next = overwriteClips(
			project,
			[base],
			[{ assetId: base.id, sourceIn: 0, speed: 1, volume: 1 }],
			{ at: 4, track: 0 }
		).project;
		expect(next.segments[0]).toEqual(before);
		expect(spans(next, 0)).toEqual([
			[0, 4],
			[4, 8],
		]);
	});

	test("reveal transitions whose predecessor was removed are dropped", () => {
		const base = asset("video", 4);
		const project = newProject("Reveal");
		const before = clip(base, 0);
		const after: Segment = {
			...clip(base, 3),
			transitionIn: { duration: 1, softness: 0, type: "dissolve" },
		};
		project.segments = [before, after, clip(base, 0, 1)];
		const next = overwriteClips(
			project,
			[base],
			[{ assetId: base.id, sourceIn: 0, sourceOut: 3.5, speed: 1, volume: 1 }],
			{ at: 0, track: 0 }
		).project;
		const kept = next.segments.find((segment) => segment.id === after.id);
		expect(kept?.transitionIn).toBeUndefined();
	});

	test("locked tracks, multicam clips, and the two-hour limit are refused", () => {
		const base = asset("video", 4);
		const project = newProject("Refuse");
		project.segments = [clip(base, 0)];
		const entry = { assetId: base.id, sourceIn: 0, speed: 1, volume: 1 };
		const locked = updateTrackSetting(project, 0, { locked: true });
		expect(() =>
			overwriteClips(locked, [base], [entry], { at: 1, track: 0 })
		).toThrow("Unlock the target track");
		expect(() =>
			overwriteClips(project, [base], [entry], { at: 7198, track: 0 })
		).toThrow("two-hour");
		const audio = asset("audio", 4);
		const group = crypto.randomUUID();
		const linked: Project = {
			...updateTrackSetting(project, 1, { locked: true }),
			segments: [
				{ ...clip(base, 0), linkGroupId: group },
				{ ...clip(audio, 0, 1), linkGroupId: group },
			],
		};
		expect(() =>
			overwriteClips(linked, [base, audio], [entry], { at: 1, track: 0 })
		).toThrow("Unlock every linked clip track");
		const multicam: Project = {
			...project,
			segments: [{ ...clip(base, 0), multicamGroupId: crypto.randomUUID() }],
		};
		expect(() =>
			overwriteClips(multicam, [base], [entry], { at: 1, track: 0 })
		).toThrow("multicam");
		expect(() =>
			overwriteClips(
				project,
				[base],
				[{ ...entry, assetId: crypto.randomUUID() }],
				{
					at: 1,
					track: 0,
				}
			)
		).toThrow("missing media");
	});

	test("insert mode ripples where overwrite does not", () => {
		const base = asset("video", 4);
		const project = newProject("Modes");
		project.segments = [clip(base, 0), clip(base, 4)];
		const entry = {
			assetId: base.id,
			sourceIn: 0,
			sourceOut: 2,
			speed: 1,
			volume: 1,
		};
		const inserted = insertClips(project, [base], 2, 0, [entry]);
		expect(spans(inserted, 0)).toEqual([
			[0, 2],
			[2, 4],
			[4, 6],
			[6, 10],
		]);
		const overwritten = overwriteClips(project, [base], [entry], {
			at: 2,
			track: 0,
		}).project;
		expect(spans(overwritten, 0)).toEqual([
			[0, 2],
			[2, 4],
			[4, 8],
		]);
	});
});

describe("overwriteImpacts", () => {
	test("reports trims, splits, removals, and linked partners", () => {
		const video = asset("video", 10);
		const audio = asset("audio", 10);
		const project = newProject("Impacts");
		const group = crypto.randomUUID();
		const split = { ...clip(video, 0), linkGroupId: group };
		const partner = { ...clip(audio, 0, 1), linkGroupId: group };
		project.segments = [split, partner, clip(video, 0, 2)];
		expect(overwriteImpacts(project, 0, 2, 4)).toEqual([
			{ action: "split", end: 4, id: split.id, start: 2, track: 0 },
			{ action: "split", end: 4, id: partner.id, start: 2, track: 1 },
		]);
		expect(overwriteImpacts(project, 0, 8, 12)[0]?.action).toBe("trim");
		expect(overwriteImpacts(project, 0, 0, 12)[0]?.action).toBe("remove");
		expect(overwriteImpacts(project, 0, 10, 12)).toEqual([]);
	});
});

describe("overwriteRequest", () => {
	test("accepts the agent body and rejects unknown fields", () => {
		const base = asset("video", 4);
		const project = newProject("Request");
		project.segments = [clip(base, 0)];
		const body = {
			at: 1,
			entries: [{ assetId: base.id }],
			revision: 0,
			track: 0,
		};
		const next = overwriteRequest(project, [base], body);
		expect(spans(next, 0)).toEqual([
			[0, 1],
			[1, 5],
		]);
		expect(
			overwriteRequestSchema.safeParse({ ...body, mode: "insert" }).success
		).toBe(false);
		expect(
			overwriteRequestSchema.safeParse({ ...body, track: 32 }).success
		).toBe(false);
	});
});

describe("overwriteClips keeps clip references valid", () => {
	const slotFor = (segmentId: string) => ({
		fixedDuration: false,
		id: crypto.randomUUID(),
		kind: "video" as const,
		label: "Hero",
		segmentId,
	});
	const entryFor = (source: Asset) => ({
		assetId: source.id,
		sourceIn: 0,
		speed: 1,
		volume: 1,
	});

	test("a removed clip drops its template slot and lip-sync link", () => {
		const base = asset("video", 2);
		const dropped = asset("video", 4);
		const project = newProject("Template");
		const existing = clip(base, 1);
		project.segments = [existing];
		project.template = { slots: [slotFor(existing.id)] };
		project.avatars = [
			avatarSchema.parse({
				accent: "#ffffff",
				end: 2,
				height: 0.5,
				id: crypto.randomUUID(),
				lipSync: {
					assetId: base.id,
					segmentId: existing.id,
					sensitivity: 0.5,
					smoothing: 0.5,
				},
				outfit: "#000000",
				skin: "#cccccc",
				start: 0,
				width: 0.3,
				x: 0.5,
				y: 0.5,
			}),
		];
		const { project: next } = overwriteClips(
			project,
			[base, dropped],
			[entryFor(dropped)],
			{ at: 0, track: 0 }
		);
		expect(next.segments.some((segment) => segment.id === existing.id)).toBe(
			false
		);
		expect(next.template?.slots).toEqual([]);
		expect(next.avatars[0]?.lipSync).toEqual({
			assetId: base.id,
			sensitivity: 0.5,
			smoothing: 0.5,
		});
	});

	test("a left trim keeps the clip id, so its template slot survives", () => {
		const base = asset("video", 10);
		const dropped = asset("video", 2);
		const project = newProject("Template trim");
		const existing = clip(base, 1);
		existing.fadeIn = 1;
		existing.transitionIn = { duration: 0.5, softness: 0, type: "dissolve" };
		project.segments = [existing];
		const slot = slotFor(existing.id);
		project.template = { slots: [slot] };
		const { project: next } = overwriteClips(
			project,
			[base, dropped],
			[entryFor(dropped)],
			{ at: 0, track: 0 }
		);
		const trimmed = next.segments.find((segment) => segment.id === existing.id);
		expect(trimmed?.start).toBeCloseTo(2);
		expect(trimmed?.sourceIn).toBeCloseTo(1);
		expect(trimmed?.fadeIn).toBe(0);
		expect(trimmed?.transitionIn).toBeUndefined();
		expect(next.template?.slots).toEqual([slot]);
	});

	test("a split keeps the id on the head piece", () => {
		const base = asset("video", 10);
		const dropped = asset("video", 2);
		const project = newProject("Template split");
		const existing = clip(base, 0);
		project.segments = [existing];
		project.template = { slots: [slotFor(existing.id)] };
		const { project: next } = overwriteClips(
			project,
			[base, dropped],
			[entryFor(dropped)],
			{ at: 4, track: 0 }
		);
		expect(next.template?.slots).toHaveLength(1);
		const head = next.segments.find((segment) => segment.id === existing.id);
		expect(head?.start).toBe(0);
		expect(spans(next, 0)).toEqual([
			[0, 4],
			[4, 6],
			[6, 10],
		]);
	});

	test("sliver trims fit both fades inside the shortened clip", () => {
		const base = asset("video", 10);
		const dropped = asset("video", 2);
		for (const at of [9.98, 5]) {
			const project = newProject("Fades");
			const existing = clip(base, 0);
			existing.fadeIn = 5;
			existing.fadeOut = 5;
			project.segments = [existing];
			const { project: next } = overwriteClips(
				project,
				[base, dropped],
				[entryFor(dropped)],
				{ at, track: 0 }
			);
			const head = next.segments.find((segment) => segment.id === existing.id);
			expect(head).toBeDefined();
			if (head) {
				expect(head.fadeIn + head.fadeOut).toBeLessThanOrEqual(
					segmentDuration(head) + 1e-9
				);
				expect(head.fadeIn).toBeCloseTo(5);
			}
		}
		// A sliver cut from the head of a clip gives way on the fade-in side.
		const project = newProject("Fades tail");
		const existing = clip(base, 1.98);
		existing.fadeIn = 5;
		existing.fadeOut = 5;
		project.segments = [existing];
		const { project: next } = overwriteClips(
			project,
			[base, dropped],
			[entryFor(dropped)],
			{ at: 0, track: 0 }
		);
		const tail = next.segments.find((segment) => segment.id === existing.id);
		expect(tail?.fadeOut).toBeCloseTo(5);
		expect(tail?.fadeIn).toBeCloseTo(4.98);
	});
});

describe("overwriteClips keeps surviving animation", () => {
	test("a one-frame overlap keeps the head's animated values unchanged", () => {
		const base = asset("video", 3);
		const dropped = asset("video", 2);
		const project = newProject("Sliver keyframes");
		const existing = clip(base, 0);
		existing.keyframes = [
			{ id: crypto.randomUUID(), property: "opacity", time: 0, value: 0 },
			{ id: crypto.randomUUID(), property: "opacity", time: 3, value: 1 },
		];
		project.segments = [existing];
		const before = [0.5, 1.5, 2.9].map((time) =>
			animatedValue(existing, "opacity", time)
		);
		const next = overwriteClips(
			project,
			[base, dropped],
			[{ assetId: dropped.id, sourceIn: 0, speed: 1, volume: 1 }],
			{ at: 2.98, track: 0 }
		).project;
		const head = next.segments.find((segment) => segment.id === existing.id);
		expect(head && segmentDuration(head)).toBeCloseTo(2.98);
		for (const [index, time] of [0.5, 1.5, 2.9].entries()) {
			expect(head && animatedValue(head, "opacity", time)).toBeCloseTo(
				before[index] ?? Number.NaN,
				6
			);
		}
		expect(
			head?.keyframes.every(
				(keyframe) => keyframe.time <= segmentDuration(head) + 1e-9
			)
		).toBe(true);
	});
});
