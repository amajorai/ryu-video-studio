import { describe, expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	projectSchema,
	type Segment,
	segmentDuration,
	updateTrackSetting,
} from "../../../../shared/project.ts";
import { dispatchShortcut } from "../../shortcuts/registry.ts";
import { createTestRuntime, lastStatus, testVideo } from "../test-runtime.ts";
import {
	deleteRange,
	rippleDeleteGapAt,
	rippleDeleteSelection,
	toggleRippleMode,
} from "./ripple.ts";
import { selectClips } from "./select.ts";
import { razorCut, razorTime, splitAtPlayhead } from "./split.ts";
import { trimClipsToPlayhead, trimSelectedToPlayhead } from "./trim.ts";
import type { ShortcutEventLike } from "./types.ts";

function press(
	key: string,
	modifiers: { alt?: boolean; cmd?: boolean; shift?: boolean } = {}
): ShortcutEventLike & { defaultPrevented: boolean } {
	const event = {
		altKey: modifiers.alt ?? false,
		code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
		ctrlKey: modifiers.cmd ?? false,
		defaultPrevented: false,
		key,
		metaKey: false,
		preventDefault: () => {
			event.defaultPrevented = true;
		},
		shiftKey: modifiers.shift ?? false,
		target: null,
	};
	return event;
}

function audioAsset(): Asset {
	return { ...testVideo("voice.wav", 30), height: 0, kind: "audio", width: 0 };
}

const end = (segment: Segment) => segment.start + segmentDuration(segment);

/**
 * Track 0: linked picture 0..6 then b-roll 6..9. Track 1: linked sound 0..6.
 * Track 2: music 0..9.
 */
function setup(patch: (project: Project) => Project = (value) => value) {
	const video = testVideo("clip.mp4", 30);
	const audio = audioAsset();
	const group = crypto.randomUUID();
	const picture = {
		...newSegment(video, 0, 0),
		linkGroupId: group,
		sourceOut: 6,
	};
	const sound = {
		...newSegment(audio, 0, 1),
		linkGroupId: group,
		sourceOut: 6,
	};
	const broll = { ...newSegment(video, 6, 0), sourceOut: 3 };
	const music = { ...newSegment(audio, 0, 2), sourceOut: 9 };
	const project = patch({
		...newProject("Cut actions"),
		segments: [picture, sound, broll, music],
	});
	const runtime = createTestRuntime(project, [video, audio]);
	return { broll, group, music, picture, runtime, sound };
}

const lane = (runtime: ReturnType<typeof setup>["runtime"], track: number) =>
	(runtime.project?.segments ?? [])
		.filter((segment) => segment.track === track)
		.sort((a, b) => a.start - b.start);

const edits = (runtime: ReturnType<typeof setup>["runtime"]) =>
	runtime.calls.filter(([name]) => name === "edit");

describe("split at playhead", () => {
	test("Cmd+K with no selection cuts every clip under the playhead in one undo step", () => {
		const { runtime } = setup();
		runtime.time = 3;
		expect(dispatchShortcut(press("k", { cmd: true }), runtime)).toBe(
			"split.atPlayhead"
		);
		expect(runtime.project?.segments).toHaveLength(7);
		expect(edits(runtime)).toEqual([["edit", "Split clips"]]);
		runtime.undo();
		expect(runtime.project?.segments).toHaveLength(4);
	});

	test("S cuts the selected clip and its linked partner only", () => {
		const { picture, runtime } = setup();
		runtime.setSelected(picture.id);
		runtime.time = 3;
		expect(dispatchShortcut(press("s"), runtime)).toBe("split.selected");
		expect(lane(runtime, 0)).toHaveLength(3);
		expect(lane(runtime, 1)).toHaveLength(2);
		expect(lane(runtime, 2)).toHaveLength(1);
		expect(lastStatus(runtime)).toBe("Split 2 clips at 0:03.0.");
	});

	test("a locked track is left whole", () => {
		const { runtime } = setup((project) =>
			updateTrackSetting(project, 2, { locked: true })
		);
		runtime.time = 3;
		splitAtPlayhead(runtime);
		expect(lane(runtime, 2)).toHaveLength(1);
		expect(lane(runtime, 0)).toHaveLength(3);
	});

	test("nothing under the playhead reports why", () => {
		const { runtime } = setup();
		runtime.time = 20;
		splitAtPlayhead(runtime);
		expect(edits(runtime)).toEqual([]);
		expect(lastStatus(runtime)).toBe(
			"There is no unlocked clip under that time to split."
		);
	});
});

