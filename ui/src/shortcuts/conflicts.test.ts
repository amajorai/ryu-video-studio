import { describe, expect, mock, test } from "bun:test";

const realAudioPreview = await import("../audio-preview.ts");
mock.module("../audio-preview.ts", () => ({
	...realAudioPreview,
	resumePreviewAudio: () => Promise.resolve(),
}));

const { DEFAULT_BINDINGS } = await import("./defaults.ts");
const {
	clashesForCombo,
	findShortcutConflicts,
	PLATFORM_RESERVED_CHORDS,
	plainEventFor,
	reservedChordFor,
} = await import("./conflicts.ts");
const { applyShortcutOverrides } = await import("./persistence.ts");

type Binding = (typeof DEFAULT_BINDINGS)[number];

const binding = (
	id: string,
	keys: Binding["keys"],
	scope?: Binding["scope"]
): Binding => ({
	action: "tool.pointer",
	id,
	keys,
	source: "legacy",
	...(scope ? { scope } : {}),
});

describe("plain events", () => {
	test("unconstrained modifiers are up and code or key is filled in", () => {
		expect(plainEventFor({ key: "s" })).toEqual({
			altKey: false,
			code: "KeyS",
			ctrlKey: false,
			key: "s",
			metaKey: false,
			shiftKey: false,
		});
		expect(plainEventFor({ alt: true, code: "KeyJ", shift: true })).toEqual({
			altKey: true,
			code: "KeyJ",
			ctrlKey: false,
			key: "j",
			metaKey: false,
			shiftKey: true,
		});
	});
});

describe("findShortcutConflicts", () => {
	test("the default table has no conflicts after the final review", () => {
		expect(findShortcutConflicts(DEFAULT_BINDINGS)).toEqual([]);
	});

	test("an earlier, more specific chord is a refinement, not a conflict", () => {
		const table = [
			binding("ripple", [{ key: "Delete", shift: true }]),
			binding("delete", [{ key: "Delete" }]),
		];
		expect(findShortcutConflicts(table)).toEqual([]);
	});

	test("a later, more specific chord is shadowed by the earlier general one", () => {
		const table = [
			binding("delete", [{ key: "Delete" }]),
			binding("ripple", [{ key: "Delete", shift: true }]),
		];
		expect(findShortcutConflicts(table)).toEqual([
			{
				bindingIds: ["delete", "ripple"],
				combo: { key: "Delete", shift: true },
			},
		]);
	});

	test("preview-scoped bindings never shadow global ones, but global ones shadow preview ones", () => {
		const crop = binding("crop", [{ key: "c" }], "preview");
		const razor = binding("razor", [{ key: "c" }]);
		expect(findShortcutConflicts([crop, razor])).toEqual([]);
		expect(findShortcutConflicts([razor, crop])).toEqual([
			{ bindingIds: ["razor", "crop"], combo: { key: "c" } },
		]);
	});

	test("key chords and code chords for the same character collide", () => {
		const table = [
			binding("by-key", [{ alt: true, key: "j" }]),
			binding("by-code", [{ alt: true, code: "KeyJ" }]),
		];
		expect(findShortcutConflicts(table)).toHaveLength(1);
	});

	test("duplicate chords within one binding are not conflicts", () => {
		expect(
			findShortcutConflicts([binding("one", [{ key: "x" }, { key: "X" }])])
		).toEqual([]);
	});

	test("a viewer rebinding shows up as a conflict", () => {
		const bindings = applyShortcutOverrides({
			"marker-toggle": [{ alt: false, cmd: false, key: "s", shift: false }],
		});
		expect(findShortcutConflicts(bindings)).toContainEqual({
			bindingIds: ["split", "marker-toggle"],
			combo: { alt: false, cmd: false, key: "s", shift: false },
		});
	});
});

describe("clashesForCombo", () => {
	const x = { alt: false, cmd: false, key: "x", shift: false };

	test("an unused chord has no clashes", () => {
		expect(clashesForCombo(DEFAULT_BINDINGS, "split", x)).toEqual([]);
	});

	test("an earlier binding that would take the new chord steals it", () => {
		const clashes = clashesForCombo(DEFAULT_BINDINGS, "marker-toggle", {
			...x,
			key: "s",
		});
		expect(clashes).toEqual([
			{ combo: { cmd: false, key: "s" }, otherId: "split", relation: "steals" },
		]);
	});

	test("a later binding whose plain chord the new one takes is shadowed", () => {
		const clashes = clashesForCombo(DEFAULT_BINDINGS, "split", {
			...x,
			key: "m",
		});
		expect(clashes).toEqual([
			{
				combo: { alt: false, cmd: false, key: "m", shift: false },
				otherId: "marker-toggle",
				relation: "shadows",
			},
		]);
	});

	test("the binding's own chords and unknown ids never clash", () => {
		expect(
			clashesForCombo(DEFAULT_BINDINGS, "split", { cmd: false, key: "s" })
		).toEqual([]);
		expect(clashesForCombo(DEFAULT_BINDINGS, "missing", x)).toEqual([]);
	});
});

describe("platform-wide chords", () => {
	test("no default binding uses a chord Ryu registers system-wide", () => {
		const taken = DEFAULT_BINDINGS.flatMap((item) =>
			item.keys
				.filter((combo) => reservedChordFor(combo))
				.map((combo) => `${item.id}: ${JSON.stringify(combo)}`)
		);
		expect(taken).toEqual([]);
	});

	test("the reserved chords are caught however they are spelled", () => {
		expect(reservedChordFor({ cmd: true, key: "a", shift: true })?.label).toBe(
			"Ryu push-to-talk"
		);
		expect(
			reservedChordFor({ cmd: true, code: "KeyD", shift: true })?.label
		).toBe("Ryu dictation");
		expect(reservedChordFor({ cmd: true, key: " ", shift: true })?.label).toBe(
			"Ryu command bar"
		);
		// Plain Space (play) and Cmd+A (select all) stay reachable.
		expect(reservedChordFor({ key: " " })).toBeUndefined();
		expect(reservedChordFor({ cmd: true, key: "a" })).toBeUndefined();
	});

	test("the list matches the platform's global accelerators when present", async () => {
		const root = new URL("../../../../../", import.meta.url);
		const desktop = Bun.file(
			new URL("apps/desktop/src/lib/hotkeys/actions.ts", root)
		);
		const island = Bun.file(new URL("apps/island/src/shared/voice.ts", root));
		// The satellite mirror ships without the monorepo; the defaults test
		// above still guards the copied list there.
		if (!((await desktop.exists()) && (await island.exists()))) {
			return;
		}
		const accelerators = new Set(
			PLATFORM_RESERVED_CHORDS.map((chord) => chord.accelerator)
		);
		const globals = [
			...(await desktop.text()).matchAll(
				/defaultBinding: "([^"]+)",\s*global: true/g
			),
		].map((match) => match[1]);
		expect(globals.length).toBeGreaterThan(0);
		for (const accelerator of globals) {
			expect(accelerators.has(accelerator ?? "")).toBe(true);
		}
		const voice = /DEFAULT_VOICE_SHORTCUT = "CommandOrControl\+([^"]+)"/.exec(
			await island.text()
		)?.[1];
		expect(accelerators.has(`Mod+${voice}`)).toBe(true);
	});
});
