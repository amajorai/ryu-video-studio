import { describe, expect, test } from "bun:test";
import {
	copyClips,
	cutClips,
	duplicateClipsTo,
	openGap,
	overwriteRange,
	pasteClips,
} from "./clipboard.ts";
import { insertClips } from "./insert.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
	segmentDuration,
	updateTrackSetting,
} from "./project.ts";
import { rippleRemoveClips } from "./ripple-edits.ts";

function asset(kind: Asset["kind"], duration = 20): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : 360,
		id: crypto.randomUUID(),
		kind,
		name: `${kind}.media`,
		width: kind === "audio" ? 0 : 640,
	};
}

function clip(
	source: Asset,
	start: number,
	track: number,
	length = 4,
	extra: Partial<Segment> = {}
): Segment {
	return {
		...newSegment(source, start, track),
		sourceOut: length,
		...extra,
	};
}

function fixture() {
	const video = asset("video");
	const audio = asset("audio");
	const linkGroupId = crypto.randomUUID();
	const picture = clip(video, 2, 0, 4, { linkGroupId });
	const sound = clip(audio, 2, 1, 4, { linkGroupId });
	const broll = clip(video, 6, 2, 3);
	const project: Project = {
		...newProject("Clipboard"),
		segments: [picture, sound, broll],
	};
	return { audio, broll, picture, project, sound, video };
}

const ends = (project: Project) =>
	project.segments.map((segment) => ({
		end: segment.start + segmentDuration(segment),
		start: segment.start,
		track: segment.track,
	}));

describe("copyClips", () => {
	test("pulls in linked partners and records offsets from the earliest start", () => {
		const { broll, picture, project, sound } = fixture();
		const payload = copyClips(project, [picture.id, broll.id]);
		expect(payload.items.map((item) => item.segment.id).sort()).toEqual(
			[picture.id, sound.id, broll.id].sort()
		);
		expect(payload.span).toBe(7);
		const offsets = Object.fromEntries(
			payload.items.map((item) => [item.segment.id, item.offset])
		);
		expect(offsets[picture.id]).toBe(0);
		expect(offsets[broll.id]).toBe(4);
	});

	test("snapshots are independent of later project edits", () => {
		const { picture, project } = fixture();
		const payload = copyClips(project, [picture.id]);
		project.segments[0]!.opacity = 0.2;
		expect(payload.items[0]?.segment.opacity).toBe(1);
	});

	test("copies overlays and includes them in the span", () => {
		const { picture, project } = fixture();
		const titleId = crypto.randomUUID();
		project.titles = [
			{
				animation: "fade",
				color: "#ffffff",
				end: 12,
				fadeIn: 0,
				fadeOut: 0,
				fontSize: 0.08,
				id: titleId,
				start: 1,
				text: "Hello",
				x: 0.5,
				y: 0.5,
			},
		];
		const payload = copyClips(
			project,
			[picture.id],
			[{ id: titleId, kind: "titles" }]
		);
		expect(payload.overlays).toHaveLength(1);
		expect(payload.overlays[0]?.offset).toBe(0);
		expect(payload.items[0]?.offset).toBe(1);
		expect(payload.span).toBe(11);
	});

	test("refuses an empty selection", () => {
		const { project } = fixture();
		expect(() => copyClips(project, [crypto.randomUUID()])).toThrow(
			"Select clips"
		);
	});
});

