import { describe, expect, test } from "bun:test";
import { type Asset, newProject, newSegment, type Project } from "./project.ts";
import { mergeProjects, sameValue } from "./project-merge.ts";
import { removeTrack, reorderTracks } from "./track-edits.ts";

const SEG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SEG_B = "aaaaaaaa-0000-4000-8000-000000000002";
const SEG_LOCAL = "aaaaaaaa-0000-4000-8000-000000000003";
const SEG_REMOTE = "aaaaaaaa-0000-4000-8000-000000000004";
const MARK_1 = "bbbbbbbb-0000-4000-8000-000000000001";
const MARK_2 = "bbbbbbbb-0000-4000-8000-000000000002";

const asset: Asset = {
	createdAt: "2026-10-01T00:00:00.000Z",
	duration: 20,
	hasAudio: true,
	height: 360,
	id: "11111111-1111-4111-8111-111111111111",
	kind: "video",
	name: "Camera",
	width: 640,
};

function baseProject(): Project {
	const project = newProject("Merge test");
	const first = { ...newSegment(asset, 0, 0), id: SEG_A };
	const second = { ...newSegment(asset, 10, 0), id: SEG_B };
	return {
		...project,
		markers: [{ id: MARK_1, label: "Intro", time: 1 }],
		revision: 4,
		segments: [
			{ ...first, sourceOut: 5 },
			{ ...second, sourceOut: 5 },
		],
	};
}

/** The remote side as a newer saved revision. */
function saved(project: Project): Project {
	return {
		...project,
		revision: project.revision + 1,
		updatedAt: "2026-10-18T10:00:00.000Z",
	};
}

