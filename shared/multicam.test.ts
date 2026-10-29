import { expect, test } from "bun:test";
import {
	changeMulticamAngles,
	createMulticamGroup,
	expandMulticamSwitches,
	type MulticamChangeEntry,
	multicamChangeRequestSchema,
	multicamGroupAt,
	multicamShortcutEntry,
	multicamSlotTracks,
	ungroupMulticam,
} from "./multicam.ts";
import { newProject, newSegment } from "./project.ts";

function asset(name: string, kind: "audio" | "video" = "video") {
	return {
		createdAt: new Date().toISOString(),
		duration: 6,
		hasAudio: true,
		height: kind === "audio" ? 0 : 360,
		id: crypto.randomUUID(),
		kind,
		name,
		width: kind === "audio" ? 0 : 640,
	};
}

test("multicam groups create ordinary angle clips and a program-audio layer", () => {
	const wide = asset("Wide");
	const close = asset("Close");
	const mic = asset("Recorder", "audio");
	const project = newProject("Multicam");
	const result = createMulticamGroup(project, [wide, close, mic], {
		action: "create",
		members: [
			{ assetId: wide.id, kind: "angle", label: "Wide" },
			{ assetId: close.id, kind: "angle", label: "Close" },
			{ assetId: mic.id, kind: "mic", label: "Recorder" },
		],
		name: "Interview angles",
		revision: project.revision,
	});
	expect(result.group.name).toBe("Interview angles");
	expect(result.group.duration).toBe(6);
	expect(result.group.switches).toEqual([{ angle: "Wide", end: 6, start: 0 }]);
	expect(result.project.segments).toHaveLength(2);
	expect(
		result.project.segments.map((segment) => [segment.track, segment.volume])
	).toEqual([
		[0, 0],
		[1, 1],
	]);
});

test("multicam angle changes split the program into source-bounded switches", () => {
	const wide = asset("Wide");
	const close = asset("Close");
	const mic = asset("Recorder", "audio");
	const project = newProject("Switches");
	const created = createMulticamGroup(project, [wide, close, mic], {
		action: "create",
		members: [
			{ assetId: wide.id, kind: "angle" },
			{ assetId: close.id, kind: "angle" },
			{ assetId: mic.id, kind: "mic" },
		],
		revision: project.revision,
	});
	const changed = changeMulticamAngles(created.project, [wide, close, mic], {
		action: "change",
		entries: [{ angle: "Close", end: 4, start: 2 }],
		groupId: created.group.id,
		revision: created.project.revision,
	});
	expect(changed.group.switches).toEqual([
		{ angle: "Wide", end: 2, start: 0 },
		{ angle: "Close", end: 4, start: 2 },
		{ angle: "Wide", end: 6, start: 4 },
	]);
	expect(
		changed.project.segments.filter((segment) => segment.track === 0)
	).toHaveLength(3);
	expect(
		changed.project.segments.filter((segment) => segment.track === 1)
	).toHaveLength(1);
});

test("ungrouping removes multicam metadata and leaves the generated clips in place", () => {
	const wide = asset("Wide");
	const close = asset("Close");
	const mic = asset("Recorder", "audio");
	const project = newProject("Ungroup");
	const created = createMulticamGroup(project, [wide, close, mic], {
		action: "create",
		members: [
			{ assetId: wide.id, kind: "angle" },
			{ assetId: close.id, kind: "angle" },
			{ assetId: mic.id, kind: "mic" },
		],
		revision: project.revision,
	});
	const ungrouped = ungroupMulticam(created.project, [wide, close, mic], {
		action: "ungroup",
		groupId: created.group.id,
		revision: created.project.revision,
	});
	expect(ungrouped.multicamGroups).toEqual([]);
	expect(ungrouped.segments).toHaveLength(created.project.segments.length);
});

function switchSession() {
	const wide = asset("Wide");
	const close = asset("Close");
	const host = asset("Host lav", "audio");
	const guest = asset("Guest lav", "audio");
	const assets = [wide, close, host, guest];
	const project = newProject("Switch session");
	const created = createMulticamGroup(project, assets, {
		action: "create",
		masterAssetId: host.id,
		members: [
			{ assetId: wide.id, kind: "angle" },
			{ assetId: close.id, kind: "angle" },
			{ assetId: host.id, kind: "mic" },
			{ assetId: guest.id, kind: "mic" },
		],
		revision: project.revision,
	});
	return { assets, close, created, guest, host, wide };
}

