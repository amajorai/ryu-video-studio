import { useLiteralMessages } from "@ryu/i18n/react";
import {
	type CSSProperties,
	type KeyboardEvent,
	type PointerEvent,
	useRef,
} from "react";
import {
	CORNER_HANDLES,
	EDGE_HANDLES,
	type FrameSize,
	graphicGesturePatch,
	graphicScaleRange,
	moveBox,
	OVERLAY_ROTATION_DRAWN,
	type Point,
	rotateBox,
	type ScaleHandle,
	type ScaleOptions,
	scaleBox,
	segmentGeometryPatch,
	segmentGestureChanges,
	segmentScaleRange,
	snapMove,
	snapTargets,
	type TransformBox,
	titleGesturePatch,
	titleScaleRange,
} from "../../../../shared/preview-geometry.ts";
import type { Project } from "../../../../shared/project.ts";
import type { EditorRuntime } from "../../editor/runtime.ts";
import { useOptionalEditor, usePreviewState } from "../use-preview-state.ts";
import {
	applyTargetPatch,
	clientToFramePx,
	createGestureCommit,
	croppingTarget,
	directManipulationStore,
	frameOf,
	framePxPerScreenPx,
	LOCKED_TRACK_MESSAGE,
	type ManipulationTarget,
	otherBoxes,
	selectedTarget,
	type TitleSizer,
	toggleCropMode,
	useDirectManipulation,
	useTitleSizer,
} from "./direct-manipulation.ts";
import type { PreviewOverlayProps } from "./overlay-props.ts";

/** Distance (screen pixels) inside which a moved item snaps to a guide. */
const SNAP_SCREEN_PX = 8;

type GestureKind = "move" | "rotate" | { handle: ScaleHandle };

/** CSS that places a rotated box over the frame, in percentages. */
export function boxStyle(box: TransformBox): CSSProperties {
	return {
		height: `${box.height * 100}%`,
		left: `${(box.cx - box.width / 2) * 100}%`,
		top: `${(box.cy - box.height / 2) * 100}%`,
		transform: `rotate(${box.rotation}deg)`,
		width: `${box.width * 100}%`,
	};
}

/** Where each scale handle sits on its box, plus its resize cursor. */
export const HANDLE_POSITION: Record<ScaleHandle, string> = {
	e: "left-full top-1/2 cursor-ew-resize",
	n: "left-1/2 top-0 cursor-ns-resize",
	ne: "left-full top-0 cursor-nesw-resize",
	nw: "left-0 top-0 cursor-nwse-resize",
	s: "left-1/2 top-full cursor-ns-resize",
	se: "left-full top-full cursor-nwse-resize",
	sw: "left-0 top-full cursor-nesw-resize",
	w: "left-0 top-1/2 cursor-ew-resize",
};

const HANDLE_LABEL: Record<ScaleHandle, string> = {
	e: "right edge",
	n: "top edge",
	ne: "top-right corner",
	nw: "top-left corner",
	s: "bottom edge",
	se: "bottom-right corner",
	sw: "bottom-left corner",
	w: "left edge",
};

const handleClass =
	"pointer-events-auto absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-[2px] border border-primary bg-background p-0 shadow-sm focus-visible:outline-2 focus-visible:outline-primary";

const targetLabel = (target: ManipulationTarget) =>
	target.kind === "segment" ? "clip" : target.kind;

/**
 * Scale handles a target offers. Graphics resize each axis and clips stretch
 * one axis (`scaleX` / `scaleY`), so both get edge handles; titles scale
 * uniformly (`fontSize`), so they get corners only.
 */
export const scaleHandlesFor = (target: ManipulationTarget): ScaleHandle[] =>
	target.kind === "title"
		? [...CORNER_HANDLES]
		: [...CORNER_HANDLES, ...EDGE_HANDLES];

/** Whether a target offers the rotation knob (titles and graphics once drawn rotated). */
export const rotatable = (target: ManipulationTarget): boolean =>
	target.kind === "segment" || OVERLAY_ROTATION_DRAWN;

function scaleRangeFor(
	target: ManipulationTarget,
	handle: ScaleHandle
): ScaleOptions["range"] {
	if (target.kind === "segment") {
		return segmentScaleRange(target.segment, target.elapsed, handle);
	}
	return target.kind === "title"
		? titleScaleRange(target.title)
		: graphicScaleRange(target.graphic);
}

/** The project with `target` drawn at `box`, or null when nothing changes. */
export function projectWithBox(
	project: Project,
	target: ManipulationTarget,
	box: TransformBox,
	tolerance: number
): Project | null {
	let patch: object;
	if (target.kind === "segment") {
		patch = segmentGeometryPatch(
			target.segment,
			segmentGestureChanges(
				target.segment,
				target.placement,
				box,
				target.elapsed
			),
			target.elapsed,
			{ tolerance }
		);
	} else if (target.kind === "title") {
		patch = titleGesturePatch(target.title, target.box, box);
	} else {
		patch = graphicGesturePatch(target.graphic, box);
	}
	return Object.keys(patch).length
		? applyTargetPatch(project, target, patch)
		: null;
}

