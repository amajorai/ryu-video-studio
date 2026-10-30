import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { cutsInside } from "../../../shared/cut-ops.ts";
import type { ClipColorLabel, Segment } from "../../../shared/project.ts";
import { pendingAudioDetachActions } from "../editor/actions/audio-detach.ts";
import { selectionToNewTrack } from "../editor/actions/placement.ts";
import { razorCut } from "../editor/actions/split.ts";
import type { ActionHandler } from "../editor/actions/types.ts";
import { clock } from "../editor/format.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { ACTION_HANDLERS } from "../shortcuts/registry.ts";
import type { ClipMenuCommand, ClipMenuRun } from "./clip-menu.ts";
import { clipColorPatch, clipLabelPatch } from "./clip-meta.ts";

/** English fallback until a caller passes the Companion's `tl`. */
const englishMessages: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

/** Seconds a menu freeze frame holds (the inspector's default). */
export const MENU_FREEZE_SECONDS = 2;
/** Longest timeline the freeze route accepts a playhead on. */
const TIMELINE_LIMIT = 7200;

type HandlerTable = Readonly<Partial<Record<string, ActionHandler>>>;

/**
 * Handlers the menu dispatches: the shortcut registry plus planned action ids
 * it does not bind yet (Recover audio). The registry wins once it gains an id.
 */
const registeredHandlers: HandlerTable = {
	...pendingAudioDetachActions,
	...ACTION_HANDLERS,
};

/** Whether `action` has a registered editor handler. */
export function menuActionAvailable(
	action: string,
	handlers: HandlerTable = registeredHandlers
): boolean {
	return Object.hasOwn(handlers, action) && Boolean(handlers[action]);
}

/** Run a registered editor action by id; false when it is missing or declined. */
export function runMenuAction(
	action: string,
	runtime: EditorRuntime,
	handlers: HandlerTable = registeredHandlers
): boolean {
	const handler = menuActionAvailable(action, handlers)
		? handlers[action]
		: undefined;
	return handler ? handler(runtime) !== false : false;
}

function patchClip(
	runtime: EditorRuntime,
	segment: Segment,
	patch: Partial<Segment>,
	label: string
) {
	runtime.edit(
		(current) => ({
			...current,
			segments: current.segments.map((candidate) => {
				if (candidate.id !== segment.id) {
					return candidate;
				}
				const next: Segment = { ...candidate, ...patch };
				// Cleared optional fields are removed, not stored as undefined.
				for (const key of Object.keys(patch) as (keyof Segment)[]) {
					if (patch[key] === undefined) {
						delete next[key];
					}
				}
				return next;
			}),
		}),
		label
	);
}

/** Rename a clip (blank text clears the label); no-op when unchanged. */
export function renameClip(
	runtime: EditorRuntime,
	segment: Segment,
	text: string
): boolean {
	const patch = clipLabelPatch(segment, text);
	if (!patch) {
		return false;
	}
	patchClip(runtime, segment, patch, "Rename clip");
	return true;
}

/** Set or clear a clip's color tag; no-op when unchanged. */
export function recolorClip(
	runtime: EditorRuntime,
	segment: Segment,
	color: ClipColorLabel | undefined
): boolean {
	const patch = clipColorPatch(segment, color);
	if (!patch) {
		return false;
	}
	patchClip(runtime, segment, patch, color ? "Color clip" : "Clear clip color");
	return true;
}

/** Freeze at the playhead when it is inside the clip, else hold the last frame. */
export function freezeClipFrame(runtime: EditorRuntime, segment: Segment) {
	const mode = cutsInside(segment, runtime.time) ? "insert" : "hold-end";
	const at = Math.max(0, Math.min(TIMELINE_LIMIT, runtime.time));
	return runtime.routeEdit(
		"freeze-frame",
		{ at, clipId: segment.id, duration: MENU_FREEZE_SECONDS, mode },
		() =>
			`Froze a ${MENU_FREEZE_SECONDS.toFixed(1)}s still ${mode === "insert" ? `at ${clock(at)}` : "after the clip"} and rippled later layers.`,
		{ refreshAssets: true }
	);
}

