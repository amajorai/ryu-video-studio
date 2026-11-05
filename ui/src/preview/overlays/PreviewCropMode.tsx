import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import {
	CORNER_HANDLES,
	CROP_ASPECT_PRESETS,
	type CropAspectId,
	cropAspectRatio,
	cropGestureChanges,
	croppedBox,
	cropToAspect,
	dragCropHandle,
	EDGE_HANDLES,
	moveCrop,
	type Point,
	rotateVector,
	type ScaleHandle,
	segmentGeometryPatch,
	type TransformBox,
} from "../../../../shared/preview-geometry.ts";
import type { Crop, Project } from "../../../../shared/project.ts";
import type { EditorRuntime } from "../../editor/runtime.ts";
import { useOptionalEditor, usePreviewState } from "../use-preview-state.ts";
import {
	applyTargetPatch,
	clientToFramePx,
	contentSizeOf,
	createGestureCommit,
	croppingTarget,
	directManipulationStore,
	exitCropMode,
	frameOf,
	type ManipulationTarget,
	selectedTarget,
	useDirectManipulation,
} from "./direct-manipulation.ts";
import type { PreviewOverlayProps } from "./overlay-props.ts";
import { boxStyle, HANDLE_POSITION } from "./PreviewTransformHandles.tsx";

type SegmentTarget = Extract<ManipulationTarget, { kind: "segment" }>;

const NO_CROP: Crop = { bottom: 0, left: 0, right: 0, top: 0 };

/** The project with the target clip cropped to `crop`, or null when unchanged. */
export function projectWithCrop(
	project: Project,
	target: SegmentTarget,
	crop: Crop,
	tolerance: number
): Project | null {
	const patch = segmentGeometryPatch(
		target.segment,
		cropGestureChanges(crop),
		target.elapsed,
		{ tolerance }
	);
	return Object.keys(patch).length
		? applyTargetPatch(project, target, patch)
		: null;
}

/**
 * A frame-pixel pointer delta as fractions of the uncropped source: undo the
 * rotation of `full` (the source box the drag started on), then divide by its
 * drawn size.
 */
export function sourceDelta(
	full: TransformBox,
	deltaPx: Point,
	frame: { height: number; width: number }
): Point {
	const local = rotateVector(deltaPx, -full.rotation);
	const width = full.width * frame.width;
	const height = full.height * frame.height;
	return { x: width ? local.x / width : 0, y: height ? local.y / height : 0 };
}

export const CROP_UNAVAILABLE_MESSAGE =
	"Crop mode ended: the clip is no longer selected, under the playhead or unlocked.";

/**
 * Crop mode (C in the focused preview): the clip's uncropped source with the
 * crop window inside. Drag the window to move it, its handles to resize it,
 * or pick an aspect preset (free, 16:9, 9:16, 1:1, 4:5, 4:3); corner drags
 * keep a locked aspect. Writes the clip's `crop` (a keyframe when cropped
 * edges are animated).
 *
 * The render crops the source and then re-fits the kept part, so a new crop
 * moves the source box. During a drag the source box stays where the drag
 * started, so the window follows the pointer; it re-fits on release.
 *
 * Crop mode belongs to one clip. Selecting another clip, locking its track,
 * or moving the playhead off it ends crop mode with a status message.
 */
