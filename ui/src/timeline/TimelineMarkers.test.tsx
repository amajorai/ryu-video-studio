import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { newProject, type Project } from "../../../shared/project.ts";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
const previousActEnvironment = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	configurable: true,
	value: true,
	writable: true,
});
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime } = await import("../editor/test-runtime.ts");
const { TimelineMarkers, markerDragTime, rulerMarkerLabel } = await import(
	"./TimelineMarkers.tsx"
);

afterAll(() => {
	if (ownsDom) {
		GlobalRegistrator.unregister();
	}
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

const ZOOM = 50;

function fixture() {
	const id = crypto.randomUUID();
	const project: Project = {
		...newProject("Ruler markers"),
		markers: [{ comment: "Check", id, label: "Cue", time: 2 }],
	};
	const runtime = createTestRuntime(project);
	runtime.duration = 10;
	return { id, runtime };
}

type Runtime = ReturnType<typeof fixture>["runtime"];

async function render(runtime: Runtime) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const draw = async () => {
		await act(async () => {
			root.render(
				<EditorProvider value={runtime}>
					<TimelineMarkers
						markers={runtime.project?.markers ?? []}
						onSeek={runtime.setTime}
						zoom={ZOOM}
					/>
				</EditorProvider>
			);
		});
	};
	await draw();
	const flag = () => {
		const element = host.querySelector<HTMLElement>(".studio-marker");
		if (!element) {
			throw new Error("Missing marker flag.");
		}
		return element;
	};
	return {
		draw,
		flag,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

function pointer(type: string, target: EventTarget, x: number) {
	target.dispatchEvent(
		new PointerEvent(type, {
			bubbles: true,
			button: 0,
			clientX: x,
			pointerId: 1,
		})
	);
}

const seeks = (runtime: Runtime) =>
	runtime.calls.filter(([name]) => name === "setTime").map(([, at]) => at);

describe("ruler marker helpers", () => {
	test("dense analysis labels are shortened", () => {
		expect(rulerMarkerLabel("Peak 3")).toBe("P3");
		expect(rulerMarkerLabel("Beat 12")).toBe("B12");
		expect(rulerMarkerLabel("Hook")).toBe("Hook");
	});

	test("drag time is frame-quantized and clamped to the timeline", () => {
		const marker = { id: crypto.randomUUID(), label: "M", time: 2 };
		const at = (deltaPx: number) =>
			markerDragTime({ deltaPx, duration: 10, fps: 30, marker, zoom: ZOOM });
		expect(at(51)).toBeCloseTo(3.033, 3);
		expect(at(-500)).toBe(0);
		expect(at(5000)).toBe(10);
	});
});

describe("TimelineMarkers", () => {
	test("a click seeks; a drag moves the marker once on release and does not seek", async () => {
		const { id, runtime } = fixture();
		const view = await render(runtime);
		await act(async () => {
			view.flag().click();
		});
		expect(seeks(runtime)).toEqual([2]);
		await act(async () => {
			pointer("pointerdown", view.flag(), 100);
		});
		await act(async () => {
			pointer("pointermove", window, 125);
		});
		expect(view.flag().style.getPropertyValue("--studio-marker-left")).toBe(
			`${2.5 * ZOOM}px`
		);
		// Nothing is saved until release.
		expect(runtime.project?.markers[0]?.time).toBe(2);
		await act(async () => {
			pointer("pointermove", window, 150);
			pointer("pointerup", window, 150);
			// The browser dispatches the release's click in the same task.
			view.flag().click();
		});
		expect(runtime.project?.markers).toMatchObject([{ id, time: 3 }]);
		expect(runtime.calls.filter(([name]) => name === "edit")).toEqual([
			["edit", "Move marker"],
		]);
		expect(seeks(runtime)).toEqual([2]);
		await view.unmount();
	});

	test("a drag released off the flag does not swallow a later click", async () => {
		const { runtime } = fixture();
		const view = await render(runtime);
		await act(async () => {
			pointer("pointerdown", view.flag(), 100);
		});
		await act(async () => {
			pointer("pointermove", window, 5000);
			pointer("pointerup", window, 5000);
			// The release's click lands on an ancestor, not the clamped flag.
			document.body.click();
		});
		expect(runtime.project?.markers[0]?.time).toBe(10);
		await view.draw();
		// A new press clears any leftover suppression.
		await act(async () => {
			pointer("pointerdown", view.flag(), 500);
			pointer("pointerup", window, 500);
			view.flag().click();
		});
		expect(seeks(runtime)).toEqual([10]);
		// So does the end of the tick, even without a new press.
		await act(async () => {
			pointer("pointerdown", view.flag(), 500);
			pointer("pointermove", window, 400);
			pointer("pointerup", window, 400);
			document.body.click();
		});
		await view.draw();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await act(async () => {
			view.flag().click();
		});
		expect(seeks(runtime)).toEqual([10, 8]);
		await view.unmount();
	});

	test("a press without travel stays a click", async () => {
		const { runtime } = fixture();
		const view = await render(runtime);
		await act(async () => {
			pointer("pointerdown", view.flag(), 100);
			pointer("pointermove", window, 101);
			pointer("pointerup", window, 101);
		});
		await act(async () => {
			view.flag().click();
		});
		expect(runtime.project?.markers[0]?.time).toBe(2);
		expect(seeks(runtime)).toEqual([2]);
		await view.unmount();
	});

	test("double-click opens the editor, which saves status and comment", async () => {
		const { id, runtime } = fixture();
		const view = await render(runtime);
		await act(async () => {
			view.flag().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		});
		const form = document.querySelector<HTMLFormElement>(
			'[data-testid="marker-editor"]'
		);
		if (!form) {
			throw new Error("The marker editor did not open.");
		}
		const status = form.querySelector<HTMLSelectElement>(
			'[aria-label="Marker status"]'
		);
		const comment = form.querySelector<HTMLTextAreaElement>(
			'[aria-label="Marker comment"]'
		);
		if (!(status && comment)) {
			throw new Error("Missing editor fields.");
		}
		await act(async () => {
			setNativeValue(status, "resolved");
			status.dispatchEvent(new Event("change", { bubbles: true }));
			setNativeValue(comment, "Fixed in v2");
			comment.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			form.requestSubmit();
		});
		expect(runtime.project?.markers).toMatchObject([
			{ comment: "Fixed in v2", id, status: "resolved" },
		]);
		await view.draw();
		expect(document.querySelector('[data-testid="marker-editor"]')).toBeNull();
		await view.unmount();
	});
});

/** Set a form control's value so React's change tracking sees the edit. */
function setNativeValue(
	element: HTMLSelectElement | HTMLTextAreaElement,
	value: string
) {
	const prototype = Object.getPrototypeOf(element) as object;
	const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
	setter?.call(element, value);
}
