import { afterEach, describe, expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	updateTrackSetting,
} from "../../../../shared/project.ts";
import { dispatchShortcut, runAction } from "../../shortcuts/registry.ts";
import { createTestRuntime, lastStatus, testVideo } from "../test-runtime.ts";
import {
	clearSettingsClipboard,
	clipboardPayload,
	copySettingsFrom,
	pasteSettingsToSelection,
} from "./clipboard.ts";
import { cancelOrClear, selectClips } from "./select.ts";
import type { ShortcutEventLike } from "./types.ts";

afterEach(() => {
	clearSettingsClipboard();
});

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
	return { ...testVideo("voice.wav", 20), height: 0, kind: "audio", width: 0 };
}

/** A linked A/V pair at 0..4 (tracks 0 and 1) and b-roll at 6..8 on track 0. */
function setup() {
	const video = testVideo("clip.mp4", 20);
	const audio = audioAsset();
	const linkGroupId = crypto.randomUUID();
	const picture = { ...newSegment(video, 0, 0), linkGroupId, sourceOut: 4 };
	const sound = { ...newSegment(audio, 0, 1), linkGroupId, sourceOut: 4 };
	const broll = { ...newSegment(video, 6, 0), brightness: 0.4, sourceOut: 2 };
	const project: Project = {
		...newProject("Clipboard actions"),
		segments: [picture, sound, broll],
	};
	const runtime = createTestRuntime(project, [video, audio]);
	return { broll, picture, project, runtime, sound };
}

const ids = (project: Project | null) =>
	(project?.segments ?? []).map((segment) => segment.id).sort();

