import { describe, expect, test } from "bun:test";
import {
	VIEWER_STORAGE_PREFIX,
	type ViewerStorageArea,
} from "../editor/viewer-storage.ts";
import {
	applyLayoutChoice,
	COLUMN_PANELS,
	groupLayout,
	initialLayoutState,
	LAYOUT_PRESET_IDS,
	LAYOUT_PRESETS,
	MIN_PANEL_PERCENT,
	normalizeSizes,
	panelContaining,
	panelDomId,
	ROW_PANELS,
	readLayoutState,
	resizeGroup,
	sameSizes,
	saveCurrentLayout,
	toggleMaximized,
	WORKSPACE_LAYOUT_KEY,
	type WorkspaceSizes,
	writeLayoutState,
} from "./layout-presets.ts";

function memoryArea(): ViewerStorageArea & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (key) => data.get(key) ?? null,
		removeItem: (key) => {
			data.delete(key);
		},
		setItem: (key, value) => {
			data.set(key, value);
		},
	};
}

const throwingArea: ViewerStorageArea = {
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

const sum = (values: Record<string, number>) =>
	Object.values(values).reduce((total, value) => total + value, 0);

describe("layout presets", () => {
	test("every preset sums to 100 per group and respects minimum sizes", () => {
		for (const id of LAYOUT_PRESET_IDS) {
			const { sizes } = LAYOUT_PRESETS[id];
			expect(sum(sizes.columns)).toBeCloseTo(100, 5);
			expect(sum(sizes.rows)).toBeCloseTo(100, 5);
			for (const panel of COLUMN_PANELS) {
				expect(sizes.columns[panel]).toBeGreaterThanOrEqual(
					MIN_PANEL_PERCENT[panel]
				);
			}
			for (const row of ROW_PANELS) {
				expect(sizes.rows[row]).toBeGreaterThanOrEqual(MIN_PANEL_PERCENT[row]);
			}
			expect(normalizeSizes(sizes)).toEqual(sizes);
		}
	});

	test("presets differ: audio grows the timeline, review grows the stage", () => {
		const edit = LAYOUT_PRESETS.edit.sizes;
		expect(LAYOUT_PRESETS.audio.sizes.rows.timeline).toBeGreaterThan(
			edit.rows.timeline
		);
		expect(LAYOUT_PRESETS.review.sizes.columns.stage).toBeGreaterThan(
			edit.columns.stage
		);
		expect(LAYOUT_PRESETS.color.sizes.columns.inspector).toBeGreaterThan(
			edit.columns.inspector
		);
	});

	test("applying a preset and saving the current layout", () => {
		const color = applyLayoutChoice(initialLayoutState(), "color");
		expect(color.choice).toBe("color");
		expect(color.sizes).toEqual(LAYOUT_PRESETS.color.sizes);
		// "saved" without a saved layout changes nothing.
		expect(applyLayoutChoice(color, "saved")).toBe(color);
		const saved = saveCurrentLayout(color);
		expect(saved.choice).toBe("saved");
		expect(saved.saved).toEqual(LAYOUT_PRESETS.color.sizes);
		const review = applyLayoutChoice(saved, "review");
		const back = applyLayoutChoice(review, "saved");
		expect(back.sizes).toEqual(LAYOUT_PRESETS.color.sizes);
		expect(back.choice).toBe("saved");
	});
});

describe("normalizeSizes", () => {
	test("clamps to minimums and rescales to 100", () => {
		const sizes: WorkspaceSizes = {
			columns: { inspector: 0, library: 5, stage: 300 },
			rows: { timeline: 2, workspace: 98 },
		};
		const normalized = normalizeSizes(sizes);
		expect(sum(normalized.columns)).toBeCloseTo(100, 5);
		expect(sum(normalized.rows)).toBeCloseTo(100, 5);
		expect(normalized.columns.inspector).toBe(MIN_PANEL_PERCENT.inspector);
		expect(normalized.columns.library).toBeGreaterThanOrEqual(
			MIN_PANEL_PERCENT.library
		);
		expect(normalized.rows.timeline).toBe(MIN_PANEL_PERCENT.timeline);
	});

	test("invalid shares fall back to the given layout", () => {
		const sizes = {
			columns: { inspector: Number.NaN, library: 20, stage: 60 },
			rows: { timeline: -4, workspace: 70 },
		};
		expect(normalizeSizes(sizes, LAYOUT_PRESETS.audio.sizes)).toEqual(
			LAYOUT_PRESETS.audio.sizes
		);
	});
});

describe("splitter persistence", () => {
	test("a drag becomes a custom layout that survives a reload", () => {
		const area = memoryArea();
		const start = readLayoutState(area);
		expect(start).toEqual(initialLayoutState());
		const dragged = resizeGroup(start, "columns", {
			[panelDomId("inspector")]: 30,
			[panelDomId("library")]: 20,
			[panelDomId("stage")]: 50,
		});
		expect(dragged.choice).toBe("custom");
		expect(dragged.sizes.columns).toEqual({
			inspector: 30,
			library: 20,
			stage: 50,
		});
		expect(writeLayoutState(dragged, area)).toBe(true);
		expect(area.data.has(VIEWER_STORAGE_PREFIX + WORKSPACE_LAYOUT_KEY)).toBe(
			true
		);
		expect(readLayoutState(area)).toEqual(dragged);
	});

	test("a layout matching the current one keeps the preset selected", () => {
		const state = applyLayoutChoice(initialLayoutState(), "review");
		const same = resizeGroup(
			state,
			"rows",
			groupLayout(
				{
					...state.sizes,
					rows: { timeline: 18.2, workspace: 81.8 },
				},
				"rows"
			)
		);
		expect(same).toBe(state);
	});

	test("incomplete splitter reports are ignored", () => {
		const state = initialLayoutState();
		expect(resizeGroup(state, "rows", { [panelDomId("timeline")]: 50 })).toBe(
			state
		);
	});

	test("blocked or corrupt storage falls back to the default layout", () => {
		expect(readLayoutState(throwingArea)).toEqual(initialLayoutState());
		expect(writeLayoutState(initialLayoutState(), throwingArea)).toBe(false);
		const area = memoryArea();
		area.setItem(VIEWER_STORAGE_PREFIX + WORKSPACE_LAYOUT_KEY, "{not json");
		expect(readLayoutState(area)).toEqual(initialLayoutState());
		area.setItem(
			VIEWER_STORAGE_PREFIX + WORKSPACE_LAYOUT_KEY,
			JSON.stringify({ ...initialLayoutState(), version: 2 })
		);
		expect(readLayoutState(area)).toEqual(initialLayoutState());
	});

	test("groupLayout follows DOM panel order for every preset", () => {
		for (const preset of Object.values(LAYOUT_PRESETS)) {
			expect(Object.keys(groupLayout(preset.sizes, "columns"))).toEqual(
				COLUMN_PANELS.map(panelDomId)
			);
			expect(Object.keys(groupLayout(preset.sizes, "rows"))).toEqual(
				ROW_PANELS.map(panelDomId)
			);
		}
	});

	test("choosing a preset keeps its sizes exactly", () => {
		for (const id of ["edit", "color", "audio", "review"] as const) {
			expect(applyLayoutChoice(initialLayoutState(), id).sizes).toEqual(
				LAYOUT_PRESETS[id].sizes
			);
		}
	});

	test("groupLayout keys sizes by DOM id", () => {
		const layout = groupLayout(LAYOUT_PRESETS.edit.sizes, "rows");
		expect(layout).toEqual({
			"studio-timeline-panel": 35,
			"studio-workspace-panel": 65,
		});
		expect(
			sameSizes(LAYOUT_PRESETS.edit.sizes, LAYOUT_PRESETS.edit.sizes)
		).toBe(true);
		expect(
			sameSizes(LAYOUT_PRESETS.edit.sizes, LAYOUT_PRESETS.review.sizes)
		).toBe(false);
	});
});

describe("maximize", () => {
	test("toggles a panel and restores it", () => {
		expect(toggleMaximized(null, "stage")).toBe("stage");
		expect(toggleMaximized("stage", "stage")).toBeNull();
		expect(toggleMaximized("stage", "timeline")).toBe("timeline");
	});

	test("finds the panel containing an element", () => {
		const host = {
			getAttribute: (name: string) =>
				name === "data-workspace-panel" ? "inspector" : null,
		};
		const inside = { closest: () => host } as unknown as Element;
		expect(panelContaining(inside)).toBe("inspector");
		const outside = { closest: () => null } as unknown as Element;
		expect(panelContaining(outside)).toBe("stage");
		expect(panelContaining(null, "timeline")).toBe("timeline");
	});
});
