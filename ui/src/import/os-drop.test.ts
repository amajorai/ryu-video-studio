import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { EditorRuntime } from "../editor/runtime.ts";
import { ASSET_DRAG_MIME } from "../library/drag-source.ts";
import { DEFAULT_BINDINGS } from "../shortcuts/defaults.ts";
import { dispatchShortcut } from "../shortcuts/registry.ts";
import {
	CLIP_PASTE_FALLBACK_MS,
	fileListOf,
	hasFileDrag,
	installOsDrop,
	isImportableFile,
	isPastableMedia,
	isTextEditingTarget,
	skippedNotice,
	withStatusSuffix,
} from "./os-drop.ts";

// Another file may have left happy-dom registered; only own what we start.
const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
afterAll(() => {
	if (ownsDom) {
		GlobalRegistrator.unregister();
	}
});

type Listener = (event: Event) => void;

/** An event target that records listeners and dispatches plain objects. */
function fakeTarget() {
	const listeners = new Map<string, Set<Listener>>();
	return {
		addEventListener: (type: string, listener: Listener) => {
			const set = listeners.get(type) ?? new Set<Listener>();
			set.add(listener);
			listeners.set(type, set);
		},
		dispatch: (type: string, event: object) => {
			for (const listener of listeners.get(type) ?? []) {
				listener(event as Event);
			}
		},
		listenerCount: () =>
			[...listeners.values()].reduce((sum, set) => sum + set.size, 0),
		removeEventListener: (type: string, listener: Listener) => {
			listeners.get(type)?.delete(listener);
		},
	};
}

const file = (name: string, type: string) => new File(["x"], name, { type });

function dragEvent(types: string[], files: File[] = []) {
	const event = {
		dataTransfer: { dropEffect: "none", files, types },
		defaultPrevented: false,
		preventDefault: () => {
			event.defaultPrevented = true;
		},
	};
	return event;
}

describe("operating-system file drop and paste", () => {
	test("accepts video, audio, and library image types", () => {
		expect(isImportableFile({ type: "video/mp4" })).toBe(true);
		expect(isImportableFile({ type: "audio/wav" })).toBe(true);
		expect(isImportableFile({ type: "image/webp" })).toBe(true);
		expect(isImportableFile({ type: "image/gif" })).toBe(false);
		expect(isImportableFile({ type: "application/pdf" })).toBe(false);
		expect(isPastableMedia({ type: "audio/wav" })).toBe(false);
		expect(isPastableMedia({ type: "image/png" })).toBe(true);
		// Lottie JSON and dotLottie files import as videos with transparency.
		expect(isImportableFile({ name: "intro.lottie", type: "" })).toBe(true);
		expect(
			isImportableFile({ name: "intro.json", type: "application/json" })
		).toBe(true);
		expect(isImportableFile({ name: "notes.txt", type: "text/plain" })).toBe(
			false
		);
	});

	test("file drops import media, skip documents, and ignore asset drags", () => {
		const target = fakeTarget();
		const imported: string[][] = [];
		const skippedCounts: number[] = [];
		const rejected: number[] = [];
		const uninstall = installOsDrop(target, {
			onFiles: (files, skipped) => {
				imported.push(files.map((item) => item.name));
				skippedCounts.push(skipped);
			},
			onRejected: (count) => rejected.push(count),
		});
		const over = dragEvent(["Files"]);
		target.dispatch("dragover", over);
		expect(over.defaultPrevented).toBe(true);
		expect(over.dataTransfer.dropEffect).toBe("copy");

		const drop = dragEvent(
			["Files"],
			[file("a.mp4", "video/mp4"), file("notes.pdf", "application/pdf")]
		);
		target.dispatch("drop", drop);
		expect(drop.defaultPrevented).toBe(true);
		expect(imported).toEqual([["a.mp4"]]);
		// A mixed drop reports the skip with the import, not separately.
		expect(skippedCounts).toEqual([1]);
		expect(rejected).toEqual([]);

		target.dispatch(
			"drop",
			dragEvent(["Files"], [file("notes.pdf", "application/pdf")])
		);
		expect(rejected).toEqual([1]);
		expect(imported).toHaveLength(1);

		const library = dragEvent([ASSET_DRAG_MIME]);
		target.dispatch("dragover", library);
		target.dispatch("drop", library);
		expect(library.defaultPrevented).toBe(false);
		expect(imported).toHaveLength(1);

		uninstall();
		expect(target.listenerCount()).toBe(0);
	});

	test("pastes import image or video blobs but never text-field pastes", () => {
		const target = fakeTarget();
		const imported: string[][] = [];
		installOsDrop(target, {
			onFiles: (files) => imported.push(files.map((item) => item.name)),
		});
		const paste = (files: File[], targetElement: EventTarget | null = null) => {
			const event = {
				clipboardData: { files },
				defaultPrevented: false,
				preventDefault: () => {
					event.defaultPrevented = true;
				},
				target: targetElement,
			};
			target.dispatch("paste", event);
			return event;
		};
		expect(paste([file("shot.png", "image/png")]).defaultPrevented).toBe(true);
		expect(paste([file("voice.wav", "audio/wav")]).defaultPrevented).toBe(
			false
		);
		expect(paste([]).defaultPrevented).toBe(false);
		const input = document.createElement("input");
		expect(paste([file("shot.png", "image/png")], input).defaultPrevented).toBe(
			false
		);
		expect(imported).toEqual([["shot.png"]]);
	});

	test("helpers build file lists and detect text fields", () => {
		const files = [file("a.mp4", "video/mp4"), file("b.png", "image/png")];
		const list = fileListOf(files);
		expect(list.length).toBe(2);
		expect(list.item(1)?.name).toBe("b.png");
		expect(list.item(5)).toBeNull();
		expect(Array.from(list).map((item) => item.name)).toEqual([
			"a.mp4",
			"b.png",
		]);
		expect(isTextEditingTarget(null)).toBe(false);
		expect(isTextEditingTarget(document.createElement("div"))).toBe(false);
		const editable = document.createElement("div");
		editable.setAttribute("contenteditable", "true");
		const child = document.createElement("span");
		editable.append(child);
		expect(isTextEditingTarget(child)).toBe(true);
		expect(hasFileDrag(null)).toBe(false);
	});

	test("the skip notice rides along on every import status", () => {
		const statuses: string[] = [];
		const runtime = {
			setStatus: (text: string) => statuses.push(text),
		} as unknown as EditorRuntime;
		const noticed = withStatusSuffix(runtime, skippedNotice(1));
		noticed.setStatus("Importing a.mp4 · 50%");
		noticed.setStatus("Media imported.");
		expect(statuses).toEqual([
			`Importing a.mp4 · 50% ${skippedNotice(1)}`,
			`Media imported. ${skippedNotice(1)}`,
		]);
		expect(withStatusSuffix(runtime, "")).toBe(runtime);
		expect(skippedNotice(2)).toContain("2 files that are");
	});
});

