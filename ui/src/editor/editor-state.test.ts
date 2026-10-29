import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { newProject } from "../../../shared/project.ts";
import {
	emptyHistory,
	HISTORY_LIMIT,
	mapHistory,
	recordHistory,
	redoHistory,
	undoHistory,
} from "./history.ts";
import { clockPosition } from "./playback-clock.ts";
import {
	createEditorStore,
	DEFAULT_ZOOM_PX_PER_SEC,
	initialEditorState,
	withClickSelection,
	withPrimarySelection,
} from "./store.ts";
import {
	readViewerValue,
	removeViewerValue,
	VIEWER_STORAGE_PREFIX,
	type ViewerStorageArea,
	writeViewerValue,
} from "./viewer-storage.ts";

describe("editor store", () => {
	test("declares every planned field with today's defaults", () => {
		const state = initialEditorState();
		expect(state.tool).toBe("pointer");
		expect(state.snapEnabled).toBe(true);
		expect(state.rippleMode).toBe(false);
		expect(state.zoomPxPerSec).toBe(DEFAULT_ZOOM_PX_PER_SEC);
		expect(state.loop).toEqual({ mode: "off" });
		expect(state.playbackRate).toBe(1);
		expect(state.previewQuality).toBe("full");
		expect(state.previewZoom).toBe("fit");
		expect(state.guides.size).toBe(0);
		expect(state.clipboard).toBeNull();
		expect(state.drag).toBeNull();
		expect(state.snapGuideTime).toBeNull();
		expect(state.maximizedPanel).toBeNull();
		expect(state.markerStatusFilter).toBe("all");
		expect(state.selection).toEqual({
			overlayIds: [],
			primaryId: null,
			segmentIds: [],
		});
		expect(state.history).toEqual(emptyHistory());
		expect(state.openKeyframeLanes).toEqual([]);
		expect(state.trackingRegion).toBeNull();
		expect(state.trackingRegionDrawing).toBe(false);
		expect(state.useProxies).toBe(false);
	});

	test("notifies subscribers only for real changes", () => {
		const store = createEditorStore();
		let notified = 0;
		const unsubscribe = store.subscribe(() => {
			notified++;
		});
		store.setState({ tool: "ripple" });
		store.setState({ tool: "ripple" });
		store.setState((state) => ({ zoomPxPerSec: state.zoomPxPerSec * 2 }));
		expect(notified).toBe(2);
		expect(store.getState().zoomPxPerSec).toBe(DEFAULT_ZOOM_PX_PER_SEC * 2);
		unsubscribe();
		store.setState({ tool: "slip" });
		expect(notified).toBe(2);
	});

	test("primary selection keeps a multi-selection that contains it", () => {
		const base = withClickSelection(
			withClickSelection(initialEditorState().selection, "a", false),
			"b",
			true
		);
		expect(base).toMatchObject({ primaryId: "b", segmentIds: ["a", "b"] });
		expect(withPrimarySelection(base, "a")).toMatchObject({
			primaryId: "a",
			segmentIds: ["a", "b"],
		});
		expect(withPrimarySelection(base, "c")).toMatchObject({
			primaryId: "c",
			segmentIds: ["c"],
		});
		expect(withPrimarySelection(base, null)).toMatchObject({
			primaryId: null,
			segmentIds: [],
		});
	});

	test("shift-click toggles and the last remaining clip is inspected", () => {
		const selection = withClickSelection(
			{ overlayIds: [], primaryId: "b", segmentIds: ["a", "b"] },
			"b",
			true
		);
		expect(selection).toMatchObject({ primaryId: "a", segmentIds: ["a"] });
		expect(withClickSelection(selection, "a", true)).toMatchObject({
			primaryId: null,
			segmentIds: [],
		});
	});
});

