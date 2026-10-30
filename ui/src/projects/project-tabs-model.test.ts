import { describe, expect, test } from "bun:test";
import type { ViewerStorageArea } from "../editor/viewer-storage.ts";
import {
	closeProjectTab,
	forgetProjectTabs,
	MAX_PROJECT_TABS,
	openProjectTab,
	projectTabsSnapshot,
	pruneProjectTabs,
	readProjectTabs,
	reloadProjectTabs,
	subscribeProjectTabs,
	tabAfterClose,
	updateProjectTabs,
	writeProjectTabs,
} from "./project-tabs-model.ts";

function memoryArea(): ViewerStorageArea & { values: Map<string, string> } {
	const values = new Map<string, string>();
	return {
		getItem: (key) => values.get(key) ?? null,
		removeItem: (key) => {
			values.delete(key);
		},
		setItem: (key, value) => {
			values.set(key, value);
		},
		values,
	};
}

const throwing: ViewerStorageArea = {
	getItem: () => {
		throw new Error("blocked");
	},
	removeItem: () => {
		throw new Error("blocked");
	},
	setItem: () => {
		throw new Error("blocked");
	},
};

describe("openProjectTab", () => {
	test("adds a new tab at the front and keeps existing tabs in place", () => {
		expect(openProjectTab([], "a")).toEqual(["a"]);
		expect(openProjectTab(["a", "b"], "c")).toEqual(["c", "a", "b"]);
		expect(openProjectTab(["a", "b", "c"], "b")).toEqual(["a", "b", "c"]);
	});

	test("caps the strip, dropping the least recent tab", () => {
		const full = Array.from({ length: MAX_PROJECT_TABS }, (_, i) => `p${i}`);
		const next = openProjectTab(full, "new");
		expect(next).toHaveLength(MAX_PROJECT_TABS);
		expect(next[0]).toBe("new");
		expect(next).not.toContain(`p${MAX_PROJECT_TABS - 1}`);
		expect(openProjectTab(["a", "b"], "c", 2)).toEqual(["c", "a"]);
	});

	test("does not mutate the input", () => {
		const tabs = ["a"];
		openProjectTab(tabs, "b");
		expect(tabs).toEqual(["a"]);
	});
});

describe("closing and pruning", () => {
	test("closeProjectTab removes only that tab", () => {
		expect(closeProjectTab(["a", "b", "c"], "b")).toEqual(["a", "c"]);
		expect(closeProjectTab(["a"], "z")).toEqual(["a"]);
	});

	test("pruneProjectTabs drops deleted projects and duplicates", () => {
		expect(pruneProjectTabs(["a", "b", "a", "c"], ["a", "c"])).toEqual([
			"a",
			"c",
		]);
	});

	test("tabAfterClose picks the right neighbour, then the left", () => {
		expect(tabAfterClose(["a", "b", "c"], "b", "b")).toBe("c");
		expect(tabAfterClose(["a", "b", "c"], "c", "c")).toBe("b");
		expect(tabAfterClose(["a"], "a", "a")).toBeNull();
		expect(tabAfterClose(["a", "b"], "a", "b")).toBe("b");
		expect(tabAfterClose(["a"], "z", "z")).toBe("z");
	});
});

describe("persistence", () => {
	test("round-trips through viewer storage", () => {
		const area = memoryArea();
		expect(readProjectTabs(area)).toEqual([]);
		expect(writeProjectTabs(["a", "b"], area)).toBe(true);
		expect(readProjectTabs(area)).toEqual(["a", "b"]);
		expect([...area.values.keys()]).toEqual(["ryu.video-studio.project-tabs"]);
	});

	test("falls back to an empty strip when storage throws or is corrupt", () => {
		expect(readProjectTabs(throwing)).toEqual([]);
		expect(writeProjectTabs(["a"], throwing)).toBe(false);
		const area = memoryArea();
		area.values.set("ryu.video-studio.project-tabs", "{not json");
		expect(readProjectTabs(area)).toEqual([]);
		area.values.set("ryu.video-studio.project-tabs", JSON.stringify([1, 2]));
		expect(readProjectTabs(area)).toEqual([]);
		expect(readProjectTabs(null)).toEqual([]);
	});
});

describe("pruning while opening", () => {
	test("dead ids never push out a live tab", () => {
		const dead = ["d1", "d2", "d3"];
		const live = ["a", "b", "c", "e", "f"];
		const tabs = [...dead.slice(0, 2), ...live, dead[2] ?? ""];
		expect(tabs).toHaveLength(MAX_PROJECT_TABS);
		const next = openProjectTab(tabs, "g", MAX_PROJECT_TABS, [...live, "g"]);
		expect(next).toEqual(["g", ...live]);
	});

	test("keeps the opened id even when the list does not include it yet", () => {
		expect(openProjectTab(["x", "a"], "new", MAX_PROJECT_TABS, ["a"])).toEqual([
			"new",
			"a",
		]);
		expect(openProjectTab(["a", "x"], "a", MAX_PROJECT_TABS, ["a"])).toEqual([
			"a",
		]);
	});

	test("forgetProjectTabs removes every deleted id", () => {
		expect(forgetProjectTabs(["a", "b", "c"], new Set(["a", "c"]))).toEqual([
			"b",
		]);
	});
});

describe("shared tab store", () => {
	test("updates notify subscribers once per change", () => {
		reloadProjectTabs();
		updateProjectTabs(() => []);
		let notified = 0;
		const unsubscribe = subscribeProjectTabs(() => {
			notified += 1;
		});
		updateProjectTabs((tabs) => openProjectTab(tabs, "a"));
		const first = projectTabsSnapshot();
		updateProjectTabs((tabs) => openProjectTab(tabs, "a"));
		expect(projectTabsSnapshot()).toBe(first);
		expect(first).toEqual(["a"]);
		expect(notified).toBe(1);
		unsubscribe();
		updateProjectTabs(() => []);
	});
});
