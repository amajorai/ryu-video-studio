/**
 * The Video Studio keyboard map. Every binding points to an action id; a
 * binding only fires once its action has a handler in `editor/actions/*`.
 * Every action has a row (actions without a default key get an empty one),
 * so the shortcuts dialog lists every action and each can be given a key.
 *
 * Bindings are matched in table order and the first one whose action handles
 * the event wins. Legacy bindings keep their exact modifier semantics (for
 * example `S` splits with or without Shift/Alt), so more specific bindings
 * sit before the legacy one they would otherwise shadow.
 */

/**
 * One key chord. `key` compares case-insensitively with `KeyboardEvent.key`;
 * `code` compares with `KeyboardEvent.code` (layout-independent). A modifier
 * left undefined matches either state. `cmd` is Meta or Control.
 */
export interface KeyCombo {
	alt?: boolean;
	cmd?: boolean;
	code?: string;
	key?: string;
	shift?: boolean;
}

/** `preview` bindings only fire while focus is inside the preview. */
export type ShortcutScope = "global" | "preview";

export type ActionCategory =
	| "AI"
	| "Clipboard"
	| "Edit"
	| "History"
	| "Markers"
	| "Multicam"
	| "Navigation"
	| "Playback"
	| "Preview"
	| "Project"
	| "Selection"
	| "Tools"
	| "Tracks"
	| "View";

export interface ActionMeta {
	category: ActionCategory;
	label: string;
	/** Rendered as a timeline toolbar button by the workspace (W5). */
	toolbar?: true;
}

