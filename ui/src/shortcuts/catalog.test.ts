import { describe, expect, test } from "bun:test";
import { bindingLabel, CATEGORY_ORDER, groupShortcuts } from "./catalog.ts";
import { ACTIONS, DEFAULT_BINDINGS } from "./defaults.ts";

describe("groupShortcuts", () => {
	test("every action category has a place in the display order", () => {
		const categories = new Set(
			Object.values(ACTIONS).map((meta) => meta.category)
		);
		for (const category of categories) {
			expect(CATEGORY_ORDER).toContain(category);
		}
	});

	test("groups follow the category order and keep table order inside a group", () => {
		const groups = groupShortcuts(DEFAULT_BINDINGS);
		const order = groups.map((group) => CATEGORY_ORDER.indexOf(group.category));
		expect(order).toEqual([...order].sort((a, b) => a - b));
		const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
		expect(total).toBe(DEFAULT_BINDINGS.length);
	});

	test("search matches labels, categories, and chords in either vocabulary", () => {
		const labels = (query: string) =>
			groupShortcuts(DEFAULT_BINDINGS, { platform: "mac", query }).flatMap(
				(group) => group.rows.map((row) => row.binding.id)
			);
		expect(labels("split selected")).toEqual(["split"]);
		expect(labels("ctrl+shift+z")).toEqual(["redo"]);
		expect(labels("⌘⇧Z")).toEqual(["redo"]);
		expect(labels("markers")).toContain("marker-toggle");
		expect(labels("no such action")).toEqual([]);
	});

	test("availability and unbound filters drop rows", () => {
		const groups = groupShortcuts(
			DEFAULT_BINDINGS.map((binding) =>
				binding.id === "split" ? { ...binding, keys: [] } : binding
			),
			{
				isAvailable: (action) => action.startsWith("split"),
				skipUnbound: true,
			}
		);
		const ids = groups.flatMap((group) =>
			group.rows.map((row) => row.binding.id)
		);
		expect(ids).not.toContain("split");
		expect(ids).toContain("split-at-playhead");
		const actions = groups.flatMap((group) =>
			group.rows.map((row) => row.binding.action)
		);
		expect(actions.every((action) => action.startsWith("split"))).toBe(true);
	});

	test("binding labels come from the action table", () => {
		expect(bindingLabel(DEFAULT_BINDINGS, "split")).toBe("Split selected clip");
		expect(bindingLabel(DEFAULT_BINDINGS, "gone")).toBe("gone");
	});
});
