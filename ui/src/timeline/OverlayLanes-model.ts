import { z } from "zod";
import {
	editOverlay,
	LANED_OVERLAY_KINDS,
	moveOverlay,
	OVERLAY_LANE_COUNT,
	type OverlayEdit,
	type OverlayKind,
	type OverlayRef,
	type OverlaySnapOptions,
	type OverlayTiming,
	overlayKindSchema,
	trimOverlay,
} from "../../../shared/overlay-edits.ts";
import { activeCaptions, type Project } from "../../../shared/project.ts";
import {
	DEFAULT_TIMELINE_COLORS,
	overlayClipKind,
	timelineColorVariable,
} from "../../../shared/timeline-colors.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import type { EditorSelection, OverlaySelection } from "../editor/store.ts";
import type { OverlayKeyframeOwner } from "./OverlayKeyframeLanes.tsx";

/** The title or graphic an overlay ref names, as a keyframe-lane owner. */
export function keyframeOwnerOf(
	project: Project,
	ref: OverlayRef
): OverlayKeyframeOwner | null {
	if (ref.kind === "titles") {
		const item = project.titles.find((title) => title.id === ref.id);
		return item ? { item, kind: "titles" } : null;
	}
	if (ref.kind === "graphics") {
		const item = project.graphics.find((graphic) => graphic.id === ref.id);
		return item ? { item, kind: "graphics" } : null;
	}
	return null;
}

/** Height of one display row inside an overlay lane, in pixels. */
export const OVERLAY_ROW_HEIGHT = 22;
/** Pointer distance from an item edge that grabs the edge for a trim. */
export const OVERLAY_EDGE_GRAB_PX = 6;
/** Pointer travel before a press on an item becomes a drag. */
export const OVERLAY_DRAG_THRESHOLD_PX = 3;
/** Per-viewer key for the collapsed lanes. */
export const OVERLAY_LANES_STORAGE_KEY = "timeline.overlay-lanes.collapsed";

/** Lanes in top-to-bottom order; avatars appear only when a project has some. */
export const OVERLAY_LANES: readonly { kind: OverlayKind; label: string }[] = [
	{ kind: "titles", label: "Titles" },
	{ kind: "graphics", label: "Graphics" },
	{ kind: "captions", label: "Captions" },
	{ kind: "avatars", label: "Avatars" },
	{ kind: "adjustmentLayers", label: "Adjustments" },
];

export const kindNoun: Record<OverlayKind, string> = {
	adjustmentLayers: "Adjustment layer",
	avatars: "Avatar",
	captions: "Caption",
	graphics: "Graphic",
	titles: "Title",
};

/** Lane fill from the viewer's Timeline colors (CSS custom properties). */
export function kindTone(kind: OverlayKind) {
	const clipKind = overlayClipKind(kind);
	const fill = `var(${timelineColorVariable(clipKind)}, ${DEFAULT_TIMELINE_COLORS[clipKind]})`;
	return {
		backgroundColor: `color-mix(in srgb, ${fill} 22%, transparent)`,
		borderColor: `color-mix(in srgb, ${fill} 70%, transparent)`,
	};
}

/** The text an overlay item shows on its lane. */
export function overlayItemLabel(project: Project, ref: OverlayRef): string {
	switch (ref.kind) {
		case "titles":
			return project.titles.find((item) => item.id === ref.id)?.text ?? "";
		case "graphics": {
			const shape = project.graphics.find((item) => item.id === ref.id)?.shape;
			return shape ? `${shape[0]?.toUpperCase()}${shape.slice(1)}` : "";
		}
		case "captions":
			return (
				activeCaptions(project).find((item) => item.id === ref.id)?.text ?? ""
			);
		case "avatars":
			return "Avatar";
		case "adjustmentLayers":
			return (
				project.adjustmentLayers?.find((item) => item.id === ref.id)?.label ??
				""
			);
		default:
			return "";
	}
}

export type OverlayDragMode = "move" | "start" | "end";

/** Which part of an item a press at `clientX` grabs. */
export function overlayDragModeAt(
	bounds: { left: number; right: number },
	clientX: number
): OverlayDragMode {
	const width = bounds.right - bounds.left;
	const grab = Math.min(OVERLAY_EDGE_GRAB_PX, width / 4);
	if (clientX - bounds.left <= grab) {
		return "start";
	}
	if (bounds.right - clientX <= grab) {
		return "end";
	}
	return "move";
}

