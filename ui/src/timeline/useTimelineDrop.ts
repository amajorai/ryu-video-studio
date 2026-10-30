import { formatMessage } from "@ryu/i18n/core";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { type RefObject, useEffect, useRef, useState } from "react";
import {
	type OverwriteImpact,
	overwriteImpacts,
} from "../../../shared/overwrite.ts";
import {
	type Asset,
	type Project,
	trackSettingFor,
} from "../../../shared/project.ts";
import {
	newRevealTransition,
	type RevealTransition,
	revealTransitionInfo,
} from "../../../shared/reveal-transitions.ts";
import { trackOrderFor } from "../../../shared/track-edits.ts";
import {
	firstFreeTrack,
	placementKindOf,
} from "../../../shared/track-placement.ts";
import { applyRevealTransition, cutNear } from "../../../shared/transitions.ts";
import {
	type DropMode,
	dropAssetOnTimeline,
} from "../editor/actions/placement.ts";
import {
	clearSnapGuide,
	createDragSnapper,
} from "../editor/actions/snapping.ts";
import { message } from "../editor/format.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import {
	type AssetDragPayload,
	activeAssetDrag,
	clearActiveAssetDrag,
	hasAssetDrag,
	payloadDuration,
	readAssetDrag,
} from "../library/drag-source.ts";
import {
	carriesTransition,
	readTransitionDrag,
} from "../transitions/transition-drag.ts";

/** Lane rows inside the lanes container, in `trackOrderFor` order. */
const TRACK_ROW_SELECTOR = ":scope > .studio-track";

/** Vertical extent of one lane, relative to the lanes container. */
export interface LaneBox {
	height: number;
	top: number;
}

/** Where a library drag would land and what it would overwrite. */
export interface DropTarget {
	assetId: string;
	/** Clip start, snapped and frame-quantized. */
	at: number;
	/** True when the pointer is outside every lane and a free track was chosen. */
	autoTrack: boolean;
	duration: number;
	/** Clips the overwrite would trim, split, or remove (empty for insert). */
	impacts: OverwriteImpact[];
	/** Lane boxes for the target track and every impacted track. */
	lanes: Record<number, LaneBox>;
	/** The target track is locked, so the drop is refused. */
	locked: boolean;
	mode: DropMode;
	name: string;
	track: number;
}

/** A pointer position resolved against the lanes container. */
export interface DropPoint {
	lanes: Record<number, LaneBox>;
	/** Pointer time in seconds (unsnapped, at least 0). */
	time: number;
	/** The lane under the pointer, if any. */
	track?: number;
}

/** Ctrl (Windows/Linux) or Cmd (macOS) held during the drop ripple-inserts. */
export const dropModeFor = (event: {
	ctrlKey: boolean;
	metaKey: boolean;
}): DropMode => (event.ctrlKey || event.metaKey ? "insert" : "overwrite");

/**
 * Resolve a client point against the lanes container: the timeline time under
 * the pointer and the lane it is over. Lane boxes for every rendered track are
 * returned so the preview can draw on any of them.
 */
export function dropPointIn(
	container: Element,
	order: readonly number[],
	point: { clientX: number; clientY: number },
	zoom: number
): DropPoint {
	const bounds = container.getBoundingClientRect();
	const rows = [...container.querySelectorAll(TRACK_ROW_SELECTOR)];
	const lanes: Record<number, LaneBox> = {};
	let track: number | undefined;
	rows.forEach((row, index) => {
		const laneTrack = order[index];
		if (laneTrack === undefined) {
			return;
		}
		const rect = row.getBoundingClientRect();
		lanes[laneTrack] = { height: rect.height, top: rect.top - bounds.top };
		if (point.clientY >= rect.top && point.clientY < rect.bottom) {
			track = laneTrack;
		}
	});
	return {
		lanes,
		time: Math.max(0, (point.clientX - bounds.left) / Math.max(zoom, 1e-6)),
		track,
	};
}