describe("pasteClips", () => {
	test("preserves relative offsets and track spacing across tracks", () => {
		const { audio, broll, picture, project, video } = fixture();
		const payload = copyClips(project, [picture.id, broll.id]);
		const result = pasteClips(project, [video, audio], payload, {
			at: 20,
			mode: "overwrite",
		});
		const pasted = result.project.segments.filter((segment) =>
			result.newIds.includes(segment.id)
		);
		expect(pasted).toHaveLength(3);
		const byStart = pasted
			.map((segment) => [segment.track, segment.start])
			.sort((a, b) => a[0]! - b[0]!);
		expect(byStart).toEqual([
			[0, 20],
			[1, 20],
			[2, 24],
		]);
	});

	test("re-mints ids and link groups so pasted pairs link to each other only", () => {
		const { audio, picture, project, video } = fixture();
		const payload = copyClips(project, [picture.id]);
		const result = pasteClips(project, [video, audio], payload, {
			at: 12,
			mode: "overwrite",
		});
		const pasted = result.project.segments.filter((segment) =>
			result.newIds.includes(segment.id)
		);
		expect(pasted).toHaveLength(2);
		const groups = new Set(pasted.map((segment) => segment.linkGroupId));
		expect(groups.size).toBe(1);
		expect(groups.has(picture.linkGroupId)).toBe(false);
		expect([...groups][0]).toBeString();
		for (const segment of pasted) {
			expect([picture.id]).not.toContain(segment.id);
		}
	});

	test("re-mints mask and keyframe ids and retargets mask keyframes", () => {
		const { audio, project, video } = fixture();
		const maskId = crypto.randomUUID();
		const keyframeId = crypto.randomUUID();
		const masked = clip(video, 0, 3, 4, {
			keyframes: [
				{
					id: keyframeId,
					property: "maskX",
					target: maskId,
					time: 1,
					value: 0.2,
				},
			],
			masks: [
				{
					feather: 0,
					height: 1,
					id: maskId,
					invert: false,
					opacity: 1,
					rotation: 0,
					shape: "rectangle",
					width: 1,
					x: 0,
					y: 0,
				},
			],
		});
		project.segments.push(masked);
		const result = pasteClips(
			project,
			[video, audio],
			copyClips(project, [masked.id]),
			{ at: 12, mode: "overwrite" }
		);
		const pasted = result.project.segments.find(
			(segment) => segment.id === result.newIds[0]
		);
		const mask = pasted?.masks?.[0];
		expect(mask?.id).not.toBe(maskId);
		expect(pasted?.keyframes[0]?.id).not.toBe(keyframeId);
		expect(pasted?.keyframes[0]?.target).toBe(mask?.id);
	});

	test("an occupied source track moves the paste to the first free track", () => {
		const { audio, broll, project, video } = fixture();
		const result = pasteClips(
			project,
			[video, audio],
			copyClips(project, [broll.id]),
			{ at: 4, mode: "overwrite" }
		);
		const pasted = result.project.segments.find(
			(segment) => segment.id === result.newIds[0]
		);
		// Tracks 0 and 1 hold the linked pair at 2..6; track 2 holds the b-roll at 6..9.
		expect(pasted?.track).toBe(3);
		expect(pasted?.start).toBe(4);
		expect(result.project.segments).toHaveLength(4);
	});

	test("a single displaced clip avoids lanes of the other media class", () => {
		const { audio, project, video } = fixture();
		const voice = clip(audio, 10, 1, 4);
		project.segments.push(voice);
		const result = pasteClips(
			project,
			[video, audio],
			copyClips(project, [voice.id]),
			{ at: 3, mode: "overwrite" }
		);
		// Track 1 (audio) is busy at 3..7; tracks 0 and 2 hold video.
		expect(
			result.project.segments.find((segment) => segment.id === result.newIds[0])
				?.track
		).toBe(3);
	});

	test("a free source track keeps the clip on it", () => {
		const { audio, broll, project, video } = fixture();
		const result = pasteClips(
			project,
			[video, audio],
			copyClips(project, [broll.id]),
			{ at: 12, mode: "overwrite" }
		);
		expect(
			result.project.segments.find((segment) => segment.id === result.newIds[0])
				?.track
		).toBe(2);
	});

	test("automatic placement skips locked tracks", () => {
		const { audio, broll, project, video } = fixture();
		const locked = updateTrackSetting(project, 2, { locked: true });
		const result = pasteClips(
			locked,
			[video, audio],
			copyClips(locked, [broll.id]),
			{ at: 12, mode: "overwrite" }
		);
		expect(
			result.project.segments.find((segment) => segment.id === result.newIds[0])
				?.track
		).toBe(0);
	});

	test("an explicit track overwrites what is under the pasted span", () => {
		const { audio, broll, picture, project, video } = fixture();
		const result = pasteClips(
			project,
			[video, audio],
			copyClips(project, [broll.id]),
			{ at: 3, mode: "overwrite", track: 0 }
		);
		const track0 = result.project.segments
			.filter((segment) => segment.track === 0)
			.map((segment) => [
				segment.start,
				Number((segment.start + segmentDuration(segment)).toFixed(3)),
			])
			.sort((a, b) => a[0]! - b[0]!);
		// The picture (2..6) is cut back to 2..3 and the paste covers 3..6.
		expect(track0).toEqual([
			[2, 3],
			[3, 6],
		]);
		const remaining = result.project.segments.find(
			(segment) => segment.id === picture.id
		);
		expect(remaining?.linkGroupId).toBe(picture.linkGroupId);
	});

	test("an explicit locked track is refused", () => {
		const { audio, broll, project, video } = fixture();
		const locked = updateTrackSetting(project, 4, { locked: true });
		expect(() =>
			pasteClips(locked, [video, audio], copyClips(locked, [broll.id]), {
				at: 3,
				mode: "overwrite",
				track: 4,
			})
		).toThrow("Unlock");
	});

	test("insert mode ripples later content right by the span", () => {
		const { audio, broll, picture, project, video } = fixture();
		const result = pasteClips(
			project,
			[video, audio],
			copyClips(project, [broll.id]),
			{ at: 2, mode: "insert", track: 0 }
		);
		const moved = result.project.segments.find(
			(segment) => segment.id === picture.id
		);
		const movedBroll = result.project.segments.find(
			(segment) => segment.id === broll.id
		);
		expect(moved?.start).toBe(5);
		expect(movedBroll?.start).toBe(9);
		const pasted = result.project.segments.find(
			(segment) => segment.id === result.newIds[0]
		);
		expect(pasted).toMatchObject({ start: 2, track: 0 });
	});

	test("insert mode splits a clip crossing the paste time", () => {
		const { audio, broll, picture, project, video } = fixture();
		const result = pasteClips(
			project,
			[video, audio],
			copyClips(project, [broll.id]),
			{ at: 4, mode: "insert", track: 0 }
		);
		const track0 = ends(result.project)
			.filter((entry) => entry.track === 0)
			.map((entry) => [entry.start, Number(entry.end.toFixed(3))])
			.sort((a, b) => a[0]! - b[0]!);
		expect(track0).toEqual([
			[2, 4],
			[4, 7],
			[7, 9],
		]);
		expect(
			result.project.segments.find((segment) => segment.id === picture.id)
				?.sourceOut
		).toBe(2);
	});

	test("insert mode leaves sync-unlocked tracks alone", () => {
		const { audio, broll, project, video } = fixture();
		const unlocked = updateTrackSetting(project, 2, { syncLocked: false });
		const result = pasteClips(
			unlocked,
			[video, audio],
			copyClips(unlocked, [broll.id]),
			{ at: 1, mode: "insert", track: 0 }
		);
		expect(
			result.project.segments.find((segment) => segment.id === broll.id)?.start
		).toBe(6);
	});

	test("pasted overlays get fresh ids and shifted times", () => {
		const { audio, picture, project, video } = fixture();
		const titleId = crypto.randomUUID();
		const captionId = crypto.randomUUID();
		project.titles = [
			{
				animation: "fade",
				color: "#ffffff",
				end: 5,
				fadeIn: 0,
				fadeOut: 0,
				fontSize: 0.08,
				id: titleId,
				start: 3,
				text: "Hi",
				x: 0.5,
				y: 0.5,
			},
		];
		project.captions = [
			{
				end: 4,
				id: captionId,
				start: 2,
				text: "Caption",
				words: [{ end: 3, id: crypto.randomUUID(), start: 2, text: "Caption" }],
			},
		];
		const payload = copyClips(
			project,
			[picture.id],
			[
				{ id: titleId, kind: "titles" },
				{ id: captionId, kind: "captions" },
			]
		);
		const result = pasteClips(project, [video, audio], payload, {
			at: 10,
			mode: "overwrite",
		});
		expect(result.newOverlays.map((overlay) => overlay.kind)).toEqual([
			"titles",
			"captions",
		]);
		const title = result.project.titles.find(
			(candidate) => candidate.id === result.newOverlays[0]?.id
		);
		expect(title).toMatchObject({ end: 13, start: 11, text: "Hi" });
		const caption = result.project.captions.find(
			(candidate) => candidate.id === result.newOverlays[1]?.id
		);
		expect(caption).toMatchObject({ end: 12, start: 10 });
		expect(caption?.words?.[0]).toMatchObject({ end: 11, start: 10 });
	});

	test("refuses a paste past two hours or of deleted media", () => {
		const { audio, broll, project, video } = fixture();
		const payload = copyClips(project, [broll.id]);
		expect(() =>
			pasteClips(project, [video, audio], payload, {
				at: 7199,
				mode: "overwrite",
			})
		).toThrow("two hours");
		expect(() =>
			pasteClips(project, [audio], payload, { at: 30, mode: "overwrite" })
		).toThrow("no longer");
	});

	test("drops a reveal transition with no covering predecessor at the paste", () => {
		const { audio, project, video } = fixture();
		const incoming = clip(video, 8, 2, 3, {
			transitionIn: { duration: 0.5, softness: 0, type: "dissolve" },
		});
		project.segments.push(incoming);
		const result = pasteClips(
			project,
			[video, audio],
			copyClips(project, [incoming.id]),
			{ at: 15, mode: "overwrite" }
		);
		const pasted = result.project.segments.find(
			(segment) => segment.id === result.newIds[0]
		);
		expect(pasted?.transitionIn).toBeUndefined();
		expect(
			result.project.segments.find((segment) => segment.id === incoming.id)
				?.transitionIn
		).toBeDefined();
	});
});

