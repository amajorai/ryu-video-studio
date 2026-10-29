import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/blocks/companion/controls";
import {
	Fragment,
	type KeyboardEvent,
	type PointerEvent,
	useRef,
	useState,
} from "react";
import { z } from "zod";
import {
	editOverlay,
	findOverlay,
	LANED_OVERLAY_KINDS,
	moveOverlay,
	OVERLAY_LANE_COUNT,
	type OverlayEdit,
	type OverlayKind,
	type OverlayLaneItem,
	type OverlayRef,
	type OverlaySnapOptions,
	type OverlayTiming,
	overlayKindSchema,
	overlayLaneLayout,
	trimOverlay,
} from "../../../shared/overlay-edits.ts";
import { activeCaptions, type Project } from "../../../shared/project.ts";
import {
	DEFAULT_TIMELINE_COLORS,
	overlayClipKind,
	timelineColorVariable,
} from "../../../shared/timeline-colors.ts";
import { useEditorProject } from "../editor/context.tsx";
import { clock } from "../editor/format.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import {
	type EditorSelection,
	type OverlaySelection,
	useEditorStore,
} from "../editor/store.ts";
import { readViewerValue, writeViewerValue } from "../editor/viewer-storage.ts";
import {
	OverlayKeyframeLanes,
	type OverlayKeyframeOwner,
} from "./OverlayKeyframeLanes.tsx";
import { TitleContextMenu } from "./TitleContextMenu.tsx";

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

const kindNoun: Record<OverlayKind, string> = {
	adjustmentLayers: "Adjustment layer",
	avatars: "Avatar",
	captions: "Caption",
	graphics: "Graphic",
	titles: "Title",
};