/** Lane box for a track that is not rendered yet: just below the last lane. */
function laneBelow(lanes: Record<number, LaneBox>): LaneBox {
	const boxes = Object.values(lanes);
	const last = boxes.reduce(
		(lowest, box) => Math.max(lowest, box.top + box.height),
		0
	);
	return { height: boxes[0]?.height ?? 54, top: last };
}

/**
 * The full drop target for a payload at a snapped time. With no lane under
 * the pointer the first free track that suits the media is used.
 */
export function resolveDropTarget(input: {
	asset: Asset;
	assets: readonly Asset[];
	at: number;
	lanes: Record<number, LaneBox>;
	mode: DropMode;
	payload: AssetDragPayload;
	project: Project;
	track?: number;
}): DropTarget {
	const { asset, at, mode, payload, project } = input;
	const duration = payloadDuration(asset, payload);
	const end = at + duration;
	const track =
		input.track ??
		firstFreeTrack(project, at, end, {
			assets: input.assets,
			kind: placementKindOf(asset.kind),
		}) ??
		0;
	const impacts =
		mode === "overwrite" ? overwriteImpacts(project, track, at, end) : [];
	const lanes: Record<number, LaneBox> = {};
	for (const laneTrack of [track, ...impacts.map((impact) => impact.track)]) {
		lanes[laneTrack] = input.lanes[laneTrack] ?? laneBelow(input.lanes);
	}
	return {
		at,
		assetId: asset.id,
		autoTrack: input.track === undefined,
		duration,
		impacts,
		lanes,
		locked: trackSettingFor(project, track).locked,
		mode,
		name: asset.name,
		track,
	};
}

/** Screen pixels around a cut that still count as dropping onto it. */
export const TRANSITION_DROP_TOLERANCE_PX = 12;

/** English fallback until a caller passes the Companion's `tl`. */
const englishMessages: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

/**
 * Apply a gallery transition dropped at `time` on `track`: the cut nearest
 * the pointer (within `TRANSITION_DROP_TOLERANCE_PX`) gets the reveal on its
 * incoming clip, which extends under the outgoing one as when it is picked
 * in the inspector. One undoable edit; refusals are reported in the status.
 */
export function dropTransitionOnCut(
	runtime: Pick<EditorRuntime, "assets" | "edit" | "project" | "setStatus">,
	type: RevealTransition,
	point: { time: number; track?: number },
	zoom: number,
	tl: LiteralMessage = englishMessages
): boolean {
	const { project } = runtime;
	if (!project) {
		return false;
	}
	const cut =
		point.track === undefined
			? undefined
			: cutNear(
					project,
					point.track,
					point.time,
					TRANSITION_DROP_TOLERANCE_PX / Math.max(zoom, 1e-6)
				);
	if (!cut) {
		runtime.setStatus(
			"Drop a transition on the cut between two clips on the same track."
		);
		return false;
	}
	const label = revealTransitionInfo[type].label;
	// Applied locally as one undoable edit; agents make the same edit with
	// POST /projects/:id/transition (sidecar/src/routes/transitions.ts).
	try {
		runtime.edit(
			applyRevealTransition(
				project,
				runtime.assets,
				cut.incoming.id,
				newRevealTransition(type)
			),
			`Transition: ${label}`
		);
	} catch (error) {
		runtime.setStatus(message(error));
		return false;
	}
	runtime.setStatus(
		tl("{transitionName} added to the cut.", { transitionName: label })
	);
	return true;
}

const targetKey = (target: DropTarget | null) =>
	target
		? `${target.assetId}:${target.track}:${target.at}:${target.mode}:${target.impacts.length}:${JSON.stringify(target.lanes)}`
		: "";

type Snapper = ReturnType<typeof createDragSnapper>;

/**
 * Library drops onto the lanes. Mount a layer inside the lanes container and
 * pass its ref: the hook listens on the container (the layer's parent), keeps
 * the live drop target for the preview, and applies the drop as one edit.
 */
