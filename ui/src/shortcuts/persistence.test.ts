import { describe, expect, mock, test } from "bun:test";

const realAudioPreview = await import("../audio-preview.ts");
mock.module("../audio-preview.ts", () => ({
	...realAudioPreview,
	resumePreviewAudio: () => Promise.resolve(),
}));

const { DEFAULT_BINDINGS } = await import("./defaults.ts");
const {
	applyShortcutOverrides,
	isBindingCustomized,
	loadShortcutBindings,
	narrowedClashCombo,
	readShortcutOverrides,
	SHORTCUT_STORAGE_KEY,
	withBindingKeys,
	withBindingReset,
	withRecordedCombo,
	writeShortcutOverrides,
} = await import("./persistence.ts");
const { createShortcutStore } = await import("./shortcut-state.ts");
const { VIEWER_STORAGE_PREFIX } = await import("../editor/viewer-storage.ts");
const { dispatchShortcut, matchesCombo } = await import("./registry.ts");
const { clashesForCombo, findShortcutConflicts } = await import(
	"./conflicts.ts"
);
const { createTestRuntime, testProject } = await import(
	"../editor/test-runtime.ts"
);

/** An in-memory Storage that survives "reloads" (new stores over the same map). */
function memoryArea() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		removeItem: (key: string) => {
			values.delete(key);
		},
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		values,
	};
}

const throwingArea = {
	getItem: () => {
		throw new Error("SecurityError");
	},
	removeItem: () => {
		throw new Error("SecurityError");
	},
	setItem: () => {
		throw new Error("QuotaExceededError");
	},
};

const x = { alt: false, cmd: false, key: "x", shift: false };
const press = (key: string) => ({
	altKey: false,
	code: `Key${key.toUpperCase()}`,
	ctrlKey: false,
	key,
	metaKey: false,
	preventDefault: () => undefined,
	shiftKey: false,
	target: null,
});

const keysOf = (
	bindings: readonly (typeof DEFAULT_BINDINGS)[number][],
	id: string
) => bindings.find((binding) => binding.id === id)?.keys;

describe("overrides", () => {
	test("no overrides returns the default table itself", () => {
		expect(applyShortcutOverrides({})).toBe(DEFAULT_BINDINGS);
	});

	test("overrides swap chords but keep table order, ids, and actions", () => {
		const bindings = applyShortcutOverrides({ split: [x], unknown: [x] });
		expect(bindings.map((binding) => binding.id)).toEqual(
			DEFAULT_BINDINGS.map((binding) => binding.id)
		);
		expect(keysOf(bindings, "split")).toEqual([x]);
		expect(keysOf(bindings, "duplicate")).toEqual(
			keysOf(DEFAULT_BINDINGS, "duplicate")
		);
	});

	test("setting a binding back to its defaults drops the override", () => {
		const changed = withBindingKeys({}, "split", [x]);
		expect(isBindingCustomized(changed, "split")).toBe(true);
		const restored = withBindingKeys(
			changed,
			"split",
			keysOf(DEFAULT_BINDINGS, "split") ?? []
		);
		expect(restored).toEqual({});
		expect(withBindingReset(changed, "split")).toEqual({});
		expect(withBindingKeys({}, "not-a-binding", [x])).toEqual({});
	});

	test("duplicate chords collapse and an empty list unbinds", () => {
		expect(withBindingKeys({}, "split", [x, { ...x, key: "X" }])).toEqual({
			split: [x],
		});
		expect(withBindingKeys({}, "split", [])).toEqual({ split: [] });
	});

	test("recording replaces or adds, and reassigning removes the chord from the other binding", () => {
		const s = { cmd: false, key: "s" };
		expect(
			withRecordedCombo({}, DEFAULT_BINDINGS, "duplicate", x, "replace")
		).toEqual({ duplicate: [x] });
		expect(
			withRecordedCombo({}, DEFAULT_BINDINGS, "duplicate", x, "add")
		).toEqual({ duplicate: [{ cmd: false, key: "d" }, x] });
		const plainS = { ...x, key: "s" };
		const reassigned = withRecordedCombo(
			{},
			DEFAULT_BINDINGS,
			"marker-toggle",
			plainS,
			"replace",
			[{ combo: s, otherId: "split" }]
		);
		expect(reassigned).toEqual({ "marker-toggle": [plainS], split: [] });
	});

	test("taking Shift+S narrows Split to plain S instead of unbinding it", () => {
		const shiftS = { alt: false, cmd: false, key: "s", shift: true };
		const clashes = clashesForCombo(DEFAULT_BINDINGS, "duplicate", shiftS);
		expect(clashes).toEqual([
			{ combo: { cmd: false, key: "s" }, otherId: "split", relation: "steals" },
		]);
		const next = withRecordedCombo(
			{},
			DEFAULT_BINDINGS,
			"duplicate",
			shiftS,
			"replace",
			clashes
		);
		expect(next).toEqual({
			duplicate: [shiftS],
			split: [{ cmd: false, key: "s", shift: false }],
		});
		const bindings = applyShortcutOverrides(next);
		const press = (shiftKey: boolean) => ({
			altKey: false,
			code: "KeyS",
			ctrlKey: false,
			key: shiftKey ? "S" : "s",
			metaKey: false,
			shiftKey,
		});
		const first = (event: ReturnType<typeof press>) =>
			bindings.find((binding) =>
				binding.keys.some((combo) => matchesCombo(combo, event))
			)?.id;
		expect(first(press(false))).toBe("split");
		expect(first(press(true))).toBe("duplicate");
		expect(findShortcutConflicts(bindings)).toEqual(
			findShortcutConflicts(DEFAULT_BINDINGS)
		);
	});

	test("narrowing only keeps a chord that no longer overlaps the new one", () => {
		const s = { cmd: false, key: "s" };
		expect(
			narrowedClashCombo(s, { alt: true, cmd: false, code: "KeyS" })
		).toEqual({ alt: false, cmd: false, key: "s" });
		expect(
			narrowedClashCombo(s, { alt: false, cmd: false, key: "s", shift: false })
		).toBeNull();
		expect(
			narrowedClashCombo(
				{ cmd: false, key: "d", shift: false },
				{ alt: false, cmd: false, key: "d", shift: false }
			)
		).toBeNull();
	});
});

