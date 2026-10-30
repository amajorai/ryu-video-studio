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
import { formatDb, gainToDb } from "../../../shared/decibels.ts";
import { type Keyframe, segmentDuration } from "../../../shared/project.ts";
import { EditorContext } from "../editor/context.tsx";
import { clock } from "../editor/format.ts";
import { commitChannel } from "../keyframes/commit.ts";
import {
	DRAG_START_PX,
	dragDiamond,
	keyframeSnapTargets,
	nudgeKeyframe,
	nudgeValue,
	timeAtOffset,
	withoutKeyframe,
} from "../keyframes/lane-math.ts";
import { useClipOverlay } from "../keyframes/useClipOverlay.ts";
import {
	addVolumeKeyframe,
	hitsVolumeLine,
	VOLUME_LINE_HEIGHT,
	type VolumeLineEdit,
	volumeFrames,
	volumeLineDrag,
	volumeLinePoints,
	volumeLineY,
	volumeStepEdit,
} from "../keyframes/volume-line.ts";
import {
	commitLineEdit,
	HANDLE_OFFSET_MIN_WIDTH_PX,
	noSubscription,
	POINT_PX,
	previewed,
	volumeGroup,
} from "./ClipVolumeLine-line-edit.ts";
import { EDGE_HANDLE_PX } from "./clip-drag.ts";
import type { ClipSlotProps } from "./clip-slot-props.ts";
import { hasWaveform } from "./clip-visual-cache.ts";

/** Marks the volume point overlay that sits beside a clip, with its id. */
export const VOLUME_POINTS_ATTRIBUTE = "data-volume-points-for";

/**
 * Volume rubber band over audible clips: the line's height is the clip's
 * gain on a decibel scale (silence at the bottom, +12 dB at the top). On the
 * selected clip, the line's handle drags (or steps with the arrow keys) the
 * static volume, or offsets every volume keyframe by the same decibels when
 * the volume is animated, and Cmd/Ctrl-clicking the line adds a volume
 * keyframe at that point. Plain presses on the line still move the clip.
 * Volume keyframes show as points that drag in time and value; arrow keys
 * move them and Delete removes them.
 */
