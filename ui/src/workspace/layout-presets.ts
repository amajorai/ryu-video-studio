import { z } from "zod";
import {
	readViewerValue,
	type ViewerStorageArea,
	writeViewerValue,
} from "../editor/viewer-storage.ts";

/**
 * Workspace layout: how the library, stage, inspector, and timeline share the
 * editor. Sizes are percentages of their splitter group, the unit the
 * resizable panels report, so a layout survives any window size.
 */

export const WORKSPACE_PANELS = [
	"library",
	"stage",
	"inspector",
	"timeline",
] as const;
export type WorkspacePanel = (typeof WORKSPACE_PANELS)[number];

export const WORKSPACE_PANEL_LABELS: Record<WorkspacePanel, string> = {
	inspector: "Inspector",
	library: "Library",
	stage: "Preview",
	timeline: "Timeline",
};

/** Splitter group ids; each maps panel ids to percentages that sum to 100. */
export const COLUMN_PANELS = ["library", "stage", "inspector"] as const;
export const ROW_PANELS = ["workspace", "timeline"] as const;
type ColumnPanel = (typeof COLUMN_PANELS)[number];
type RowPanel = (typeof ROW_PANELS)[number];

export interface WorkspaceSizes {
	columns: Record<ColumnPanel, number>;
	rows: Record<RowPanel, number>;
}

/** Smallest share (percent) a panel may take, so no splitter hides a panel. */
export const MIN_PANEL_PERCENT: Record<ColumnPanel | RowPanel, number> = {
	inspector: 12,
	library: 12,
	stage: 25,
	timeline: 15,
	workspace: 30,
};

export const LAYOUT_PRESET_IDS = ["edit", "color", "audio", "review"] as const;
export type LayoutPresetId = (typeof LAYOUT_PRESET_IDS)[number];
/** A built-in preset, the viewer's saved layout, or sizes dragged by hand. */
export type LayoutChoice = LayoutPresetId | "custom" | "saved";

export interface LayoutPreset {
	description: string;
	id: LayoutPresetId;
	label: string;
	sizes: WorkspaceSizes;
}

export const LAYOUT_PRESETS: Record<LayoutPresetId, LayoutPreset> = {
	audio: {
		description: "A tall timeline for levels, waveforms, and sync.",
		id: "audio",
		label: "Audio",
		sizes: {
			columns: { inspector: 22, library: 22, stage: 56 },
			rows: { timeline: 55, workspace: 45 },
		},
	},
	color: {
		description: "A large preview with a wide inspector for grading.",
		id: "color",
		label: "Color",
		sizes: {
			columns: { inspector: 30, library: 14, stage: 56 },
			rows: { timeline: 25, workspace: 75 },
		},
	},
	edit: {
		description: "Balanced library, preview, inspector, and timeline.",
		id: "edit",
		label: "Edit",
		sizes: {
			columns: { inspector: 20, library: 26, stage: 54 },
			rows: { timeline: 35, workspace: 65 },
		},
	},
	review: {
		description: "The preview fills the screen with a slim timeline.",
		id: "review",
		label: "Review",
		sizes: {
			columns: { inspector: 12, library: 12, stage: 76 },
			rows: { timeline: 18, workspace: 82 },
		},
	},
};

export const DEFAULT_LAYOUT_PRESET: LayoutPresetId = "edit";

const percent = z.number().finite().min(0).max(100);
const sizesSchema = z
	.object({
		columns: z
			.object({ inspector: percent, library: percent, stage: percent })
			.strict(),
		rows: z.object({ timeline: percent, workspace: percent }).strict(),
	})
	.strict();

export const workspaceLayoutStateSchema = z
	.object({
		choice: z.enum([...LAYOUT_PRESET_IDS, "custom", "saved"]),
		saved: sizesSchema.nullable(),
		sizes: sizesSchema,
		version: z.literal(1),
	})
	.strict();

export type WorkspaceLayoutState = z.infer<typeof workspaceLayoutStateSchema>;

export const WORKSPACE_LAYOUT_KEY = "workspace.layout";

/**
 * Clamp each share to its minimum and rescale the rest so the group sums to
 * 100. Non-finite or negative inputs fall back to `fallback`.
 */