describe("mergeProjects", () => {
	test("merges disjoint edits and lands on the remote revision", () => {
		const base = baseProject();
		const local: Project = {
			...base,
			segments: base.segments.map((segment) =>
				segment.id === SEG_A ? { ...segment, volume: 0.5 } : segment
			),
			title: "Renamed here",
		};
		const remote = saved({
			...base,
			markers: [...base.markers, { id: MARK_2, label: "Agent", time: 3 }],
			segments: base.segments.map((segment) =>
				segment.id === SEG_A ? { ...segment, opacity: 0.25 } : segment
			),
		});
		const result = mergeProjects(base, local, remote);
		expect(result.status).toBe("clean");
		if (result.status !== "clean") {
			return;
		}
		const merged = result.project;
		expect(merged.revision).toBe(5);
		expect(merged.updatedAt).toBe(remote.updatedAt);
		expect(merged.title).toBe("Renamed here");
		const clip = merged.segments.find((segment) => segment.id === SEG_A);
		expect(clip?.volume).toBe(0.5);
		expect(clip?.opacity).toBe(0.25);
		expect(merged.markers.map((marker) => marker.id)).toEqual([MARK_1, MARK_2]);
	});

	test("keeps clips each side added, in local order after their neighbour", () => {
		const base = baseProject();
		const added = { ...newSegment(asset, 20, 0), id: SEG_LOCAL };
		const local: Project = {
			...base,
			segments: [...base.segments, { ...added, sourceOut: 2 }],
		};
		const remoteClip = { ...newSegment(asset, 0, 1), id: SEG_REMOTE };
		const remote = saved({
			...base,
			segments: [{ ...remoteClip, sourceOut: 2 }, ...base.segments],
		});
		const result = mergeProjects(base, local, remote);
		expect(result.status).toBe("clean");
		if (result.status === "clean") {
			expect(result.project.segments.map((segment) => segment.id)).toEqual([
				SEG_REMOTE,
				SEG_A,
				SEG_B,
				SEG_LOCAL,
			]);
		}
	});

	test("reports a conflict when both sides change the same field", () => {
		const base = baseProject();
		const local: Project = {
			...base,
			markers: [{ id: MARK_1, label: "Mine", time: 1 }],
		};
		const remote = saved({
			...base,
			markers: [{ id: MARK_1, label: "Agent's", time: 1 }],
		});
		const result = mergeProjects(base, local, remote);
		expect(result.status).toBe("conflict");
		expect(result.conflicts).toEqual([
			{
				collection: "markers",
				field: "label",
				id: MARK_1,
				kind: "both-changed",
				name: "Mine",
			},
		]);
	});

	test("the same change on both sides is not a conflict", () => {
		const base = baseProject();
		const local: Project = { ...base, title: "Same" };
		const remote = saved({ ...base, title: "Same" });
		const result = mergeProjects(base, local, remote);
		expect(result.status).toBe("clean");
	});

	test("deleting a clip the other side edited is a conflict, both ways", () => {
		const base = baseProject();
		const editedHere: Project = {
			...base,
			segments: base.segments.map((segment) =>
				segment.id === SEG_B ? { ...segment, volume: 2 } : segment
			),
		};
		const deletedThere = saved({
			...base,
			segments: base.segments.filter((segment) => segment.id !== SEG_B),
		});
		const remoteDelete = mergeProjects(base, editedHere, deletedThere);
		expect(remoteDelete.status).toBe("conflict");
		expect(remoteDelete.conflicts[0]).toMatchObject({
			collection: "segments",
			id: SEG_B,
			kind: "deleted-remotely",
		});

		const deletedHere: Project = {
			...base,
			segments: base.segments.filter((segment) => segment.id !== SEG_B),
		};
		const editedThere = saved(editedHere);
		const localDelete = mergeProjects(base, deletedHere, editedThere);
		expect(localDelete.status).toBe("conflict");
		expect(localDelete.conflicts[0]).toMatchObject({
			id: SEG_B,
			kind: "deleted-locally",
		});
	});

	test("an untouched entity deleted on one side stays deleted", () => {
		const base = baseProject();
		const local: Project = { ...base, title: "Edited title" };
		const remote = saved({
			...base,
			markers: [],
			segments: base.segments.filter((segment) => segment.id !== SEG_A),
		});
		const result = mergeProjects(base, local, remote);
		expect(result.status).toBe("clean");
		if (result.status === "clean") {
			expect(result.project.segments.map((segment) => segment.id)).toEqual([
				SEG_B,
			]);
			expect(result.project.markers).toEqual([]);
			expect(result.project.title).toBe("Edited title");
		}
	});

	test("clips moved onto each other by the two sides are a conflict", () => {
		const base = baseProject();
		const local: Project = {
			...base,
			segments: base.segments.map((segment) =>
				segment.id === SEG_A ? { ...segment, start: 2 } : segment
			),
		};
		const remote = saved({
			...base,
			segments: base.segments.map((segment) =>
				segment.id === SEG_B ? { ...segment, start: 6 } : segment
			),
		});
		const result = mergeProjects(base, local, remote);
		expect(result.status).toBe("conflict");
		expect(result.conflicts[0]?.kind).toBe("overlap");
	});

	test("compares values regardless of key order", () => {
		expect(
			sameValue(
				{ a: 1, b: [1, { c: 2, d: 3 }] },
				{ b: [1, { d: 3, c: 2 }], a: 1 }
			)
		).toBe(true);
		expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(true);
		expect(sameValue([1, 2], [2, 1])).toBe(false);
	});
});

