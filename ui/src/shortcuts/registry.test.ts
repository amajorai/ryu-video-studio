import { beforeEach, describe, expect, mock, test } from "bun:test";

const resumed: string[] = [];
const realAudioPreview = await import("../audio-preview.ts");
mock.module("../audio-preview.ts", () => ({
	...realAudioPreview,
	resumePreviewAudio: () => {
		resumed.push("resume");
		return Promise.resolve();
	},
}));

const { DEFAULT_BINDINGS, ACTIONS } = await import("./defaults.ts");
const {
	ACTION_HANDLERS,
	candidateBindings,
	dispatchShortcut,
	hasActionHandler,
	isEditableTarget,
	matchesCombo,
	mergeActionHandlers,
	runAction,
} = await import("./registry.ts");
const { createTestRuntime, lastStatus, testProject } = await import(
	"../editor/test-runtime.ts"
);
const { applyToolEdit, RAZOR_UNAVAILABLE } = await import(
	"../editor/actions/trim.ts"
);

interface FakeEvent {
	altKey: boolean;
	code: string;
	ctrlKey: boolean;
	defaultPrevented: boolean;
	key: string;
	metaKey: boolean;
	preventDefault: () => void;
	shiftKey: boolean;
	target: EventTarget | null;
}

function press(
	key: string,
	modifiers: {
		alt?: boolean;
		code?: string;
		ctrl?: boolean;
		meta?: boolean;
		shift?: boolean;
		target?: EventTarget | null;
	} = {}
): FakeEvent {
	const letter = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key;
	const event: FakeEvent = {
		altKey: modifiers.alt ?? false,
		code: modifiers.code ?? letter,
		ctrlKey: modifiers.ctrl ?? false,
		defaultPrevented: false,
		key,
		metaKey: modifiers.meta ?? false,
		preventDefault: () => {
			event.defaultPrevented = true;
		},
		shiftKey: modifiers.shift ?? false,
		target: modifiers.target ?? null,
	};
	return event;
}

/** A target whose `closest` matches only `selector`. */
const targetMatching = (selector: string) =>
	({
		closest: (query: string) => (query.includes(selector) ? {} : null),
	}) as unknown as EventTarget;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
	const fixture = testProject();
	const runtime = createTestRuntime(fixture.project, [fixture.asset]);
	return { ...fixture, runtime };
}

beforeEach(() => {
	resumed.length = 0;
});