describe("storage", () => {
	test("overrides round-trip through viewer storage under a namespaced key", () => {
		const area = memoryArea();
		expect(writeShortcutOverrides({ split: [x] }, area)).toBe(true);
		expect([...area.values.keys()]).toEqual([
			`${VIEWER_STORAGE_PREFIX}${SHORTCUT_STORAGE_KEY}`,
		]);
		expect(readShortcutOverrides(area)).toEqual({ split: [x] });
	});

	test("storage that throws falls back to the defaults and reports the failed write", () => {
		expect(readShortcutOverrides(throwingArea)).toEqual({});
		expect(loadShortcutBindings(throwingArea)).toBe(DEFAULT_BINDINGS);
		expect(writeShortcutOverrides({ split: [x] }, throwingArea)).toBe(false);
		expect(readShortcutOverrides(null)).toEqual({});
	});

	test("corrupt, foreign, or out-of-range values fall back to the defaults", () => {
		const area = memoryArea();
		const key = `${VIEWER_STORAGE_PREFIX}${SHORTCUT_STORAGE_KEY}`;
		for (const raw of [
			"{not json",
			JSON.stringify({ bindings: { split: [x] }, version: 2 }),
			JSON.stringify({ bindings: { split: [{ shift: true }] }, version: 1 }),
			JSON.stringify({ bindings: { split: [{ ...x, extra: 1 }] }, version: 1 }),
			JSON.stringify({
				bindings: { split: Array.from({ length: 13 }, () => x) },
				version: 1,
			}),
		]) {
			area.values.set(key, raw);
			expect(readShortcutOverrides(area)).toEqual({});
		}
	});
});

describe("shortcut store", () => {
	test("opens and closes the dialog and notifies subscribers once per change", () => {
		const store = createShortcutStore(memoryArea());
		let calls = 0;
		const unsubscribe = store.subscribe(() => {
			calls += 1;
		});
		store.openDialog();
		store.openDialog();
		expect(store.getState().dialogOpen).toBe(true);
		store.closeDialog();
		store.closeDialog();
		expect(store.getState().dialogOpen).toBe(false);
		expect(calls).toBe(2);
		unsubscribe();
	});

	test("changes still apply for the session when storage throws", () => {
		const store = createShortcutStore(throwingArea);
		expect(store.setOverrides({ split: [x] })).toBe(false);
		expect(store.getState().persisted).toBe(false);
		expect(keysOf(store.getState().bindings, "split")).toEqual([x]);
	});

	test("reload picks up overrides another tab saved", () => {
		const area = memoryArea();
		const store = createShortcutStore(area);
		writeShortcutOverrides({ split: [x] }, area);
		store.reload();
		expect(keysOf(store.getState().bindings, "split")).toEqual([x]);
	});

	test("acceptance: rebinding split to X works after a reload", () => {
		const area = memoryArea();
		const before = createShortcutStore(area);
		before.setOverrides(
			withRecordedCombo(
				before.getState().overrides,
				before.getState().bindings,
				"split",
				x,
				"replace"
			)
		);

		const afterReload = createShortcutStore(area);
		const bindings = afterReload.getState().bindings;
		const { first, project, asset } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		runtime.setSelected(first.id);
		runtime.time = 4;

		expect(dispatchShortcut(press("s"), runtime, bindings)).toBeNull();
		expect(runtime.project?.segments).toHaveLength(2);
		expect(dispatchShortcut(press("x"), runtime, bindings)).toBe(
			"split.selected"
		);
		expect(runtime.project?.segments).toHaveLength(3);
	});
});