test("mic switches build program audio from per-range member clips", () => {
	const { assets, created, guest, host } = switchSession();
	const changed = changeMulticamAngles(created.project, assets, {
		action: "change",
		entries: [
			{ audio: "Guest lav", end: 3, start: 1 },
			{ audio: "Guest lav", end: 4, start: 3 },
		],
		groupId: created.group.id,
		revision: created.project.revision,
	});
	expect(changed.group.switches).toEqual([
		{ angle: "Wide", end: 1, start: 0 },
		{ angle: "Wide", audio: "Guest lav", end: 4, start: 1 },
		{ angle: "Wide", end: 6, start: 4 },
	]);
	expect(expandMulticamSwitches(changed.group).audio).toEqual([
		{ end: 1, mic: "Host lav", start: 0 },
		{ end: 4, mic: "Guest lav", start: 1 },
		{ end: 6, mic: "Host lav", start: 4 },
	]);
	const program = changed.project.segments.filter(
		(segment) => segment.track === 1
	);
	expect(
		program.map((segment) => [
			segment.assetId,
			segment.start,
			segment.sourceIn,
			segment.sourceOut,
			segment.volume,
		])
	).toEqual([
		[host.id, 0, 0, 1, 1],
		[guest.id, 1, 1, 4, 1],
		[host.id, 4, 4, 6, 1],
	]);
	// Angle video stays a single silent clip because the picture never changed.
	expect(
		changed.project.segments
			.filter((segment) => segment.track === 0)
			.map((segment) => segment.volume)
	).toEqual([0, 0, 0]);
	// Choosing the master again restores a single program-audio clip.
	const restored = changeMulticamAngles(changed.project, assets, {
		action: "change",
		entries: [{ audio: "Host lav", end: 6, start: 0 }],
		groupId: created.group.id,
		revision: changed.project.revision,
	});
	expect(restored.group.switches).toEqual([
		{ angle: "Wide", end: 6, start: 0 },
	]);
	expect(
		restored.project.segments.filter((segment) => segment.track === 1)
	).toHaveLength(1);
});

test("layout switches place the listed angles with the shared layout slots", () => {
	const { assets, close, created, wide } = switchSession();
	const changed = changeMulticamAngles(created.project, assets, {
		action: "change",
		entries: [
			{
				end: 5,
				layout: {
					angles: ["Close", "Wide"],
					fit: "fill",
					layout: "side-by-side",
				},
				start: 2,
			},
		],
		groupId: created.group.id,
		revision: created.project.revision,
	});
	expect(changed.group.switches[1]).toEqual({
		angle: "Close",
		end: 5,
		layout: { angles: ["Close", "Wide"], fit: "fill", layout: "side-by-side" },
		start: 2,
	});
	const inLayout = changed.project.segments.filter(
		(segment) => segment.start === 2 && segment.track !== 1
	);
	expect(
		inLayout.map((segment) => [
			segment.assetId,
			segment.track,
			segment.x,
			segment.scale,
			segment.fit,
		])
	).toEqual([
		[close.id, 0, -0.5, 0.5, "fill"],
		[wide.id, 2, 0.5, 0.5, "fill"],
	]);
	// A plain angle switch over the layout returns to a full-frame cut.
	const cut = changeMulticamAngles(changed.project, assets, {
		action: "change",
		entries: [{ angle: "Wide", end: 5, start: 3 }],
		groupId: created.group.id,
		revision: changed.project.revision,
	});
	expect(cut.group.switches.map((entry) => entry.layout?.layout)).toEqual([
		undefined,
		"side-by-side",
		undefined,
		undefined,
	]);
	expect(cut.group.switches.at(-1)).toEqual({
		angle: "Wide",
		end: 6,
		start: 3,
	});
});