/** Reverse the clip (or restore it forward); linked partners follow. */
export function reverseClip(runtime: EditorRuntime, segment: Segment) {
	return runtime.routeEdit(
		"reverse",
		{ clipIds: [segment.id] },
		() => "Clip direction changed; linked partners followed.",
		{ refreshAssets: true }
	);
}

/** Swap the clip's media, keeping its trims, transform, and grade. */
export function swapClipMediaTo(
	runtime: EditorRuntime,
	segment: Segment,
	assetId: string
) {
	const name =
		runtime.assets.find((asset) => asset.id === assetId)?.name ?? "new media";
	return runtime.routeEdit(
		"swap-clip-media",
		{ assetId, clipId: segment.id },
		() => `Replaced the clip's media with ${name}.`
	);
}

/** Open the media library and bring the clip's asset tile into view. */
export function revealInLibrary(
	runtime: EditorRuntime,
	segment: Segment,
	root: ParentNode = document,
	tl: LiteralMessage = englishMessages
) {
	const asset = runtime.assets.find(
		(candidate) => candidate.id === segment.assetId
	);
	if (!asset) {
		runtime.setStatus("This clip's media is missing from the library.");
		return;
	}
	runtime.setPanel("media");
	const label = tl("Add {assetName} to timeline", { assetName: asset.name });
	const focusTile = () => {
		const button = [
			...root.querySelectorAll<HTMLElement>("button[aria-label]"),
		].find((candidate) => candidate.getAttribute("aria-label") === label);
		if (!button) {
			runtime.setStatus(
				tl(
					"{assetName} is hidden by the library filters. Clear them to see it.",
					{
						assetName: asset.name,
					}
				)
			);
			return;
		}
		button.scrollIntoView?.({ block: "nearest" });
		button.focus();
	};
	// The library tab renders after the panel switch commits.
	setTimeout(focusTile, 0);
}

/** Open the speed tools with the clip selected. */
export function openSpeedTools(runtime: EditorRuntime) {
	runtime.setPanel("tempo");
}

export interface ClipMenuDispatch {
	/** Opens the rename dialog (UI state lives in the menu component). */
	onRename: () => void;
	/** Timeline time under the pointer when the menu opened. */
	pointerTime?: number;
	runtime: EditorRuntime;
	segment: Segment;
	/** The Companion's message formatter; English when omitted. */
	tl?: LiteralMessage;
}

function runCommand(command: ClipMenuCommand, dispatch: ClipMenuDispatch) {
	const { pointerTime, runtime, segment } = dispatch;
	switch (command) {
		case "duplicateToNewTrack":
			selectionToNewTrack(runtime, true);
			return;
		case "freezeFrame":
			void freezeClipFrame(runtime, segment);
			return;
		case "moveToNewTrack":
			selectionToNewTrack(runtime, false);
			return;
		case "rename":
			dispatch.onRename();
			return;
		case "revealInLibrary":
			revealInLibrary(runtime, segment, document, dispatch.tl);
			return;
		case "reverse":
			void reverseClip(runtime, segment);
			return;
		case "speed":
			openSpeedTools(runtime);
			return;
		case "splitAtPointer":
			if (pointerTime !== undefined) {
				razorCut(runtime, { at: pointerTime, segment, shiftKey: false });
			}
			return;
		default:
			command satisfies never;
	}
}

/** Perform a chosen menu item against the latest editor runtime. */
export function runClipMenuItem(
	run: ClipMenuRun,
	dispatch: ClipMenuDispatch,
	handlers: HandlerTable = registeredHandlers
) {
	switch (run.type) {
		case "action":
			runMenuAction(run.action, dispatch.runtime, handlers);
			return;
		case "color":
			recolorClip(dispatch.runtime, dispatch.segment, run.color);
			return;
		case "command":
			runCommand(run.command, dispatch);
			return;
		case "swap":
			void swapClipMediaTo(dispatch.runtime, dispatch.segment, run.assetId);
			return;
		default:
			run satisfies never;
	}
}
