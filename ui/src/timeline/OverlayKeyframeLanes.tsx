import { Button } from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@ryu/ui/components/popover.tsx";
import {
	type KeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	useRef,
	useState,
} from "react";
import { z } from "zod";
import { keyframeCurve, withCurve } from "../../../shared/animation.ts";
import {
	addOverlayKeyframe,
	type GraphicKeyframeChannel,
	graphicChannelSample,
	graphicKeyframeChannels,
	isGraphicKeyframeChannel,
	isTitleKeyframeChannel,
	type KeyframeSample,
	overlayKeyframeBounds,
	type TitleKeyframeChannel,
	titleChannelSample,
	titleKeyframeChannels,
} from "../../../shared/overlay-keyframes.ts";
import type { Graphic, Keyframe, Title } from "../../../shared/project.ts";
import {
	isColorKeyframeProperty,
	type KeyframeProperty,
} from "../../../shared/schema/keyframe.ts";
import { clock } from "../editor/format.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { readViewerValue, writeViewerValue } from "../editor/viewer-storage.ts";
import { commitOwnerChannel } from "../keyframes/commit.ts";
import { GraphEditor } from "../keyframes/GraphEditor.tsx";
import {
	channelLabel,
	DRAG_START_PX,
	dragDiamond,
	GRAPH_ROW_PX,
	itemKeyframeSnapTargets,
	type KeyframeOwnerRef,
	LANE_ROW_PX,
	type LaneChannel,
	laneChannels,
	nudgeKeyframe,
	nudgeValue,
	sampledCurvePoints,
	valueToY,
	withoutKeyframe,
} from "../keyframes/lane-math.ts";

const laneViewSchema = z.enum(["lanes", "graph"]);
type LaneView = z.infer<typeof laneViewSchema>;
/** Shared with the clip lanes, so one choice applies to every lane. */
const LANE_VIEW_KEY = "keyframes.lane-view";
const DIAMOND_PX = 10;

/** A keyframed overlay item: a title or a graphic. */
export type OverlayKeyframeOwner =
	| { item: Graphic; kind: "graphics" }
	| { item: Title; kind: "titles" };

interface DragState {
	channel: string;
	id: string;
	moved: boolean;
	pointerId: number;
	startX: number;
	startY: number;
}

const sameTime = (a: number, b: number) => Math.abs(a - b) < 1e-6;

function ownerRef(owner: OverlayKeyframeOwner): KeyframeOwnerRef {
	return owner.kind === "titles"
		? { titleId: owner.item.id }
		: { graphicId: owner.item.id };
}

function channelsOf(
	owner: OverlayKeyframeOwner
): readonly (GraphicKeyframeChannel | TitleKeyframeChannel)[] {
	return owner.kind === "titles"
		? titleKeyframeChannels
		: graphicKeyframeChannels;
}

function sampleOf(
	owner: OverlayKeyframeOwner,
	property: KeyframeProperty,
	elapsed: number
): KeyframeSample | null {
	if (owner.kind === "titles") {
		return isTitleKeyframeChannel(property)
			? titleChannelSample(owner.item, property, elapsed)
			: null;
	}
	return isGraphicKeyframeChannel(property)
		? graphicChannelSample(owner.item, property, elapsed)
		: null;
}

/** A diamond's readout: the color, or the value to two decimals. */
export function overlayKeyframeText(frame: Keyframe): string {
	return isColorKeyframeProperty(frame.property)
		? (frame.color ?? "")
		: frame.value.toFixed(2);
}

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
				`Added a ${channelLabel({ property: adding }).toLowerCase()} keyframe to the ${noun}.`
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
			aria-label={`${noun === "title" ? "Title" : "Graphic"} keyframe lanes`}
			className="relative flex flex-col rounded-b-md border border-border bg-popover text-popover-foreground shadow-md"
			data-no-scrub=""
			data-overlay-keyframe-lanes={item.id}
			onPointerDown={(event) => event.stopPropagation()}
			role="group"
			style={{ marginLeft: `${item.start * zoom}px`, width: `${width}px` }}
		>
			<div className="flex flex-wrap items-center gap-1 border-border border-b px-1 py-0.5">
				<Button
					aria-pressed={view === "lanes"}
					onClick={() => chooseView("lanes")}
					size="xs"
					type="button"
					variant={view === "lanes" ? "default" : "ghost"}
				>
					Lanes
				</Button>
				<Button
					aria-pressed={view === "graph"}
					onClick={() => chooseView("graph")}
					size="xs"
					type="button"
					variant={view === "graph" ? "default" : "ghost"}
				>
					Graph
				</Button>
				<Popover
					onOpenChange={(open) => setCurveOpen(open)}
					open={curveOpen && hasNext}
				>
					<PopoverAnchor>
						<span className="inline-flex">
							<Button
								disabled={!hasNext}
								onClick={() => setCurveOpen(true)}
								size="xs"
								title={
									hasNext
										? "Shape the curve to the next keyframe"
										: "Select a keyframe that has a next keyframe"
								}
								type="button"
								variant="ghost"
							>
								Curve
							</Button>
						</span>
					</PopoverAnchor>
					<PopoverContent align="start" data-no-scrub="" spacing="form">
						{selectedFrame && selectedChannel ? (
							<GraphEditor
								curve={keyframeCurve(selectedFrame)}
								onChange={(curve) =>
									save(
										selectedChannel,
										selectedChannel.frames.map((frame) =>
											frame.id === selectedFrame.id
												? withCurve(frame, curve)
												: frame
										),
										"Keyframe curve",
										{ channel: selectedChannel.key, time: selectedFrame.time }
									)
								}
							/>
						) : null}
					</PopoverContent>
				</Popover>
				<Button
					disabled={!(selectedFrame && selectedChannel)}
					onClick={() => {
						if (selectedChannel && selectedFrame) {
							save(
								selectedChannel,
								withoutKeyframe(selectedChannel.frames, selectedFrame.id),
								"Delete keyframe",
								null
							);
							setCurveOpen(false);
						}
					}}
					size="xs"
					type="button"
					variant="ghost"
				>
					Delete
				</Button>
				<NativeSelect
					aria-label={`${noun === "title" ? "Title" : "Graphic"} keyframe channel to add`}
					onChange={(event) => {
						const { value } = event.target;
						const match = channels.find((channel) => channel === value);
						if (match) {
							setAdding(match);
						}
					}}
					size="sm"
					value={adding}
				>
					{channels.map((channel) => (
						<NativeSelectOption key={channel} value={channel}>
							{channelLabel({ property: channel })}
						</NativeSelectOption>
					))}
				</NativeSelect>
				<Button
					disabled={!playheadInside}
					onClick={addAtPlayhead}
					size="xs"
					title={
						playheadInside
							? "Record this channel's value at the playhead"
							: "Move the playhead inside this item to add a keyframe"
					}
					type="button"
					variant="ghost"
				>
					Add
				</Button>
			</div>
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
									aria-label={`${channel.label} keyframe at ${clock(frame.time)}, ${text}`}
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