interface GestureInput {
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	pointer: Point;
	shiftKey: boolean;
}

/** The box a gesture produces for one pointer position. */
export function gestureBox(
	kind: GestureKind,
	target: ManipulationTarget,
	start: Point,
	input: GestureInput,
	context: {
		frame: FrameSize;
		others: () => TransformBox[];
		snapEnabled: boolean;
		snapThresholdPx: number;
	}
): { box: TransformBox; guides: { x: number | null; y: number | null } } {
	const none = { x: null, y: null };
	if (kind === "move") {
		const moved = moveBox(
			target.box,
			{ x: input.pointer.x - start.x, y: input.pointer.y - start.y },
			context.frame
		);
		// Cmd/Ctrl suspends snapping for one drag.
		if (!context.snapEnabled || input.metaKey || input.ctrlKey) {
			return { box: moved, guides: none };
		}
		return snapMove(
			moved,
			snapTargets(context.others(), context.frame),
			context.frame,
			context.snapThresholdPx
		);
	}
	if (kind === "rotate") {
		return {
			box: rotateBox(
				target.box,
				start,
				input.pointer,
				context.frame,
				input.shiftKey
			),
			guides: none,
		};
	}
	return {
		box: scaleBox(target.box, kind.handle, input.pointer, context.frame, {
			fromCenter: input.altKey,
			range: scaleRangeFor(target, kind.handle),
		}),
		guides: none,
	};
}

/** Keyboard nudges move one project pixel (ten with Shift). */
const NUDGE: Record<string, Point> = {
	ArrowDown: { x: 0, y: 1 },
	ArrowLeft: { x: -1, y: 0 },
	ArrowRight: { x: 1, y: 0 },
	ArrowUp: { x: 0, y: -1 },
};

/** Snap guides drawn while a moved item is snapped. */
function SnapGuideLines({
	guides,
}: {
	guides: { x: number | null; y: number | null };
}) {
	return (
		<>
			{guides.x === null ? null : (
				<div
					className="absolute inset-y-0 w-px bg-pink-500"
					data-preview-snap-guide="x"
					style={{ left: `${guides.x * 100}%` }}
				/>
			)}
			{guides.y === null ? null : (
				<div
					className="absolute inset-x-0 h-px bg-pink-500"
					data-preview-snap-guide="y"
					style={{ top: `${guides.y * 100}%` }}
				/>
			)}
		</>
	);
}

/**
 * Move, scale and rotate handles around the selected clip, title or graphic.
 * Dragging the box moves it (snapping to the canvas center, edges and other
 * items); corners scale uniformly (Alt from the center); clip and graphic
 * edges stretch one axis (clip `scaleX` / `scaleY`); the knob rotates (Shift
 * snaps to 15°). Each drag is one undo step.
 */