export function normalizeGroup<Id extends string>(
	sizes: Record<Id, number>,
	ids: readonly Id[],
	fallback: Record<Id, number>
): Record<Id, number> {
	const valid = ids.every(
		(id) => Number.isFinite(sizes[id]) && (sizes[id] ?? -1) >= 0
	);
	const source = valid ? sizes : fallback;
	const minimum = (id: Id) =>
		MIN_PANEL_PERCENT[id as unknown as ColumnPanel | RowPanel] ?? 0;
	const reserved = ids.reduce((sum, id) => sum + minimum(id), 0);
	const extra = ids.map((id) => Math.max(0, source[id] - minimum(id)));
	const extraTotal = extra.reduce((sum, value) => sum + value, 0);
	const room = Math.max(0, 100 - reserved);
	const result = {} as Record<Id, number>;
	for (const [index, id] of ids.entries()) {
		const share =
			extraTotal > 0
				? ((extra[index] ?? 0) / extraTotal) * room
				: room / ids.length;
		result[id] = round(minimum(id) + share);
	}
	// Absorb rounding drift in the largest panel so the group sums to 100.
	const drift = round(100 - ids.reduce((sum, id) => sum + result[id], 0));
	const largest = ids.reduce((best, id) =>
		result[id] > result[best] ? id : best
	);
	result[largest] = round(result[largest] + drift);
	return result;
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

export function normalizeSizes(
	sizes: WorkspaceSizes,
	fallback: WorkspaceSizes = LAYOUT_PRESETS[DEFAULT_LAYOUT_PRESET].sizes
): WorkspaceSizes {
	return {
		columns: normalizeGroup(sizes.columns, COLUMN_PANELS, fallback.columns),
		rows: normalizeGroup(sizes.rows, ROW_PANELS, fallback.rows),
	};
}

export function initialLayoutState(): WorkspaceLayoutState {
	return {
		choice: DEFAULT_LAYOUT_PRESET,
		saved: null,
		sizes: LAYOUT_PRESETS[DEFAULT_LAYOUT_PRESET].sizes,
		version: 1,
	};
}

/** Pick a preset, or the viewer's saved layout when one exists. */
export function applyLayoutChoice(
	state: WorkspaceLayoutState,
	choice: LayoutPresetId | "saved"
): WorkspaceLayoutState {
	if (choice === "saved") {
		return state.saved
			? { ...state, choice, sizes: normalizeSizes(state.saved) }
			: state;
	}
	return {
		...state,
		choice,
		sizes: normalizeSizes(LAYOUT_PRESETS[choice].sizes),
	};
}

/** Remember the current sizes as the viewer's own layout ("Save current"). */
export function saveCurrentLayout(
	state: WorkspaceLayoutState
): WorkspaceLayoutState {
	return { ...state, choice: "saved", saved: state.sizes };
}

/**
 * Record a splitter drag for one group (`layout` is keyed by DOM id). Sizes that match the active choice
 * keep it selected; anything else becomes a custom layout.
 */
export function resizeGroup(
	state: WorkspaceLayoutState,
	group: "columns" | "rows",
	layout: Readonly<Record<string, number>>
): WorkspaceLayoutState {
	const ids: readonly string[] =
		group === "columns" ? COLUMN_PANELS : ROW_PANELS;
	const picked: Record<string, number> = {};
	for (const id of ids) {
		const value = layout[panelDomId(id)];
		if (typeof value !== "number") {
			return state;
		}
		picked[id] = value;
	}
	const sizes = normalizeSizes(
		{ ...state.sizes, [group]: picked } as WorkspaceSizes,
		state.sizes
	);
	if (sameSizes(sizes, state.sizes)) {
		return state;
	}
	return { ...state, choice: "custom", sizes };
}

/** The DOM id (and splitter layout key) of a panel or row. */
export function panelDomId(id: string): string {
	return `studio-${id}-panel`;
}

/** One group's sizes keyed by DOM id in DOM order, the shape the splitter group takes. */
export function groupLayout(
	sizes: WorkspaceSizes,
	group: "columns" | "rows"
): Record<string, number> {
	// The splitter validates a layout by position against its panels in DOM
	// order, so keys must follow COLUMN_PANELS / ROW_PANELS, never the object's
	// own (alphabetical) key order.
	const layout: Record<string, number> = {};
	if (group === "columns") {
		for (const id of COLUMN_PANELS) {
			layout[panelDomId(id)] = sizes.columns[id];
		}
	} else {
		for (const id of ROW_PANELS) {
			layout[panelDomId(id)] = sizes.rows[id];
		}
	}
	return layout;
}

/** Shares within half a percent count as equal (splitters report floats). */
export function sameSizes(a: WorkspaceSizes, b: WorkspaceSizes): boolean {
	const close = (x: number, y: number) => Math.abs(x - y) < 0.5;
	return (
		COLUMN_PANELS.every((id) => close(a.columns[id], b.columns[id])) &&
		ROW_PANELS.every((id) => close(a.rows[id], b.rows[id]))
	);
}

export function readLayoutState(
	area?: ViewerStorageArea | null
): WorkspaceLayoutState {
	const stored = readViewerValue(
		WORKSPACE_LAYOUT_KEY,
		workspaceLayoutStateSchema,
		initialLayoutState(),
		area
	);
	return {
		...stored,
		saved: stored.saved ? normalizeSizes(stored.saved) : null,
		sizes: normalizeSizes(stored.sizes),
	};
}

/** Persist the layout for this viewer; false when storage is unavailable. */
export function writeLayoutState(
	state: WorkspaceLayoutState,
	area?: ViewerStorageArea | null
): boolean {
	return writeViewerValue(WORKSPACE_LAYOUT_KEY, state, area);
}

/** Backtick: maximize `panel`, or restore when it is already maximized. */
export function toggleMaximized(
	current: string | null,
	panel: WorkspacePanel
): WorkspacePanel | null {
	return current === panel ? null : panel;
}

export function isWorkspacePanel(value: unknown): value is WorkspacePanel {
	return (
		typeof value === "string" &&
		(WORKSPACE_PANELS as readonly string[]).includes(value)
	);
}

/** The attribute every workspace panel carries, read to find the focused one. */
export const WORKSPACE_PANEL_ATTRIBUTE = "data-workspace-panel";

/**
 * The panel containing `element`, or `fallback` when focus is outside the
 * workspace (for example on the toolbar or the page body).
 */
export function panelContaining(
	element: Element | null,
	fallback: WorkspacePanel = "stage"
): WorkspacePanel {
	const host = element?.closest?.(`[${WORKSPACE_PANEL_ATTRIBUTE}]`);
	const value = host?.getAttribute(WORKSPACE_PANEL_ATTRIBUTE);
	return isWorkspacePanel(value) ? value : fallback;
}