describe("paste insert one frame before a clip's end", () => {
	function nearEnd() {
		const video = asset("video", 40);
		const long = clip(video, 0, 0, 10);
		const short = { ...clip(video, 20, 0, 2), sourceIn: 0 };
		const project: Project = {
			...newProject("Near end"),
			segments: [long, short],
		};
		return { long, project, short, video };
	}
	const onTrack = (project: Project, track: number) =>
		ends(project)
			.filter((item) => item.track === track)
			.map((item) => [
				Number(item.start.toFixed(3)),
				Number(item.end.toFixed(3)),
			]);

	test("an explicit track keeps the clip whole and pastes after it", () => {
		const { long, project, short, video } = nearEnd();
		const result = duplicateClipsTo(project, [video], {
			at: 10 - 1 / 30 + 0.013,
			clipIds: [short.id],
			mode: "insert",
			revision: 0,
			track: 0,
		});
		const kept = result.project.segments.find((item) => item.id === long.id);
		expect(kept?.start).toBe(0);
		expect(kept?.sourceOut).toBe(10);
		expect(onTrack(result.project, 0)).toEqual([
			[0, 10],
			[10, 12],
			[22, 24],
		]);
	});

	test("automatic placement keeps the clip whole and pastes on its track", () => {
		const { long, project, short, video } = nearEnd();
		const result = duplicateClipsTo(project, [video], {
			at: 9.98,
			clipIds: [short.id],
			mode: "insert",
			revision: 0,
		});
		const kept = result.project.segments.find((item) => item.id === long.id);
		expect(kept?.start).toBe(0);
		expect(kept?.sourceOut).toBe(10);
		expect(onTrack(result.project, 0)).toEqual([
			[0, 10],
			[10, 12],
			[22, 24],
		]);
		expect(onTrack(result.project, 1)).toEqual([]);
	});

	test("openGap leaves a clip ending a sliver after the gap in place", () => {
		const { long, project, video } = nearEnd();
		const opened = openGap(project, 9.98, 2, [video]);
		expect(opened.segments.find((item) => item.id === long.id)).toEqual(long);
	});
});