describe("clipboard actions", () => {
	test("cut then paste three clips with a linked pair is one undo step each", () => {
		const { broll, picture, project, runtime } = setup();
		selectClips(runtime, [picture.id, broll.id]);
		expect(dispatchShortcut(press("x", { cmd: true }), runtime)).toBe(
			"clipboard.cut"
		);
		expect(runtime.project?.segments).toHaveLength(0);
		expect(runtime.store.getState().clipboard?.items).toHaveLength(3);
		const afterCut = runtime.project;

		runtime.time = 10;
		expect(dispatchShortcut(press("v", { cmd: true }), runtime)).toBe(
			"clipboard.paste"
		);
		const pasted = runtime.project?.segments ?? [];
		expect(pasted).toHaveLength(3);
		expect(pasted.map((segment) => segment.start).sort()).toEqual([10, 10, 16]);
		const linked = pasted.filter((segment) => segment.linkGroupId);
		expect(linked).toHaveLength(2);
		expect(linked[0]?.linkGroupId).toBe(linked[1]?.linkGroupId);
		expect(linked[0]?.linkGroupId).not.toBe(picture.linkGroupId);
		expect(runtime.selectedIds).toHaveLength(3);
		expect(runtime.calls.filter(([name]) => name === "edit")).toEqual([
			["edit", "Cut"],
			["edit", "Paste"],
		]);

		runtime.undo();
		expect(runtime.project).toEqual(afterCut);
		runtime.undo();
		expect(ids(runtime.project)).toEqual(ids(project));
	});

	test("cut ripples when ripple mode is on", () => {
		const { broll, picture, runtime } = setup();
		runtime.store.setState({ rippleMode: true });
		selectClips(runtime, [picture.id]);
		dispatchShortcut(press("x", { cmd: true }), runtime);
		expect(
			runtime.project?.segments.find((segment) => segment.id === broll.id)
				?.start
		).toBe(2);
		expect(runtime.calls.findLast(([name]) => name === "edit")).toEqual([
			"edit",
			"Ripple cut",
		]);
	});

	test("ripple cut leaves a gap open when other clips remain in it", () => {
		const video = testVideo("clip.mp4", 20);
		const picture = { ...newSegment(video, 0, 0), sourceOut: 4 };
		const broll = { ...newSegment(video, 6, 0), sourceOut: 2 };
		const cover = { ...newSegment(video, 0, 2), sourceOut: 8 };
		const runtime = createTestRuntime(
			{ ...newProject("Gap"), segments: [picture, broll, cover] },
			[video]
		);
		runtime.store.setState({ rippleMode: true });
		selectClips(runtime, [picture.id]);
		dispatchShortcut(press("x", { cmd: true }), runtime);
		expect(
			runtime.project?.segments.find((segment) => segment.id === cover.id)
		).toEqual(cover);
		expect(
			runtime.project?.segments.find((segment) => segment.id === broll.id)
				?.start
		).toBe(6);
		expect(lastStatus(runtime)).toContain("1 gap stayed open");
	});

	test("Ctrl+Y redoes the last undone edit", () => {
		const { picture, runtime } = setup();
		selectClips(runtime, [picture.id]);
		dispatchShortcut(press("x", { cmd: true }), runtime);
		const afterCut = runtime.project;
		runtime.undo();
		expect(dispatchShortcut(press("y", { cmd: true }), runtime)).toBe(
			"history.redoAlt"
		);
		expect(runtime.project).toEqual(afterCut);
	});

	test("copy keeps the timeline and paste insert ripples later clips", () => {
		const { broll, runtime } = setup();
		selectClips(runtime, [broll.id]);
		expect(dispatchShortcut(press("c", { cmd: true }), runtime)).toBe(
			"clipboard.copy"
		);
		expect(runtime.project?.segments).toHaveLength(3);
		runtime.time = 6;
		expect(
			dispatchShortcut(press("v", { cmd: true, shift: true }), runtime)
		).toBe("clipboard.pasteInsert");
		expect(
			runtime.project?.segments.find((segment) => segment.id === broll.id)
				?.start
		).toBe(8);
		const copy = runtime.project?.segments.find(
			(segment) => segment.id === runtime.selectedId
		);
		expect(copy).toMatchObject({ start: 6, track: 0 });
	});

	test("a cut payload still pastes after its clips are gone", () => {
		const { broll, runtime } = setup();
		selectClips(runtime, [broll.id]);
		dispatchShortcut(press("x", { cmd: true }), runtime);
		expect(clipboardPayload(runtime)?.items[0]?.segment.id).toBe(broll.id);
	});

	test("copy, cut and paste decline with nothing to act on", () => {
		const { runtime } = setup();
		const copy = press("c", { cmd: true });
		expect(dispatchShortcut(copy, runtime)).toBeNull();
		expect(copy.defaultPrevented).toBe(false);
		expect(dispatchShortcut(press("x", { cmd: true }), runtime)).toBeNull();
		expect(dispatchShortcut(press("v", { cmd: true }), runtime)).toBeNull();
	});

	test("D duplicates the selection and its linked partner after its end", () => {
		const { picture, runtime } = setup();
		selectClips(runtime, [picture.id]);
		expect(dispatchShortcut(press("d"), runtime)).toBe("clipboard.duplicate");
		const copies = runtime.project?.segments.filter(
			(segment) => segment.start === 4
		);
		// The partner comes along; the b-roll at 6..8 occupies track 0 and
		// track 1 is an audio lane, so the pair keeps its spacing two tracks up.
		expect(copies?.map((segment) => segment.track).sort()).toEqual([2, 3]);
		expect(runtime.time).toBe(4);
		expect(runtime.calls.findLast(([name]) => name === "edit")).toEqual([
			"edit",
			"Duplicate clip",
		]);
	});

	test("paste reports a locked destination instead of editing", () => {
		const { broll, runtime } = setup();
		selectClips(runtime, [broll.id]);
		dispatchShortcut(press("c", { cmd: true }), runtime);
		let locked = runtime.project as Project;
		for (let track = 0; track < 32; track += 1) {
			locked = updateTrackSetting(locked, track, { locked: true });
		}
		runtime.project = locked;
		runtime.refresh();
		const before = runtime.calls.length;
		expect(dispatchShortcut(press("v", { cmd: true }), runtime)).toBe(
			"clipboard.paste"
		);
		expect(runtime.calls.slice(before).some(([name]) => name === "edit")).toBe(
			false
		);
		expect(lastStatus(runtime)).toBe(
			"No free track can hold the pasted clips."
		);
	});
});

