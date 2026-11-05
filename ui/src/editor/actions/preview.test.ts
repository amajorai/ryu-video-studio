import { describe, expect, test } from "bun:test";
import { type ActionId, DEFAULT_BINDINGS } from "../../shortcuts/defaults.ts";
import {
	ACTION_HANDLERS,
	dispatchShortcut,
	hasActionHandler,
} from "../../shortcuts/registry.ts";
import { createTestRuntime, lastStatus, testProject } from "../test-runtime.ts";
import type { ViewerStorageArea } from "../viewer-storage.ts";
import {
	COPY_FRAME_UNSUPPORTED,
	canCopyFrame,
	copyPreviewFrame,
	customGuideOf,
	type FullscreenDocument,
	fetchPreviewFrame,
	frameFileName,
	GUIDES_STORAGE_KEY,
	type ImageClipboard,
	savePreviewFrame,
	setCustomGuide,
	setPlaybackRate,
	setPreviewGuides,
	setPreviewQuality,
	setPreviewZoom,
	togglePreviewFullscreen,
	togglePreviewGuide,
	togglePreviewGuides,
} from "./preview.ts";

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

const runtimeWithProject = () => createTestRuntime(testProject().project);
const pngBlob = () =>
	new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });

function keyEvent(key: string, extra: Partial<KeyboardEvent> = {}) {
	let prevented = false;
	return {
		altKey: false,
		code: "",
		ctrlKey: false,
		get defaultPrevented() {
			return prevented;
		},
		key,
		metaKey: false,
		preventDefault: () => {
			prevented = true;
		},
		shiftKey: false,
		target: null,
		...extra,
	};
}

describe("preview view state", () => {
	test("zoom accepts fit and clamps numbers to 25-400%", () => {
		const runtime = runtimeWithProject();
		setPreviewZoom(runtime, 8);
		expect(runtime.store.getState().previewZoom).toBe(4);
		setPreviewZoom(runtime, 0.1);
		expect(runtime.store.getState().previewZoom).toBe(0.25);
		setPreviewZoom(runtime, "fit");
		expect(runtime.store.getState().previewZoom).toBe("fit");
	});

	test("quality and playback rate land in the store", () => {
		const runtime = runtimeWithProject();
		setPreviewQuality(runtime, "quarter");
		setPlaybackRate(runtime, 25);
		expect(runtime.store.getState()).toMatchObject({
			playbackRate: 10,
			previewQuality: "quarter",
		});
	});

	test("Cmd+0 fits and Cmd+1 shows 100%", () => {
		const runtime = runtimeWithProject();
		const handlers = ACTION_HANDLERS;
		const press = (key: string, extra: Partial<KeyboardEvent>) =>
			dispatchShortcut(
				keyEvent(key, extra),
				runtime,
				DEFAULT_BINDINGS,
				handlers
			);
		expect(press("1", { metaKey: true })).toBe("preview.zoom100");
		expect(runtime.store.getState().previewZoom).toBe(1);
		expect(press("0", { ctrlKey: true })).toBe("preview.zoomFit");
		expect(runtime.store.getState().previewZoom).toBe("fit");
	});

	test("the zoom and fullscreen shortcuts are live", () => {
		const ids: ActionId[] = [
			"preview.fullscreen",
			"preview.zoom100",
			"preview.zoomFit",
		];
		for (const id of ids) {
			expect(hasActionHandler(id)).toBe(true);
			expect(
				DEFAULT_BINDINGS.some(
					(binding) => binding.action === id && binding.keys.length > 0
				)
			).toBe(true);
		}
	});
});