test("switch entries reject unknown mics, mic-only angles, and bad layouts", () => {
	const { assets, created } = switchSession();
	const change = (entry: MulticamChangeEntry) =>
		changeMulticamAngles(created.project, assets, {
			action: "change",
			entries: [entry],
			groupId: created.group.id,
			revision: created.project.revision,
		});
	expect(() => change({ audio: "Wide", end: 2, start: 1 })).toThrow(
		"not a microphone"
	);
	expect(() => change({ angle: "Host lav", end: 2, start: 1 })).toThrow(
		"not a camera angle"
	);
	expect(() =>
		change({
			end: 2,
			layout: { angles: ["Wide"], fit: "fit", layout: "side-by-side" },
			start: 1,
		})
	).toThrow();
	expect(() =>
		change({
			angle: "Wide",
			end: 2,
			layout: {
				angles: ["Close", "Wide"],
				fit: "fit",
				layout: "side-by-side",
			},
			start: 1,
		})
	).toThrow("first listed angle");
	expect(() =>
		multicamChangeRequestSchema.parse({
			action: "change",
			entries: [{ end: 2, start: 1 }],
			groupId: created.group.id,
			revision: 0,
		})
	).toThrow();
});

test("shortcut entries switch from the playhead to the end of the current range", () => {
	const { assets, created } = switchSession();
	const group = created.group;
	expect(multicamGroupAt(created.project, 2.5)?.id).toBe(group.id);
	expect(multicamGroupAt(created.project, 6)).toBeUndefined();
	expect(multicamShortcutEntry(group, 2.5, "angle", 1)).toEqual({
		angle: "Close",
		end: 6,
		start: 2.5,
	});
	expect(multicamShortcutEntry(group, 2.5, "angle", 0)).toBeNull();
	expect(multicamShortcutEntry(group, 2.5, "angle", 5)).toBeNull();
	expect(multicamShortcutEntry(group, 2.5, "mic", 1)).toEqual({
		audio: "Guest lav",
		end: 6,
		start: 2.5,
	});
	expect(multicamShortcutEntry(group, 2.5, "mic", 0)).toBeNull();
	const switched = changeMulticamAngles(created.project, assets, {
		action: "change",
		entries: [multicamShortcutEntry(group, 2.5, "angle", 1)!],
		groupId: group.id,
		revision: created.project.revision,
	}).group;
	expect(multicamShortcutEntry(switched, 1, "angle", 1)).toEqual({
		angle: "Close",
		end: 2.5,
		start: 1,
	});
});

function threeMemberSession(name: string) {
	const wide = asset("Wide");
	const close = asset("Close");
	const mic = asset("Recorder", "audio");
	const assets = [wide, close, mic];
	const project = newProject(name);
	return { assets, close, mic, project, wide };
}

test("a switch one frame after a boundary is absorbed so program audio stays continuous", () => {
	const { assets, close, mic, project, wide } = threeMemberSession("Sliver");
	const created = createMulticamGroup(project, assets, {
		action: "create",
		members: [
			{ assetId: wide.id, kind: "angle", label: "Wide" },
			{ assetId: close.id, kind: "angle", label: "Close" },
			{ assetId: mic.id, kind: "mic", label: "Recorder" },
		],
		revision: project.revision,
	});
	const first = changeMulticamAngles(created.project, assets, {
		action: "change",
		entries: [{ angle: "Close", end: 6, start: 3 }],
		groupId: created.group.id,
		revision: created.project.revision,
	});
	// One frame at 30 fps after the 3 s boundary, as the 1-9 keys produce.
	const second = changeMulticamAngles(first.project, assets, {
		action: "change",
		entries: [{ angle: "Wide", end: 6, start: 3 + 1 / 30 }],
		groupId: created.group.id,
		revision: first.project.revision,
	});
	expect(second.group.switches).toEqual([{ angle: "Wide", end: 6, start: 0 }]);
	const audio = second.project.segments.filter(
		(segment) => segment.track === 1
	);
	expect(
		audio.map((segment) => [segment.start, segment.sourceIn, segment.sourceOut])
	).toEqual([[0, 0, 6]]);

	// A sliver between two different angles folds into one neighbour: the
	// switches stay contiguous and program audio is a single clip.
	const split = changeMulticamAngles(first.project, assets, {
		action: "change",
		entries: [{ angle: "Wide", end: 3.02, start: 2.99 }],
		groupId: created.group.id,
		revision: first.project.revision,
	});
	for (const [index, switchPoint] of split.group.switches.entries()) {
		const next = split.group.switches[index + 1];
		if (next) {
			expect(next.start).toBe(switchPoint.end);
		}
	}
	expect(split.group.switches[0]?.start).toBe(0);
	expect(split.group.switches.at(-1)?.end).toBe(6);
	expect(
		split.project.segments.filter((segment) => segment.track === 1)
	).toHaveLength(1);
});