describe("mergeProjects with renumbered tracks", () => {
	const SEG_C = "aaaaaaaa-0000-4000-8000-000000000005";
	const SEG_D = "aaaaaaaa-0000-4000-8000-000000000006";

	/** Clips on tracks 0, 1 and 2. */
	function threeTracks(): Project {
		const project = baseProject();
		return {
			...project,
			segments: [
				{ ...newSegment(asset, 0, 0), id: SEG_A, sourceOut: 5 },
				{ ...newSegment(asset, 0, 1), id: SEG_B, sourceOut: 5 },
				{ ...newSegment(asset, 0, 2), id: SEG_C, sourceOut: 5 },
			],
		};
	}

	function withLocalClip(project: Project, track: number): Project {
		return {
			...project,
			segments: [
				...project.segments,
				{ ...newSegment(asset, 8, track), id: SEG_LOCAL, sourceOut: 4 },
			],
		};
	}

	const trackOf = (project: Project, id: string) =>
		project.segments.find((segment) => segment.id === id)?.track;

	test("a track removed elsewhere conflicts with a clip added on a renumbered track", () => {
		const base = threeTracks();
		const local = withLocalClip(base, 2);
		const remote = saved(removeTrack(base, [asset], 1, { force: true }));
		const result = mergeProjects(base, local, remote);
		expect(result.status).toBe("conflict");
		expect(result.conflicts).toEqual([
			{ collection: "trackSettings", kind: "tracks" },
		]);
	});

	test("a clip added on a track the removal left in place merges cleanly", () => {
		const base = threeTracks();
		const local = withLocalClip(base, 0);
		const remote = saved(removeTrack(base, [asset], 1, { force: true }));
		const result = mergeProjects(base, local, remote);
		expect(result.status).toBe("clean");
		if (result.status === "clean") {
			expect(trackOf(result.project, SEG_LOCAL)).toBe(0);
			expect(trackOf(result.project, SEG_C)).toBe(1);
			expect(trackOf(result.project, SEG_B)).toBeUndefined();
		}
	});

	test("a clip added locally follows its track through a reorder elsewhere", () => {
		const base = threeTracks();
		const local = withLocalClip(base, 2);
		// Track 2 to the bottom: 2 -> 0, 0 -> 1, 1 -> 2.
		const remote = saved(reorderTracks(base, [2, 0, 1]));
		const result = mergeProjects(base, local, remote);
		expect(result.status).toBe("clean");
		if (result.status === "clean") {
			expect(trackOf(result.project, SEG_C)).toBe(0);
			expect(trackOf(result.project, SEG_LOCAL)).toBe(0);
			expect(trackOf(result.project, SEG_A)).toBe(1);
			expect(trackOf(result.project, SEG_B)).toBe(2);
		}
	});

	test("a local clip move follows the reorder too", () => {
		const base = threeTracks();
		const local = {
			...base,
			segments: base.segments.map((segment) =>
				segment.id === SEG_A ? { ...segment, start: 8, track: 1 } : segment
			),
		};
		const remote = saved(reorderTracks(base, [1, 2, 0]));
		const result = mergeProjects(base, local, remote);
		expect(result.status).toBe("clean");
		if (result.status === "clean") {
			// Track 1 became track 0, so the moved clip sits beside SEG_B there.
			expect(trackOf(result.project, SEG_A)).toBe(0);
			expect(trackOf(result.project, SEG_B)).toBe(0);
		}
	});

	test("local track settings under a reorder elsewhere conflict", () => {
		const base = threeTracks();
		const local: Project = {
			...base,
			trackSettings: [
				{
					hidden: false,
					locked: false,
					muted: true,
					name: "Track 3",
					solo: false,
					track: 2,
				},
			],
		};
		const remote = saved(reorderTracks(base, [2, 0, 1]));
		const result = mergeProjects(base, local, remote);
		expect(result.status).toBe("conflict");
		expect(result.conflicts[0]?.kind).toBe("tracks");
	});

	test("an agent moving one clip to another track is not a renumbering", () => {
		const base = {
			...threeTracks(),
			segments: [
				...threeTracks().segments,
				{ ...newSegment(asset, 10, 0), id: SEG_D, sourceOut: 5 },
			],
		};
		const local = withLocalClip(base, 1);
		const remote = saved({
			...base,
			segments: base.segments.map((segment) =>
				segment.id === SEG_D ? { ...segment, track: 2 } : segment
			),
		});
		const result = mergeProjects(base, local, remote);
		expect(result.status).toBe("clean");
		if (result.status === "clean") {
			expect(trackOf(result.project, SEG_LOCAL)).toBe(1);
			expect(trackOf(result.project, SEG_D)).toBe(2);
		}
	});
});