describe("Cmd/Ctrl+V with clips on the in-app clipboard", () => {
	const fakeRuntime = { busy: false, project: {} } as unknown as EditorRuntime;

	/**
	 * Install the window handlers next to an App-style bubble-phase keydown
	 * listener running the real shortcut dispatcher, whose clip paste handler
	 * claims every Cmd/Ctrl+V (as W1-T2's does while clips are copied).
	 */
	function harness() {
		const imported: string[][] = [];
		const clipPastes: string[] = [];
		const dispatcherPastes: string[] = [];
		const onShortcut = (event: KeyboardEvent) => {
			dispatchShortcut(event, fakeRuntime, DEFAULT_BINDINGS, {
				"clipboard.paste": () => {
					dispatcherPastes.push("overwrite");
					return true;
				},
			});
		};
		window.addEventListener("keydown", onShortcut);
		const uninstall = installOsDrop(window, {
			hasClipPaste: () => true,
			onClipPaste: (mode) => clipPastes.push(mode),
			onFiles: (files) => imported.push(files.map((item) => item.name)),
		});
		const keydown = (init: KeyboardEventInit = {}) => {
			const event = new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				ctrlKey: true,
				key: "v",
				...init,
			});
			document.body.dispatchEvent(event);
			return event;
		};
		const paste = (files: File[]) => {
			const event = new Event("paste", { bubbles: true, cancelable: true });
			Object.defineProperty(event, "clipboardData", { value: { files } });
			document.body.dispatchEvent(event);
			return event;
		};
		const cleanup = () => {
			uninstall();
			window.removeEventListener("keydown", onShortcut);
		};
		return {
			cleanup,
			clipPastes,
			dispatcherPastes,
			imported,
			keydown,
			paste,
		};
	}

	test("system-clipboard media imports instead of pasting old clips", () => {
		const run = harness();
		const key = run.keydown();
		// The keystroke keeps its default, so the browser fires `paste`.
		expect(key.defaultPrevented).toBe(false);
		expect(run.dispatcherPastes).toEqual([]);
		const event = run.paste([file("shot.png", "image/png")]);
		expect(event.defaultPrevented).toBe(true);
		expect(run.imported).toEqual([["shot.png"]]);
		expect(run.clipPastes).toEqual([]);
		run.cleanup();
	});

	test("a paste without media pastes the clips, Shift as insert", () => {
		const run = harness();
		run.keydown();
		expect(run.paste([]).defaultPrevented).toBe(true);
		run.keydown({ shiftKey: true });
		run.paste([file("voice.wav", "audio/wav")]);
		expect(run.clipPastes).toEqual(["overwrite", "insert"]);
		expect(run.imported).toEqual([]);
		// A paste event without a preceding keystroke (menu paste) is not a clip paste.
		expect(run.paste([]).defaultPrevented).toBe(false);
		expect(run.clipPastes).toHaveLength(2);
		run.cleanup();
	});

	test("clips still paste when no paste event follows the keystroke", async () => {
		const run = harness();
		run.keydown();
		expect(run.clipPastes).toEqual([]);
		await Bun.sleep(CLIP_PASTE_FALLBACK_MS + 20);
		expect(run.clipPastes).toEqual(["overwrite"]);
		run.cleanup();
	});

	test("text fields and an empty clip clipboard are left to the dispatcher", () => {
		const run = harness();
		const input = document.createElement("input");
		document.body.append(input);
		input.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "v" })
		);
		input.remove();
		expect(run.clipPastes).toEqual([]);
		run.cleanup();

		const dispatcherPastes: string[] = [];
		const onShortcut = (event: KeyboardEvent) => {
			dispatchShortcut(event, fakeRuntime, DEFAULT_BINDINGS, {
				"clipboard.paste": () => {
					dispatcherPastes.push("overwrite");
					return true;
				},
			});
		};
		window.addEventListener("keydown", onShortcut);
		const uninstall = installOsDrop(window, {
			hasClipPaste: () => false,
			onClipPaste: () => dispatcherPastes.push("unexpected"),
			onFiles: () => undefined,
		});
		document.body.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "v" })
		);
		expect(dispatcherPastes).toEqual(["overwrite"]);
		uninstall();
		window.removeEventListener("keydown", onShortcut);
	});
});