export const ACTIONS = {
	"ai.askAgent": {
		category: "AI",
		label: "Ask agent about selection or range",
	},
	"audio.detachSelected": { category: "Edit", label: "Detach clip audio" },
	"clip.delete": { category: "Edit", label: "Delete selected clips" },
	"clip.nudgeLeft": { category: "Edit", label: "Move clip one frame left" },
	"clip.nudgeRight": { category: "Edit", label: "Move clip one frame right" },
	"clipboard.copy": { category: "Clipboard", label: "Copy" },
	"clipboard.cut": { category: "Clipboard", label: "Cut" },
	"clipboard.duplicate": { category: "Clipboard", label: "Duplicate clip" },
	"clipboard.paste": { category: "Clipboard", label: "Paste" },
	"clipboard.pasteInsert": { category: "Clipboard", label: "Paste insert" },
	"clipboard.pasteSettings": {
		category: "Clipboard",
		label: "Paste clip settings",
	},
	"export.range": {
		category: "Project",
		label: "Export range",
		toolbar: true,
	},
	"export.video": { category: "Project", label: "Export video" },
	"history.redo": { category: "History", label: "Redo" },
	"history.redoAlt": { category: "History", label: "Redo (alternate)" },
	"history.undo": { category: "History", label: "Undo" },
	"insert.selectedAtPlayhead": {
		category: "Edit",
		label: "Insert selected clip at playhead",
	},
	"markers.add": { category: "Markers", label: "Add marker" },
	"markers.fromRange": { category: "Markers", label: "Marker from range" },
	"markers.next": { category: "Markers", label: "Next marker" },
	"markers.previous": { category: "Markers", label: "Previous marker" },
	"markers.toggle": { category: "Markers", label: "Toggle marker" },
	"multicam.switchAngle": {
		category: "Multicam",
		label: "Switch multicam angle",
	},
	"multicam.switchMic": { category: "Multicam", label: "Switch multicam mic" },
	"navigation.end": { category: "Navigation", label: "Go to end" },
	"navigation.markIn": { category: "Navigation", label: "Mark range in" },
	"navigation.clearRange": { category: "Navigation", label: "Clear range" },
	"navigation.jumpBack5": {
		category: "Navigation",
		label: "Jump back 5 seconds",
	},
	"navigation.jumpForward5": {
		category: "Navigation",
		label: "Jump forward 5 seconds",
	},
	"navigation.markOut": { category: "Navigation", label: "Mark range out" },
	"navigation.nextEdit": { category: "Navigation", label: "Next edit point" },
	"navigation.nextMarker": { category: "Navigation", label: "Next marker" },
	"navigation.previousEdit": {
		category: "Navigation",
		label: "Previous edit point",
	},
	"navigation.previousMarker": {
		category: "Navigation",
		label: "Previous marker",
	},
	"navigation.start": { category: "Navigation", label: "Go to start" },
	"navigation.stepBackFrame": {
		category: "Navigation",
		label: "Step back one frame",
	},
	"navigation.stepBackSecond": {
		category: "Navigation",
		label: "Step back one second",
	},
	"navigation.stepForwardFrame": {
		category: "Navigation",
		label: "Step forward one frame",
	},
	"navigation.stepForwardSecond": {
		category: "Navigation",
		label: "Step forward one second",
	},
	"nest.decompose": { category: "Edit", label: "Decompose nested sequence" },
	"nest.nest": { category: "Edit", label: "Nest selection" },
	"playback.forward": { category: "Playback", label: "Play forward" },
	"playback.pause": { category: "Playback", label: "Pause" },
	"playback.playAround": { category: "Playback", label: "Play around" },
	"playback.reverse": { category: "Playback", label: "Play reverse" },
	"playback.toggle": { category: "Playback", label: "Play or pause" },
	"playback.toggleLoop": {
		category: "Playback",
		label: "Loop playback",
		toolbar: true,
	},
	"preview.cropMode": { category: "Preview", label: "Crop mode" },
	"preview.fullscreen": { category: "Preview", label: "Fullscreen preview" },
	"preview.toggleGuides": {
		category: "Preview",
		label: "Preview guides",
		toolbar: true,
	},
	"preview.zoom100": { category: "Preview", label: "Preview at 100%" },
	"preview.zoomFit": { category: "Preview", label: "Fit preview" },
	"project.save": { category: "Project", label: "Save project" },
	"ripple.deleteRange": { category: "Edit", label: "Ripple delete range" },
	"ripple.deleteSelection": { category: "Edit", label: "Ripple delete" },
	"ripple.toggleMode": {
		category: "Edit",
		label: "Ripple mode",
		toolbar: true,
	},
	"select.all": { category: "Selection", label: "Select all" },
	"select.allOnTrack": {
		category: "Selection",
		label: "Select all on track",
	},
	"select.cancel": {
		category: "Selection",
		label: "Cancel drag or clear selection",
	},
	"select.forwardAllTracks": {
		category: "Selection",
		label: "Select forward on all tracks",
	},
	"select.forwardOnTrack": {
		category: "Selection",
		label: "Select forward on track",
	},
	"snapping.toggle": { category: "Tools", label: "Snapping", toolbar: true },
	"split.atPlayhead": {
		category: "Edit",
		label: "Split at playhead",
		toolbar: true,
	},
	"split.selected": { category: "Edit", label: "Split selected clip" },
	"splitEdit.jCut": { category: "Edit", label: "J-cut nearest cut" },
	"splitEdit.lCut": { category: "Edit", label: "L-cut nearest cut" },
	"splitEdit.openPanel": { category: "Edit", label: "Auto J/L cuts" },
	"splitEdit.reserved": {
		category: "Edit",
		label: "Reserved (Alt+Shift+L)",
	},
	"tool.pointer": { category: "Tools", label: "Pointer tool" },
	"tool.razor": { category: "Tools", label: "Razor tool", toolbar: true },
	"tool.ripple": { category: "Tools", label: "Ripple tool" },
	"tool.roll": { category: "Tools", label: "Roll tool" },
	"tool.slide": { category: "Tools", label: "Slide tool" },
	"tool.slip": { category: "Tools", label: "Slip tool" },
	"tracks.toggleClipHidden": { category: "Tracks", label: "Hide clip" },
	"tracks.toggleClipMute": { category: "Tracks", label: "Mute clip" },
	"trim.endToPlayhead": {
		category: "Edit",
		label: "Ripple trim end to playhead",
		toolbar: true,
	},
	"trim.endToPlayheadGap": {
		category: "Edit",
		label: "Trim end to playhead (leave gap)",
	},
	"trim.selectedEndToPlayhead": {
		category: "Edit",
		label: "Trim selected clip end to playhead",
	},
	"trim.selectedStartToPlayhead": {
		category: "Edit",
		label: "Trim selected clip start to playhead",
	},
	"trim.startToPlayhead": {
		category: "Edit",
		label: "Ripple trim start to playhead",
		toolbar: true,
	},
	"trim.startToPlayheadGap": {
		category: "Edit",
		label: "Trim start to playhead (leave gap)",
	},
	"workspace.maximizePanel": { category: "View", label: "Maximize panel" },
	"workspace.shortcuts": { category: "View", label: "Keyboard shortcuts" },
	"zoom.fit": { category: "View", label: "Zoom timeline to fit" },
	"zoom.in": { category: "View", label: "Zoom timeline in" },
	"zoom.out": { category: "View", label: "Zoom timeline out" },
} as const satisfies Record<string, ActionMeta>;