describe("preview guides", () => {
	test("toggling one guide, dropping unknown ids, and remembering the choice", () => {
		const runtime = runtimeWithProject();
		const area = memoryArea();
		togglePreviewGuide(runtime, "thirds", area);
		togglePreviewGuide(runtime, "center", area);
		togglePreviewGuide(runtime, "thirds", area);
		expect([...runtime.store.getState().guides]).toEqual(["center"]);
		setPreviewGuides(runtime, ["vertical-ui", "nope"], area);
		expect([...runtime.store.getState().guides]).toEqual(["vertical-ui"]);
		expect(area.values.get(`ryu.video-studio.${GUIDES_STORAGE_KEY}`)).toBe(
			'["vertical-ui"]'
		);
	});

	test("the guides toggle hides all, then restores the last set", () => {
		const runtime = runtimeWithProject();
		const area = memoryArea();
		togglePreviewGuides(runtime, area);
		expect([...runtime.store.getState().guides]).toEqual([
			"action-safe",
			"title-safe",
		]);
		setPreviewGuides(runtime, ["thirds", "aspect-9:16"], area);
		togglePreviewGuides(runtime, area);
		expect(runtime.store.getState().guides.size).toBe(0);
		togglePreviewGuides(runtime, area);
		expect([...runtime.store.getState().guides].sort()).toEqual([
			"aspect-9:16",
			"thirds",
		]);
	});

	test("a throwing storage still toggles guides", () => {
		const runtime = runtimeWithProject();
		const broken: ViewerStorageArea = {
			getItem: () => {
				throw new Error("blocked");
			},
			removeItem: () => undefined,
			setItem: () => {
				throw new Error("blocked");
			},
		};
		togglePreviewGuides(runtime, broken);
		expect(runtime.store.getState().guides.size).toBe(2);
	});
});

describe("preview fullscreen", () => {
	test("requests fullscreen on the viewport and exits when already fullscreen", async () => {
		const runtime = runtimeWithProject();
		const calls: string[] = [];
		const viewport = {
			requestFullscreen: () => {
				calls.push("request");
				return Promise.resolve();
			},
		} as unknown as Element;
		const doc: FullscreenDocument = {
			exitFullscreen: () => {
				calls.push("exit");
				return Promise.resolve();
			},
			fullscreenElement: null,
			querySelector: (selector) =>
				selector === "[data-preview-viewport]" ? viewport : null,
		};
		await togglePreviewFullscreen(runtime, doc);
		await togglePreviewFullscreen(runtime, {
			...doc,
			fullscreenElement: viewport,
		});
		expect(calls).toEqual(["request", "exit"]);
	});

	test("reports missing or blocked fullscreen", async () => {
		const runtime = runtimeWithProject();
		await togglePreviewFullscreen(runtime, {
			fullscreenElement: null,
			querySelector: () => null,
		});
		expect(lastStatus(runtime)).toBe(
			"Fullscreen preview is not available here."
		);
		await togglePreviewFullscreen(runtime, {
			fullscreenElement: null,
			querySelector: () =>
				({
					requestFullscreen: () => Promise.reject(new Error("denied")),
				}) as unknown as Element,
		});
		expect(lastStatus(runtime)).toBe(
			"Fullscreen preview was blocked by the browser."
		);
	});
});