describe("razor", () => {
	test("C selects the razor and a razor click cuts the clicked clip", () => {
		const { broll, runtime } = setup();
		expect(dispatchShortcut(press("c"), runtime)).toBe("tool.razor");
		expect(runtime.tool).toBe("razor");
		runtime.time = 0;
		razorCut(runtime, { at: 7.5, segment: broll, shiftKey: false });
		expect(lane(runtime, 0).map((segment) => segment.start)).toEqual([
			0, 6, 7.5,
		]);
		expect(lane(runtime, 2)).toHaveLength(1);
		expect(edits(runtime)).toEqual([["edit", "Razor cut"]]);
	});

	test("Shift-click cuts through every unlocked track", () => {
		const { broll, runtime } = setup();
		runtime.time = 0;
		razorCut(runtime, { at: 7.5, segment: broll, shiftKey: true });
		expect(lane(runtime, 0)).toHaveLength(3);
		expect(lane(runtime, 2).map((segment) => segment.start)).toEqual([0, 7.5]);
	});

	test("the cut snaps to the playhead within the threshold and quantizes otherwise", () => {
		const { broll, runtime } = setup();
		runtime.time = 7.5;
		runtime.zoom = 70;
		expect(
			razorTime(runtime, { at: 7.45, segment: broll, shiftKey: false })
		).toBe(7.5);
		expect(
			razorTime(runtime, { at: 8.012, segment: broll, shiftKey: false })
		).toBeCloseTo(8, 9);
		runtime.store.setState({ snapEnabled: false });
		expect(
			razorTime(runtime, { at: 7.45, segment: broll, shiftKey: false })
		).toBeCloseTo(7.466_666_7, 6);
	});

	test("a drag with the razor explains that it cuts on click", () => {
		const { runtime } = setup();
		expect(dispatchShortcut(press("c"), runtime)).toBe("tool.razor");
		expect(String(lastStatus(runtime))).toContain("Razor");
	});
});

