import type { ActionId } from "../../shortcuts/defaults.ts";
import type { EditorRuntime } from "../runtime.ts";

/** The parts of a `KeyboardEvent` the shortcut registry and handlers read. */
export interface ShortcutEventLike {
	altKey: boolean;
	code: string;
	ctrlKey: boolean;
	key: string;
	metaKey: boolean;
	preventDefault: () => void;
	shiftKey: boolean;
	target: EventTarget | null;
}

/**
 * Run an editor action. Returning `false` declines the event, so the registry
 * tries the next matching binding and leaves the browser default alone; any
 * other result (usually none) handles it.
 */
export type ActionHandler = (
	runtime: EditorRuntime,
	event?: ShortcutEventLike
) => unknown;

export type ActionHandlers = Partial<Record<ActionId, ActionHandler>>;
