import { aiActions } from "../editor/actions/ai.ts";
import { audioDetachActions } from "../editor/actions/audio-detach.ts";
import { clipboardActions } from "../editor/actions/clipboard.ts";
import { exportActions } from "../editor/actions/export.ts";
import { historyActions } from "../editor/actions/history.ts";
import { markerActions } from "../editor/actions/markers.ts";
import { multicamActions } from "../editor/actions/multicam.ts";
import { navigationActions } from "../editor/actions/navigation.ts";
import { nestActions } from "../editor/actions/nest.ts";
import { placementActions } from "../editor/actions/placement.ts";
import { playbackActions } from "../editor/actions/playback.ts";
import { previewActions } from "../editor/actions/preview.ts";
import { rippleActions } from "../editor/actions/ripple.ts";
import { selectActions } from "../editor/actions/select.ts";
import { snappingActions } from "../editor/actions/snapping.ts";
import { splitActions } from "../editor/actions/split.ts";
import { trackActions } from "../editor/actions/tracks.ts";
import { trimActions } from "../editor/actions/trim.ts";
import type {
	ActionHandlers,
	ShortcutEventLike,
} from "../editor/actions/types.ts";
import { workspaceActions } from "../editor/actions/workspace.ts";
import { zoomActions } from "../editor/actions/zoom.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { directManipulationActions } from "../preview/overlays/direct-manipulation.ts";
import {
	type ActionId,
	DEFAULT_BINDINGS,
	type KeyCombo,
	type ShortcutBinding,
} from "./defaults.ts";

const handlerGroups: readonly ActionHandlers[] = [
	aiActions,
	audioDetachActions,
	clipboardActions,
	directManipulationActions,
	exportActions,
	historyActions,
	markerActions,
	multicamActions,
	navigationActions,
	nestActions,
	placementActions,
	playbackActions,
	previewActions,
	rippleActions,
	selectActions,
	snappingActions,
	splitActions,
	trackActions,
	trimActions,
	workspaceActions,
	zoomActions,
];

/** Merge handler groups; an action handled by two groups is a programming error. */
export function mergeActionHandlers(
	groups: readonly ActionHandlers[]
): ActionHandlers {
	const merged: ActionHandlers = {};
	for (const group of groups) {
		for (const [id, handler] of Object.entries(group) as [
			ActionId,
			ActionHandlers[ActionId],
		][]) {
			if (merged[id]) {
				throw new Error(`Editor action ${id} has two handlers.`);
			}
			merged[id] = handler;
		}
	}
	return merged;
}

/** Every implemented editor action, keyed by action id. */
export const ACTION_HANDLERS: ActionHandlers =
	mergeActionHandlers(handlerGroups);

/** Whether an action has an implementation (menus disable the rest). */
export function hasActionHandler(
	id: ActionId,
	handlers: ActionHandlers = ACTION_HANDLERS
): boolean {
	return Boolean(handlers[id]);
}

/** Run an action from a button or menu; returns false when it is unavailable or declined. */
export function runAction(
	id: ActionId,
	runtime: EditorRuntime,
	handlers: ActionHandlers = ACTION_HANDLERS
): boolean {
	const handler = handlers[id];
	return handler ? handler(runtime) !== false : false;
}

interface ClosestTarget {
	closest: (selector: string) => unknown;
}

const hasClosest = (
	target: EventTarget | null
): target is EventTarget & ClosestTarget =>
	typeof (target as Partial<ClosestTarget> | null)?.closest === "function";

/** Text entry and dialogs keep their own keys; the editor never intercepts them. */
export const EDITABLE_SELECTOR =
	"input,textarea,select,[contenteditable=true],[role=dialog]";

export function isEditableTarget(target: EventTarget | null): boolean {
	return hasClosest(target) && Boolean(target.closest(EDITABLE_SELECTOR));
}

/**
 * Focused controls that act on Enter or Space themselves. Bindings with
 * `skipInteractiveTargets` leave their keys to these.
 */
export const INTERACTIVE_SELECTOR = [
	"a[href]",
	"button",
	"summary",
	...[
		"button",
		"checkbox",
		"combobox",
		"gridcell",
		"link",
		"listbox",
		"menu",
		"menuitem",
		"menuitemcheckbox",
		"menuitemradio",
		"option",
		"radio",
		"slider",
		"switch",
		"tab",
		"treeitem",
	].map((role) => `[role=${role}]`),
].join(",");

export function isInteractiveTarget(target: EventTarget | null): boolean {
	return hasClosest(target) && Boolean(target.closest(INTERACTIVE_SELECTOR));
}

/** Focus inside an element with this attribute value enables `preview` bindings. */
export const PREVIEW_SCOPE_SELECTOR = '[data-shortcut-scope="preview"]';

const modifierMatches = (wanted: boolean | undefined, actual: boolean) =>
	wanted === undefined || wanted === actual;

/** Whether `event` is the chord `combo` (see `KeyCombo` for the rules). */
export function matchesCombo(
	combo: KeyCombo,
	event: Pick<
		ShortcutEventLike,
		"altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
	>
): boolean {
	if (combo.code !== undefined && combo.code !== event.code) {
		return false;
	}
	if (
		combo.key !== undefined &&
		combo.key.toLowerCase() !== event.key.toLowerCase()
	) {
		return false;
	}
	return (
		modifierMatches(combo.cmd, event.metaKey || event.ctrlKey) &&
		modifierMatches(combo.alt, event.altKey) &&
		modifierMatches(combo.shift, event.shiftKey)
	);
}

function scopeMatches(binding: ShortcutBinding, target: EventTarget | null) {
	if (binding.skipInteractiveTargets && isInteractiveTarget(target)) {
		return false;
	}
	if ((binding.scope ?? "global") === "global") {
		return true;
	}
	return hasClosest(target) && Boolean(target.closest(PREVIEW_SCOPE_SELECTOR));
}

/** The bindings matching `event`, in priority order, whose actions are implemented. */
export function candidateBindings(
	event: ShortcutEventLike,
	bindings: readonly ShortcutBinding[] = DEFAULT_BINDINGS,
	handlers: ActionHandlers = ACTION_HANDLERS
): ShortcutBinding[] {
	return bindings.filter(
		(binding) =>
			handlers[binding.action] !== undefined &&
			scopeMatches(binding, event.target) &&
			binding.keys.some((combo) => matchesCombo(combo, event))
	);
}

/**
 * Route a window keydown to the first matching implemented action. Keys
 * typed into fields or dialogs, and every key while no project is open or
 * the editor is busy, are left alone. Returns the action that handled the
 * event (its default is prevented), or null.
 */
export function dispatchShortcut(
	event: ShortcutEventLike,
	runtime: EditorRuntime,
	bindings: readonly ShortcutBinding[] = DEFAULT_BINDINGS,
	handlers: ActionHandlers = ACTION_HANDLERS
): ActionId | null {
	if (isEditableTarget(event.target) || !runtime.project || runtime.busy) {
		return null;
	}
	for (const binding of candidateBindings(event, bindings, handlers)) {
		const handler = handlers[binding.action];
		if (handler && handler(runtime, event) !== false) {
			event.preventDefault();
			return binding.action;
		}
	}
	return null;
}