describe("cutClips", () => {
	test("removes the clips and their partners and returns the payload", () => {
		const { audio, picture, project, video } = fixture();
		const result = cutClips(project, [video, audio], [picture.id], [], {
			ripple: false,
		});
		expect(result.payload.items).toHaveLength(2);
		expect(result.project.segments).toHaveLength(1);
	});

	test("ripple closes the cut span", () => {
		const { audio, broll, picture, project, video } = fixture();
		const result = cutClips(project, [video, audio], [picture.id], [], {
			ripple: true,
		});
		expect(
			result.project.segments.find((segment) => segment.id === broll.id)?.start
		).toBe(2);
	});

	test("ripple handles non-contiguous spans latest first", () => {
		const video = asset("video");
		const a = clip(video, 0, 0, 2);
		const b = clip(video, 2, 0, 2);
		const c = clip(video, 4, 0, 2);
		const d = clip(video, 6, 0, 2);
		const project = { ...newProject("Spans"), segments: [a, b, c, d] };
		const result = cutClips(project, [video], [b.id, d.id], [], {
			ripple: true,
		});
		expect(
			result.project.segments.map((segment) => [segment.id, segment.start])
		).toEqual([
			[a.id, 0],
			[c.id, 2],
		]);
	});

	test("refuses locked tracks", () => {
		const { audio, picture, project, video } = fixture();
		const locked = updateTrackSetting(project, 1, { locked: true });
		expect(() =>
			cutClips(locked, [video, audio], [picture.id], [], { ripple: false })
		).toThrow("Unlock");
	});

	test("cut then paste at the playhead restores three clips with a fresh link", () => {
		const { audio, broll, picture, project, video } = fixture();
		const cut = cutClips(project, [video, audio], [picture.id, broll.id], [], {
			ripple: false,
		});
		expect(cut.project.segments).toHaveLength(0);
		const pasted = pasteClips(cut.project, [video, audio], cut.payload, {
			at: 0,
			mode: "overwrite",
		});
		expect(pasted.newIds).toHaveLength(3);
		const linked = pasted.project.segments.filter(
			(segment) => segment.linkGroupId
		);
		expect(linked).toHaveLength(2);
		expect(linked[0]?.linkGroupId).toBe(linked[1]?.linkGroupId);
	});
});