describe("binding table", () => {
	test("every binding names a declared action; only toolbar/menu actions are unbound", () => {
		const unbound = [
			"audio.detachSelected",
			"export.range",
			"export.video",
			"insert.selectedAtPlayhead",
			"markers.add",
			"preview.toggleGuides",
			"ripple.deleteRange",
			"ripple.toggleMode",
			// Cmd/Ctrl+Shift+A is Ryu's system-wide push-to-talk; the clip menu
			// runs it instead.
			"select.allOnTrack",
		];
		for (const binding of DEFAULT_BINDINGS) {
			expect(ACTIONS[binding.action]).toBeDefined();
			if (binding.keys.length === 0) {
				expect(unbound).toContain(binding.action);
			}
		}
		const ids = DEFAULT_BINDINGS.map((binding) => binding.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("every action has a row, so the shortcuts dialog lists all of them", () => {
		const listed = new Set(DEFAULT_BINDINGS.map((binding) => binding.action));
		for (const id of Object.keys(ACTIONS)) {
			expect({ id, listed: listed.has(id as never) }).toEqual({
				id,
				listed: true,
			});
		}
	});

	test("every binding has a handler; handlers only exist for declared actions", () => {
		for (const binding of DEFAULT_BINDINGS) {
			expect({
				action: binding.action,
				handled: hasActionHandler(binding.action),
			}).toEqual({
				action: binding.action,
				handled: true,
			});
			expect(binding.source).not.toBe("planned");
		}
		for (const id of Object.keys(ACTION_HANDLERS)) {
			expect(id in ACTIONS).toBe(true);
		}
	});

	test("every action is live, including the W5-I2 promotions", () => {
		for (const action of [
			"preview.cropMode",
			"preview.fullscreen",
			"preview.zoomFit",
			"preview.zoom100",
			"workspace.shortcuts",
			"snapping.toggle",
			"ai.askAgent",
		] as const) {
			expect(hasActionHandler(action)).toBe(true);
		}
		for (const id of Object.keys(ACTIONS)) {
			expect({ handled: hasActionHandler(id as never), id }).toEqual({
				handled: true,
				id,
			});
		}
	});

	test("merging two groups that handle the same action is refused", () => {
		const handler = () => undefined;
		expect(() =>
			mergeActionHandlers([
				{ "tool.pointer": handler },
				{ "tool.pointer": handler },
			])
		).toThrow("tool.pointer");
	});

	test("matchesCombo treats undefined modifiers as either state and Cmd as Meta or Control", () => {
		expect(matchesCombo({ key: "s" }, press("S", { shift: true }))).toBe(true);
		expect(
			matchesCombo({ cmd: true, key: "s" }, press("s", { ctrl: true }))
		).toBe(true);
		expect(
			matchesCombo({ cmd: true, key: "s" }, press("s", { meta: true }))
		).toBe(true);
		expect(
			matchesCombo({ cmd: false, key: "s" }, press("s", { meta: true }))
		).toBe(false);
		expect(matchesCombo({ code: "KeyJ" }, press("∆", { code: "KeyJ" }))).toBe(
			true
		);
	});
});

describe("guards", () => {
	test("keys typed into fields or dialogs are ignored", () => {
		const { runtime } = setup();
		for (const selector of ["input", "textarea", "select", "[role=dialog]"]) {
			const event = press("s", { target: targetMatching(selector) });
			expect(isEditableTarget(event.target)).toBe(true);
			expect(dispatchShortcut(event, runtime)).toBeNull();
			expect(event.defaultPrevented).toBe(false);
		}
	});

	test("nothing dispatches without a project or while busy", () => {
		const empty = createTestRuntime(null);
		expect(dispatchShortcut(press("v"), empty)).toBeNull();
		const { runtime } = setup();
		runtime.busy = true;
		const event = press("b");
		expect(dispatchShortcut(event, runtime)).toBeNull();
		expect(event.defaultPrevented).toBe(false);
	});

	test("unbound keys keep their browser default", () => {
		const { runtime } = setup();
		const event = press("j", { meta: true });
		expect(dispatchShortcut(event, runtime)).toBeNull();
		expect(event.defaultPrevented).toBe(false);
	});
});

describe("legacy bindings keep their behaviour", () => {
	test("Cmd+S saves through act", async () => {
		const { runtime } = setup();
		const event = press("s", { meta: true });
		expect(dispatchShortcut(event, runtime)).toBe("project.save");
		expect(event.defaultPrevented).toBe(true);
		await flush();
		expect(runtime.calls).toContainEqual(["save"]);
	});

	test("Cmd+Z undoes and Cmd+Shift+Z redoes", () => {
		const { first, project, runtime } = setup();
		runtime.setSelected(first.id);
		runtime.time = 4;
		expect(dispatchShortcut(press("s"), runtime)).toBe("split.selected");
		expect(runtime.project?.segments).toHaveLength(3);
		expect(dispatchShortcut(press("z", { ctrl: true }), runtime)).toBe(
			"history.undo"
		);
		expect(runtime.project?.segments).toEqual(project.segments);
		expect(
			dispatchShortcut(press("Z", { ctrl: true, shift: true }), runtime)
		).toBe("history.redo");
		expect(runtime.project?.segments).toHaveLength(3);
	});

	test("Space toggles playback, rewinding at the end, but not on a focused button", async () => {
		const { runtime } = setup();
		runtime.time = runtime.duration;
		expect(dispatchShortcut(press(" "), runtime)).toBe("playback.toggle");
		await flush();
		expect(runtime.calls).toContainEqual(["setTime", 0]);
		expect(runtime.calls).toContainEqual(["setPlaying", true]);
		const onButton = press(" ", { target: targetMatching("button") });
		expect(dispatchShortcut(onButton, runtime)).toBeNull();
		expect(onButton.defaultPrevented).toBe(false);
	});

	test("J, K, and L shuttle backwards, pause, and play forwards", async () => {
		const { runtime } = setup();
		expect(dispatchShortcut(press("j"), runtime)).toBe("playback.reverse");
		await flush();
		expect(runtime.calls).toContainEqual(["setPlaybackDirection", -1]);
		expect(runtime.playing).toBe(true);
		expect(dispatchShortcut(press("k"), runtime)).toBe("playback.pause");
		expect(runtime.playing).toBe(false);
		expect(dispatchShortcut(press("L", { shift: true }), runtime)).toBe(
			"playback.forward"
		);
		await flush();
		expect(runtime.calls).toContainEqual(["setPlaybackDirection", 1]);
		expect(resumed).toHaveLength(2);
	});

	test("Home and End stop and jump to either end", () => {
		const { runtime } = setup();
		runtime.time = 3;
		expect(dispatchShortcut(press("End"), runtime)).toBe("navigation.end");
		expect(runtime.time).toBe(runtime.duration);
		expect(runtime.calls).toContainEqual(["setPlaybackDirection", -1]);
		expect(dispatchShortcut(press("Home", { meta: true }), runtime)).toBe(
			"navigation.start"
		);
		expect(runtime.time).toBe(0);
		expect(runtime.playing).toBe(false);
	});

	test("Enter also goes to the start, but never on a focused control or field", () => {
		const { runtime } = setup();
		runtime.time = 4;
		expect(dispatchShortcut(press("Enter"), runtime)).toBe("navigation.start");
		expect(runtime.time).toBe(0);
		for (const selector of ["button", "[role=menuitem]", "a[href]", "input"]) {
			runtime.time = 4;
			const focused = press("Enter", { target: targetMatching(selector) });
			expect(dispatchShortcut(focused, runtime)).toBeNull();
			expect(focused.defaultPrevented).toBe(false);
			expect(runtime.time).toBe(4);
		}
		// Modified Enter is left alone.
		expect(
			dispatchShortcut(press("Enter", { meta: true }), runtime)
		).toBeNull();
		expect(
			DEFAULT_BINDINGS.filter(
				(binding) => binding.action === "navigation.start"
			).map((binding) => binding.id)
		).toEqual(["go-start", "go-start-enter"]);
	});

	test("I and O mark the range around the playhead", () => {
		const { runtime } = setup();
		runtime.time = 2;
		expect(dispatchShortcut(press("i"), runtime)).toBe("navigation.markIn");
		expect(runtime.range).toEqual({ end: 3, start: 2 });
		runtime.time = 6;
		expect(dispatchShortcut(press("O", { shift: true }), runtime)).toBe(
			"navigation.markOut"
		);
		expect(runtime.range).toEqual({ end: 6, start: 2 });
		runtime.time = 1;
		dispatchShortcut(press("o"), runtime);
		expect(runtime.range.end).toBe(6);
		expect(lastStatus(runtime)).toBe(
			"Move the playhead after the range start before marking its end."
		);
	});

	test("[ and ] navigate markers; Alt+[ and Alt+] trim the selected clip to the playhead", () => {
		const { first, runtime } = setup();
		runtime.project = {
			...(runtime.project ?? testProject().project),
			markers: [
				{ color: "#ffffff", id: crypto.randomUUID(), label: "A", time: 2 },
				{ color: "#ffffff", id: crypto.randomUUID(), label: "B", time: 5 },
			],
		};
		runtime.time = 3;
		expect(dispatchShortcut(press("]"), runtime)).toBe("markers.next");
		expect(runtime.time).toBe(5);
		expect(dispatchShortcut(press("["), runtime)).toBe("markers.previous");
		expect(runtime.time).toBe(2);
		runtime.setSelected(first.id);
		runtime.time = 1;
		expect(dispatchShortcut(press("[", { alt: true }), runtime)).toBe(
			"trim.selectedStartToPlayhead"
		);
		const trimmedStart = runtime.project?.segments.find(
			(segment) => segment.id === first.id
		);
		expect(trimmedStart?.start).toBe(1);
		expect(trimmedStart?.sourceIn).toBe(1);
		runtime.time = 8;
		expect(dispatchShortcut(press("]", { alt: true }), runtime)).toBe(
			"trim.selectedEndToPlayhead"
		);
		const trimmedEnd = runtime.project?.segments.find(
			(segment) => segment.id === first.id
		);
		expect(trimmedEnd?.sourceOut).toBe(8);
	});

	test("Cmd/Ctrl+Shift+arrows jump five seconds", () => {
		const { runtime } = setup();
		runtime.time = 6;
		expect(
			dispatchShortcut(press("ArrowLeft", { ctrl: true, shift: true }), runtime)
		).toBe("navigation.jumpBack5");
		expect(runtime.time).toBeCloseTo(1, 6);
		expect(
			dispatchShortcut(
				press("ArrowRight", { ctrl: true, shift: true }),
				runtime
			)
		).toBe("navigation.jumpForward5");
		expect(runtime.time).toBeCloseTo(6, 6);
	});

	test("arrows step a frame, Shift+arrows a second, Alt+arrows nudge the selected clip", () => {
		const { first, runtime } = setup();
		runtime.time = 2;
		expect(dispatchShortcut(press("ArrowRight"), runtime)).toBe(
			"navigation.stepForwardFrame"
		);
		expect(runtime.time).toBeCloseTo(2 + 1 / 30, 6);
		expect(dispatchShortcut(press("ArrowLeft", { shift: true }), runtime)).toBe(
			"navigation.stepBackSecond"
		);
		expect(runtime.time).toBeCloseTo(1 + 1 / 30, 6);
		// Alt+arrow without a selected clip steps the playhead.
		expect(dispatchShortcut(press("ArrowLeft", { alt: true }), runtime)).toBe(
			"navigation.stepBackFrame"
		);
		runtime.setSelected(first.id);
		runtime.project = {
			...(runtime.project ?? testProject().project),
			segments: (runtime.project?.segments ?? []).map((segment) =>
				segment.id === first.id ? { ...segment, start: 1 } : segment
			),
		};
		runtime.refresh();
		expect(dispatchShortcut(press("ArrowRight", { alt: true }), runtime)).toBe(
			"clip.nudgeRight"
		);
		expect(
			runtime.project?.segments.find((segment) => segment.id === first.id)
				?.start
		).toBeCloseTo(1 + 1 / 30, 6);
	});

	test("Delete and Backspace remove the selection; Shift+Delete ripple-deletes", () => {
		const { first, runtime, second } = setup();
		expect(dispatchShortcut(press("Delete"), runtime)).toBeNull();
		runtime.setSelected(first.id);
		expect(dispatchShortcut(press("Backspace"), runtime)).toBe("clip.delete");
		expect(runtime.project?.segments.map((segment) => segment.id)).toEqual([
			second.id,
		]);
		expect(runtime.selectedId).toBeNull();
		runtime.setSelected(second.id);
		expect(dispatchShortcut(press("Delete", { shift: true }), runtime)).toBe(
			"ripple.deleteSelection"
		);
		expect(runtime.project?.segments).toHaveLength(0);
	});

	test("Delete is declined on a locked track", () => {
		const { first, runtime } = setup();
		runtime.project = {
			...(runtime.project ?? testProject().project),
			trackSettings: [
				{ locked: true, muted: false, name: "Track 1", solo: false, track: 0 },
			],
		};
		runtime.setSelected(first.id);
		const event = press("Delete");
		expect(dispatchShortcut(event, runtime)).toBeNull();
		expect(event.defaultPrevented).toBe(false);
		expect(runtime.project?.segments).toHaveLength(2);
	});

	test("S splits and D duplicates the selected clip", () => {
		const { first, runtime } = setup();
		runtime.setSelected(first.id);
		runtime.time = 4;
		expect(dispatchShortcut(press("S", { alt: true }), runtime)).toBe(
			"split.selected"
		);
		expect(runtime.project?.segments).toHaveLength(3);
		runtime.setSelected(runtime.project?.segments[0]?.id ?? null);
		expect(dispatchShortcut(press("d"), runtime)).toBe("clipboard.duplicate");
		expect(runtime.project?.segments).toHaveLength(4);
		expect(runtime.calls.filter(([name]) => name === "edit")).toEqual([
			["edit", "Split clip"],
			["edit", "Duplicate clip"],
		]);
	});

	test("V, B, R, Y, and U pick the timeline tools", () => {
		const { runtime } = setup();
		const expected = {
			b: "ripple",
			r: "roll",
			u: "slide",
			v: "pointer",
			y: "slip",
		} as const;
		for (const [key, tool] of Object.entries(expected)) {
			expect(dispatchShortcut(press(key), runtime)).toBe(`tool.${tool}`);
			expect(runtime.tool).toBe(tool);
		}
		// Modified tool letters are not tool shortcuts.
		expect(dispatchShortcut(press("v", { shift: true }), runtime)).toBeNull();
	});

	test("Alt+J and Alt+L split-edit the nearest cut; Alt+Shift+J opens the planner; Alt+Shift+L is consumed", () => {
		const { runtime } = setup();
		expect(
			dispatchShortcut(press("∆", { alt: true, code: "KeyJ" }), runtime)
		).toBe("splitEdit.jCut");
		expect(lastStatus(runtime)).toBe(
			"No linked audio/video cut on the timeline. Detach or link clip audio first."
		);
		expect(
			dispatchShortcut(press("l", { alt: true, code: "KeyL" }), runtime)
		).toBe("splitEdit.lCut");
		expect(
			dispatchShortcut(
				press("J", { alt: true, code: "KeyJ", shift: true }),
				runtime
			)
		).toBe("splitEdit.openPanel");
		expect(runtime.panel).toBe("split-edits");
		const consumed = press("L", { alt: true, code: "KeyL", shift: true });
		expect(dispatchShortcut(consumed, runtime)).toBe("splitEdit.reserved");
		expect(consumed.defaultPrevented).toBe(true);
		expect(runtime.playing).toBe(false);
	});
});

describe("final shortcut review (W5-I2)", () => {
	test("N toggles snapping and R picks the Roll tool", () => {
		const { runtime } = setup();
		expect(
			candidateBindings(press("n")).map((binding) => binding.action)
		).toEqual(["snapping.toggle"]);
		const before = runtime.store.getState().snapEnabled;
		expect(dispatchShortcut(press("n"), runtime)).toBe("snapping.toggle");
		expect(runtime.store.getState().snapEnabled).toBe(!before);
		expect(dispatchShortcut(press("r"), runtime)).toBe("tool.roll");
		expect(runtime.tool).toBe("roll");
	});

	test("J/K/L shuttle and the Alt split-edit keys keep their chords", () => {
		const actionFor = (key: string, modifiers = {}) =>
			candidateBindings(press(key, modifiers))[0]?.action;
		expect(actionFor("j")).toBe("playback.reverse");
		expect(actionFor("k")).toBe("playback.pause");
		expect(actionFor("l")).toBe("playback.forward");
		expect(actionFor("j", { alt: true, code: "KeyJ" })).toBe("splitEdit.jCut");
		expect(actionFor("l", { alt: true, code: "KeyL" })).toBe("splitEdit.lCut");
		expect(actionFor("J", { alt: true, code: "KeyJ", shift: true })).toBe(
			"splitEdit.openPanel"
		);
		expect(actionFor("k", { meta: true })).toBe("split.atPlayhead");
		expect(actionFor("l", { meta: true })).toBe("playback.toggleLoop");
	});

	test("C is crop mode inside the focused preview and the razor elsewhere", () => {
		const { runtime } = setup();
		const inPreview = press("c", {
			target: targetMatching('[data-shortcut-scope="preview"]'),
		});
		expect(candidateBindings(inPreview)[0]?.action).toBe("preview.cropMode");
		expect(dispatchShortcut(press("c"), runtime)).toBe("tool.razor");
	});

	test("C selects the razor outside the preview", () => {
		const { runtime } = setup();
		expect(hasActionHandler("tool.razor")).toBe(true);
		expect(dispatchShortcut(press("c"), runtime)).toBe("tool.razor");
		expect(runtime.tool).toBe("razor");
	});

	test("a razor drag reports that the tool is unavailable instead of failing silently", () => {
		const { first, runtime } = setup();
		runtime.setTool("razor");
		const before = runtime.project;
		applyToolEdit(runtime, first, "move", 1);
		expect(runtime.project).toBe(before);
		expect(lastStatus(runtime)).toBe(RAZOR_UNAVAILABLE);
	});

	test("C is crop mode inside the focused preview once implemented, the razor elsewhere", () => {
		const { runtime } = setup();
		const handlers = {
			...ACTION_HANDLERS,
			"preview.cropMode": () => undefined,
			"tool.razor": () => undefined,
		};
		const inPreview = press("c", {
			target: targetMatching('[data-shortcut-scope="preview"]'),
		});
		expect(
			dispatchShortcut(inPreview, runtime, DEFAULT_BINDINGS, handlers)
		).toBe("preview.cropMode");
		expect(
			dispatchShortcut(press("c"), runtime, DEFAULT_BINDINGS, handlers)
		).toBe("tool.razor");
	});

	test("a planned binding fires once a handler exists", () => {
		const { runtime } = setup();
		const fired: string[] = [];
		const handlers = {
			...ACTION_HANDLERS,
			"ripple.deleteSelection": () => {
				fired.push("ripple");
			},
		};
		expect(
			dispatchShortcut(
				press("Delete", { shift: true }),
				runtime,
				DEFAULT_BINDINGS,
				handlers
			)
		).toBe("ripple.deleteSelection");
		expect(fired).toEqual(["ripple"]);
	});

	test("runAction runs implemented actions and reports missing ones", () => {
		const { runtime } = setup();
		expect(runAction("tool.slip", runtime)).toBe(true);
		expect(runtime.tool).toBe("slip");
		expect(runAction("preview.zoom100", runtime)).toBe(true);
		expect(runtime.store.getState().previewZoom).toBe(1);
		expect(runAction("tool.slip", runtime, {})).toBe(false);
	});
});
