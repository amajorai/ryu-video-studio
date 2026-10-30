import { describe, expect, test } from "bun:test";
import {
	characterForCode,
	codeForCharacter,
	comboId,
	comboLabel,
	detectKeyPlatform,
	type RecordedKeyEvent,
	recordKeyEvent,
} from "./keys.ts";

function keydown(
	key: string,
	modifiers: Partial<Omit<RecordedKeyEvent, "key">> = {}
): RecordedKeyEvent {
	return {
		altKey: false,
		code: codeForCharacter(key),
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		...modifiers,
		key,
	};
}

describe("platform detection", () => {
	test("Apple devices use the mac vocabulary, everything else the other", () => {
		expect(detectKeyPlatform({ platform: "MacIntel" })).toBe("mac");
		expect(detectKeyPlatform({ userAgentData: { platform: "macOS" } })).toBe(
			"mac"
		);
		expect(
			detectKeyPlatform({ userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0)" })
		).toBe("mac");
		expect(detectKeyPlatform({ platform: "Win32" })).toBe("other");
		expect(detectKeyPlatform({ platform: "Linux x86_64" })).toBe("other");
		expect(detectKeyPlatform({})).toBe("other");
	});
});

describe("recording normalization across mac and windows", () => {
	test("Cmd on mac and Ctrl on windows record the same chord", () => {
		const mac = recordKeyEvent(keydown("k", { metaKey: true }));
		const win = recordKeyEvent(keydown("k", { ctrlKey: true }));
		expect(mac).toEqual(win);
		expect(mac).toEqual({
			combo: { alt: false, cmd: true, key: "k", shift: false },
			kind: "combo",
		});
	});

	test("letters are lowercased whether or not Shift or Caps Lock is on", () => {
		expect(recordKeyEvent(keydown("X", { shiftKey: true }))).toEqual({
			combo: { alt: false, cmd: false, key: "x", shift: true },
			kind: "combo",
		});
		expect(recordKeyEvent(keydown("X"))).toEqual({
			combo: { alt: false, cmd: false, key: "x", shift: false },
			kind: "combo",
		});
	});

	test("Alt chords record the physical key so mac Option characters still match", () => {
		const mac = recordKeyEvent({
			...keydown("∆", { altKey: true }),
			code: "KeyJ",
		});
		const win = recordKeyEvent(keydown("j", { altKey: true }));
		expect(mac).toEqual(win);
		expect(mac).toEqual({
			combo: { alt: true, cmd: false, code: "KeyJ", shift: false },
			kind: "combo",
		});
	});

	test("mac Option dead keys record by physical key instead of being ignored", () => {
		for (const code of ["KeyE", "KeyU", "KeyI", "KeyN"]) {
			expect(
				recordKeyEvent({ ...keydown("Dead", { altKey: true }), code })
			).toEqual({
				combo: { alt: true, cmd: false, code, shift: false },
				kind: "combo",
			});
		}
		const backquote = { alt: true, cmd: false, code: "Backquote", shift: true };
		expect(
			recordKeyEvent({
				...keydown("Dead", { altKey: true, shiftKey: true }),
				code: "Backquote",
			})
		).toEqual({ combo: backquote, kind: "combo" });
		expect(comboLabel(backquote, "mac")).toBe("⌥⇧`");
		// Without Alt a dead key is still a composition in progress.
		expect(recordKeyEvent({ ...keydown("Dead"), code: "KeyE" })).toEqual({
			kind: "ignore",
		});
	});

	test("shifted symbols leave Shift unconstrained; digits and named keys do not", () => {
		expect(
			recordKeyEvent({ ...keydown("?", { shiftKey: true }), code: "Slash" })
		).toEqual({ combo: { alt: false, cmd: false, key: "?" }, kind: "combo" });
		expect(recordKeyEvent(keydown("1"))).toEqual({
			combo: { alt: false, cmd: false, key: "1", shift: false },
			kind: "combo",
		});
		expect(
			recordKeyEvent({
				...keydown("Delete", { shiftKey: true }),
				code: "Delete",
			})
		).toEqual({
			combo: { alt: false, cmd: false, key: "Delete", shift: true },
			kind: "combo",
		});
		expect(recordKeyEvent({ ...keydown(" "), code: "Space" })).toEqual({
			combo: { alt: false, cmd: false, key: " ", shift: false },
			kind: "combo",
		});
	});

	test("legacy key names are normalized", () => {
		expect(recordKeyEvent({ ...keydown("Left"), code: "ArrowLeft" })).toEqual({
			combo: { alt: false, cmd: false, key: "ArrowLeft", shift: false },
			kind: "combo",
		});
		expect(recordKeyEvent({ ...keydown("Esc"), code: "Escape" })).toEqual({
			kind: "cancel",
		});
	});

	test("modifier-only, dead, and composition keys are ignored", () => {
		for (const key of ["Shift", "Control", "Meta", "Alt", "Dead", "Process"]) {
			expect(recordKeyEvent(keydown(key, { shiftKey: true }))).toEqual({
				kind: "ignore",
			});
		}
	});

	test("Escape cancels, Shift+Escape records, Tab is reserved", () => {
		expect(recordKeyEvent(keydown("Escape"))).toEqual({ kind: "cancel" });
		expect(recordKeyEvent(keydown("Escape", { shiftKey: true }))).toEqual({
			combo: { alt: false, cmd: false, key: "Escape", shift: true },
			kind: "combo",
		});
		expect(recordKeyEvent(keydown("Tab")).kind).toBe("invalid");
		expect(recordKeyEvent(keydown("Tab", { ctrlKey: true })).kind).toBe(
			"combo"
		);
	});
});

describe("codes, ids, and labels", () => {
	test("letter and digit codes map to characters both ways", () => {
		expect(characterForCode("KeyJ")).toBe("j");
		expect(characterForCode("Digit7")).toBe("7");
		expect(characterForCode("BracketLeft")).toBeNull();
		expect(characterForCode(undefined)).toBeNull();
		expect(codeForCharacter("q")).toBe("KeyQ");
		expect(codeForCharacter("Q")).toBe("KeyQ");
		expect(codeForCharacter("3")).toBe("Digit3");
		expect(codeForCharacter("?")).toBe("");
	});

	test("comboId separates modifier states and ignores letter case", () => {
		expect(comboId({ key: "S" })).toBe(comboId({ key: "s" }));
		expect(comboId({ key: "s" })).not.toBe(comboId({ key: "s", shift: false }));
		expect(comboId({ cmd: true, key: "z", shift: true })).not.toBe(
			comboId({ cmd: true, key: "z", shift: false })
		);
		expect(comboId({ alt: true, code: "KeyJ" })).not.toBe(
			comboId({ alt: true, key: "j" })
		);
	});

	test("labels follow the platform vocabulary", () => {
		const redo = { cmd: true, key: "z", shift: true };
		expect(comboLabel(redo, "mac")).toBe("⌘⇧Z");
		expect(comboLabel(redo, "other")).toBe("Ctrl+Shift+Z");
		expect(comboLabel({ alt: true, code: "KeyJ" }, "mac")).toBe("⌥J");
		expect(comboLabel({ alt: true, code: "Digit3" }, "other")).toBe("Alt+3");
		expect(comboLabel({ key: " " })).toBe("Space");
		expect(comboLabel({ key: "ArrowLeft", shift: true }, "other")).toBe(
			"Shift+←"
		);
		expect(comboLabel({ key: "Delete" })).toBe("Delete");
		expect(comboLabel({ key: "`" })).toBe("`");
		expect(comboLabel({ key: "?" })).toBe("?");
	});
});