describe("helpers", () => {
	test("overwriteRange removes, trims, and splits", () => {
		const video = asset("video");
		const inside = clip(video, 2, 0, 1);
		const spanning = clip(video, 0, 1, 10);
		const result = overwriteRange([inside, spanning], 0, 1, 4);
		expect(result).toEqual([spanning]);
		const split = overwriteRange([spanning], 1, 3, 5);
		expect(
			split.map((segment) => [
				segment.start,
				segment.start + segmentDuration(segment),
			])
		).toEqual([
			[0, 3],
			[5, 10],
		]);
		// Overlaps shorter than a frame piece are tolerated.
		expect(overwriteRange([spanning], 1, 9.98, 12)).toEqual([spanning]);
	});

	test("openGap shifts overlays and markers after the point", () => {
		const { project } = fixture();
		project.markers = [
			{ id: crypto.randomUUID(), label: "Early", time: 1 },
			{ id: crypto.randomUUID(), label: "Late", time: 7 },
		];
		const next = openGap(project, 5, 2, []);
		expect(next.markers.map((marker) => marker.time)).toEqual([1, 9]);
	});

	test("duplicateClipsTo validates clip ids", () => {
		const { audio, project, video } = fixture();
		expect(() =>
			duplicateClipsTo(project, [video, audio], {
				at: 1,
				clipIds: [crypto.randomUUID()],
				revision: 0,
			})
		).toThrow("not found");
	});
});

const spans = (project: Project, track: number) =>
	ends(project)
		.filter((entry) => entry.track === track)
		.map((entry) => [entry.start, Number(entry.end.toFixed(3))])
		.sort((a, b) => a[0]! - b[0]!);

function linkedPair(length = 10) {
	const video = asset("video");
	const audio = asset("audio");
	const linkGroupId = crypto.randomUUID();
	const picture = clip(video, 0, 0, length, { linkGroupId });
	const sound = clip(audio, 0, 1, length, { linkGroupId });
	const broll = clip(video, 0, 2, 2, { sourceIn: 0 });
	const project: Project = {
		...newProject("Linked"),
		segments: [picture, sound, broll],
	};
	return { audio, broll, picture, project, sound, video };
}