export function ClipVolumeLine({
	asset,
	fps,
	locked,
	segment,
	selected,
	zoom,
}: ClipSlotProps) {
	const runtime = useContext(EditorContext);
	const tl = useLiteralMessages();
	const rootRef = useRef<HTMLSpanElement>(null);
	const [lineEdit, setLineEdit] = useState<VolumeLineEdit | null>(null);
	const [pointDrag, setPointDrag] = useState<Keyframe[] | null>(null);
	const pointRef = useRef<{
		id: string;
		moved: boolean;
		pointerId: number;
		startX: number;
		startY: number;
	} | null>(null);
	const handleRef = useRef<{
		moved: boolean;
		pointerId: number;
		startY: number;
	} | null>(null);
	const audible = hasWaveform(asset);
	const width = Math.max(12, segmentDuration(segment) * zoom);
	const overlay = useClipOverlay(rootRef, VOLUME_POINTS_ATTRIBUTE, segment.id, {
		left: segment.start * zoom,
		width,
	});
	const interactive = audible && runtime !== null && !locked && selected;
	// The handle and points live in an overlay beside the clip that does not
	// follow the clip's drag transform, so they hide while the clip moves.
	const store = runtime?.store;
	const groupDragging = useSyncExternalStore(
		store?.subscribe ?? noSubscription,
		() => store?.getState().drag?.ids.includes(segment.id) ?? false,
		() => false
	);
	const controlsShown = interactive && !groupDragging;
	// Native press handling on the clip reads the latest render through refs.
	const latest = useRef({ fps, interactive, runtime, segment, tl, zoom });
	useEffect(() => {
		latest.current = { fps, interactive, runtime, segment, tl, zoom };
	});

	const hasRuntime = runtime !== null;
	useEffect(() => {
		const clip = rootRef.current?.parentElement;
		if (!(clip && hasRuntime && audible)) {
			return;
		}
		let suppressClick = false;
		const onDown = (event: PointerEvent) => {
			const {
				interactive: active,
				runtime: editor,
				segment: current,
				tl: translate,
			} = latest.current;
			if (
				!(active && editor) ||
				event.button !== 0 ||
				!(event.metaKey || event.ctrlKey)
			) {
				return;
			}
			const bounds = clip.getBoundingClientRect();
			const x = event.clientX - bounds.left;
			const y =
				(event.clientY - bounds.top) *
				(bounds.height > 0 ? VOLUME_LINE_HEIGHT / bounds.height : 1);
			if (x < EDGE_HANDLE_PX || bounds.width - x < EDGE_HANDLE_PX) {
				return;
			}
			const time = timeAtOffset(
				x,
				latest.current.zoom,
				latest.current.fps,
				segmentDuration(current)
			);
			if (!hitsVolumeLine(current, time, y)) {
				return;
			}
			// The line owns this press: keep the clip drag engine and the
			// clip's own handlers (and the click after) out of it.
			event.stopImmediatePropagation();
			event.preventDefault();
			suppressClick = true;
			// The new keyframe takes the line's own value there, so a click a
			// few pixels off the line never changes how loud the clip is; the
			// point is dragged afterwards to change it.
			const add = addVolumeKeyframe(current, time, latest.current.fps);
			if (!add.added) {
				editor.setStatus(
					translate("Volume keyframe already at {time}: {level}.", {
						level: formatDb(gainToDb(add.value)),
						time: clock(add.time),
					})
				);
				return;
			}
			if (
				commitChannel(
					editor,
					current.id,
					volumeGroup,
					add.frames,
					"Add volume keyframe"
				)
			) {
				editor.setStatus(
					translate("Volume keyframe at {time}: {level}.", {
						level: formatDb(gainToDb(add.value)),
						time: clock(add.time),
					})
				);
			}
		};
		const onClick = (event: MouseEvent) => {
			if (suppressClick) {
				suppressClick = false;
				event.stopImmediatePropagation();
				event.preventDefault();
			}
		};
		clip.addEventListener("pointerdown", onDown, { capture: true });
		clip.addEventListener("click", onClick, { capture: true });
		return () => {
			clip.removeEventListener("pointerdown", onDown, { capture: true });
			clip.removeEventListener("click", onClick, { capture: true });
		};
	}, [audible, hasRuntime]);

	if (!audible) {
		return null;
	}
	const shown = pointDrag
		? previewed(segment, { frames: pointDrag, kind: "keyframes" })
		: previewed(segment, lineEdit);
	const frames = volumeFrames(shown);
	const duration = segmentDuration(segment);
	const projectFps = fps;

	const pointFrames = (
		event: ReactPointerEvent,
		drag: NonNullable<typeof pointRef.current>
	) =>
		dragDiamond({
			dxPx: event.clientX - drag.startX,
			duration,
			dyPx:
				(event.clientY - drag.startY) *
				(VOLUME_LINE_HEIGHT /
					Math.max(
						1,
						rootRef.current?.parentElement?.offsetHeight || VOLUME_LINE_HEIGHT
					)),
			fps: projectFps,
			frames: volumeFrames(segment),
			height: VOLUME_LINE_HEIGHT,
			id: drag.id,
			property: "volume",
			snapping: runtime?.store.getState().snapEnabled ?? true,
			snapTargets: keyframeSnapTargets(segment, {
				excludeIds: new Set(volumeFrames(segment).map((frame) => frame.id)),
				markerTimes: runtime?.project?.markers.map((marker) => marker.time),
				playhead: runtime?.time,
			}),
			vertical: true,
			zoom,
		});

	const onPointDown = (frame: Keyframe) => (event: ReactPointerEvent) => {
		if (event.button !== 0) {
			return;
		}
		event.stopPropagation();
		event.currentTarget.setPointerCapture?.(event.pointerId);
		pointRef.current = {
			id: frame.id,
			moved: false,
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
		};
	};
	const onPointMove = (event: ReactPointerEvent) => {
		const drag = pointRef.current;
		if (!drag || drag.pointerId !== event.pointerId) {
			return;
		}
		event.stopPropagation();
		const distance = Math.hypot(
			event.clientX - drag.startX,
			event.clientY - drag.startY
		);
		if (!drag.moved && distance < DRAG_START_PX) {
			return;
		}
		drag.moved = true;
		setPointDrag(pointFrames(event, drag));
	};
	const onPointUp = (event: ReactPointerEvent) => {
		const drag = pointRef.current;
		if (!drag || drag.pointerId !== event.pointerId) {
			return;
		}
		event.stopPropagation();
		pointRef.current = null;
		setPointDrag(null);
		if (drag.moved && runtime) {
			commitChannel(
				runtime,
				segment.id,
				volumeGroup,
				pointFrames(event, drag),
				"Move volume keyframe"
			);
		}
	};
	const onPointCancel = () => {
		pointRef.current = null;
		setPointDrag(null);
	};
	const onPointKey = (frame: Keyframe) => (event: KeyboardEvent) => {
		if (!runtime) {
			return;
		}
		const channel = volumeFrames(segment);
		const step = event.shiftKey ? 10 : 1;
		const keys: Record<string, () => Keyframe[]> = {
			ArrowDown: () => nudgeValue(channel, frame.id, "volume", -step),
			ArrowLeft: () =>
				nudgeKeyframe(channel, frame.id, -step, projectFps, duration),
			ArrowRight: () =>
				nudgeKeyframe(channel, frame.id, step, projectFps, duration),
			ArrowUp: () => nudgeValue(channel, frame.id, "volume", step),
			Backspace: () => withoutKeyframe(channel, frame.id),
			Delete: () => withoutKeyframe(channel, frame.id),
		};
		const next = keys[event.key];
		if (!next) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const removing = event.key === "Delete" || event.key === "Backspace";
		commitChannel(
			runtime,
			segment.id,
			volumeGroup,
			next(),
			removing ? "Delete volume keyframe" : "Move volume keyframe"
		);
	};

	/** Drawing units per client pixel of the clip's rendered height. */
	const unitsPerPx = () =>
		VOLUME_LINE_HEIGHT /
		Math.max(
			1,
			rootRef.current?.parentElement?.offsetHeight || VOLUME_LINE_HEIGHT
		);
	const onHandleDown = (event: ReactPointerEvent) => {
		if (event.button !== 0) {
			return;
		}
		event.stopPropagation();
		event.currentTarget.setPointerCapture?.(event.pointerId);
		handleRef.current = {
			moved: false,
			pointerId: event.pointerId,
			startY: event.clientY,
		};
	};
	const onHandleMove = (event: ReactPointerEvent) => {
		const drag = handleRef.current;
		if (!drag || drag.pointerId !== event.pointerId) {
			return;
		}
		event.stopPropagation();
		const dy = event.clientY - drag.startY;
		if (!drag.moved && Math.abs(dy) < DRAG_START_PX) {
			return;
		}
		drag.moved = true;
		setLineEdit(volumeLineDrag(segment, dy * unitsPerPx()));
	};
	const onHandleUp = (event: ReactPointerEvent) => {
		const drag = handleRef.current;
		if (!drag || drag.pointerId !== event.pointerId) {
			return;
		}
		event.stopPropagation();
		handleRef.current = null;
		setLineEdit(null);
		if (drag.moved && runtime) {
			commitLineEdit(
				runtime,
				segment.id,
				volumeLineDrag(segment, (event.clientY - drag.startY) * unitsPerPx()),
				"Volume line",
				tl
			);
		}
	};
	const onHandleCancel = () => {
		handleRef.current = null;
		setLineEdit(null);
	};
	const onHandleKey = (event: KeyboardEvent) => {
		const step = event.shiftKey ? 6 : 1;
		const deltas: Record<string, number> = { ArrowDown: -step, ArrowUp: step };
		const delta = deltas[event.key];
		if (delta === undefined || !runtime) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		commitLineEdit(
			runtime,
			segment.id,
			volumeStepEdit(segment, delta),
			"Volume line",
			tl
		);
	};
	// The handle sits a quarter of the way in on clips wide enough to keep it
	// clear of the trim edges, so clicks on the middle of the clip (its label)
	// still select and open the clip; narrow clips keep it centred.
	const handleTime =
		duration * zoom >= HANDLE_OFFSET_MIN_WIDTH_PX ? duration / 4 : duration / 2;
	const handle = controlsShown ? (
		<button
			aria-label={
				frames.length > 0
					? "Volume line: drag or use the arrow keys to raise or lower every volume keyframe"
					: tl("Clip volume {level}: drag or use the arrow keys to change it", {
							level: formatDb(gainToDb(shown.volume)),
						})
			}
			className="pointer-events-auto absolute h-1.5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize rounded-full border border-background bg-amber-400 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
			data-clip-drag-ignore=""
			data-no-scrub=""
			data-slot="volume-handle"
			data-volume-handle=""
			key="volume-handle"
			onClick={(event) => event.stopPropagation()}
			onKeyDown={onHandleKey}
			onPointerCancel={onHandleCancel}
			onPointerDown={onHandleDown}
			onPointerMove={onHandleMove}
			onPointerUp={onHandleUp}
			style={{
				left: `${handleTime * zoom}px`,
				top: `${(volumeLineY(shown, handleTime) / VOLUME_LINE_HEIGHT) * 100}%`,
			}}
			title="Drag to change the volume. Cmd/Ctrl-click the line to add a volume keyframe."
			type="button"
		/>
	) : null;

	const points = controlsShown
		? frames.map((frame) => {
				const y = volumeLineY(shown, frame.time);
				return (
					<button
						aria-label={tl("Volume keyframe at {time}, {level}", {
							level: formatDb(gainToDb(frame.value)),
							time: clock(frame.time),
						})}
						className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-background bg-amber-400 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
						data-clip-drag-ignore=""
						data-no-scrub=""
						data-slot="volume-point"
						data-volume-point={frame.id}
						key={frame.id}
						onClick={(event) => event.stopPropagation()}
						onKeyDown={onPointKey(frame)}
						onPointerCancel={onPointCancel}
						onPointerDown={onPointDown(frame)}
						onPointerMove={onPointMove}
						onPointerUp={onPointUp}
						style={{
							height: `${POINT_PX}px`,
							left: `${frame.time * zoom}px`,
							top: `${(y / VOLUME_LINE_HEIGHT) * 100}%`,
							width: `${POINT_PX}px`,
						}}
						title={`${formatDb(gainToDb(frame.value))} at ${clock(frame.time)}`}
						type="button"
					/>
				);
			})
		: null;
	const level = formatDb(
		gainToDb(lineEdit?.kind === "static" ? lineEdit.volume : segment.volume)
	);

	return (
		<span
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 z-[3] text-amber-400"
			data-volume-line=""
			ref={rootRef}
		>
			<svg
				className="absolute inset-0 h-full w-full overflow-visible"
				preserveAspectRatio="none"
				viewBox={`0 0 ${width} ${VOLUME_LINE_HEIGHT}`}
			>
				<polyline
					className="fill-none stroke-current"
					points={volumeLinePoints(shown, width, zoom)}
					strokeWidth={selected ? 1.5 : 1}
					vectorEffect="non-scaling-stroke"
				/>
			</svg>
			{lineEdit ? (
				<span className="absolute top-0 right-3 rounded bg-popover px-1 font-mono text-[0.6rem] text-popover-foreground shadow">
					{lineEdit.kind === "static" ? level : "Volume keyframes"}
				</span>
			) : null}
			{overlay && controlsShown
				? createPortal(
						<>
							{handle}
							{points}
						</>,
						overlay
					)
				: null}
		</span>
	);
}
