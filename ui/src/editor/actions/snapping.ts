import {
	collectSnapTargets,
	quantizeToFrame,
	type SnapResult,
	type SnapTarget,
	snap,
} from "../../../../shared/timeline-snap.ts";
import type { EditorRuntime } from "../runtime.ts";
import type { ActionHandlers } from "./types.ts";

/** Turn timeline snapping on or off (N, the toolbar magnet). */
export function toggleSnapping(runtime: EditorRuntime) {
	const enabled = !runtime.store.getState().snapEnabled;
	runtime.store.setState({ snapEnabled: enabled, snapGuideTime: null });
	runtime.setStatus(enabled ? "Snapping on." : "Snapping off.");
}

/** Hide the snap indicator (call when a drag ends or is cancelled). */
export function clearSnapGuide(runtime: Pick<EditorRuntime, "store">) {
	runtime.store.setState({ snapGuideTime: null });
}

export interface DragSnapOptions {
	/** Clip or overlay ids being dragged; their (and linked) edges are not targets. */
	exclude?: Iterable<string>;
	/**
	 * Also exclude clips linked to an excluded clip (default true). Pass false
	 * for an unlinked (Alt) drag that keeps the partners as targets.
	 */
	excludeLinked?: boolean;
	/** Snap to keyframes too (keyframe drags); owner defaults to the selection. */
	includeKeyframes?: boolean;
	/** Snap to title/graphic/caption/avatar/adjustment bounds (default true). */
	includeOverlays?: boolean;
	/** Whose keyframes to snap to; defaults to `runtime.selectedId`. */
	keyframeOwnerId?: string | null;
	thresholdPx?: number;
}

type SnapRuntime = Pick<
	EditorRuntime,
	"project" | "range" | "selectedId" | "store" | "time" | "zoom"
>;

/** Snap (or, when suspended, only frame-quantize) one value; no side effects. */
function resolveSnap(
	runtime: SnapRuntime,
	targets: readonly SnapTarget[],
	value: number,
	options: DragSnapOptions,
	modifiers: DragSnapModifiers
): SnapResult {
	const fps = runtime.project?.fps ?? 30;
	const enabled = runtime.store.getState().snapEnabled;
	if (!enabled || modifiers.shiftKey) {
		return { time: quantizeToFrame(value, fps) };
	}
	return snap(value, targets, {
		fps,
		pxPerSec: runtime.zoom,
		thresholdPx: options.thresholdPx,
	});
}

function dragTargets(
	runtime: SnapRuntime,
	options: DragSnapOptions
): SnapTarget[] {
	const { project } = runtime;
	if (!project) {
		return [];
	}
	return collectSnapTargets(project, {
		exclude: new Set(options.exclude ?? []),
		excludeLinked: options.excludeLinked,
		includeKeyframes: options.includeKeyframes,
		includeOverlays: options.includeOverlays,
		keyframeOwnerId:
			options.keyframeOwnerId === undefined
				? runtime.selectedId
				: options.keyframeOwnerId,
		range: runtime.range,
		time: runtime.time,
	});
}

/** The modifier state of the pointer event driving a drag. */
export interface DragSnapModifiers {
	/** Shift held: snapping is suspended and the value only quantizes to frames. */
	shiftKey?: boolean;
}

/**
 * Create the snapper for one drag gesture. Targets are collected once, when
 * the drag starts; each call snaps a candidate time (seconds), updates the
 * indicator in `store.snapGuideTime`, and returns the result. While snapping
 * is off or Shift is held the value only quantizes to frames.
 */
export function createDragSnapper(
	runtime: SnapRuntime,
	options: DragSnapOptions = {}
): (value: number, modifiers?: DragSnapModifiers) => SnapResult {
	const targets = dragTargets(runtime, options);
	return (value, modifiers = {}) => {
		const result = resolveSnap(runtime, targets, value, options, modifiers);
		runtime.store.setState({ snapGuideTime: result.target?.time ?? null });
		return result;
	};
}

/**
 * Snap one time with fresh targets (razor clicks, single-shot placements).
 * It does not publish a snap guide, so no indicator is left behind.
 */
export function snapDragTime(
	runtime: SnapRuntime,
	value: number,
	options: DragSnapOptions & DragSnapModifiers = {}
): number {
	return resolveSnap(
		runtime,
		dragTargets(runtime, options),
		value,
		options,
		options
	).time;
}

/** Snapping handlers (the N binding and toolbar magnet are wired by W5-I2). */
export const snappingActions: ActionHandlers = {
	"snapping.toggle": (runtime) => {
		toggleSnapping(runtime);
	},
};
