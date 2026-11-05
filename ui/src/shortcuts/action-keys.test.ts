import { describe, expect, test } from "bun:test";
import { actionKeyHint, withKeyHint } from "./action-keys.ts";
import { DEFAULT_BINDINGS } from "./defaults.ts";
import { applyShortcutOverrides } from "./persistence.ts";

describe("action key hints", () => {
	test("toolbar buttons describe the platform's default keys", () => {
		const split = actionKeyHint(
			DEFAULT_BINDINGS,
			["split.selected", "split.atPlayhead"],
			"other"
		);
		expect(split.aria?.split(" ").sort()).toEqual(["Control+K", "S"]);
		expect(withKeyHint("Split", split)).toContain("S");
		expect(actionKeyHint(DEFAULT_BINDINGS, "project.save", "mac").aria).toBe(
			"Meta+S"
		);
		expect(actionKeyHint(DEFAULT_BINDINGS, "project.save", "other").aria).toBe(
			"Control+S"
		);
	});

	test("a rebind changes the hint, and an unbound action has none", () => {
		const rebound = applyShortcutOverrides({
			"ask-agent": [{ alt: false, cmd: true, key: "j", shift: true }],
		});
		const hint = actionKeyHint(rebound, "ai.askAgent", "other");
		expect(hint.aria).toBe("Control+Shift+J");
		expect(withKeyHint("Ask agent", hint)).toBe("Ask agent (Ctrl+Shift+J)");
		const unbound = applyShortcutOverrides({ "ask-agent": [] });
		expect(actionKeyHint(unbound, "ai.askAgent", "other")).toEqual({});
		expect(withKeyHint("Ask agent", {})).toBe("Ask agent");
	});
});