describe("ripple cut across tracks", () => {
	test("never removes unselected clips on other tracks", () => {
		const video = asset("video");
		const a = clip(video, 0, 0, 10);
		const b = clip(video, 4, 1, 2);
		const c = clip(video, 8, 1, 2);
		const project = { ...newProject("Multi"), segments: [a, b, c] };
		const result = cutClips(project, [video], [b.id], [], { ripple: true });
		expect(result.project.segments.find((s) => s.id === a.id)).toEqual(a);
		expect(spans(result.project, 0)).toEqual([[0, 10]]);
		// The span still holds A, so it stays open and nothing shifts.
		expect(result.unclosedSpans).toBe(1);
		expect(result.project.segments.find((s) => s.id === c.id)?.start).toBe(8);
	});

	test("a locked clip covering the span keeps it open", () => {
		const video = asset("video");
		const a = clip(video, 0, 0, 10);
		const b = clip(video, 4, 1, 2);
		const c = clip(video, 8, 1, 2);
		const project = updateTrackSetting(
			{ ...newProject("Locked"), segments: [a, b, c] },
			0,
			{ locked: true }
		);
		const result = cutClips(project, [video], [b.id], [], { ripple: true });
		expect(result.unclosedSpans).toBe(1);
		expect(spans(result.project, 0)).toEqual([[0, 10]]);
		expect(result.project.segments.find((s) => s.id === c.id)?.start).toBe(8);
	});

	test("without ripple nothing is reported open", () => {
		const { audio, picture, project, video } = fixture();
		expect(
			cutClips(project, [video, audio], [picture.id], [], { ripple: false })
				.unclosedSpans
		).toBe(0);
	});
});

describe("link groups across paste edits", () => {
	test("paste insert splits an A/V pair into two separate pairs", () => {
		const { audio, broll, picture, project, video } = linkedPair();
		const result = pasteClips(
			project,
			[video, audio],
			copyClips(project, [broll.id]),
			{ at: 5, mode: "insert" }
		);
		const pieces = result.project.segments.filter(
			(segment) => segment.track < 2 && !result.newIds.includes(segment.id)
		);
		expect(pieces).toHaveLength(4);
		const left = pieces.filter((segment) => segment.start < 5);
		const right = pieces.filter((segment) => segment.start >= 5);
		expect(left.map((segment) => segment.linkGroupId)).toEqual([
			picture.linkGroupId,
			picture.linkGroupId,
		]);
		expect(right[0]?.linkGroupId).toBeDefined();
		expect(right[0]?.linkGroupId).toBe(right[1]?.linkGroupId);
		expect(right[0]?.linkGroupId).not.toBe(picture.linkGroupId);
	});

	test("paste overwrite cuts the linked partner and regroups each side", () => {
		const { audio, broll, picture, project, video } = linkedPair();
		project.template = {
			slots: [
				{
					fixedDuration: false,
					id: crypto.randomUUID(),
					kind: "video",
					label: "Hero",
					segmentId: picture.id,
				},
			],
		};
		const result = pasteClips(
			project,
			[video, audio],
			copyClips(project, [broll.id]),
			{ at: 4, mode: "overwrite", track: 0 }
		);
		expect(spans(result.project, 1)).toEqual([
			[0, 4],
			[6, 10],
		]);
		const original = result.project.segments.filter(
			(segment) => !result.newIds.includes(segment.id) && segment.track < 2
		);
		const left = original.filter((segment) => segment.start < 4);
		const right = original.filter((segment) => segment.start >= 6);
		expect(left.map((segment) => segment.linkGroupId)).toEqual([
			picture.linkGroupId,
			picture.linkGroupId,
		]);
		expect(right[0]?.linkGroupId).toBe(right[1]?.linkGroupId);
		expect(right[0]?.linkGroupId).not.toBe(picture.linkGroupId);
		expect(
			result.project.segments.find((s) => s.id === result.newIds[0])
				?.linkGroupId
		).toBeUndefined();
		expect(result.project.template?.slots[0]?.segmentId).toBe(picture.id);
	});

	test("paste overwrite keeps the id of a clip whose head it covers", () => {
		const video = asset("video");
		const target = clip(video, 0, 0, 10);
		const source = clip(video, 20, 1, 4);
		const project = { ...newProject("Head"), segments: [target, source] };
		const result = pasteClips(
			project,
			[video],
			copyClips(project, [source.id]),
			{
				at: 0,
				mode: "overwrite",
				track: 0,
			}
		);
		const survivor = result.project.segments.find((s) => s.id === target.id);
		expect(survivor?.start).toBe(4);
	});

	test("paste overwrite refuses multicam clips and locked partners", () => {
		const { audio, broll, picture, project, video } = linkedPair();
		const payload = copyClips(project, [broll.id]);
		const multicam: Project = {
			...project,
			segments: project.segments.map((segment) =>
				segment.id === picture.id
					? { ...segment, multicamGroupId: crypto.randomUUID() }
					: segment
			),
		};
		expect(() =>
			pasteClips(multicam, [video, audio], payload, {
				at: 4,
				mode: "overwrite",
				track: 0,
			})
		).toThrow("multicam");
		const locked = updateTrackSetting(project, 1, { locked: true });
		expect(() =>
			pasteClips(locked, [video, audio], payload, {
				at: 4,
				mode: "overwrite",
				track: 0,
			})
		).toThrow("Unlock every linked clip track");
	});
});