/** Lane fill from the viewer's Timeline colors (CSS custom properties). */
function kindTone(kind: OverlayKind) {
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

const sameRef = (a: OverlayRef, b: OverlayRef) =>
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

const collapsedSchema = z.array(overlayKindSchema);

interface OverlayDrag {
	edit: OverlayEdit | null;
	item: OverlayTiming;
	mode: OverlayDragMode;
	moved: boolean;
	originX: number;
	originY: number;
	ref: OverlayRef;
	row: number;
}

const editLabel = (edit: OverlayEdit, noun: string) =>
	edit.op === "trim"
		? `Trim ${noun.toLowerCase()}`
		: `Move ${noun.toLowerCase()}`;

/**
 * Title, graphic, caption, avatar, and adjustment lanes above the clip
 * tracks. Each lane collapses; items move by dragging their body (titles
 * and graphics also change lane vertically), trim by dragging an edge, and
 * snap like clips do. Delete removes the focused item, Mod+D duplicates it,
 * and Alt+arrow keys nudge it by a frame.
 */
export function OverlayLanes({ zoom }: { zoom: number }) {
	const runtime = useEditorProject();
	const { project } = runtime;
	const selected = useEditorStore(
		runtime.store,
		(state) => state.selection.overlayIds
	);
	const snapEnabled = useEditorStore(
		runtime.store,
		(state) => state.snapEnabled
	);
	const [collapsed, setCollapsed] = useState<OverlayKind[]>(() =>
		readViewerValue(OVERLAY_LANES_STORAGE_KEY, collapsedSchema, [])
	);
	const [drag, setDrag] = useState<OverlayDrag | null>(null);
	/** Titles and graphics whose keyframe lanes are expanded. */
	const [openLanes, setOpenLanes] = useState<string[]>([]);
	const suppressClick = useRef(false);
	const toggleLanes = (id: string) =>
		setOpenLanes((open) =>
			open.includes(id) ? open.filter((item) => item !== id) : [...open, id]
		);

	const snapOptions = (): OverlaySnapOptions | undefined =>
		snapEnabled
			? { pxPerSec: zoom, range: runtime.range, time: runtime.time }
			: undefined;
	const preview =
		drag?.edit && drag.moved
			? previewOverlayEdit(project, drag.edit, snapOptions())
			: project;

	const toggle = (kind: OverlayKind) => {
		const next = collapsed.includes(kind)
			? collapsed.filter((item) => item !== kind)
			: [...collapsed, kind];
		setCollapsed(next);
		writeViewerValue(OVERLAY_LANES_STORAGE_KEY, next);
	};

	const select = (ref: OverlayRef, additive: boolean, start: number) => {
		runtime.store.setState((state) => ({
			selection: withOverlayClickSelection(state.selection, ref, additive),
		}));
		runtime.setSelected(null);
		runtime.setTime(start);
	};

	const onPointerDown = (
		event: PointerEvent<HTMLButtonElement>,
		item: OverlayLaneItem
	) => {
		const current = findOverlay(project, item);
		if (event.button !== 0 || !current) {
			return;
		}
		setDrag({
			edit: null,
			item: current,
			mode: overlayDragModeAt(
				event.currentTarget.getBoundingClientRect(),
				event.clientX
			),
			moved: false,
			originX: event.clientX,
			originY: event.clientY,
			ref: { id: item.id, kind: item.kind },
			row: item.row,
		});
		event.currentTarget.setPointerCapture?.(event.pointerId);
	};
	const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
		if (!drag) {
			return;
		}
		const deltaX = event.clientX - drag.originX;
		const deltaY = event.clientY - drag.originY;
		const moved =
			drag.moved || Math.hypot(deltaX, deltaY) >= OVERLAY_DRAG_THRESHOLD_PX;
		if (!moved) {
			return;
		}
		setDrag({
			...drag,
			edit: overlayDragEdit({ ...drag, deltaX, deltaY, zoom }),
			moved,
		});
	};
	const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
		const current = drag;
		setDrag(null);
		event.currentTarget.releasePointerCapture?.(event.pointerId);
		if (!(current?.moved && current.edit)) {
			return;
		}
		suppressClick.current = true;
		const landed = findOverlay(preview, current.ref);
		if (!landed) {
			return;
		}
		// Commit what the preview showed: the snapped times, as exact edits.
		const edit: OverlayEdit =
			current.edit.op === "trim"
				? {
						...current.edit,
						time: current.edit.edge === "start" ? landed.start : landed.end,
					}
				: current.edit.op === "move"
					? { ...current.edit, start: landed.start }
					: current.edit;
		applyOverlayEdit(
			runtime,
			edit,
			editLabel(edit, kindNoun[current.ref.kind])
		);
	};

	const onKeyDown = (
		event: KeyboardEvent<HTMLButtonElement>,
		item: OverlayLaneItem
	) => {
		const ref: OverlayRef = { id: item.id, kind: item.kind };
		const noun = kindNoun[item.kind].toLowerCase();
		if (event.key === "Delete" || event.key === "Backspace") {
			event.preventDefault();
			event.stopPropagation();
			applyOverlayEdit(runtime, { ...ref, op: "delete" }, `Delete ${noun}`);
			return;
		}
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
			event.preventDefault();
			event.stopPropagation();
			const id = applyOverlayEdit(
				runtime,
				{ ...ref, op: "duplicate" },
				`Duplicate ${noun}`
			);
			if (id) {
				runtime.store.setState((state) => ({
					selection: withOverlayClickSelection(
						state.selection,
						{ id, kind: item.kind },
						false
					),
				}));
			}
			return;
		}
		if (
			event.altKey &&
			(event.key === "ArrowLeft" || event.key === "ArrowRight")
		) {
			event.preventDefault();
			event.stopPropagation();
			const step =
				(event.shiftKey ? 1 : 1 / project.fps) *
				(event.key === "ArrowLeft" ? -1 : 1);
			applyOverlayEdit(
				runtime,
				{ ...ref, op: "move", start: Math.max(0, item.start + step) },
				`Move ${noun}`
			);
		}
	};

	const lanes = OVERLAY_LANES.filter(
		(lane) => lane.kind !== "avatars" || project.avatars.length > 0
	);
	return (
		<div className="relative" data-overlay-lanes="">
			{lanes.map((lane) => {
				const layout = overlayLaneLayout(preview, lane.kind);
				const isCollapsed = collapsed.includes(lane.kind);
				const rows = isCollapsed ? 0 : layout.rows;
				const keyframed = LANED_OVERLAY_KINDS.has(lane.kind);
				const expanded = isCollapsed
					? []
					: layout.items.flatMap((item) => {
							const owner = openLanes.includes(item.id)
								? keyframeOwnerOf(preview, item)
								: null;
							return owner ? [owner] : [];
						});
				return (
					<div key={lane.kind}>
						<div
							aria-label={`${lane.label} lane`}
							className="relative border-border border-t"
							data-collapsed={isCollapsed ? "true" : undefined}
							data-overlay-lane={lane.kind}
							role="group"
							style={{ height: rows * OVERLAY_ROW_HEIGHT + 18 }}
						>
							<div className="sticky left-0 z-[2] -ml-44 flex h-[18px] w-44 items-center bg-card/90 px-1 text-[0.65rem] text-muted-foreground">
								<Button
									aria-expanded={!isCollapsed}
									className="h-4 px-1 text-[0.65rem]"
									onClick={() => toggle(lane.kind)}
									size="sm"
									variant="ghost"
								>
									<HugeiconsIcon
										aria-hidden="true"
										className="size-3"
										icon={isCollapsed ? ArrowRight01Icon : ArrowDown01Icon}
									/>
									{lane.label}
									<span className="ml-1 tabular-nums">
										{layout.items.length}
									</span>
								</Button>
							</div>
							{!isCollapsed &&
								layout.items.map((item) => {
									const label = overlayItemLabel(preview, item);
									const isSelected = selected.some((ref) => sameRef(ref, item));
									const isDragging =
										drag?.moved === true && sameRef(drag.ref, item);
									const button = (
										<Button
											aria-label={`${kindNoun[item.kind]} ${label} ${clock(item.start)} to ${clock(item.end)}`}
											aria-pressed={isSelected}
											className={`absolute flex h-[20px] touch-none items-center justify-start overflow-hidden whitespace-nowrap rounded-sm border px-1.5 text-[0.65rem] text-foreground ${
												isSelected ? "ring-2 ring-primary" : ""
											} ${isDragging ? "z-[5] cursor-grabbing" : "cursor-grab"}`}
											data-clip-kind={overlayClipKind(item.kind)}
											data-overlay-id={item.id}
											data-overlay-kind={item.kind}
											data-row={item.row}
											key={item.id}
											onClick={(event) => {
												if (suppressClick.current) {
													suppressClick.current = false;
													return;
												}
												select(
													{ id: item.id, kind: item.kind },
													event.shiftKey,
													item.start
												);
											}}
											onKeyDown={(event) => onKeyDown(event, item)}
											onPointerCancel={() => setDrag(null)}
											onPointerDown={(event) => onPointerDown(event, item)}
											onPointerMove={onPointerMove}
											onPointerUp={onPointerUp}
											size="sm"
											style={{
												...kindTone(item.kind),
												left: item.start * zoom,
												top: 18 + item.row * OVERLAY_ROW_HEIGHT + 1,
												width: Math.max(4, (item.end - item.start) * zoom),
											}}
											title={`${kindNoun[item.kind]} · ${clock(item.start)}–${clock(item.end)}. Drag to move${LANED_OVERLAY_KINDS.has(item.kind) ? " or change lane" : ""}, drag an edge to trim. Delete removes it; Mod+D duplicates.`}
											variant="ghost"
										>
											<span
												aria-hidden="true"
												className="absolute inset-y-0 left-0 w-1 cursor-ew-resize bg-foreground/30"
											/>
											<span className="truncate">{label}</span>
											<span
												aria-hidden="true"
												className="absolute inset-y-0 right-0 w-1 cursor-ew-resize bg-foreground/30"
											/>
										</Button>
									);
									const open = openLanes.includes(item.id);
									const keyCount =
										keyframeOwnerOf(preview, item)?.item.keyframes?.length ?? 0;
									const lanesToggle =
										keyframed && (isSelected || open) ? (
											<button
												aria-expanded={open}
												aria-label={`${open ? "Hide" : "Show"} keyframe lanes for ${kindNoun[item.kind].toLowerCase()} ${label}`}
												className="absolute z-[6] flex h-[14px] min-w-[14px] items-center justify-center rounded-sm bg-background/90 px-0.5 text-[0.55rem] text-foreground leading-none shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
												data-overlay-keyframe-toggle={item.id}
												key={`${item.id}-lanes`}
												onClick={(event) => {
													event.stopPropagation();
													toggleLanes(item.id);
												}}
												onPointerDown={(event) => event.stopPropagation()}
												style={{
													left: Math.max(
														item.start * zoom,
														item.end * zoom - 16
													),
													top: 18 + item.row * OVERLAY_ROW_HEIGHT + 4,
												}}
												title={`Keyframe lanes (${keyCount} keyframe${keyCount === 1 ? "" : "s"})`}
												type="button"
											>
												{open ? "▾" : "◆"}
											</button>
										) : null;
									if (item.kind !== "titles") {
										return (
											<Fragment key={item.id}>
												{button}
												{lanesToggle}
											</Fragment>
										);
									}
									const ref: OverlayRef = { id: item.id, kind: item.kind };
									const menu = (
										<TitleContextMenu
											key={item.id}
											onDuplicate={() =>
												applyOverlayEdit(
													runtime,
													{ ...ref, op: "duplicate" },
													`Duplicate ${kindNoun.titles.toLowerCase()}`
												)
											}
											onRemove={() =>
												applyOverlayEdit(
													runtime,
													{ ...ref, op: "delete" },
													`Delete ${kindNoun.titles.toLowerCase()}`
												)
											}
											titleId={item.id}
										>
											{button}
										</TitleContextMenu>
									);
									return (
										<Fragment key={item.id}>
											{menu}
											{lanesToggle}
										</Fragment>
									);
								})}
						</div>
						{expanded.map((owner) => (
							<OverlayKeyframeLanes
								fps={project.fps}
								key={owner.item.id}
								owner={owner}
								runtime={runtime}
								zoom={zoom}
							/>
						))}
					</div>
				);
			})}
		</div>
	);
}