describe("trim to playhead", () => {
	test("Q ripples the start of every clip under the playhead and moves the playhead", () => {
		const { broll, music, picture, runtime } = setup();
		runtime.time = 2;
		expect(dispatchShortcut(press("q"), runtime)).toBe("trim.startToPlayhead");
		const trimmed = runtime.project?.segments.find(
			(segment) => segment.id === picture.id
		);
		expect(trimmed?.start).toBe(0);
		expect(trimmed?.sourceIn).toBeCloseTo(2, 9);
		expect(
			runtime.project?.segments.find((segment) => segment.id === broll.id)
				?.start
		).toBeCloseTo(4, 9);
		expect(
			runtime.project?.segments.find((segment) => segment.id === music.id)
				?.sourceIn
		).toBeCloseTo(2, 9);
		expect(runtime.time).toBe(0);
		expect(edits(runtime)).toEqual([["edit", "Ripple trim start"]]);
	});

	test("Alt+] fits an exit transition to the shorter clip instead of failing", () => {
		const { broll, runtime } = setup((project) => ({
			...project,
			segments: project.segments.map((segment) =>
				segment.track === 0 && segment.start === 6
					? { ...segment, exitDuration: 3, exitTransition: "crossfade" }
					: segment
			),
		}));
		runtime.setSelected(broll.id);
		runtime.time = 7;
		trimSelectedToPlayhead(runtime, "end");
		const trimmed = runtime.project?.segments.find(
			(segment) => segment.id === broll.id
		);
		expect(trimmed && segmentDuration(trimmed)).toBeCloseTo(1, 9);
		expect(trimmed?.exitDuration).toBeCloseTo(1, 9);
		expect(edits(runtime)).toEqual([["edit", "Trim end to playhead"]]);
	});

	test("W ripples the end and shifts later clips", () => {
		const { broll, runtime } = setup();
		runtime.time = 4;
		expect(dispatchShortcut(press("w"), runtime)).toBe("trim.endToPlayhead");
		const first = lane(runtime, 0)[0];
		expect(first && end(first)).toBeCloseTo(4, 9);
		expect(
			runtime.project?.segments.find((segment) => segment.id === broll.id)
				?.start
		).toBeCloseTo(4, 9);
	});

	test("Alt+Q and Alt+W leave a gap", () => {
		const { broll, picture, runtime } = setup();
		runtime.setSelected(picture.id);
		runtime.time = 2;
		expect(dispatchShortcut(press("q", { alt: true }), runtime)).toBe(
			"trim.startToPlayheadGap"
		);
		const trimmed = runtime.project?.segments.find(
			(segment) => segment.id === picture.id
		);
		expect(trimmed?.start).toBeCloseTo(2, 9);
		expect(
			runtime.project?.segments.find((segment) => segment.id === broll.id)
				?.start
		).toBe(6);
		runtime.time = 5;
		trimClipsToPlayhead(runtime, "end", false);
		const shortened = runtime.project?.segments.find(
			(segment) => segment.id === picture.id
		);
		expect(shortened && end(shortened)).toBeCloseTo(5, 9);
		expect(
			runtime.project?.segments.find((segment) => segment.id === broll.id)
				?.start
		).toBe(6);
	});

	test("Alt+] trims the inspected clip with ripple when ripple mode is on", () => {
		const { broll, picture, runtime } = setup((project) =>
			updateTrackSetting(project, 2, { syncLocked: false })
		);
		runtime.store.setState({ rippleMode: true });
		runtime.setSelected(picture.id);
		runtime.time = 4;
		expect(dispatchShortcut(press("]", { alt: true }), runtime)).toBe(
			"trim.selectedEndToPlayhead"
		);
		expect(
			runtime.project?.segments.find((segment) => segment.id === broll.id)
				?.start
		).toBeCloseTo(4, 9);
	});

	test("a ripple trim over a sync-locked music bed leaves the gap and says so", () => {
		const { broll, picture, runtime } = setup();
		runtime.store.setState({ rippleMode: true });
		runtime.setSelected(picture.id);
		runtime.time = 4;
		dispatchShortcut(press("]", { alt: true }), runtime);
		expect(
			runtime.project?.segments.find((segment) => segment.id === broll.id)
				?.start
		).toBe(6);
		expect(String(lastStatus(runtime))).toContain("left a gap");
	});

	test("without a project the keys fall through", () => {
		const runtime = createTestRuntime(null);
		expect(dispatchShortcut(press("q"), runtime)).toBeNull();
	});
});

const withoutMusic = (project: Project): Project => ({
	...project,
	segments: project.segments.filter((segment) => segment.track !== 2),
});