describe("automatic placement lane class", () => {
	test("a displaced A/V pair never puts video on an audio lane", () => {
		const video = asset("video");
		const audio = asset("audio");
		const linkGroupId = crypto.randomUUID();
		const picture = clip(video, 0, 0, 4, { linkGroupId });
		const sound = clip(audio, 0, 1, 4, { linkGroupId });
		const blocker = clip(video, 10, 0, 4);
		const project = {
			...newProject("Lanes"),
			segments: [picture, sound, blocker],
		};
		const result = pasteClips(
			project,
			[video, audio],
			copyClips(project, [picture.id]),
			{ at: 10, mode: "overwrite" }
		);
		const placed = result.newIds.map((id) =>
			result.project.segments.find((segment) => segment.id === id)
		);
		const byAsset = Object.fromEntries(
			placed.map((segment) => [segment?.assetId, segment?.track])
		);
		expect(byAsset[video.id]).toBe(2);
		expect(byAsset[audio.id]).toBe(3);
	});
});

function twoClipTrack(extra: Partial<Project> = {}) {
	const video = asset("video");
	const a = clip(video, 0, 0, 4);
	const b = clip(video, 4, 0, 4, { sourceIn: 4, sourceOut: 8 });
	const project: Project = {
		...newProject("Parity"),
		...extra,
		segments: [a, b],
	};
	return { a, b, project, video };
}

const startOf = (project: Project, id: string) =>
	project.segments.find((segment) => segment.id === id)?.start;