export type ActionId = keyof typeof ACTIONS;

export interface ShortcutBinding {
	action: ActionId;
	/** Stable id for persistence and conflict reports. */
	id: string;
	keys: readonly KeyCombo[];
	scope?: ShortcutScope;
	/**
	 * Leave the key to a focused button, link, menu or other control
	 * (`INTERACTIVE_SELECTOR` in `registry.ts`), so keys such as Enter keep
	 * activating the control instead of running the action.
	 */
	skipInteractiveTargets?: true;
	/**
	 * `legacy` bindings shipped before the shell split; `shipped` ones were
	 * added since; `planned` ones are inert until their action is handled.
	 */
	source: "legacy" | "planned" | "shipped";
}

const legacy = (
	id: string,
	action: ActionId,
	...keys: KeyCombo[]
): ShortcutBinding => ({ action, id, keys, source: "legacy" });
const shipped = (
	id: string,
	action: ActionId,
	...keys: KeyCombo[]
): ShortcutBinding => ({ action, id, keys, source: "shipped" });
/** A row with no default key, so the dialog lists the action and can bind it. */
const unbound = (id: string, action: ActionId): ShortcutBinding => ({
	action,
	id,
	keys: [],
	source: "shipped",
});
const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
const plain = { alt: false, cmd: false, shift: false } as const;

/**
 * The default map. Order matters: see the module comment. The final shortcut
 * review (W5-I2) left no conflicts: `N` toggles snapping and the Roll tool
 * moved to `R`; `C` is the razor everywhere except inside the focused preview
 * (crop mode); J/K/L shuttle, Alt+J/Alt+L split edits and Shift+Alt+J (Auto
 * J/L cuts) keep their keys. Actions reached only from toolbars and menus
 * close the table with no default key, so they can still be bound.
 */