export function useTimelineDrop({
	layerRef,
	runtime,
	zoom,
}: {
	layerRef: RefObject<HTMLElement | null>;
	runtime: EditorRuntime;
	zoom: number;
}): { target: DropTarget | null } {
	const [target, setTarget] = useState<DropTarget | null>(null);
	const tl = useLiteralMessages();
	const latest = useRef({ runtime, tl, zoom });
	latest.current = { runtime, tl, zoom };
	useEffect(() => {
		const container = layerRef.current?.parentElement;
		if (!container) {
			return;
		}
		let snapper: Snapper | null = null;
		let shown = "";
		const show = (next: DropTarget | null) => {
			const key = targetKey(next);
			if (key !== shown) {
				shown = key;
				setTarget(next);
			}
		};
		const reset = () => {
			snapper = null;
			show(null);
			clearSnapGuide(latest.current.runtime);
		};
		const resolve = (
			event: DragEvent,
			payload: AssetDragPayload,
			asset: Asset
		): DropTarget | null => {
			const { runtime: current, zoom: scale } = latest.current;
			const { project } = current;
			if (!project) {
				return null;
			}
			const point = dropPointIn(
				container,
				trackOrderFor(project),
				event,
				scale
			);
			snapper ??= createDragSnapper(current);
			const at = snapper(point.time, { shiftKey: event.shiftKey }).time;
			return resolveDropTarget({
				asset,
				assets: current.assets,
				at,
				lanes: point.lanes,
				mode: dropModeFor(event),
				payload,
				project,
				track: point.track,
			});
		};
		const onDragOver = (event: DragEvent) => {
			if (event.dataTransfer && carriesTransition(event.dataTransfer)) {
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
				return;
			}
			if (!hasAssetDrag(event.dataTransfer)) {
				return;
			}
			event.preventDefault();
			const active = activeAssetDrag();
			const resolved = active
				? resolve(event, active.payload, active.asset)
				: null;
			if (event.dataTransfer) {
				event.dataTransfer.dropEffect = resolved?.locked ? "none" : "copy";
			}
			show(resolved);
		};
		const onDragLeave = (event: DragEvent) => {
			const next = event.relatedTarget;
			if (next instanceof Node && container.contains(next)) {
				return;
			}
			reset();
		};
		const onDrop = (event: DragEvent) => {
			const transition = event.dataTransfer
				? readTransitionDrag(event.dataTransfer)
				: undefined;
			if (transition) {
				event.preventDefault();
				const { runtime: current, tl: messages, zoom: scale } = latest.current;
				if (current.project) {
					dropTransitionOnCut(
						current,
						transition,
						dropPointIn(
							container,
							trackOrderFor(current.project),
							event,
							scale
						),
						scale,
						messages
					);
				}
				return;
			}
			if (!hasAssetDrag(event.dataTransfer)) {
				return;
			}
			event.preventDefault();
			const { runtime: current } = latest.current;
			const payload =
				readAssetDrag(event.dataTransfer) ?? activeAssetDrag()?.payload;
			const asset = current.assets.find(
				(candidate) => candidate.id === payload?.assetId
			);
			const resolved = payload && asset ? resolve(event, payload, asset) : null;
			reset();
			clearActiveAssetDrag();
			if (!(payload && asset && resolved)) {
				current.setStatus("That media is no longer in the library.");
				return;
			}
			if (resolved.locked) {
				current.setStatus("Unlock the target track before placing clips.");
				return;
			}
			dropAssetOnTimeline(current, asset, {
				at: resolved.at,
				mode: resolved.mode,
				sourceIn: payload.sourceIn,
				sourceOut: payload.sourceOut,
				track: resolved.track,
			});
		};
		container.addEventListener("dragover", onDragOver);
		container.addEventListener("dragleave", onDragLeave);
		container.addEventListener("drop", onDrop);
		return () => {
			container.removeEventListener("dragover", onDragOver);
			container.removeEventListener("dragleave", onDragLeave);
			container.removeEventListener("drop", onDrop);
		};
	}, [layerRef]);
	return { target };
}