describe("paste insert follows insertClips track rules", () => {
	test("insert onto a track with sync lock off never removes a clip", () => {
		const { a, b, project: base, video } = twoClipTrack();
		const project = updateTrackSetting(base, 0, { syncLocked: false });
		const result = pasteClips(project, [video], copyClips(project, [a.id]), {
			at: 4,
			mode: "insert",
			track: 0,
		});
		expect(spans(result.project, 0)).toEqual([
			[0, 4],
			[4, 8],
			[8, 12],
		]);
		expect(startOf(result.project, b.id)).toBe(8);
		const inserted = insertClips(project, [video], 4, 0, [
			{ assetId: video.id, sourceIn: 0, sourceOut: 4, speed: 1, volume: 1 },
		]);
		expect(spans(result.project, 0)).toEqual(spans(inserted, 0));
	});

	test("automatic insert also opens the gap on an unsynced source track", () => {
		const { a, b, project: base, video } = twoClipTrack();
		const project = updateTrackSetting(base, 0, { syncLocked: false });
		const result = pasteClips(project, [video], copyClips(project, [a.id]), {
			at: 4,
			mode: "insert",
		});
		expect(result.project.segments).toHaveLength(3);
		expect(startOf(result.project, b.id)).toBe(8);
	});

	test("locked sync-locked tracks shift like insertClips", () => {
		const { a, b, project: base, video } = twoClipTrack();
		const c = clip(video, 4, 1, 4);
		const project = updateTrackSetting(
			{ ...base, segments: [...base.segments, c] },
			1,
			{ locked: true }
		);
		const result = pasteClips(project, [video], copyClips(project, [a.id]), {
			at: 4,
			mode: "insert",
		});
		const inserted = insertClips(project, [video], 4, 0, [
			{ assetId: video.id, sourceIn: 0, sourceOut: 4, speed: 1, volume: 1 },
		]);
		expect(startOf(result.project, b.id)).toBe(8);
		expect(startOf(result.project, c.id)).toBe(startOf(inserted, c.id));
		expect(startOf(result.project, c.id)).toBe(8);
	});

	test("refuses to split a clip on a locked track", () => {
		const { a, project: base, video } = twoClipTrack();
		const long = clip(video, 0, 1, 10);
		const project = updateTrackSetting(
			{ ...base, segments: [...base.segments, long] },
			1,
			{ locked: true }
		);
		expect(() =>
			pasteClips(project, [video], copyClips(project, [a.id]), {
				at: 4,
				mode: "insert",
			})
		).toThrow("Unlock track 2");
	});

	test("pinned markers stay put, as with insertClips", () => {
		const { a, project, video } = twoClipTrack({
			markers: [{ id: crypto.randomUUID(), label: "Pinned", time: 6 }],
			rippleMarkers: false,
		});
		const result = pasteClips(project, [video], copyClips(project, [a.id]), {
			at: 4,
			mode: "insert",
		});
		const inserted = insertClips(project, [video], 4, 0, [
			{ assetId: video.id, sourceIn: 0, sourceOut: 4, speed: 1, volume: 1 },
		]);
		expect(result.project.markers[0]?.time).toBe(6);
		expect(inserted.markers[0]?.time).toBe(6);
	});

	test("rippling markers still move by default", () => {
		const { a, project, video } = twoClipTrack({
			markers: [{ id: crypto.randomUUID(), label: "Moves", time: 6 }],
		});
		const result = pasteClips(project, [video], copyClips(project, [a.id]), {
			at: 4,
			mode: "insert",
		});
		expect(result.project.markers[0]?.time).toBe(10);
	});
});

describe("ripple cut matches rippleRemoveClips", () => {
	const summary = (project: Project) =>
		project.segments
			.map((segment) => `${segment.track}:${segment.start}`)
			.sort();

	test("pinned markers stay put", () => {
		const { a, project, video } = twoClipTrack({
			markers: [{ id: crypto.randomUUID(), label: "Pinned", time: 6 }],
			rippleMarkers: false,
		});
		const result = cutClips(project, [video], [a.id], [], { ripple: true });
		expect(result.project.markers[0]?.time).toBe(6);
		expect(
			rippleRemoveClips(project, [video], [a.id]).project.markers[0]?.time
		).toBe(6);
	});

	test("locked tracks after the span follow the ripple", () => {
		const { a, b, project: base, video } = twoClipTrack();
		const c = clip(video, 4, 1, 4);
		const project = updateTrackSetting(
			{ ...base, segments: [...base.segments, c] },
			1,
			{ locked: true }
		);
		const result = cutClips(project, [video], [a.id], [], { ripple: true });
		const reference = rippleRemoveClips(project, [video], [a.id]);
		expect(startOf(result.project, b.id)).toBe(0);
		expect(startOf(result.project, c.id)).toBe(0);
		expect(summary(result.project)).toEqual(summary(reference.project));
	});

	test("a locked clip inside the span keeps it open", () => {
		const { a, b, project: base, video } = twoClipTrack();
		const d = clip(video, 2, 2, 4);
		const project = updateTrackSetting(
			{ ...base, segments: [...base.segments, d] },
			2,
			{ locked: true }
		);
		const result = cutClips(project, [video], [a.id], [], { ripple: true });
		const reference = rippleRemoveClips(project, [video], [a.id]);
		expect(result.unclosedSpans).toBe(1);
		expect(reference.unclosed).toBe(1);
		expect(startOf(result.project, b.id)).toBe(4);
		expect(summary(result.project)).toEqual(summary(reference.project));
	});
});
