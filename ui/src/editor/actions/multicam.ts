import {
	multicamGroupAt,
	multicamShortcutEntry,
} from "../../../../shared/multicam.ts";
import type { EditorRuntime } from "../runtime.ts";
import type { ActionHandlers, ShortcutEventLike } from "./types.ts";

/** The 1-9 digit a shortcut event carries (by physical key first, so Alt+digit works on macOS). */
export function shortcutDigit(event?: ShortcutEventLike): number | null {
	const code = event?.code.match(/^(?:Digit|Numpad)([1-9])$/)?.[1];
	const key = event?.key.match(/^[1-9]$/)?.[0];
	const digit = Number(code ?? key);
	return Number.isInteger(digit) && digit >= 1 && digit <= 9 ? digit : null;
}

/**
 * Switch the multicam program at the playhead to the n-th angle (`1-9`) or
 * mic (`Alt+1-9`) until the end of the current switch. Declines the key
 * outside a multicam group or when the digit names no member.
 */
export function switchMulticamAt(
	runtime: EditorRuntime,
	kind: "angle" | "mic",
	digit: number
): boolean {
	const project = runtime.project;
	const group = project ? multicamGroupAt(project, runtime.time) : undefined;
	if (!group) {
		return false;
	}
	const members = group.members.filter((member) =>
		kind === "angle" ? member.kind !== "mic" : member.kind !== "angle"
	);
	const member = members[digit - 1];
	if (!member) {
		return false;
	}
	const entry = multicamShortcutEntry(group, runtime.time, kind, digit - 1);
	if (!entry) {
		runtime.setStatus(
			`${member.label} is already the program ${kind === "angle" ? "angle" : "mic"} here.`
		);
		return true;
	}
	void runtime.routeEdit(
		"multicam",
		{ action: "change", entries: [entry], groupId: group.id },
		() =>
			`${kind === "angle" ? "Cut to" : "Program audio from"} ${member.label} at ${entry.start.toFixed(2)}s.`
	);
	return true;
}

function switchFromKey(kind: "angle" | "mic") {
	return (runtime: EditorRuntime, event?: ShortcutEventLike) => {
		const digit = shortcutDigit(event);
		return digit === null ? false : switchMulticamAt(runtime, kind, digit);
	};
}

/** Multicam angle (1-9) and mic (Alt+1-9) switch handlers. */
export const multicamActions: ActionHandlers = {
	"multicam.switchAngle": switchFromKey("angle"),
	"multicam.switchMic": switchFromKey("mic"),
};