describe("paste settings", () => {
	test("Cmd+Alt+V pastes the copied clip's settings onto the selection", () => {
		const { broll, picture, runtime } = setup();
		selectClips(runtime, [broll.id]);
		dispatchShortcut(press("c", { cmd: true }), runtime);
		selectClips(runtime, [picture.id]);
		const event = { ...press("v", { alt: true, cmd: true }), code: "KeyV" };
		expect(dispatchShortcut(event, runtime)).toBe("clipboard.pasteSettings");
		expect(
			runtime.project?.segments.find((segment) => segment.id === picture.id)
				?.brightness
		).toBe(0.4);
	});

	test("the settings clipboard limits the paste to its groups", () => {
		const { broll, picture, runtime } = setup();
		copySettingsFrom({ ...broll, opacity: 0.5 }, ["transform"]);
		expect(pasteSettingsToSelection(runtime, [picture.id])).toBe(true);
		const changed = runtime.project?.segments.find(
			(segment) => segment.id === picture.id
		);
		expect(changed).toMatchObject({ brightness: 0, opacity: 0.5 });
		expect(runtime.calls.findLast(([name]) => name === "edit")).toEqual([
			"edit",
			"Paste clip settings",
		]);
	});

	test("declines without a source", () => {
		const { picture, runtime } = setup();
		selectClips(runtime, [picture.id]);
		expect(pasteSettingsToSelection(runtime)).toBe(false);
	});
});

describe("selection actions", () => {
	test("A selects forward on the selected clip's track; Shift+A on all tracks", () => {
		const { broll, picture, runtime, sound } = setup();
		selectClips(runtime, [broll.id]);
		runtime.time = 0;
		expect(dispatchShortcut(press("a"), runtime)).toBe("select.forwardOnTrack");
		expect([...runtime.selectedIds].sort()).toEqual(
			[picture.id, broll.id].sort()
		);
		runtime.time = 0.5;
		expect(dispatchShortcut(press("A", { shift: true }), runtime)).toBe(
			"select.forwardAllTracks"
		);
		expect(runtime.selectedIds).toEqual([broll.id]);
		runtime.time = 0;
		dispatchShortcut(press("A", { shift: true }), runtime);
		expect([...runtime.selectedIds].sort()).toEqual(
			[picture.id, sound.id, broll.id].sort()
		);
	});

	test("A without a selected clip asks for one", () => {
		const { runtime } = setup();
		dispatchShortcut(press("a"), runtime);
		expect(runtime.selectedIds).toEqual([]);
		expect(lastStatus(runtime)).toBe(
			"Select a clip to choose its track first."
		);
	});

	test("Cmd+A selects all; Cmd+Shift+A is left to Ryu's push-to-talk", () => {
		const { broll, picture, runtime } = setup();
		expect(dispatchShortcut(press("a", { cmd: true }), runtime)).toBe(
			"select.all"
		);
		expect(runtime.selectedIds).toHaveLength(3);
		selectClips(runtime, [broll.id]);
		// The OS takes Cmd/Ctrl+Shift+A for the island's push-to-talk, so
		// Select all on track ships unbound and runs from its action.
		expect(
			dispatchShortcut(press("a", { cmd: true, shift: true }), runtime)
		).not.toBe("select.allOnTrack");
		selectClips(runtime, [broll.id]);
		expect(runAction("select.allOnTrack", runtime)).toBe(true);
		expect([...runtime.selectedIds].sort()).toEqual(
			[picture.id, broll.id].sort()
		);
	});

	test("Escape cancels a drag first, then clears the selection, then declines", () => {
		const { picture, runtime } = setup();
		selectClips(runtime, [picture.id]);
		runtime.store.setState({
			drag: { ids: [], kind: "marquee", originX: 0, originY: 0 },
		});
		expect(dispatchShortcut(press("Escape"), runtime)).toBe("select.cancel");
		expect(runtime.store.getState().drag).toBeNull();
		expect(runtime.selectedIds).toEqual([picture.id]);
		expect(dispatchShortcut(press("Escape"), runtime)).toBe("select.cancel");
		expect(runtime.selectedIds).toEqual([]);
		expect(cancelOrClear(runtime)).toBe(false);
	});
});
