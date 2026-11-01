import { useLiteralMessages } from "@ryu/i18n/react";
import {
	type KeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	useContext,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { type Keyframe, segmentDuration } from "../../../shared/project.ts";
import { EditorContext } from "../editor/context.tsx";
import { clock } from "../editor/format.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { readViewerValue, writeViewerValue } from "../editor/viewer-storage.ts";
import { commitChannel } from "../keyframes/commit.ts";
import {
	curvePoints,
	DRAG_START_PX,
	dragDiamond,
	GRAPH_ROW_PX,
	keyframeSnapTargets,
	LANE_ROW_PX,
	type LaneChannel,
	laneChannels,
	nudgeKeyframe,
	nudgeValue,
	valueToY,
	withoutKeyframe,
} from "../keyframes/lane-math.ts";
import { useClipOverlay } from "../keyframes/useClipOverlay.ts";
import { useLaneExpansion } from "./ClipKeyframeLane-expansion.ts";
import {
	contain,
	containClipKeys,
	DIAMOND_PX,
	type DiamondDragState,
	KEYFRAME_LANES_ATTRIBUTE,
	keyframeValueText,
	LANE_VIEW_KEY,
	type LaneSelection,
	type LaneView,
	laneViewSchema,
	noSubscription,
	sameTime,
} from "./ClipKeyframeLane-shared.ts";
import { ClipKeyframeLaneToolbar } from "./ClipKeyframeLane-toolbar.tsx";
import type { ClipSlotProps } from "./clip-slot-props.ts";

export {
	KEYFRAME_LANES_ATTRIBUTE,
	keyframeValueText,
} from "./ClipKeyframeLane-shared.ts";

/**
 * Keyframe diamonds over the clip, and an expand toggle that opens one lane
 * per animated channel under it. In the lanes view diamonds drag in time
 * (snapped to the playhead, clip edges, markers and the clip's other
 * keyframes); the graph view draws each channel's curve and diamonds drag
 * in value too. Delete removes the selected keyframe, and the curve button
 * opens the graph editor for the interval after it. Every change replaces
 * the channel through `setKeyframes` (the `/keyframes` route's logic) as
 * one undoable edit.
 */
export function ClipKeyframeLane({
	fps,
	locked,
	segment,
	selected,
	zoom,
}: ClipSlotProps) {
	const runtime = useContext(EditorContext);
	const tl = useLiteralMessages();
	const rootRef = useRef<HTMLSpanElement>(null);
	const [view, setView] = useState<LaneView>(() =>
		readViewerValue(LANE_VIEW_KEY, laneViewSchema, "lanes")
	);
	const [selection, setSelection] = useState<LaneSelection | null>(null);
	const [preview, setPreview] = useState<{
		channel: string;
		frames: Keyframe[];
	} | null>(null);
	const [curveOpen, setCurveOpen] = useState(false);
	const dragRef = useRef<DiamondDragState | null>(null);
	const store = runtime?.store;
	const { expanded, setExpanded, setLocalExpanded } = useLaneExpansion(
		store,
		segment.id
	);
	const groupDragging = useSyncExternalStore(
		store?.subscribe ?? noSubscription,
		() => store?.getState().drag?.ids.includes(segment.id) ?? false,
		() => false
	);
	const width = Math.max(12, segmentDuration(segment) * zoom);
	const overlay = useClipOverlay(
		rootRef,
		KEYFRAME_LANES_ATTRIBUTE,
		segment.id,
		{
			left: segment.start * zoom,
			width,
		}
	);
	const animated = segment.keyframes.length > 0;
	useEffect(() => {
		if (animated) {
			return;
		}
		setLocalExpanded(false);
		store?.setState((state) =>
			state.openKeyframeLanes.includes(segment.id)
				? {
						openKeyframeLanes: state.openKeyframeLanes.filter(
							(id) => id !== segment.id
						),
					}
				: {}
		);
	}, [animated, segment.id, store]);

	const channels = laneChannels(segment).map((channel) =>
		preview?.channel === channel.key
			? { ...channel, frames: preview.frames }
			: channel
	);
	const selectedChannel = channels.find(
		(channel) => channel.key === selection?.channel
	);
	const selectedIndex =
		selectedChannel?.frames.findIndex((frame) =>
			sameTime(frame.time, selection?.time ?? Number.NaN)
		) ?? -1;
	const selectedFrame = selectedChannel?.frames[selectedIndex];
	const hasNext =
		selectedChannel !== undefined &&
		selectedIndex >= 0 &&
		selectedIndex < selectedChannel.frames.length - 1;
	const editable = runtime !== null && !locked;
	const rowHeight = view === "graph" ? GRAPH_ROW_PX : LANE_ROW_PX;
	const duration = segmentDuration(segment);

	const save = (
		editor: EditorRuntime,
		channel: LaneChannel,
		frames: Keyframe[],
		label: string,
		select?: LaneSelection | null
	) => {
		const next = commitChannel(
			editor,
			segment.id,
			channel.group,
			frames,
			label
		);
		if (next && select !== undefined) {
			setSelection(select);
		}
		return next;
	};

	const chooseView = (next: LaneView) => {
		setView(next);
		writeViewerValue(LANE_VIEW_KEY, next);
	};

	const removeSelected = () => {
		if (!(runtime && selectedChannel && selectedFrame && editable)) {
			return;
		}
		save(
			runtime,
			selectedChannel,
			withoutKeyframe(selectedChannel.frames, selectedFrame.id),
			"Delete keyframe",
			null
		);
		runtime.setStatus(
			tl("Deleted the {channel} keyframe.", {
				channel: selectedChannel.label.toLowerCase(),
			})
		);
		setCurveOpen(false);
	};

	const dragFrames = (
		channel: LaneChannel,
		drag: DiamondDragState,
		x: number,
		y: number
	) =>
		dragDiamond({
			dxPx: x - drag.startX,
			duration,
			dyPx: y - drag.startY,
			fps,
			frames: channel.frames,
			height: rowHeight,
			id: drag.id,
			property: channel.group.property,
			snapping: runtime?.store.getState().snapEnabled ?? true,
			snapTargets: keyframeSnapTargets(segment, {
				excludeIds: new Set(channel.frames.map((frame) => frame.id)),
				markerTimes: runtime?.project?.markers.map((marker) => marker.time),
				playhead: runtime?.time,
			}),
			vertical: view === "graph",
			zoom,
		});

	const onDiamondDown =
		(channel: LaneChannel, frame: Keyframe) => (event: ReactPointerEvent) => {
			if (event.button !== 0) {
				return;
			}
			event.stopPropagation();
			setSelection({ channel: channel.key, time: frame.time });
			if (!editable) {
				return;
			}
			event.currentTarget.setPointerCapture?.(event.pointerId);
			dragRef.current = {
				channel: channel.key,
				id: frame.id,
				moved: false,
				pointerId: event.pointerId,
				startX: event.clientX,
				startY: event.clientY,
			};
		};
	const onDiamondMove =
		(channel: LaneChannel) => (event: ReactPointerEvent) => {
			const drag = dragRef.current;
			if (!drag || drag.pointerId !== event.pointerId) {
				return;
			}
			const distance = Math.hypot(
				event.clientX - drag.startX,
				event.clientY - drag.startY
			);
			if (!drag.moved && distance < DRAG_START_PX) {
				return;
			}
			drag.moved = true;
			const base = laneChannels(segment).find(
				(item) => item.key === channel.key
			);
			if (base) {
				setPreview({
					channel: channel.key,
					frames: dragFrames(base, drag, event.clientX, event.clientY),
				});
			}
		};
	const onDiamondUp = (channel: LaneChannel) => (event: ReactPointerEvent) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) {
			return;
		}
		event.stopPropagation();
		dragRef.current = null;
		setPreview(null);
		const base = laneChannels(segment).find((item) => item.key === channel.key);
		if (!(drag.moved && runtime && base)) {
			return;
		}
		const frames = dragFrames(base, drag, event.clientX, event.clientY);
		const moved = frames.find((frame) => frame.id === drag.id);
		save(
			runtime,
			base,
			frames,
			"Move keyframe",
			moved ? { channel: channel.key, time: moved.time } : undefined
		);
	};
	const onDiamondCancel = () => {
		dragRef.current = null;
		setPreview(null);
	};

	const onDiamondKey =
		(channel: LaneChannel, frame: Keyframe) => (event: KeyboardEvent) => {
			const select = { channel: channel.key, time: frame.time };
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				event.stopPropagation();
				setSelection(select);
				const index = channel.frames.findIndex((item) => item.id === frame.id);
				if (event.key === "Enter" && index < channel.frames.length - 1) {
					setCurveOpen(true);
				}
				return;
			}
			if (!(editable && runtime)) {
				return;
			}
			const step = event.shiftKey ? 10 : 1;
			let frames: Keyframe[] | null = null;
			let label = "Move keyframe";
			if (event.key === "Delete" || event.key === "Backspace") {
				frames = withoutKeyframe(channel.frames, frame.id);
				label = "Delete keyframe";
			} else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
				frames = nudgeKeyframe(
					channel.frames,
					frame.id,
					event.key === "ArrowLeft" ? -step : step,
					fps,
					duration
				);
			} else if (
				view === "graph" &&
				(event.key === "ArrowUp" || event.key === "ArrowDown")
			) {
				frames = nudgeValue(
					channel.frames,
					frame.id,
					channel.group.property,
					event.key === "ArrowUp" ? step : -step
				);
				label = "Keyframe value";
			}
			if (!frames) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			const moved = frames.find((item) => item.id === frame.id);
			save(
				runtime,
				channel,
				frames,
				label,
				moved ? { channel: channel.key, time: moved.time } : null
			);
		};

	const showToggle =
		runtime !== null && animated && !groupDragging && (selected || expanded);
	const diamondTimes = [
		...new Set(segment.keyframes.map((frame) => frame.time)),
	].sort((a, b) => a - b);

	const lanes = expanded ? (
		<div
			aria-label="Keyframe lanes"
			className="pointer-events-auto absolute top-full left-0 flex min-w-40 flex-col rounded-b-md border border-border bg-popover text-popover-foreground shadow-md"
			data-clip-drag-ignore=""
			data-keyframe-lanes=""
			data-no-scrub=""
			onClick={contain}
			onDoubleClick={contain}
			onKeyDown={containClipKeys}
			onPointerDown={contain}
			onPointerMove={contain}
			onPointerUp={contain}
			role="group"
			style={{ width: `${width}px` }}
		>
			<ClipKeyframeLaneToolbar
				chooseView={chooseView}
				curveOpen={curveOpen}
				editable={editable}
				hasNext={hasNext}
				removeSelected={removeSelected}
				runtime={runtime}
				save={save}
				selectedChannel={selectedChannel}
				selectedFrame={selectedFrame}
				setCurveOpen={setCurveOpen}
				view={view}
			/>
			{channels.map((channel) => (
				<div data-keyframe-lane={channel.key} key={channel.key}>
					<div className="truncate px-1 text-[0.6rem] text-muted-foreground">
						{channel.label}
					</div>
					<div
						className="relative border-border/60 border-t"
						style={{ height: `${rowHeight}px` }}
					>
						{view === "graph" ? (
							<svg
								aria-hidden="true"
								className="pointer-events-none absolute inset-0 text-primary"
								height={rowHeight}
								width={width}
							>
								<polyline
									className="fill-none stroke-current"
									points={curvePoints(segment, channel.group, {
										height: rowHeight,
										width,
										zoom,
									})}
									strokeWidth={1.5}
								/>
							</svg>
						) : null}
						{channel.frames.map((frame) => {
							const isSelected =
								selection?.channel === channel.key &&
								sameTime(selection.time, frame.time);
							const top =
								view === "graph"
									? valueToY(channel.group.property, frame.value, rowHeight)
									: rowHeight / 2;
							return (
								<button
									aria-label={tl("{label} keyframe at {time}, {value}", {
										label: channel.label,
										time: clock(frame.time),
										value: keyframeValueText(
											channel.group.property,
											frame.value
										),
									})}
									aria-pressed={isSelected}
									className="absolute rotate-45 rounded-[2px] border border-background bg-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-primary"
									data-keyframe-diamond={frame.id}
									data-slot="keyframe-diamond"
									disabled={runtime === null}
									key={frame.id}
									onKeyDown={onDiamondKey(channel, frame)}
									onPointerCancel={onDiamondCancel}
									onPointerDown={onDiamondDown(channel, frame)}
									onPointerMove={onDiamondMove(channel)}
									onPointerUp={onDiamondUp(channel)}
									style={{
										height: `${DIAMOND_PX}px`,
										left: `${frame.time * zoom - DIAMOND_PX / 2}px`,
										top: `${top - DIAMOND_PX / 2}px`,
										width: `${DIAMOND_PX}px`,
									}}
									title={`${channel.label}: ${keyframeValueText(channel.group.property, frame.value)} at ${clock(frame.time)}`}
									type="button"
								/>
							);
						})}
					</div>
				</div>
			))}
		</div>
	) : null;

	const controls = showToggle ? (
		<>
			<button
				aria-expanded={expanded}
				aria-label={expanded ? "Hide keyframe lanes" : "Show keyframe lanes"}
				className="pointer-events-auto absolute bottom-0 left-3 flex size-3.5 items-center justify-center rounded-sm bg-background/80 text-[0.55rem] text-foreground leading-none shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
				data-clip-drag-ignore=""
				data-keyframe-toggle=""
				data-no-scrub=""
				data-slot="keyframe-toggle"
				onClick={(event) => {
					event.stopPropagation();
					setExpanded((open) => !open);
					setCurveOpen(false);
				}}
				onPointerDown={contain}
				onPointerUp={contain}
				title="Keyframe lanes"
				type="button"
			>
				{expanded ? "▾" : "▸"}
			</button>
			{lanes}
		</>
	) : null;

	return (
		<span
			aria-hidden="true"
			className="pointer-events-none absolute inset-x-0 bottom-0 z-[3] h-2"
			data-keyframe-strip=""
			ref={rootRef}
		>
			{expanded
				? null
				: diamondTimes.map((time) => (
						<span
							className="absolute bottom-0.5 size-1.5 -translate-x-1/2 rotate-45 bg-foreground/80"
							key={time}
							style={{ left: `${time * zoom}px` }}
						/>
					))}
			{overlay && controls ? createPortal(controls, overlay) : null}
		</span>
	);
}