describe("ripple delete", () => {
	test("ripple-deleting the marked range leaves its default span unmarked", () => {
		const { runtime } = setup();
		runtime.setRangeStart(1);
		runtime.setRangeEnd(3);
		runtime.setRangeMarked(true);
		deleteRange(runtime);
		expect(edits(runtime)).toEqual([["edit", "Ripple delete range"]]);
		expect(runtime.range).toEqual({ end: 2, start: 1 });
		expect(runtime.rangeMarked).toBe(false);
	});

	test("Shift+Delete removes the selection with partners and closes the span", () => {
		const { broll, picture, runtime } = setup(withoutMusic);
		runtime.setSelected(picture.id);
		expect(dispatchShortcut(press("Delete", { shift: true }), runtime)).toBe(
			"ripple.deleteSelection"
		);
		expect(
			runtime.project?.segments.find((segment) => segment.id === broll.id)
				?.start
		).toBe(0);
		expect(lane(runtime, 1)).toHaveLength(0);
		expect(runtime.selectedId).toBeNull();
		expect(edits(runtime)).toEqual([["edit", "Ripple delete"]]);
	});

	test("a span another clip still covers stays open and is reported", () => {
		const { broll, picture, runtime } = setup();
		runtime.setSelected(picture.id);
		expect(dispatchShortcut(press("Backspace", { shift: true }), runtime)).toBe(
			"ripple.deleteSelection"
		);
		expect(
			runtime.project?.segments.find((segment) => segment.id === broll.id)
				?.start
		).toBe(6);
		expect(lastStatus(runtime)).toBe(
			"Ripple-deleted 2 clips. 1 gap stayed open because other clips still cover it."
		);
	});

	test("ripple mode makes Delete ripple; toggling reports the mode", () => {
		const { broll, picture, runtime } = setup(withoutMusic);
		runtime.setSelected(picture.id);
		expect(dispatchShortcut(press("Delete"), runtime)).toBe("clip.delete");
		expect(
			runtime.project?.segments.find((segment) => segment.id === broll.id)
				?.start
		).toBe(6);
		runtime.undo();
		toggleRippleMode(runtime);
		expect(runtime.store.getState().rippleMode).toBe(true);
		expect(String(lastStatus(runtime))).toContain("Ripple mode on");
		runtime.setSelected(picture.id);
		expect(dispatchShortcut(press("Backspace"), runtime)).toBe("clip.delete");
		expect(
			runtime.project?.segments.find((segment) => segment.id === broll.id)
				?.start
		).toBe(0);
	});

	test("deleting a reveal's predecessor drops the reveal so the project stays valid", () => {
		const video = testVideo("clip.mp4", 30);
		const outgoing = { ...newSegment(video, 0, 0), sourceOut: 4 };
		const incoming: Segment = {
			...newSegment(video, 3.5, 0),
			sourceOut: 4,
			transitionIn: { duration: 0.5, softness: 0.2, type: "wipe-left" },
		};
		for (const ripple of [false, true]) {
			const runtime = createTestRuntime(
				{ ...newProject("Reveal"), segments: [outgoing, incoming] },
				[video]
			);
			if (ripple) {
				toggleRippleMode(runtime);
			}
			runtime.setSelected(outgoing.id);
			expect(dispatchShortcut(press("Delete"), runtime)).toBe("clip.delete");
			const remaining = runtime.project?.segments ?? [];
			expect(remaining.map((segment) => segment.id)).toEqual([incoming.id]);
			expect(remaining[0]?.transitionIn).toBeUndefined();
			expect(() => projectSchema.parse(runtime.project)).not.toThrow();
		}
	});

	test("a non-contiguous selection closes each span", () => {
		const video = testVideo("clip.mp4", 30);
		const clips = [0, 2, 4, 6].map((start) => ({
			...newSegment(video, start, 0),
			sourceOut: 2,
		}));
		const runtime = createTestRuntime(
			{ ...newProject("Spans"), segments: clips },
			[video]
		);
		selectClips(runtime, [clips[0]?.id ?? "", clips[2]?.id ?? ""]);
		expect(rippleDeleteSelection(runtime)).toBe(true);
		expect(runtime.project?.segments.map((segment) => segment.start)).toEqual([
			0, 2,
		]);
	});

	test("nothing selected declines the key", () => {
		const { runtime } = setup();
		expect(rippleDeleteSelection(runtime)).toBe(false);
	});

	test("ripple delete gap closes the gap on the lane", () => {
		const video = testVideo("clip.mp4", 30);
		const first = { ...newSegment(video, 0, 0), sourceOut: 2 };
		const second = { ...newSegment(video, 5, 0), sourceOut: 2 };
		const runtime = createTestRuntime(
			{ ...newProject("Gap"), segments: [first, second] },
			[video]
		);
		rippleDeleteGapAt(runtime, 0, 3);
		expect(runtime.project?.segments.map((segment) => segment.start)).toEqual([
			0, 2,
		]);
		expect(lastStatus(runtime)).toBe("Closed a 0:03.0 gap on track 1.");
		rippleDeleteGapAt(runtime, 0, 1);
		expect(lastStatus(runtime)).toBe(
			"There is no gap between clips at that point."
		);
	});
});