export function PreviewCropMode({
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
	const cropMode = useDirectManipulation((state) => state.cropMode);
	const cropTargetId = useDirectManipulation((state) => state.cropTargetId);
	const aspect = useDirectManipulation((state) => state.cropAspect);
	/** The source box a running drag started on (held still until release). */
	const [dragFull, setDragFull] = useState<TransformBox | null>(null);
	const selected =
		runtime && cropMode
			? selectedTarget(
					project,
					runtime.assets,
					{ ...selection, overlayIds: [] },
					time,
					() => ({ height: 0, width: 0 })
				)
			: null;
	const target =
		selected?.kind === "segment" &&
		!selected.locked &&
		croppingTarget({ cropMode, cropTargetId }, selected.id)
			? selected
			: null;
	const stale = Boolean(runtime && cropMode && !playing && !target);
	useEffect(() => {
		if (stale && runtime) {
			exitCropMode(directManipulationStore(runtime.store));
			runtime.setStatus(CROP_UNAVAILABLE_MESSAGE);
		}
	}, [stale, runtime]);
	if (!(runtime && target) || playing) {
		return null;
	}
	const manipulation = directManipulationStore(runtime.store);
	const frame = frameOf(project);
	const tolerance = 1 / (2 * project.fps);
	const asset = runtime.assets.find(
		(item) => item.id === target.segment.assetId
	);
	const content = contentSizeOf(asset, frame);
	const crop = target.placement.crop;
	const ratio = cropAspectRatio(aspect);

	const write = (next: Crop, label: string) => {
		const updated = projectWithCrop(project, target, next, tolerance);
		if (updated) {
			runtime.edit(updated, label);
		}
	};

	const chooseAspect = (id: CropAspectId) => {
		manipulation.setState({ cropAspect: id });
		const presetRatio = cropAspectRatio(id);
		if (presetRatio !== null) {
			write(cropToAspect(crop, presetRatio, content), `Crop clip to ${id}`);
		}
	};

	const beginDrag = (handle: ScaleHandle | "window", event: PointerEvent) => {
		const rect = root.current?.getBoundingClientRect();
		if (event.button !== 0 || !rect) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const startProject = project;
		const start = clientToFramePx(
			{ x: event.clientX, y: event.clientY },
			rect,
			frame
		);
		const commit = createGestureCommit(
			() => latest.current ?? runtime,
			"Crop clip"
		);
		const startFull = target.placement.full;
		setDragFull(startFull);
		const move = (moveEvent: globalThis.PointerEvent) => {
			const pointer = clientToFramePx(
				{ x: moveEvent.clientX, y: moveEvent.clientY },
				rect,
				frame
			);
			const delta = sourceDelta(
				startFull,
				{ x: pointer.x - start.x, y: pointer.y - start.y },
				frame
			);
			const next =
				handle === "window"
					? moveCrop(crop, delta)
					: dragCropHandle(crop, handle, delta, { content, ratio });
			const updated = projectWithCrop(startProject, target, next, tolerance);
			if (updated) {
				commit.update(updated);
			} else if (commit.started) {
				commit.update(startProject);
			}
		};
		const end = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", end);
			window.removeEventListener("pointercancel", end);
			setDragFull(null);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", end);
		window.addEventListener("pointercancel", end);
	};

	const full = dragFull ?? target.placement.full;
	const cropWindowBox = croppedBox(full, crop, frame);
	const handles: ScaleHandle[] =
		ratio === null ? [...CORNER_HANDLES, ...EDGE_HANDLES] : [...CORNER_HANDLES];

	return (
		<div
			className="pointer-events-none absolute inset-0 z-[72]"
			data-preview-crop=""
			ref={root}
		>
			<div
				className="absolute overflow-hidden border border-primary/70 border-dashed"
				data-crop-bounds=""
				style={boxStyle(full)}
			>
				<div
					className="absolute shadow-[0_0_0_9999px_rgb(0_0_0/0.45)]"
					data-crop-window=""
					style={{
						bottom: `${crop.bottom * 100}%`,
						left: `${crop.left * 100}%`,
						right: `${crop.right * 100}%`,
						top: `${crop.top * 100}%`,
					}}
				/>
			</div>
			<div className="absolute" style={boxStyle(cropWindowBox)}>
				<button
					aria-label="Move the crop window"
					className="pointer-events-auto absolute inset-0 cursor-move border border-primary bg-transparent p-0"
					data-crop-handle="window"
					data-slot="preview-handle"
					onKeyDown={(event) => {
						if (event.key === "Escape" || event.key === "Enter") {
							event.preventDefault();
							event.stopPropagation();
							exitCropMode(manipulation);
						}
					}}
					onPointerDown={(event) => beginDrag("window", event)}
					type="button"
				/>
				{handles.map((handle) => (
					<button
						aria-label={tl("Crop from the {handle} handle", { handle })}
						className={`pointer-events-auto absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-[2px] border-2 border-primary bg-background p-0 ${HANDLE_POSITION[handle]}`}
						data-crop-handle={handle}
						data-slot="preview-handle"
						key={handle}
						onPointerDown={(event) => beginDrag(handle, event)}
						type="button"
					/>
				))}
			</div>
			<fieldset
				aria-label="Crop aspect ratio"
				className="pointer-events-auto absolute top-2 left-1/2 m-0 flex -translate-x-1/2 flex-wrap items-center gap-1 rounded-md border border-border bg-background/90 p-1"
				data-crop-toolbar=""
			>
				{CROP_ASPECT_PRESETS.map((preset) => (
					<Button
						aria-pressed={aspect === preset.id}
						data-crop-aspect={preset.id}
						key={preset.id}
						onClick={() => chooseAspect(preset.id)}
						size="sm"
						variant={aspect === preset.id ? "secondary" : "ghost"}
					>
						{preset.label}
					</Button>
				))}
				<Button
					data-crop-action="reset"
					onClick={() => {
						manipulation.setState({ cropAspect: "free" });
						write(NO_CROP, "Reset crop");
					}}
					size="sm"
					variant="ghost"
				>
					Reset
				</Button>
				<Button
					data-crop-action="done"
					onClick={() => exitCropMode(manipulation)}
					size="sm"
				>
					Done
				</Button>
			</fieldset>
		</div>
	);
}
