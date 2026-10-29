import { describe, expect, test } from "bun:test";
import {
	activatePreviewTab,
	canGoBack,
	canGoForward,
	closePreviewTab,
	emptyPreviewTabs,
	MAX_SOURCE_TABS,
	openSourceTab,
	previewTabBack,
	previewTabForward,
	previewTabsSchema,
	prunePreviewTabs,
	TIMELINE_TAB,
} from "./preview-tabs.ts";

describe("preview tabs", () => {
	test("opening a source adds a tab, activates it, and records history", () => {
		const opened = openSourceTab(emptyPreviewTabs(), "a");
		expect(opened).toEqual({
			active: "a",
			back: [TIMELINE_TAB],
			forward: [],
			tabs: ["a"],
		});
		const again = openSourceTab(openSourceTab(opened, "b"), "a");
		expect(again.tabs).toEqual(["a", "b"]);
		expect(again.active).toBe("a");
		expect(again.back).toEqual([TIMELINE_TAB, "a", "b"]);
		expect(openSourceTab(again, TIMELINE_TAB)).toBe(again);
	});

	test("back and forward walk the switches like a browser", () => {
		let state = openSourceTab(openSourceTab(emptyPreviewTabs(), "a"), "b");
		expect(canGoBack(state)).toBe(true);
		expect(canGoForward(state)).toBe(false);
		state = previewTabBack(state);
		expect(state.active).toBe("a");
		state = previewTabBack(state);
		expect(state.active).toBe(TIMELINE_TAB);
		expect(canGoBack(state)).toBe(false);
		expect(previewTabBack(state)).toBe(state);
		state = previewTabForward(state);
		expect(state.active).toBe("a");
		state = previewTabForward(state);
		expect(state.active).toBe("b");
		expect(canGoForward(state)).toBe(false);
		// A new switch clears forward history.
		state = activatePreviewTab(previewTabBack(state), TIMELINE_TAB);
		expect(state.forward).toEqual([]);
		expect(activatePreviewTab(state, "missing")).toBe(state);
	});

	test("closing the active tab returns to the last open tab", () => {
		let state = openSourceTab(openSourceTab(emptyPreviewTabs(), "a"), "b");
		state = closePreviewTab(state, "b");
		expect(state.active).toBe("a");
		expect(state.tabs).toEqual(["a"]);
		state = closePreviewTab(state, "a");
		expect(state).toEqual(emptyPreviewTabs());
		expect(closePreviewTab(state, "a")).toBe(state);
	});

	test("closing an inactive tab removes it from history", () => {
		let state = openSourceTab(openSourceTab(emptyPreviewTabs(), "a"), "b");
		state = closePreviewTab(state, "a");
		expect(state.active).toBe("b");
		expect(state.back).toEqual([TIMELINE_TAB]);
		expect(previewTabBack(state).active).toBe(TIMELINE_TAB);
	});

	test("tab count is capped by closing the oldest inactive tab", () => {
		let state = emptyPreviewTabs();
		for (let index = 0; index <= MAX_SOURCE_TABS; index += 1) {
			state = openSourceTab(state, `asset-${index}`);
		}
		expect(state.tabs).toHaveLength(MAX_SOURCE_TABS);
		expect(state.tabs).not.toContain("asset-0");
		expect(state.active).toBe(`asset-${MAX_SOURCE_TABS}`);
	});

	test("pruning closes tabs for deleted assets", () => {
		const state = openSourceTab(openSourceTab(emptyPreviewTabs(), "a"), "b");
		const pruned = prunePreviewTabs(state, new Set(["a"]));
		expect(pruned.tabs).toEqual(["a"]);
		expect(pruned.active).toBe("a");
	});

	test("stored tabs are sanitized", () => {
		expect(
			previewTabsSchema.parse({
				active: "gone",
				back: ["a", "a", "zzz", TIMELINE_TAB],
				forward: 4,
				tabs: ["a", "a", TIMELINE_TAB, "b"],
			})
		).toEqual({
			active: TIMELINE_TAB,
			back: ["a", TIMELINE_TAB],
			forward: [],
			tabs: ["a", "b"],
		});
		expect(previewTabsSchema.safeParse(null).success).toBe(false);
	});
});