describe("frame snapshots", () => {
	test("fetches inspect-frame at the playhead and decodes the PNG", async () => {
		const runtime = runtimeWithProject();
		runtime.time = 2.5;
		const paths: string[] = [];
		runtime.api = (path) => {
			paths.push(path);
			return Promise.resolve({ data: btoa("\x89PNG"), mimeType: "image/png" });
		};
		const blob = await fetchPreviewFrame(runtime);
		expect(paths).toEqual([
			`/projects/${runtime.project?.id}/inspect-frame?time=2.5`,
		]);
		expect(blob.type).toBe("image/png");
		expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([
			0x89, 0x50, 0x4e, 0x47,
		]);
	});

	test("rejects a malformed inspect-frame response", async () => {
		const runtime = runtimeWithProject();
		runtime.api = () => Promise.resolve({ data: "", mimeType: "image/jpeg" });
		await expect(fetchPreviewFrame(runtime)).rejects.toThrow();
	});

	test("file names are filesystem safe", () => {
		expect(frameFileName("My cut: v2/final", 65.5)).toMatch(
			/^My-cut-v2-final-[\d-]+\.png$/
		);
		expect(frameFileName("   ", 0)).toMatch(/^frame-[\d-]+\.png$/);
	});

	test("Save frame downloads the PNG", async () => {
		const runtime = runtimeWithProject();
		const downloads: [Blob, string][] = [];
		await savePreviewFrame(runtime, {
			download: (blob, name) => downloads.push([blob, name]),
			fetchFrame: () => Promise.resolve(pngBlob()),
		});
		expect(downloads).toHaveLength(1);
		expect(downloads[0]?.[1]).toEndWith(".png");
		expect(lastStatus(runtime)).toStartWith("Saved the frame");
	});

	test("Save frame reports a failed render", async () => {
		const runtime = runtimeWithProject();
		await savePreviewFrame(runtime, {
			download: () => undefined,
			fetchFrame: () => Promise.reject(new Error("ffmpeg failed")),
		});
		expect(lastStatus(runtime)).toBe("Could not save the frame: ffmpeg failed");
	});

	test("Copy frame writes a PNG clipboard item", async () => {
		const runtime = runtimeWithProject();
		const written: unknown[][] = [];
		class FakeItem {
			readonly items: Record<string, Blob | Promise<Blob>>;
			constructor(items: Record<string, Blob | Promise<Blob>>) {
				this.items = items;
			}
		}
		const clipboard: ImageClipboard = {
			ClipboardItem: FakeItem,
			write: (items) => {
				written.push(items);
				return Promise.resolve();
			},
		};
		expect(canCopyFrame(clipboard)).toBe(true);
		const copied = await copyPreviewFrame(runtime, clipboard, {
			fetchFrame: () => Promise.resolve(pngBlob()),
		});
		expect(copied).toBe(true);
		const item = written[0]?.[0] as FakeItem;
		expect(Object.keys(item.items)).toEqual(["image/png"]);
		expect((await item.items["image/png"])?.type).toBe("image/png");
		expect(lastStatus(runtime)).toStartWith("Copied the frame");
	});

	test("Copy frame falls back to a message when image clipboard is unsupported", async () => {
		const runtime = runtimeWithProject();
		let fetched = false;
		const unsupported: ImageClipboard = { write: () => Promise.resolve() };
		expect(canCopyFrame(unsupported)).toBe(false);
		expect(canCopyFrame({})).toBe(false);
		const copied = await copyPreviewFrame(runtime, unsupported, {
			fetchFrame: () => {
				fetched = true;
				return Promise.resolve(pngBlob());
			},
		});
		expect(copied).toBe(false);
		expect(fetched).toBe(false);
		expect(lastStatus(runtime)).toBe(COPY_FRAME_UNSUPPORTED);
	});

	test("Copy frame reports a rejected clipboard write", async () => {
		const runtime = runtimeWithProject();
		const clipboard: ImageClipboard = {
			// The fake only needs to be constructible.
			ClipboardItem: class {},
			write: () => Promise.reject(new Error("permission denied")),
		};
		expect(
			await copyPreviewFrame(runtime, clipboard, {
				fetchFrame: () => Promise.resolve(pngBlob()),
			})
		).toBe(false);
		expect(lastStatus(runtime)).toBe(
			"Could not copy the frame: permission denied"
		);
	});
});

describe("custom guide preferences", () => {
	test("the custom guide is clamped, kept in the store, and remembered per viewer", () => {
		const area = memoryArea();
		const runtime = createTestRuntime(testProject().project);
		expect(customGuideOf(runtime.store.getState(), area).gridColumns).toBe(4);
		setCustomGuide(runtime, { aspect: 2.35, gridColumns: 40 }, area);
		expect(runtime.store.getState().customGuide).toMatchObject({
			aspect: 2.35,
			gridColumns: 24,
		});
		const fresh = createTestRuntime(testProject().project);
		expect(customGuideOf(fresh.store.getState(), area)).toMatchObject({
			aspect: 2.35,
			gridColumns: 24,
		});
	});
});