export function PreviewTransformHandles({
	playing,
	project,
	time,
}: PreviewOverlayProps) {
	const tl = useLiteralMessages();
	const runtime = useOptionalEditor();
	const root = useRef<HTMLDivElement>(null);
	const latest = useRef<EditorRuntime | null>(runtime);
	latest.current = runtime;
	const selection = usePreviewState((state) => state.selection);
	const snapEnabled = usePreviewState((state) => state.snapEnabled);
	const cropMode = useDirectManipulation((state) => state.cropMode);
	const cropTargetId = useDirectManipulation((state) => state.cropTargetId);
	const editingTitleId = useDirectManipulation((state) => state.editingTitleId);
	const snapGuides = useDirectManipulation((state) => state.snapGuides);
	const titleSize: TitleSizer = useTitleSizer(root, project, time);
	const target =
		runtime && !playing
			? selectedTarget(project, runtime.assets, selection, time, titleSize)
			: null;
	if (
		!(runtime && target) ||
		croppingTarget({ cropMode, cropTargetId }, target.id) ||
		editingTitleId === target.id
	) {
		return null;
	}
	const manipulation = directManipulationStore(runtime.store);
	const frame = frameOf(project);
	const tolerance = 1 / (2 * project.fps);
	const label = targetLabel(target);

	const refuseLocked = () => {
		if (target.kind === "segment" && target.locked) {
			runtime.setStatus(LOCKED_TRACK_MESSAGE);
			return true;
		}
		return false;
	};

	const beginGesture = (kind: GestureKind, event: PointerEvent) => {
		if (event.button !== 0 || refuseLocked()) {
			return;
		}
		const rect = root.current?.getBoundingClientRect();
		if (!rect) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const toFrame = (clientX: number, clientY: number) =>
			clientToFramePx({ x: clientX, y: clientY }, rect, frame);
		const start = toFrame(event.clientX, event.clientY);
		const startProject = project;
		const commit = createGestureCommit(
			() => latest.current ?? runtime,
			kind === "move"
				? `Move ${label}`
				: kind === "rotate"
					? `Rotate ${label}`
					: `Scale ${label}`
		);
		let others: TransformBox[] | null = null;
		const context = {
			frame,
			others: () => {
				others ??= otherBoxes(
					startProject,
					runtime.assets,
					time,
					target.id,
					titleSize
				);
				return others;
			},
			snapEnabled,
			snapThresholdPx: SNAP_SCREEN_PX * framePxPerScreenPx(rect, frame),
		};
		const move = (moveEvent: globalThis.PointerEvent) => {
			const result = gestureBox(
				kind,
				target,
				start,
				{
					altKey: moveEvent.altKey,
					ctrlKey: moveEvent.ctrlKey,
					metaKey: moveEvent.metaKey,
					pointer: toFrame(moveEvent.clientX, moveEvent.clientY),
					shiftKey: moveEvent.shiftKey,
				},
				context
			);
			manipulation.setState({
				snapGuides:
					result.guides.x === null && result.guides.y === null
						? null
						: result.guides,
			});
			const next = projectWithBox(startProject, target, result.box, tolerance);
			if (next) {
				commit.update(next);
			} else if (commit.started) {
				commit.update(startProject);
			}
		};
		const end = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", end);
			window.removeEventListener("pointercancel", end);
			manipulation.setState({ snapGuides: null });
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", end);
		window.addEventListener("pointercancel", end);
	};

	const onBodyKeyDown = (event: KeyboardEvent) => {
		const nudge = NUDGE[event.key];
		if (nudge && !(event.metaKey || event.ctrlKey || event.altKey)) {
			event.preventDefault();
			event.stopPropagation();
			if (refuseLocked()) {
				return;
			}
			const step = event.shiftKey ? 10 : 1;
			const next = projectWithBox(
				project,
				target,
				moveBox(target.box, { x: nudge.x * step, y: nudge.y * step }, frame),
				tolerance
			);
			if (next) {
				runtime.edit(next, `Nudge ${label}`);
			}
			return;
		}
		const plain = !(
			event.metaKey ||
			event.ctrlKey ||
			event.altKey ||
			event.shiftKey
		);
		if (plain && event.key.toLowerCase() === "c" && target.kind === "segment") {
			event.preventDefault();
			event.stopPropagation();
			toggleCropMode(runtime);
		} else if (plain && event.key === "Enter" && target.kind === "title") {
			event.preventDefault();
			event.stopPropagation();
			manipulation.setState({ editingTitleId: target.id });
		}
	};

	return (
		<div
			className="pointer-events-none absolute inset-0 z-[70]"
			data-preview-transform=""
			ref={root}
		>
			{snapGuides ? <SnapGuideLines guides={snapGuides} /> : null}
			<div
				className="absolute border border-primary"
				data-transform-box={target.kind}
				style={boxStyle(target.box)}
			>
				<button
					aria-label={
						target.kind === "segment"
							? tl("Move {label}. Arrow keys nudge, C crops.", { label })
							: target.kind === "title"
								? tl("Move {label}. Arrow keys nudge, Enter edits the text.", {
										label,
									})
								: tl("Move {label}. Arrow keys nudge.", { label })
					}
					className="pointer-events-auto absolute inset-0 cursor-move border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-primary"
					data-slot="preview-handle"
					data-transform-handle="move"
					onDoubleClick={() => {
						if (target.kind === "title") {
							manipulation.setState({ editingTitleId: target.id });
						}
					}}
					onKeyDown={onBodyKeyDown}
					onPointerDown={(event) => beginGesture("move", event)}
					type="button"
				/>
				{scaleHandlesFor(target).map((handle) => (
					<button
						aria-label={tl("Scale {label} from the {handle}", {
							handle: HANDLE_LABEL[handle],
							label,
						})}
						className={`${handleClass} ${HANDLE_POSITION[handle]}`}
						data-slot="preview-handle"
						data-transform-handle={handle}
						key={handle}
						onPointerDown={(event) => beginGesture({ handle }, event)}
						type="button"
					/>
				))}
				{rotatable(target) ? (
					<>
						<span
							aria-hidden="true"
							className="absolute bottom-full left-1/2 h-5 w-px bg-primary"
						/>
						<button
							aria-label={tl(
								"Rotate {label}. Hold Shift to snap to 15 degrees.",
								{
									label,
								}
							)}
							className={`${handleClass} top-[-1.25rem] left-1/2 cursor-grab rounded-full`}
							data-slot="preview-handle"
							data-transform-handle="rotate"
							onPointerDown={(event) => beginGesture("rotate", event)}
							type="button"
						/>
					</>
				) : null}
			</div>
		</div>
	);
}
