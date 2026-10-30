import {
	pasteSettings,
	SETTINGS_GROUPS,
	type SettingsGroup,
} from "../../../../shared/clip-edits.ts";
import {
	type ClipboardPayload,
	copyClips,
	cutClips,
	type PasteMode,
	pasteClips,
} from "../../../../shared/clipboard.ts";
import type { Segment } from "../../../../shared/project.ts";
import { clock, message } from "../format.ts";
import type { EditorRuntime } from "../runtime.ts";
import type { ClipboardPayload as StoreClipboard } from "../store.ts";
import { selectClips } from "./select.ts";
import type { ActionHandlers } from "./types.ts";

const plural = (count: number, noun: string) =>
	`${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Full snapshots behind the store's id-only clipboard. The store keeps what
 * the UI shows (ids, offsets, span); the snapshot lets a cut payload paste
 * after its clips are gone. A store payload without a snapshot (set by
 * another feature) is rebuilt from the clips still on the timeline.
 */
const snapshots = new WeakMap<StoreClipboard, ClipboardPayload>();

function storeClipboard(runtime: EditorRuntime, payload: ClipboardPayload) {
	const summary: StoreClipboard = {
		items: payload.items.map((item) => ({
			offset: item.offset,
			segmentId: item.segment.id,
		})),
		overlays: payload.overlays.map((overlay) => ({
			id: overlay.item.id,
			kind: overlay.kind,
		})),
		span: payload.span,
	};
	snapshots.set(summary, payload);
	runtime.store.setState({ clipboard: summary });
}

/** The clipboard payload to paste, or null when the clipboard is empty. */
export function clipboardPayload(
	runtime: EditorRuntime
): ClipboardPayload | null {
	const summary = runtime.store.getState().clipboard;
	if (!summary) {
		return null;
	}
	const snapshot = snapshots.get(summary);
	if (snapshot) {
		return snapshot;
	}
	if (!runtime.project) {
		return null;
	}
	try {
		return copyClips(
			runtime.project,
			summary.items.map((item) => item.segmentId),
			summary.overlays
		);
	} catch {
		return null;
	}
}

function selection(runtime: EditorRuntime) {
	const { overlayIds, segmentIds } = runtime.store.getState().selection;
	return { overlays: overlayIds, segmentIds };
}

const hasSelection = (runtime: EditorRuntime) => {
	const { overlays, segmentIds } = selection(runtime);
	return segmentIds.length > 0 || overlays.length > 0;
};

/** Copy the selected clips (with linked partners) and overlays. */
export function copySelection(runtime: EditorRuntime): boolean {
	const { project } = runtime;
	if (!(project && hasSelection(runtime))) {
		return false;
	}
	const { overlays, segmentIds } = selection(runtime);
	try {
		const payload = copyClips(project, segmentIds, overlays);
		storeClipboard(runtime, payload);
		runtime.setStatus(
			`Copied ${plural(payload.items.length + payload.overlays.length, "item")}.`
		);
	} catch (error) {
		runtime.setStatus(message(error));
	}
	return true;
}

/**
 * Cut the selection as one undo step; in ripple mode the removed spans are
 * closed, otherwise gaps are left.
 */
export function cutSelection(runtime: EditorRuntime): boolean {
	const { assets, project } = runtime;
	if (!(project && hasSelection(runtime))) {
		return false;
	}
	const { overlays, segmentIds } = selection(runtime);
	const ripple = runtime.store.getState().rippleMode;
	try {
		const result = cutClips(project, assets, segmentIds, overlays, { ripple });
		runtime.edit(result.project, ripple ? "Ripple cut" : "Cut");
		storeClipboard(runtime, result.payload);
		runtime.store.setState((state) => ({
			selection: { ...state.selection, overlayIds: [] },
		}));
		runtime.setSelected(null);
		const cut = `Cut ${plural(result.payload.items.length + result.payload.overlays.length, "item")}.`;
		runtime.setStatus(
			result.unclosedSpans
				? `${cut} ${plural(result.unclosedSpans, "gap")} stayed open because other clips still cover ${result.unclosedSpans === 1 ? "it" : "them"}.`
				: cut
		);
	} catch (error) {
		runtime.setStatus(message(error));
	}
	return true;
}

export interface PasteRequest {
	/** Defaults to the playhead. */
	at?: number;
	label?: string;
	mode: PasteMode;
	/** Lowest destination track; omitted pastes onto free tracks. */
	track?: number;
}

/**
 * Paste `payload` (default: the clipboard) as one undo step and select what
 * was pasted. Returns the new clip ids, or null when nothing was pasted.
 */
export function pastePayload(
	runtime: EditorRuntime,
	request: PasteRequest,
	payload: ClipboardPayload | null = clipboardPayload(runtime)
): string[] | null {
	const { assets, project } = runtime;
	if (!(project && payload)) {
		return null;
	}
	const at = Math.max(0, request.at ?? runtime.time);
	try {
		const options: Parameters<typeof pasteClips>[3] = {
			at,
			mode: request.mode,
		};
		if (request.track !== undefined) {
			options.track = request.track;
		}
		const result = pasteClips(project, assets, payload, options);
		runtime.edit(
			result.project,
			request.label ?? (request.mode === "insert" ? "Paste insert" : "Paste")
		);
		if (result.newIds.length) {
			selectClips(runtime, result.newIds);
		}
		runtime.store.setState((state) => ({
			selection: { ...state.selection, overlayIds: result.newOverlays },
		}));
		runtime.setStatus(
			`Pasted ${plural(result.newIds.length + result.newOverlays.length, "item")} at ${clock(at)}.`
		);
		return result.newIds;
	} catch (error) {
		runtime.setStatus(message(error));
		return null;
	}
}

/**
 * Duplicate the selection (with linked partners) right after its own end,
 * on the same tracks when free, otherwise on the first free tracks.
 */
export function duplicateSelected(runtime: EditorRuntime) {
	const { project, selectedTrackLocked } = runtime;
	if (!project) {
		return;
	}
	if (selectedTrackLocked) {
		runtime.setStatus("Unlock this track before duplicating its clips.");
		return;
	}
	const { overlays, segmentIds } = selection(runtime);
	if (!(segmentIds.length || overlays.length)) {
		return;
	}
	try {
		const payload = copyClips(project, segmentIds, overlays);
		const origin = Math.min(
			...payload.items.map((item) => item.segment.start - item.offset),
			...payload.overlays.map((overlay) => overlay.item.start - overlay.offset)
		);
		const at = origin + payload.span;
		const single = segmentIds.length === 1 && overlays.length === 0;
		const ids = pastePayload(
			runtime,
			{
				at,
				label: single ? "Duplicate clip" : "Duplicate clips",
				mode: "overwrite",
			},
			payload
		);
		if (ids) {
			runtime.setTime(at);
		}
	} catch (error) {
		runtime.setStatus(message(error));
	}
}

/* Settings clipboard ------------------------------------------------------ */

export interface SettingsClipboard {
	groups: readonly SettingsGroup[];
	segment: Segment;
}

let settingsClipboard: SettingsClipboard | null = null;
const settingsListeners = new Set<() => void>();

/** Subscribe to settings-clipboard changes (for `useSyncExternalStore`). */
export function subscribeSettingsClipboard(listener: () => void) {
	settingsListeners.add(listener);
	return () => {
		settingsListeners.delete(listener);
	};
}

/** The copied clip settings, if any. */
export function getSettingsClipboard(): SettingsClipboard | null {
	return settingsClipboard;
}

/** Remember `segment`'s settings and which groups paste-settings applies. */
export function copySettingsFrom(
	segment: Segment,
	groups: readonly SettingsGroup[] = SETTINGS_GROUPS
) {
	settingsClipboard = {
		groups: [...groups],
		segment: structuredClone(segment),
	};
	for (const listener of settingsListeners) {
		listener();
	}
}

/** Change the groups the next paste-settings applies. */
export function setSettingsGroups(groups: readonly SettingsGroup[]) {
	if (settingsClipboard) {
		copySettingsFrom(settingsClipboard.segment, groups);
	}
}

/** Forget the copied settings (tests and project switches). */
export function clearSettingsClipboard() {
	settingsClipboard = null;
	for (const listener of settingsListeners) {
		listener();
	}
}

/**
 * Paste copied settings onto the selected clips as one undo step. The source
 * is the settings clipboard, or else the first clip on the clip clipboard.
 */
export function pasteSettingsToSelection(
	runtime: EditorRuntime,
	targets: readonly string[] = selection(runtime).segmentIds
): boolean {
	const { assets, project } = runtime;
	const source =
		settingsClipboard ??
		(() => {
			const first = clipboardPayload(runtime)?.items[0]?.segment;
			return first ? { groups: SETTINGS_GROUPS, segment: first } : null;
		})();
	if (!(project && source)) {
		if (project) {
			runtime.setStatus("Copy a clip or its settings before pasting settings.");
		}
		return false;
	}
	const targetIds = targets.filter((id) => id !== source.segment.id);
	if (!targetIds.length) {
		runtime.setStatus("Select the clips to paste settings onto.");
		return true;
	}
	try {
		runtime.edit(
			pasteSettings(project, assets, source.segment, targetIds, {
				groups: source.groups,
			}),
			"Paste clip settings"
		);
		runtime.setStatus(
			`Pasted ${source.groups.join(", ")} settings onto ${plural(targetIds.length, "clip")}.`
		);
	} catch (error) {
		runtime.setStatus(message(error));
	}
	return true;
}

/** Paste the clipboard at the playhead; declines when the clipboard is empty. */
function pasteFromClipboard(runtime: EditorRuntime, mode: PasteMode): boolean {
	const payload = clipboardPayload(runtime);
	if (!payload) {
		return false;
	}
	pastePayload(runtime, { mode }, payload);
	return true;
}

/** Clipboard handlers: cut, copy, paste, paste insert, paste settings, and duplicate. */
export const clipboardActions: ActionHandlers = {
	"clipboard.copy": (runtime) => copySelection(runtime),
	"clipboard.cut": (runtime) => cutSelection(runtime),
	"clipboard.duplicate": (runtime) => {
		duplicateSelected(runtime);
	},
	"clipboard.paste": (runtime) => pasteFromClipboard(runtime, "overwrite"),
	"clipboard.pasteInsert": (runtime) => pasteFromClipboard(runtime, "insert"),
	"clipboard.pasteSettings": (runtime) => pasteSettingsToSelection(runtime),
};