export interface OverlayDragInput {
	deltaX: number;
	deltaY: number;
	item: OverlayTiming;
	mode: OverlayDragMode;
	ref: OverlayRef;
	/** The item's display row when the drag started. */
	row: number;
	zoom: number;
}

/**
 * The edit a pointer drag describes. A move keeps the duration; dragging a
 * title or graphic vertically by whole rows assigns it that lane. An edge
 * drag trims that edge.
 */
export function overlayDragEdit(input: OverlayDragInput): OverlayEdit {
	const deltaSeconds = input.deltaX / Math.max(input.zoom, 1e-6);
	const { id, kind } = input.ref;
	if (input.mode !== "move") {
		const edgeTime = input.mode === "start" ? input.item.start : input.item.end;
		return {
			edge: input.mode,
			id,
			kind,
			op: "trim",
			time: Math.max(0, edgeTime + deltaSeconds),
		};
	}
	const start = Math.max(0, input.item.start + deltaSeconds);
	const rowDelta = Math.round(input.deltaY / OVERLAY_ROW_HEIGHT);
	if (!(LANED_OVERLAY_KINDS.has(kind) && rowDelta !== 0)) {
		return { id, kind, op: "move", start };
	}
	const lane = Math.min(
		OVERLAY_LANE_COUNT - 1,
		Math.max(0, input.row + rowDelta)
	);
	return { id, kind, lane, op: "move", start };
}

/** Apply a move or trim without validation, for the live drag preview. */
export function previewOverlayEdit(
	project: Project,
	edit: OverlayEdit,
	snap: OverlaySnapOptions | undefined
): Project {
	if (edit.op === "move") {
		return moveOverlay(
			project,
			{ id: edit.id, kind: edit.kind, lane: edit.lane, start: edit.start },
			{ snap }
		);
	}
	if (edit.op === "trim") {
		return trimOverlay(
			project,
			{ edge: edit.edge, id: edit.id, kind: edit.kind, time: edit.time },
			{ snap }
		);
	}
	return project;
}

export const sameRef = (a: OverlayRef, b: OverlayRef) =>
	a.id === b.id && a.kind === b.kind;

/**
 * Click selection for overlays: a plain click selects only `ref` (and clears
 * the clip selection); Shift toggles it in the overlay selection.
 */
export function withOverlayClickSelection(
	selection: EditorSelection,
	ref: OverlaySelection,
	additive: boolean
): EditorSelection {
	if (!additive) {
		return { overlayIds: [ref], primaryId: null, segmentIds: [] };
	}
	const selected = selection.overlayIds.some((item) => sameRef(item, ref));
	return {
		...selection,
		overlayIds: selected
			? selection.overlayIds.filter((item) => !sameRef(item, ref))
			: [...selection.overlayIds, ref],
	};
}

/** Commit one overlay edit as a single undo step; failures become status text. */
export function applyOverlayEdit(
	runtime: EditorRuntime,
	edit: OverlayEdit,
	label: string
): string | undefined {
	const project = runtime.project;
	if (!project) {
		return undefined;
	}
	try {
		const result = editOverlay(project, runtime.assets, edit);
		if (result.project !== project) {
			runtime.edit(result.project, label);
		}
		if (edit.op === "delete") {
			runtime.store.setState((state) => ({
				selection: {
					...state.selection,
					overlayIds: state.selection.overlayIds.filter(
						(item) => !sameRef(item, edit)
					),
				},
			}));
		}
		return result.id;
	} catch (error) {
		runtime.setStatus(
			error instanceof Error ? error.message : "The overlay edit failed."
		);
		return undefined;
	}
}

export const collapsedSchema = z.array(overlayKindSchema);

export interface OverlayDrag {
	edit: OverlayEdit | null;
	item: OverlayTiming;
	mode: OverlayDragMode;
	moved: boolean;
	originX: number;
	originY: number;
	ref: OverlayRef;
	row: number;
}

export const editLabel = (edit: OverlayEdit, noun: string) =>
	edit.op === "trim"
		? `Trim ${noun.toLowerCase()}`
		: `Move ${noun.toLowerCase()}`;
