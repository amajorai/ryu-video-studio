import { useLiteralMessages } from "@ryu/i18n/react";
import {
	type KeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	useRef,
	useState,
} from "react";
import {
	addOverlayKeyframe,
	overlayKeyframeBounds,
} from "../../../shared/overlay-keyframes.ts";
import type { Keyframe } from "../../../shared/project.ts";
import {
	isColorKeyframeProperty,
	type KeyframeProperty,
} from "../../../shared/schema/keyframe.ts";
import { clock } from "../editor/format.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { readViewerValue, writeViewerValue } from "../editor/viewer-storage.ts";
import { commitOwnerChannel } from "../keyframes/commit.ts";
import {
	channelLabel,
	DRAG_START_PX,
	dragDiamond,
	GRAPH_ROW_PX,
	itemKeyframeSnapTargets,
	LANE_ROW_PX,
	type LaneChannel,
	laneChannels,
	nudgeKeyframe,
	nudgeValue,
	sampledCurvePoints,
	valueToY,
	withoutKeyframe,
} from "../keyframes/lane-math.ts";
import {
	channelsOf,
	DIAMOND_PX,
	type DragState,
	LANE_VIEW_KEY,
	type LaneView,
	laneViewSchema,
	type OverlayKeyframeOwner,
	overlayKeyframeText,
	ownerRef,
	sameTime,
	sampleOf,
} from "./OverlayKeyframeLanes-model.ts";
import { OverlayKeyframeToolbar } from "./OverlayKeyframeLanes-toolbar.tsx";

export {
	type OverlayKeyframeOwner,
	overlayKeyframeText,
} from "./OverlayKeyframeLanes-model.ts";

/**
 * Expanded keyframe lanes for one title or graphic, under its overlay lane:
 * one lane per animated channel (position, scale, rotation, opacity, text
 * style, shape parameters and colors). Diamonds drag in time (snapped to the
 * item edges, playhead, markers and the item's other keyframes), and in
 * value in the graph view; arrow keys nudge, Delete removes, and the curve
 * button opens the graph editor for the interval after the selected
 * keyframe. "Add" records the chosen channel at the playhead. Every change
 * replaces the channel through `setKeyframes` (the `/keyframes` route's
 * logic, with `titleId` or `graphicId`) as one undoable edit.
 */
