import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Fragment,
	type KeyboardEvent,
	type PointerEvent,
	useRef,
	useState,
} from "react";
import {
	findOverlay,
	LANED_OVERLAY_KINDS,
	type OverlayEdit,
	type OverlayKind,
	type OverlayLaneItem,
	type OverlayRef,
	type OverlaySnapOptions,
	overlayLaneLayout,
} from "../../../shared/overlay-edits.ts";
import { overlayClipKind } from "../../../shared/timeline-colors.ts";
import { useEditorProject } from "../editor/context.tsx";
import { clock } from "../editor/format.ts";
import { useEditorStore } from "../editor/store.ts";
import { readViewerValue, writeViewerValue } from "../editor/viewer-storage.ts";
import { OverlayKeyframeLanes } from "./OverlayKeyframeLanes.tsx";
import {
	applyOverlayEdit,
	collapsedSchema,
	editLabel,
	keyframeOwnerOf,
	kindNoun,
	kindTone,
	OVERLAY_DRAG_THRESHOLD_PX,
	OVERLAY_LANES,
	OVERLAY_LANES_STORAGE_KEY,
	OVERLAY_ROW_HEIGHT,
	type OverlayDrag,
	overlayDragEdit,
	overlayDragModeAt,
	overlayItemLabel,
	previewOverlayEdit,
	sameRef,
	withOverlayClickSelection,
} from "./OverlayLanes-model.ts";
import { TitleContextMenu } from "./TitleContextMenu.tsx";

export {
	applyOverlayEdit,
	keyframeOwnerOf,
	OVERLAY_DRAG_THRESHOLD_PX,
	OVERLAY_EDGE_GRAB_PX,
	OVERLAY_LANES,
	OVERLAY_LANES_STORAGE_KEY,
	OVERLAY_ROW_HEIGHT,
	type OverlayDragInput,
	type OverlayDragMode,
	overlayDragEdit,
	overlayDragModeAt,
	overlayItemLabel,
	previewOverlayEdit,
	withOverlayClickSelection,
} from "./OverlayLanes-model.ts";

/**
 * Title, graphic, caption, avatar, and adjustment lanes above the clip
 * tracks. Each lane collapses; items move by dragging their body (titles
 * and graphics also change lane vertically), trim by dragging an edge, and
 * snap like clips do. Delete removes the focused item, Mod+D duplicates it,
 * and Alt+arrow keys nudge it by a frame.
 */
export function OverlayLanes({ zoom }: { zoom: number }) {
	const tl = useLiteralMessages();
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
							aria-label={tl("{label} lane", { label: lane.label })}
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
											title={
												LANED_OVERLAY_KINDS.has(item.kind)
													? tl(
															"{noun} · {start}–{end}. Drag to move or change lane, drag an edge to trim. Delete removes it; Mod+D duplicates.",
															{
																end: clock(item.end),
																noun: kindNoun[item.kind],
																start: clock(item.start),
															}
														)
													: tl(
															"{noun} · {start}–{end}. Drag to move, drag an edge to trim. Delete removes it; Mod+D duplicates.",
															{
																end: clock(item.end),
																noun: kindNoun[item.kind],
																start: clock(item.start),
															}
														)
											}
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
												aria-label={
													open
														? tl("Hide keyframe lanes for {noun} {label}", {
																label,
																noun: kindNoun[item.kind].toLowerCase(),
															})
														: tl("Show keyframe lanes for {noun} {label}", {
																label,
																noun: kindNoun[item.kind].toLowerCase(),
															})
												}
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
												title={tl(
													"Keyframe lanes ({keyCount, plural, one {# keyframe} other {# keyframes}})",
													{ keyCount }
												)}
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
