import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { KeyframeCurve } from "../../../shared/animation.ts";
import type { ViewerStorageArea } from "../editor/viewer-storage.ts";

// React DOM decides at import time whether `input` events exist, so it loads
// after the DOM is registered (typing would otherwise never reach onChange).
GlobalRegistrator.register();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const previousActEnvironment = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	configurable: true,
	value: true,
	writable: true,
});
const { GraphEditor, curvePath, graphPoint, handleFromPointer } = await import(
	"./GraphEditor.tsx"
);
const { loadCustomPresets } = await import("./easing-presets.ts");

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

function memoryArea(): ViewerStorageArea {
	const data = new Map<string, string>();
	return {
		getItem: (key) => data.get(key) ?? null,
		removeItem: (key) => {
			data.delete(key);
		},
		setItem: (key, value) => {
			data.set(key, value);
		},
	};
}

async function render(curve: KeyframeCurve, storage: ViewerStorageArea) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const changes: KeyframeCurve[] = [];
	const draw = async (next: KeyframeCurve) => {
		await act(async () => {
			root.render(
				<GraphEditor
					curve={next}
					onChange={(changed) => changes.push(changed)}
					storage={storage}
				/>
			);
		});
	};
	await draw(curve);
	return {
		changes,
		draw,
		host,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

const button = (host: HTMLElement, text: string) => {
	const found = [...host.querySelectorAll("button")].find(
		(candidate) => candidate.textContent === text
	);
	if (!found) {
		throw new Error(`No ${text} button.`);
	}
	return found;
};

describe("graph geometry", () => {
	test("the unit box maps into the graph and pointers map back", () => {
		const origin = graphPoint(0, 0);
		const corner = graphPoint(1, 1);
		expect(origin.x).toBeLessThan(corner.x);
		expect(origin.y).toBeGreaterThan(corner.y);
		const bounds = { height: 220, left: 0, top: 0, width: 200 };
		const back = handleFromPointer(bounds, corner.x, corner.y);
		expect(back.u).toBeCloseTo(1, 2);
		expect(back.y).toBeCloseTo(1, 2);
		// Pointers outside the graph clamp to the schema ranges.
		expect(handleFromPointer(bounds, -100, -1000)).toEqual({ u: 0, y: 2 });
		expect(curvePath(null)).toContain(" H ");
		expect(curvePath([0.25, 0.1, 0.25, 1])).toContain(" C ");
	});
});

describe("GraphEditor", () => {
	test("presets apply their curve and show which one is active", async () => {
		const view = await render({ kind: "linear" }, memoryArea());
		expect(button(view.host, "Linear").getAttribute("aria-pressed")).toBe(
			"true"
		);
		await act(async () => button(view.host, "Pop overshoot").click());
		expect(view.changes.at(-1)).toEqual({
			bezier: [0.34, 1.56, 0.64, 1],
			kind: "bezier",
		});
		await act(async () => button(view.host, "Hold").click());
		expect(view.changes.at(-1)).toEqual({ kind: "hold" });
		await view.draw({ kind: "hold" });
		expect(view.host.querySelectorAll("[data-graph-handle]")).toHaveLength(0);
		expect(view.host.querySelector("[data-graph-readout]")?.textContent).toBe(
			"Hold"
		);
		await view.unmount();
	});

	test("arrow keys move a handle and report a Bezier curve", async () => {
		const view = await render({ kind: "ease-in-out" }, memoryArea());
		const start = view.host.querySelector<SVGElement>(
			'[data-graph-handle="0"]'
		);
		if (!start) {
			throw new Error("No start handle.");
		}
		expect(start.getAttribute("role")).toBe("slider");
		await act(async () => {
			start.dispatchEvent(
				new KeyboardEvent("keydown", {
					bubbles: true,
					key: "ArrowRight",
					shiftKey: true,
				})
			);
		});
		expect(view.changes.at(-1)).toEqual({
			bezier: [0.433, 0, 0.667, 1],
			kind: "bezier",
		});
		await view.unmount();
	});

	test("dragging a handle reports once, on release", async () => {
		const view = await render({ kind: "linear" }, memoryArea());
		const svg = view.host.querySelector("svg");
		const end = view.host.querySelector<SVGElement>('[data-graph-handle="1"]');
		if (!(svg && end)) {
			throw new Error("No graph.");
		}
		svg.getBoundingClientRect = () =>
			({ height: 220, left: 0, top: 0, width: 200 }) as DOMRect;
		const target = graphPoint(0.5, 1.2);
		const fire = (type: string, x: number, y: number) =>
			end.dispatchEvent(
				new PointerEvent(type, {
					bubbles: true,
					button: 0,
					clientX: x,
					clientY: y,
					pointerId: 4,
				})
			);
		await act(async () => {
			fire("pointerdown", 100, 100);
			fire("pointermove", target.x, target.y);
		});
		expect(view.changes).toHaveLength(0);
		expect(view.host.querySelector("[data-graph-readout]")?.textContent).toBe(
			"cubic-bezier(0.33, 0.33, 0.50, 1.20)"
		);
		await act(async () => fire("pointerup", target.x, target.y));
		expect(view.changes).toEqual([
			{ bezier: [0.333, 0.333, 0.5, 1.2], kind: "bezier" },
		]);
		await view.unmount();
	});

	test("the current curve saves as a custom preset for this viewer", async () => {
		const storage = memoryArea();
		const view = await render(
			{ bezier: [0.2, 0, 0.3, 1], kind: "bezier" },
			storage
		);
		const name = view.host.querySelector<HTMLInputElement>(
			'input[aria-label="Saved curve name"]'
		);
		if (!name) {
			throw new Error("No name field.");
		}
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value"
			)?.set;
			setter?.call(name, "Snappy");
			name.dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		expect(button(view.host, "Save curve").disabled).toBe(false);
		await act(async () => name.form?.requestSubmit());
		expect(loadCustomPresets(storage)).toEqual([
			{ bezier: [0.2, 0, 0.3, 1], id: "custom-snappy", name: "Snappy" },
		]);
		expect(button(view.host, "Snappy").getAttribute("aria-pressed")).toBe(
			"true"
		);
		await act(async () =>
			view.host
				.querySelector<HTMLButtonElement>(
					'button[aria-label="Delete saved curve Snappy"]'
				)
				?.click()
		);
		expect(loadCustomPresets(storage)).toEqual([]);
		await view.unmount();
	});
});
