import { describe, expect, test } from "bun:test";
import {
	EMPTY_LIBRARY_SELECTION,
	pruneLibrarySelection,
	selectAllLibraryAssets,
	selectLibraryAsset,
	selectModifiers,
} from "./library-selection.ts";

const visible = ["a", "b", "c", "d", "e"];
const plain = { range: false, toggle: false };
const toggle = { range: false, toggle: true };
const range = { range: true, toggle: false };
const addRange = { range: true, toggle: true };

describe("library selection", () => {
	test("plain click selects one and sets the anchor", () => {
		expect(
			selectLibraryAsset(EMPTY_LIBRARY_SELECTION, visible, "c", plain)
		).toEqual({ anchor: "c", ids: ["c"] });
	});

	test("Cmd/Ctrl toggles in visible order", () => {
		let selection = selectLibraryAsset(
			EMPTY_LIBRARY_SELECTION,
			visible,
			"d",
			toggle
		);
		selection = selectLibraryAsset(selection, visible, "b", toggle);
		expect(selection).toEqual({ anchor: "b", ids: ["b", "d"] });
		selection = selectLibraryAsset(selection, visible, "d", toggle);
		expect(selection).toEqual({ anchor: "d", ids: ["b"] });
	});

	test("Shift selects the range from the anchor in either direction", () => {
		const anchored = selectLibraryAsset(
			EMPTY_LIBRARY_SELECTION,
			visible,
			"d",
			plain
		);
		expect(selectLibraryAsset(anchored, visible, "b", range)).toEqual({
			anchor: "d",
			ids: ["b", "c", "d"],
		});
		expect(selectLibraryAsset(anchored, visible, "e", range).ids).toEqual([
			"d",
			"e",
		]);
		// Without an anchor, Shift starts a range at the clicked asset.
		expect(
			selectLibraryAsset(EMPTY_LIBRARY_SELECTION, visible, "c", range)
		).toEqual({ anchor: "c", ids: ["c"] });
	});

	test("Cmd+Shift adds the range to the selection", () => {
		let selection = selectLibraryAsset(
			EMPTY_LIBRARY_SELECTION,
			visible,
			"a",
			plain
		);
		selection = selectLibraryAsset(selection, visible, "d", toggle);
		expect(selectLibraryAsset(selection, visible, "e", addRange).ids).toEqual([
			"a",
			"d",
			"e",
		]);
	});

	test("unknown ids are ignored and select-all covers the visible list", () => {
		const selection = { anchor: "a", ids: ["a"] };
		expect(selectLibraryAsset(selection, visible, "zz", plain)).toBe(selection);
		expect(selectAllLibraryAssets(visible)).toEqual({
			anchor: "a",
			ids: visible,
		});
		expect(selectAllLibraryAssets([])).toEqual({ anchor: null, ids: [] });
	});

	test("pruning drops hidden ids and keeps identity when unchanged", () => {
		const selection = { anchor: "b", ids: ["b", "d"] };
		expect(pruneLibrarySelection(selection, visible)).toBe(selection);
		expect(pruneLibrarySelection(selection, ["a", "d"])).toEqual({
			anchor: null,
			ids: ["d"],
		});
	});

	test("modifiers read Shift and either Cmd or Ctrl", () => {
		expect(
			selectModifiers({ ctrlKey: false, metaKey: true, shiftKey: false })
		).toEqual(toggle);
		expect(
			selectModifiers({ ctrlKey: true, metaKey: false, shiftKey: true })
		).toEqual(addRange);
	});
});