export function OverlayKeyframeLanes({
	fps,
	owner,
	runtime,
	zoom,
}: {
	fps: number;
	owner: OverlayKeyframeOwner;
	runtime: EditorRuntime;
	zoom: number;
}) {
	const tl = useLiteralMessages();
	const { item } = owner;
	const [view, setView] = useState<LaneView>(() =>
		readViewerValue(LANE_VIEW_KEY, laneViewSchema, "lanes")
	);
	const [selection, setSelection] = useState<{
		channel: string;
		time: number;
	} | null>(null);
	const [preview, setPreview] = useState<{
		channel: string;
		frames: Keyframe[];
	} | null>(null);
	const [curveOpen, setCurveOpen] = useState(false);
	const channels = channelsOf(owner);
	const [adding, setAdding] = useState<KeyframeProperty>(
		channels[0] as KeyframeProperty
	);
	const dragRef = useRef<DragState | null>(null);
	const duration = item.end - item.start;
	const width = Math.max(40, duration * zoom);
	const rowHeight = view === "graph" ? GRAPH_ROW_PX : LANE_ROW_PX;
	const keyframes = item.keyframes ?? [];
	const base = laneChannels({ keyframes });
	const lanes = base.map((channel) =>
		preview?.channel === channel.key
			? { ...channel, frames: preview.frames }
			: channel
	);
	const selectedChannel = lanes.find(
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
	const noun = owner.kind === "titles" ? "title" : "graphic";
	const playheadInside = runtime.time >= item.start && runtime.time <= item.end;

	const save = (
		channel: Pick<LaneChannel, "group">,
		frames: Keyframe[],
		label: string,
		select?: { channel: string; time: number } | null
	) => {
		const next = commitOwnerChannel(
			runtime,
			ownerRef(owner),
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

	const addAtPlayhead = () => {
		const sample = sampleOf(owner, adding, runtime.time - item.start);
		if (!sample) {
			return;
		}
		const added = addOverlayKeyframe(
			{ ...item, keyframes },
			adding,
			sample,
			runtime.time,
			crypto.randomUUID(),
			overlayKeyframeBounds(
				owner.kind === "titles" ? "title" : "graphic",
				adding
			)
		);
		const frames = (added.keyframes ?? []).filter(
			(frame) => frame.property === adding && frame.target === undefined
		);
		const landed = Number((runtime.time - item.start).toFixed(4));
		if (
			save({ group: { property: adding } }, frames, "Add keyframe", {
				channel: adding,
				time: landed,
			})
		) {
			runtime.setStatus(
				tl(
					"Added a {channel} keyframe to the {kind, select, title {title} other {graphic}}.",
					{
						channel: channelLabel({ property: adding }).toLowerCase(),
						kind: noun,
					}
				)
			);
		}
	};

	const dragFrames = (
		channel: LaneChannel,
		drag: DragState,
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
			snapping: runtime.store.getState().snapEnabled,
			snapTargets: itemKeyframeSnapTargets(
				{ duration, keyframes, start: item.start },
				{
					excludeIds: new Set(channel.frames.map((frame) => frame.id)),
					markerTimes: runtime.project?.markers.map((marker) => marker.time),
					playhead: runtime.time,
				}
			),
			vertical:
				view === "graph" && !isColorKeyframeProperty(channel.group.property),
			zoom,
		});

	const onDown =
		(channel: LaneChannel, frame: Keyframe) => (event: ReactPointerEvent) => {
			if (event.button !== 0) {
				return;
			}
			event.stopPropagation();
			setSelection({ channel: channel.key, time: frame.time });
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
	const onMove = (channel: LaneChannel) => (event: ReactPointerEvent) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) {
			return;
		}
		if (
			!drag.moved &&
			Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <
				DRAG_START_PX
		) {
			return;
		}
		drag.moved = true;
		const original = base.find((item) => item.key === channel.key);
		if (original) {
			setPreview({
				channel: channel.key,
				frames: dragFrames(original, drag, event.clientX, event.clientY),
			});
		}
	};
	const onUp = (channel: LaneChannel) => (event: ReactPointerEvent) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) {
			return;
		}
		event.stopPropagation();
		dragRef.current = null;
		setPreview(null);
		const original = base.find((item) => item.key === channel.key);
		if (!(drag.moved && original)) {
			return;
		}
		const frames = dragFrames(original, drag, event.clientX, event.clientY);
		const moved = frames.find((frame) => frame.id === drag.id);
		save(
			original,
			frames,
			"Move keyframe",
			moved ? { channel: channel.key, time: moved.time } : undefined
		);
	};
	const onCancel = () => {
		dragRef.current = null;
		setPreview(null);
	};

	const onKey =
		(channel: LaneChannel, frame: Keyframe) => (event: KeyboardEvent) => {
			const select = { channel: channel.key, time: frame.time };
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				event.stopPropagation();
				setSelection(select);
				const index = channel.frames.findIndex(
					(other) => other.id === frame.id
				);
				if (event.key === "Enter" && index < channel.frames.length - 1) {
					setCurveOpen(true);
				}
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
				!isColorKeyframeProperty(channel.group.property) &&
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
			const moved = frames.find((other) => other.id === frame.id);
			save(
				channel,
				frames,
				label,
				moved ? { channel: channel.key, time: moved.time } : null
			);
		};

	const valueAt = (property: KeyframeProperty) => (time: number) => {
		const sample = sampleOf(owner, property, time);
		return sample && "value" in sample ? sample.value : 0;
	};

	return (
		<div
			aria-label={tl(
				"{kind, select, title {Title} other {Graphic}} keyframe lanes",
				{ kind: noun }
			)}
			className="relative flex flex-col rounded-b-md border border-border bg-popover text-popover-foreground shadow-md"
			data-no-scrub=""
			data-overlay-keyframe-lanes={item.id}
			onPointerDown={(event) => event.stopPropagation()}
			role="group"
			style={{ marginLeft: `${item.start * zoom}px`, width: `${width}px` }}
		>
			<OverlayKeyframeToolbar
				addAtPlayhead={addAtPlayhead}
				adding={adding}
				channels={channels}
				chooseView={chooseView}
				curveOpen={curveOpen}
				hasNext={hasNext}
				noun={noun}
				playheadInside={playheadInside}
				save={save}
				selectedChannel={selectedChannel}
				selectedFrame={selectedFrame}
				setAdding={setAdding}
				setCurveOpen={setCurveOpen}
				view={view}
			/>
			{lanes.length === 0 ? (
				<p className="px-1 py-0.5 text-[0.6rem] text-muted-foreground">
					No keyframes yet. Choose a channel and add one at the playhead.
				</p>
			) : null}
			{lanes.map((channel) => (
				<div data-overlay-keyframe-lane={channel.key} key={channel.key}>
					<div className="truncate px-1 text-[0.6rem] text-muted-foreground">
						{channel.label}
					</div>
					<div
						className="relative border-border/60 border-t"
						style={{ height: `${rowHeight}px` }}
					>
						{view === "graph" &&
						!isColorKeyframeProperty(channel.group.property) ? (
							<svg
								aria-hidden="true"
								className="pointer-events-none absolute inset-0 text-primary"
								height={rowHeight}
								width={width}
							>
								<polyline
									className="fill-none stroke-current"
									points={sampledCurvePoints(
										channel.frames,
										channel.group.property,
										valueAt(channel.group.property),
										{ height: rowHeight, width, zoom }
									)}
									strokeWidth={1.5}
								/>
							</svg>
						) : null}
						{channel.frames.map((frame) => {
							const selected =
								selection?.channel === channel.key &&
								sameTime(selection.time, frame.time);
							const top =
								view === "graph"
									? valueToY(channel.group.property, frame.value, rowHeight)
									: rowHeight / 2;
							const text = overlayKeyframeText(frame);
							return (
								<button
									aria-label={tl("{label} keyframe at {time}, {text}", {
										label: channel.label,
										text,
										time: clock(frame.time),
									})}
									aria-pressed={selected}
									className="absolute rotate-45 rounded-[2px] border border-background bg-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-primary"
									data-overlay-keyframe-diamond={frame.id}
									key={frame.id}
									onKeyDown={onKey(channel, frame)}
									onPointerCancel={onCancel}
									onPointerDown={onDown(channel, frame)}
									onPointerMove={onMove(channel)}
									onPointerUp={onUp(channel)}
									style={{
										...(frame.color ? { backgroundColor: frame.color } : {}),
										height: `${DIAMOND_PX}px`,
										left: `${frame.time * zoom - DIAMOND_PX / 2}px`,
										top: `${top - DIAMOND_PX / 2}px`,
										width: `${DIAMOND_PX}px`,
									}}
									title={`${channel.label}: ${text} at ${clock(frame.time)}`}
									type="button"
								/>
							);
						})}
					</div>
				</div>
			))}
		</div>
	);
}