export const DEFAULT_BINDINGS: readonly ShortcutBinding[] = [
	legacy("save", "project.save", { cmd: true, key: "s" }),
	legacy("undo", "history.undo", { cmd: true, key: "z", shift: false }),
	legacy("redo", "history.redo", { cmd: true, key: "z", shift: true }),
	legacy("play-toggle", "playback.toggle", { key: " " }),
	legacy("j-cut", "splitEdit.jCut", {
		alt: true,
		cmd: false,
		code: "KeyJ",
		shift: false,
	}),
	legacy("l-cut", "splitEdit.lCut", {
		alt: true,
		cmd: false,
		code: "KeyL",
		shift: false,
	}),
	legacy("split-edit-panel", "splitEdit.openPanel", {
		alt: true,
		cmd: false,
		code: "KeyJ",
		shift: true,
	}),
	legacy("split-edit-reserved", "splitEdit.reserved", {
		alt: true,
		cmd: false,
		code: "KeyL",
		shift: true,
	}),
	{
		...shipped("crop-mode", "preview.cropMode", { ...plain, key: "c" }),
		scope: "preview",
	},
	legacy("tool-pointer", "tool.pointer", { ...plain, key: "v" }),
	legacy("tool-ripple", "tool.ripple", { ...plain, key: "b" }),
	legacy("tool-roll", "tool.roll", { ...plain, key: "r" }),
	legacy("tool-slip", "tool.slip", { ...plain, key: "y" }),
	legacy("tool-slide", "tool.slide", { ...plain, key: "u" }),
	shipped("tool-razor", "tool.razor", { ...plain, key: "c" }),
	shipped("snapping", "snapping.toggle", { ...plain, key: "n" }),
	shipped("split-at-playhead", "split.atPlayhead", {
		alt: false,
		cmd: true,
		key: "k",
		shift: false,
	}),
	legacy("split", "split.selected", { cmd: false, key: "s" }),
	legacy("duplicate", "clipboard.duplicate", { cmd: false, key: "d" }),
	legacy("pause", "playback.pause", { cmd: false, key: "k" }),
	legacy("reverse", "playback.reverse", { cmd: false, key: "j" }),
	legacy("forward", "playback.forward", { cmd: false, key: "l" }),
	legacy("go-start", "navigation.start", { key: "Home" }),
	{
		...shipped("go-start-enter", "navigation.start", {
			...plain,
			key: "Enter",
		}),
		skipInteractiveTargets: true,
	},
	legacy("go-end", "navigation.end", { key: "End" }),
	legacy("marker-previous", "markers.previous", {
		alt: false,
		cmd: false,
		key: "[",
	}),
	legacy("marker-next", "markers.next", { alt: false, cmd: false, key: "]" }),
	legacy("trim-start", "trim.selectedStartToPlayhead", {
		alt: true,
		cmd: false,
		key: "[",
	}),
	legacy("trim-end", "trim.selectedEndToPlayhead", {
		alt: true,
		cmd: false,
		key: "]",
	}),
	legacy("mark-in", "navigation.markIn", { cmd: false, key: "i" }),
	legacy("mark-out", "navigation.markOut", { cmd: false, key: "o" }),
	legacy("nudge-left", "clip.nudgeLeft", { alt: true, key: "ArrowLeft" }),
	legacy("nudge-right", "clip.nudgeRight", { alt: true, key: "ArrowRight" }),
	legacy("step-back-second", "navigation.stepBackSecond", {
		alt: false,
		cmd: false,
		key: "ArrowLeft",
		shift: true,
	}),
	legacy("step-forward-second", "navigation.stepForwardSecond", {
		alt: false,
		cmd: false,
		key: "ArrowRight",
		shift: true,
	}),
	shipped("clear-range", "navigation.clearRange", {
		alt: true,
		cmd: false,
		code: "KeyX",
		shift: false,
	}),
	shipped("jump-back-5", "navigation.jumpBack5", {
		alt: false,
		cmd: true,
		key: "ArrowLeft",
		shift: true,
	}),
	shipped("jump-forward-5", "navigation.jumpForward5", {
		alt: false,
		cmd: true,
		key: "ArrowRight",
		shift: true,
	}),
	legacy("step-back-frame", "navigation.stepBackFrame", {
		key: "ArrowLeft",
		shift: false,
	}),
	legacy("step-forward-frame", "navigation.stepForwardFrame", {
		key: "ArrowRight",
		shift: false,
	}),
	shipped(
		"ripple-delete",
		"ripple.deleteSelection",
		{ cmd: false, key: "Delete", shift: true },
		{ cmd: false, key: "Backspace", shift: true }
	),
	legacy("delete", "clip.delete", { key: "Delete" }, { key: "Backspace" }),
	shipped("trim-start-ripple", "trim.startToPlayhead", { ...plain, key: "q" }),
	shipped("trim-end-ripple", "trim.endToPlayhead", { ...plain, key: "w" }),
	shipped("trim-start-gap", "trim.startToPlayheadGap", {
		alt: true,
		cmd: false,
		code: "KeyQ",
		shift: false,
	}),
	shipped("trim-end-gap", "trim.endToPlayheadGap", {
		alt: true,
		cmd: false,
		code: "KeyW",
		shift: false,
	}),
	shipped("select-forward", "select.forwardOnTrack", { ...plain, key: "a" }),
	shipped("select-forward-all", "select.forwardAllTracks", {
		alt: false,
		cmd: false,
		key: "a",
		shift: true,
	}),
	shipped("select-all", "select.all", {
		alt: false,
		cmd: true,
		key: "a",
		shift: false,
	}),
	shipped("cancel", "select.cancel", { key: "Escape" }),
	shipped("redo-alt", "history.redoAlt", {
		alt: false,
		cmd: true,
		key: "y",
		shift: false,
	}),
	shipped("cut", "clipboard.cut", {
		alt: false,
		cmd: true,
		key: "x",
		shift: false,
	}),
	shipped("copy", "clipboard.copy", {
		alt: false,
		cmd: true,
		key: "c",
		shift: false,
	}),
	shipped("paste", "clipboard.paste", {
		alt: false,
		cmd: true,
		key: "v",
		shift: false,
	}),
	shipped("paste-insert", "clipboard.pasteInsert", {
		alt: false,
		cmd: true,
		key: "v",
		shift: true,
	}),
	shipped("paste-settings", "clipboard.pasteSettings", {
		alt: true,
		cmd: true,
		code: "KeyV",
		shift: false,
	}),
	shipped(
		"zoom-in",
		"zoom.in",
		{ alt: false, cmd: false, key: "+" },
		{ alt: false, cmd: false, key: "=" }
	),
	shipped("zoom-out", "zoom.out", { alt: false, cmd: false, key: "-" }),
	shipped("zoom-fit", "zoom.fit", {
		alt: false,
		cmd: false,
		key: "z",
		shift: true,
	}),
	shipped("edit-previous", "navigation.previousEdit", {
		...plain,
		key: "ArrowUp",
	}),
	shipped("edit-next", "navigation.nextEdit", { ...plain, key: "ArrowDown" }),
	shipped("marker-previous-arrow", "navigation.previousMarker", {
		alt: false,
		cmd: false,
		key: "ArrowUp",
		shift: true,
	}),
	shipped("marker-next-arrow", "navigation.nextMarker", {
		alt: false,
		cmd: false,
		key: "ArrowDown",
		shift: true,
	}),
	shipped("marker-toggle", "markers.toggle", { ...plain, key: "m" }),
	shipped("marker-from-range", "markers.fromRange", {
		alt: true,
		cmd: false,
		code: "KeyM",
		shift: false,
	}),
	shipped("clip-mute", "tracks.toggleClipMute", {
		alt: false,
		cmd: false,
		key: "m",
		shift: true,
	}),
	shipped("clip-hide", "tracks.toggleClipHidden", {
		alt: false,
		cmd: false,
		key: "h",
		shift: true,
	}),
	shipped("loop", "playback.toggleLoop", {
		alt: false,
		cmd: true,
		key: "l",
		shift: false,
	}),
	shipped("play-around", "playback.playAround", {
		alt: false,
		cmd: false,
		key: "/",
	}),
	shipped("fullscreen", "preview.fullscreen", { ...plain, key: "f" }),
	shipped("preview-fit", "preview.zoomFit", {
		alt: false,
		cmd: true,
		key: "0",
		shift: false,
	}),
	shipped("preview-100", "preview.zoom100", {
		alt: false,
		cmd: true,
		key: "1",
		shift: false,
	}),
	shipped("maximize-panel", "workspace.maximizePanel", {
		alt: false,
		cmd: false,
		key: "`",
	}),
	shipped("shortcuts", "workspace.shortcuts", {
		alt: false,
		cmd: false,
		key: "?",
	}),
	shipped("nest", "nest.nest", {
		alt: true,
		cmd: true,
		code: "KeyG",
		shift: false,
	}),
	shipped("decompose", "nest.decompose", {
		alt: true,
		cmd: true,
		code: "KeyG",
		shift: true,
	}),
	legacy(
		"multicam-angle",
		"multicam.switchAngle",
		...digits.map((digit) => ({ ...plain, key: digit }))
	),
	legacy(
		"multicam-mic",
		"multicam.switchMic",
		...digits.map((digit) => ({
			alt: true,
			cmd: false,
			code: `Digit${digit}`,
			shift: false,
		}))
	),
	// W3-X6: opens the agent handoff dialog (`AgentHandoffDialog`).
	shipped("ask-agent", "ai.askAgent", {
		alt: true,
		cmd: false,
		code: "KeyA",
		shift: false,
	}),
	// No default key: reached from toolbars, menus and the inspector.
	// Select all on track has none because Cmd/Ctrl+Shift+A is Ryu's
	// system-wide push-to-talk (see PLATFORM_RESERVED_CHORDS).
	unbound("detach-audio", "audio.detachSelected"),
	unbound("export-range", "export.range"),
	unbound("export-video", "export.video"),
	unbound("insert-at-playhead", "insert.selectedAtPlayhead"),
	unbound("marker-add", "markers.add"),
	unbound("preview-guides", "preview.toggleGuides"),
	unbound("ripple-delete-range", "ripple.deleteRange"),
	unbound("ripple-mode", "ripple.toggleMode"),
	unbound("select-all-track", "select.allOnTrack"),
];

/** `Cmd+Shift+Z`-style label for menus, titles, and `aria-keyshortcuts`. */
export function formatCombo(
	combo: KeyCombo,
	platform: "mac" | "other" = "other"
) {
	const parts: string[] = [];
	if (combo.cmd) {
		parts.push(platform === "mac" ? "Meta" : "Control");
	}
	if (combo.alt) {
		parts.push("Alt");
	}
	if (combo.shift) {
		parts.push("Shift");
	}
	const key = combo.key ?? combo.code?.replace(/^(Key|Digit)/, "") ?? "";
	parts.push(
		key === " " ? "Space" : key.length === 1 ? key.toUpperCase() : key
	);
	return parts.join("+");
}

/** The default bindings for one action, for button titles and the shortcut sheet. */
export function bindingsFor(action: ActionId): readonly ShortcutBinding[] {
	return DEFAULT_BINDINGS.filter((binding) => binding.action === action);
}
