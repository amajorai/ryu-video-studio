import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Project } from "../../shared/project.ts";

// Another file may have left happy-dom registered; only own what we start.
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
const { TitlesPanel } = await import("./TitlesPanel.tsx");
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

type Title = Project["titles"][number];
const title: Title = {
	animation: "fade",
	color: "#ffffff",
	end: 3,
	fadeIn: 0.2,
	fadeOut: 0.2,
	fontSize: 0.08,
	id: "00000000-0000-4000-8000-000000000001",
	start: 0,
	text: "Hello",
	x: 0.5,
	y: 0.5,
};

async function render(onChange: (titles: Title[]) => void) {
	const element = document.createElement("div");
	document.body.append(element);
	const root = createRoot(element);
	await act(async () => {
		root.render(
			<TitlesPanel
				narrationAvailable={false}
				onChange={onChange}
				time={0}
				titles={[title]}
			/>
		);
	});
	const input = (label: string) => {
		const found = element.querySelector<HTMLInputElement>(
			`input[aria-label="Title 1 ${label}"]`
		);
		if (!found) {
			throw new Error(`missing ${label}`);
		}
		return found;
	};
	return {
		input,
		unmount: async () => {
			await act(async () => root.unmount());
			element.remove();
		},
	};
}

describe("TitlesPanel numeric fields", () => {
	test("typing a math expression commits its result", async () => {
		const changes: Title[][] = [];
		const view = await render((next) => changes.push(next));
		const end = view.input("End");
		expect(end.getAttribute("role")).toBe("spinbutton");
		await act(async () => {
			end.value = "1.5*3";
			end.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		});
		expect(changes.at(-1)?.[0]?.end).toBe(4.5);
		const fade = view.input("Fade in");
		await act(async () => {
			fade.value = "+0.1";
			fade.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		});
		expect(changes.at(-1)?.[0]?.fadeIn).toBe(0.1);
		await view.unmount();
	});

	test("an out-of-range value clamps and an invalid one reverts", async () => {
		const changes: Title[][] = [];
		const view = await render((next) => changes.push(next));
		const x = view.input("Horizontal position");
		await act(async () => {
			x.value = "2";
			x.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		});
		expect(changes.at(-1)?.[0]?.x).toBe(1);
		const count = changes.length;
		const setValue = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set;
		await act(async () => {
			setValue?.call(x, "0.5 +");
			x.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			x.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		});
		expect(changes).toHaveLength(count);
		expect(x.value).toBe("0.5");
		await view.unmount();
	});

	test("dragging a field label scrubs the title value", async () => {
		const changes: Title[][] = [];
		const view = await render((next) => changes.push(next));
		const start = view.input("Start");
		const label = start.parentElement?.querySelector<HTMLElement>(
			".ryu-app-field__label"
		);
		expect(label?.textContent).toBe("Start");
		const pointer = (kind: string, clientX: number) =>
			act(async () => {
				label?.dispatchEvent(
					new PointerEvent(kind, {
						bubbles: true,
						button: 0,
						cancelable: true,
						clientX,
						pointerId: 1,
					})
				);
			});
		await pointer("pointerdown", 100);
		await pointer("pointermove", 150);
		expect(start.value).toBe("0.5");
		await pointer("pointerup", 150);
		expect(changes.at(-1)?.[0]?.start).toBe(0.5);
		await view.unmount();
	});
});
