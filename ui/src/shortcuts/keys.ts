import type { KeyCombo } from "./defaults.ts";

/**
 * Key normalization for recording and labelling shortcuts. Recorded chords
 * use the same `KeyCombo` shape as the default table, so the registry matches
 * them with no special cases: Cmd means Meta or Control on every platform,
 * letters are case-insensitive, and Alt chords record the physical key
 * (`code`) because macOS Option composes characters (`Alt+J` types `∆`).
 */

export type KeyPlatform = "mac" | "other";

interface NavigatorLike {
	platform?: string;
	userAgent?: string;
	userAgentData?: { platform?: string };
}

const APPLE_PLATFORM = /mac|iphone|ipad|ipod/i;

/** Which modifier vocabulary to show (⌘⌥⇧ on Apple devices, Ctrl/Alt/Shift elsewhere). */
export function detectKeyPlatform(
	navigatorLike: NavigatorLike | undefined = globalThis.navigator as
		| NavigatorLike
		| undefined
): KeyPlatform {
	const hint =
		navigatorLike?.userAgentData?.platform ??
		navigatorLike?.platform ??
		navigatorLike?.userAgent ??
		"";
	return APPLE_PLATFORM.test(hint) ? "mac" : "other";
}

/** The parts of a `KeyboardEvent` a recording reads. */
export interface RecordedKeyEvent {
	altKey: boolean;
	code: string;
	ctrlKey: boolean;
	key: string;
	metaKey: boolean;
	shiftKey: boolean;
}

const MODIFIER_KEYS = new Set([
	"Alt",
	"AltGraph",
	"CapsLock",
	"Control",
	"Fn",
	"FnLock",
	"Hyper",
	"Meta",
	"NumLock",
	"OS",
	"ScrollLock",
	"Shift",
	"Super",
	"Symbol",
	"SymbolLock",
]);

/** Legacy `KeyboardEvent.key` names some engines still report. */
const KEY_ALIASES: Record<string, string> = {
	Del: "Delete",
	Down: "ArrowDown",
	Esc: "Escape",
	Left: "ArrowLeft",
	Right: "ArrowRight",
	Spacebar: " ",
	Up: "ArrowUp",
};

const LETTER = /^[a-z]$/i;
const DIGIT = /^\d$/;
const LETTER_CODE = /^Key([A-Z])$/;
const DIGIT_CODE = /^Digit(\d)$/;
/** Keys Alt chords record by position: Option rewrites (or dead-keys) their characters on macOS. */
const PHYSICAL_CODE =
	/^(Key[A-Z]|Digit\d|Backquote|Backslash|BracketLeft|BracketRight|Comma|Equal|Minus|Period|Quote|Semicolon|Slash)$/;

/** `KeyJ` → `j`, `Digit4` → `4`; other codes have no layout-independent character. */
export function characterForCode(code: string | undefined): string | null {
	if (!code) {
		return null;
	}
	const letter = LETTER_CODE.exec(code);
	if (letter?.[1]) {
		return letter[1].toLowerCase();
	}
	return DIGIT_CODE.exec(code)?.[1] ?? null;
}

/** `j` → `KeyJ`, `4` → `Digit4`; other characters return an empty code. */
export function codeForCharacter(key: string): string {
	if (LETTER.test(key)) {
		return `Key${key.toUpperCase()}`;
	}
	return DIGIT.test(key) ? `Digit${key}` : "";
}

export type RecordingOutcome =
	| { combo: KeyCombo; kind: "combo" }
	| { kind: "cancel" }
	| { kind: "ignore" }
	| { kind: "invalid"; reason: string };

/**
 * Turn a keydown captured while recording into a chord. Modifier-only
 * presses are ignored (the viewer is still holding the chord), plain Escape
 * cancels the recording, and Tab stays reserved for keyboard focus.
 */