test("program audio bridges sub-frame gaps left by older sessions", () => {
	const master = crypto.randomUUID();
	const expansion = expandMulticamSwitches({
		duration: 6,
		id: crypto.randomUUID(),
		masterAssetId: master,
		members: [
			{
				assetId: crypto.randomUUID(),
				kind: "angle",
				label: "Wide",
				offsetSeconds: 0,
			},
			{
				assetId: crypto.randomUUID(),
				kind: "angle",
				label: "Close",
				offsetSeconds: 0,
			},
			{ assetId: master, kind: "mic", label: "Recorder", offsetSeconds: 0 },
		],
		name: "Legacy",
		segmentIds: [],
		start: 0,
		switches: [
			{ angle: "Wide", end: 3, start: 0 },
			{ angle: "Close", end: 6, start: 3.01 },
		],
	});
	expect(expansion.audio).toEqual([{ end: 6, mic: "Recorder", start: 0 }]);
});

test("layout slots skip tracks holding the user's clips and locked tracks", () => {
	const { assets, close, mic, project, wide } =
		threeMemberSession("Free tracks");
	const broll = asset("B-roll");
	const all = [...assets, broll];
	const userClip = { ...newSegment(broll, 0, 2), sourceOut: 6 };
	const withClip = {
		...project,
		segments: [userClip],
		trackSettings: [
			{ locked: true, muted: false, name: "Track 4", solo: false, track: 3 },
		],
	};
	const created = createMulticamGroup(withClip, all, {
		action: "create",
		members: [
			{ assetId: wide.id, kind: "angle", label: "Wide" },
			{ assetId: close.id, kind: "angle", label: "Close" },
			{ assetId: mic.id, kind: "mic", label: "Recorder" },
		],
		revision: withClip.revision,
		start: 0,
	});
	const layout = {
		layout: {
			angles: ["Wide", "Close"],
			fit: "fit" as const,
			layout: "side-by-side" as const,
		},
		end: 6,
		start: 0,
	};
	const changed = changeMulticamAngles(created.project, all, {
		action: "change",
		entries: [layout],
		groupId: created.group.id,
		revision: created.project.revision,
	});
	const own = changed.project.segments.filter(
		(segment) => segment.multicamGroupId === created.group.id
	);
	expect(own.map((segment) => segment.track).sort()).toEqual([0, 1, 4]);
	expect(
		changed.project.segments.filter((segment) => segment.track === 2)
	).toEqual([userClip]);
	expect(multicamSlotTracks(changed.project, changed.group)).toEqual([0, 4]);

	// Rebuilding the same session picks the same tracks.
	const rebuilt = changeMulticamAngles(changed.project, all, {
		action: "change",
		entries: [layout],
		groupId: created.group.id,
		revision: changed.project.revision,
	});
	expect(
		rebuilt.project.segments
			.filter((segment) => segment.multicamGroupId === created.group.id)
			.map((segment) => segment.track)
			.sort()
	).toEqual([0, 1, 4]);
});

test("a layout is refused when no free unlocked track is left", () => {
	const { assets, close, mic, project, wide } = threeMemberSession("Full");
	const created = createMulticamGroup(project, assets, {
		action: "create",
		members: [
			{ assetId: wide.id, kind: "angle", label: "Wide" },
			{ assetId: close.id, kind: "angle", label: "Close" },
			{ assetId: mic.id, kind: "mic", label: "Recorder" },
		],
		revision: project.revision,
		start: 0,
	});
	const locked = {
		...created.project,
		trackSettings: Array.from({ length: 30 }, (_, index) => ({
			locked: true,
			muted: false,
			name: `Track ${index + 3}`,
			solo: false,
			track: index + 2,
		})),
	};
	expect(() =>
		changeMulticamAngles(locked, assets, {
			action: "change",
			entries: [
				{
					end: 6,
					layout: {
						angles: ["Wide", "Close"],
						fit: "fill",
						layout: "side-by-side",
					},
					start: 0,
				},
			],
			groupId: created.group.id,
			revision: locked.revision,
		})
	).toThrow("Not enough free, unlocked tracks");
});