describe("labelled history", () => {
	test("undo and redo keep the current decisions and revision", () => {
		const first = { ...newProject("one"), revision: 3 };
		const second = { ...first, title: "two" };
		let history = recordHistory(emptyHistory(), first, "Rename", 10);
		expect(history.past).toEqual([{ at: 10, label: "Rename", project: first }]);
		const saved = { ...second, revision: 7 };
		const undone = undoHistory(history, saved);
		expect(undone?.project.title).toBe("one");
		expect(undone?.project.revision).toBe(7);
		history = undone?.state ?? history;
		expect(history.future[0]?.label).toBe("Rename");
		const redone = redoHistory(history, undone?.project ?? first);
		expect(redone?.project.title).toBe("two");
		expect(redone?.state.past).toHaveLength(1);
		expect(redone?.state.future).toHaveLength(0);
	});

	test("a new edit clears redo and the stack is bounded", () => {
		const project = newProject();
		let history = emptyHistory();
		for (let index = 0; index < HISTORY_LIMIT + 5; index++) {
			history = recordHistory(history, { ...project, title: `${index}` });
		}
		expect(history.past).toHaveLength(HISTORY_LIMIT);
		expect(history.past[0]?.project.title).toBe("5");
		const undone = undoHistory(history, project);
		expect(undone?.state.future).toHaveLength(1);
		expect(
			recordHistory(undone?.state ?? history, project, "Edit").future
		).toEqual([]);
		expect(undoHistory(emptyHistory(), project)).toBeNull();
		expect(redoHistory(emptyHistory(), project)).toBeNull();
	});

	test("mapHistory rewrites every stored snapshot", () => {
		const project = newProject();
		const history = recordHistory(emptyHistory(), project);
		const mapped = mapHistory(history, (item) => ({
			...item,
			requireApproval: true,
		}));
		expect(mapped.past[0]?.project.requireApproval).toBe(true);
	});
});

describe("playback clock", () => {
	test("advances in either direction and ends at the timeline bounds", () => {
		const origin = { at: 1000, time: 2 };
		expect(clockPosition(origin, 1500, 1, 10)).toEqual({
			ended: false,
			time: 2.5,
		});
		expect(clockPosition(origin, 1500, -1, 10)).toEqual({
			ended: false,
			time: 1.5,
		});
		expect(clockPosition(origin, 20_000, 1, 10)).toEqual({
			ended: true,
			time: 10,
		});
		expect(clockPosition(origin, 20_000, -1, 10)).toEqual({
			ended: true,
			time: 0,
		});
	});
});

describe("viewer storage", () => {
	const memory = (): ViewerStorageArea & { values: Map<string, string> } => {
		const values = new Map<string, string>();
		return {
			getItem: (key) => values.get(key) ?? null,
			removeItem: (key) => {
				values.delete(key);
			},
			setItem: (key, value) => {
				values.set(key, value);
			},
			values,
		};
	};
	const throwing: ViewerStorageArea = {
		getItem: () => {
			throw new Error("blocked");
		},
		removeItem: () => {
			throw new Error("blocked");
		},
		setItem: () => {
			throw new Error("blocked");
		},
	};

	test("round-trips values under the namespaced key", () => {
		const area = memory();
		expect(writeViewerValue("zoom", 120, area)).toBe(true);
		expect(area.values.get(`${VIEWER_STORAGE_PREFIX}zoom`)).toBe("120");
		expect(readViewerValue("zoom", z.number(), 70, area)).toBe(120);
		expect(removeViewerValue("zoom", area)).toBe(true);
		expect(readViewerValue("zoom", z.number(), 70, area)).toBe(70);
	});

	test("falls back on missing, invalid, or unavailable storage", () => {
		const area = memory();
		area.values.set(`${VIEWER_STORAGE_PREFIX}zoom`, "{not json");
		expect(readViewerValue("zoom", z.number(), 70, area)).toBe(70);
		area.values.set(`${VIEWER_STORAGE_PREFIX}zoom`, '"wide"');
		expect(readViewerValue("zoom", z.number(), 70, area)).toBe(70);
		expect(readViewerValue("zoom", z.number(), 70, throwing)).toBe(70);
		expect(writeViewerValue("zoom", 1, throwing)).toBe(false);
		expect(removeViewerValue("zoom", throwing)).toBe(false);
		expect(readViewerValue("zoom", z.number(), 70, null)).toBe(70);
		expect(writeViewerValue("zoom", 1, null)).toBe(false);
	});
});