export function recordKeyEvent(event: RecordedKeyEvent): RecordingOutcome {
	const cmd = event.metaKey || event.ctrlKey;
	if (event.altKey && PHYSICAL_CODE.test(event.code)) {
		// Checked before the dead-key filter: macOS Option+E/U/I/N report
		// `Dead`, but the physical key still identifies the chord.
		return {
			combo: { alt: true, cmd, code: event.code, shift: event.shiftKey },
			kind: "combo",
		};
	}
	const key = KEY_ALIASES[event.key] ?? event.key;
	if (
		!key ||
		MODIFIER_KEYS.has(key) ||
		key === "Dead" ||
		key === "Unidentified" ||
		key === "Process"
	) {
		return { kind: "ignore" };
	}
	if (key === "Escape" && !(cmd || event.altKey || event.shiftKey)) {
		return { kind: "cancel" };
	}
	if (key === "Tab" && !(cmd || event.altKey)) {
		return {
			kind: "invalid",
			reason: "Tab moves keyboard focus and can't be a shortcut.",
		};
	}
	const base = { alt: event.altKey, cmd };
	if (LETTER.test(key)) {
		return {
			combo: { ...base, key: key.toLowerCase(), shift: event.shiftKey },
			kind: "combo",
		};
	}
	if (key.length === 1 && key !== " " && event.shiftKey) {
		// Shift produced this symbol (`?`, `+`, `!`) on the viewer's layout, so
		// the character already encodes it and Shift stays unconstrained.
		return { combo: { ...base, key }, kind: "combo" };
	}
	return { combo: { ...base, key, shift: event.shiftKey }, kind: "combo" };
}

/** The character a chord's key resolves to, for comparing `key` with `code` chords. */
export function comboCharacter(combo: KeyCombo): string {
	if (combo.key !== undefined) {
		return combo.key.length === 1 ? combo.key.toLowerCase() : combo.key;
	}
	return characterForCode(combo.code) ?? combo.code ?? "";
}

/** A stable identity for a chord: equal strings mean the chords match identically. */
export function comboId(combo: KeyCombo): string {
	const flag = (value: boolean | undefined) =>
		value === undefined ? "*" : value ? "1" : "0";
	const keyPart =
		combo.code === undefined ? `key:${comboCharacter(combo)}` : combo.code;
	return `${flag(combo.cmd)}${flag(combo.alt)}${flag(combo.shift)}|${keyPart}`;
}

const NAMED_KEY_LABELS: Record<string, string> = {
	" ": "Space",
	ArrowDown: "↓",
	ArrowLeft: "←",
	ArrowRight: "→",
	ArrowUp: "↑",
	Backquote: "`",
	Backslash: "\\",
	BracketLeft: "[",
	BracketRight: "]",
	Comma: ",",
	Equal: "=",
	Escape: "Esc",
	Minus: "-",
	Period: ".",
	Quote: "'",
	Semicolon: ";",
	Slash: "/",
};

const MODIFIER_LABELS: Record<
	KeyPlatform,
	{ alt: string; cmd: string; join: string; shift: string }
> = {
	mac: { alt: "⌥", cmd: "⌘", join: "", shift: "⇧" },
	other: { alt: "Alt", cmd: "Ctrl", join: "+", shift: "Shift" },
};

/** The key part of a chord as people read it (`S`, `Space`, `←`). */
export function keyLabel(combo: KeyCombo): string {
	const raw = combo.key ?? combo.code ?? "";
	const named = NAMED_KEY_LABELS[raw];
	if (named) {
		return named;
	}
	const character =
		combo.key === undefined ? characterForCode(combo.code) : combo.key;
	if (character && character.length === 1) {
		return character.toUpperCase();
	}
	return raw;
}

/** A chord as the platform writes it: `⌘⇧Z` on macOS, `Ctrl+Shift+Z` elsewhere. */
export function comboLabel(
	combo: KeyCombo,
	platform: KeyPlatform = "other"
): string {
	const labels = MODIFIER_LABELS[platform];
	const parts: string[] = [];
	if (combo.cmd) {
		parts.push(labels.cmd);
	}
	if (combo.alt) {
		parts.push(labels.alt);
	}
	if (combo.shift) {
		parts.push(labels.shift);
	}
	parts.push(keyLabel(combo));
	return parts.join(labels.join);
}
