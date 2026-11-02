import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

GlobalRegistrator.register();
const previousActEnvironment = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	configurable: true,
	value: true,
	writable: true,
});
const { createRoot } = await import("react-dom/client");
const { DEFAULT_TIMELINE_COLORS, TIMELINE_CLIP_KINDS } = await import(
	"../../../shared/timeline-colors.ts"
);
const { VIEWER_STORAGE_PREFIX } = await import("../editor/viewer-storage.ts");
const { createTimelineColorStore, TIMELINE_COLORS_KEY } = await import(
	"../timeline/timeline-colors.ts"
);
const { TimelineColorsPane } = await import("./TimelineColorsPane.tsx");

afterAll(() => {
	GlobalRegistrator.unregister();
	if (previousActEnvironment) {
		Object.defineProperty(
			globalThis,
			"IS_REACT_ACT_ENVIRONMENT",
			previousActEnvironment
		);
	} else {
		Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
	}
});

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

function setValue(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	act(() => {
		setter?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

const storageKey = VIEWER_STORAGE_PREFIX + TIMELINE_COLORS_KEY;

describe("Timeline colors pane", () => {
	test("one swatch per clip kind, persisted per viewer, with Reset all", async () => {
		const area = memoryArea();
		const store = createTimelineColorStore(area);
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		await act(async () => {
			root.render(<TimelineColorsPane store={store} />);
		});
		const swatches = [
			...host.querySelectorAll<HTMLInputElement>('input[type="color"]'),
		];
		expect(swatches).toHaveLength(TIMELINE_CLIP_KINDS.length);
		expect(swatches[0]?.value).toBe(DEFAULT_TIMELINE_COLORS.video);
		const reset = [...host.querySelectorAll("button")].find(
			(button) => button.textContent === "Reset all"
		);
		expect(reset?.disabled).toBe(true);

		const audio = host.querySelector<HTMLInputElement>(
			'input[aria-label="Audio clips color"]'
		);
		if (!audio) {
			throw new Error("audio swatch missing");
		}
		setValue(audio, "#123456");
		expect(store.getState()).toEqual({ audio: "#123456" });
		expect(JSON.parse(area.values.get(storageKey) ?? "{}")).toEqual({
			audio: "#123456",
		});
		expect(host.textContent).toContain("Custom");
		// A fresh store (a reload) reads the saved preference back.
		expect(createTimelineColorStore(area).getState()).toEqual({
			audio: "#123456",
		});

		expect(reset?.disabled).toBe(false);
		await act(async () => {
			reset?.click();
		});
		expect(store.getState()).toEqual({});
		expect(area.values.has(storageKey)).toBe(false);
		expect(audio.value).toBe(DEFAULT_TIMELINE_COLORS.audio);
		await act(async () => root.unmount());
		host.remove();
	});

	test("unreadable storage falls back to the defaults", () => {
		const area = memoryArea();
		area.setItem(storageKey, "{not json");
		expect(createTimelineColorStore(area).getState()).toEqual({});
		expect(createTimelineColorStore(null).getState()).toEqual({});
	});
});
