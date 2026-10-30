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
const { TitleStyleControls, withTitleField } = await import(
	"./TitleStyleControls.tsx"
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

async function render(value: Title, onChange: (next: Title) => void) {
	const element = document.createElement("div");
	document.body.append(element);
	const root = createRoot(element);
	await act(async () => {
		root.render(
			<TitleStyleControls index={0} onChange={onChange} title={value} />
		);
	});
	return {
		element,
		unmount: async () => {
			await act(async () => root.unmount());
			element.remove();
		},
	};
}

describe("title style controls", () => {
	test("setting and clearing optional fields", () => {
		const styled = withTitleField(title, "fontFamily", "anton");
		expect(styled.fontFamily).toBe("anton");
		const cleared = withTitleField(styled, "fontFamily", undefined);
		expect("fontFamily" in cleared).toBe(false);
		expect(cleared).toEqual(title);
	});

	test("selects set fonts and animations; Default removes them", async () => {
		const changes: Title[] = [];
		const view = await render(title, (next) => changes.push(next));
		const font = view.element.querySelector<HTMLSelectElement>(
			'select[aria-label="Title 1 Font"]'
		);
		expect(font?.options.length).toBe(14);
		await act(async () => {
			if (font) {
				font.value = "lobster";
				font.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		expect(changes.at(-1)?.fontFamily).toBe("lobster");
		const animation = view.element.querySelector<HTMLSelectElement>(
			'select[aria-label="Title 1 In animation"]'
		);
		await act(async () => {
			if (animation) {
				animation.value = "typewriter";
				animation.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		expect(changes.at(-1)?.animationIn).toBe("typewriter");
		await view.unmount();
		const styled = await render({ ...title, animationIn: "pop" }, (next) =>
			changes.push(next)
		);
		const reset = styled.element.querySelector<HTMLSelectElement>(
			'select[aria-label="Title 1 In animation"]'
		);
		await act(async () => {
			if (reset) {
				reset.value = "";
				reset.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		expect("animationIn" in (changes.at(-1) ?? {})).toBe(false);
		await styled.unmount();
	});

	test("number fields clamp to bounds, take expressions and blank clears", async () => {
		const changes: Title[] = [];
		const view = await render({ ...title, letterSpacing: 0.1 }, (next) =>
			changes.push(next)
		);
		const spacing = view.element.querySelector<HTMLInputElement>(
			'input[aria-label="Title 1 Letter spacing (em)"]'
		);
		const blur = (value: string) =>
			act(async () => {
				if (spacing) {
					spacing.value = value;
					spacing.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
				}
			});
		await blur("0.3");
		expect(changes.at(-1)?.letterSpacing).toBe(0.3);
		await blur("9");
		expect(changes.at(-1)?.letterSpacing).toBe(0.5);
		await blur("0.1 * 2");
		expect(changes.at(-1)?.letterSpacing).toBe(0.2);
		const count = changes.length;
		await blur("0.1 *");
		expect(changes).toHaveLength(count);
		await blur("");
		expect("letterSpacing" in (changes.at(-1) ?? {})).toBe(false);
		await view.unmount();
	});

	test("the box toggle shows box fields only when a box is set", async () => {
		const plain = await render(title, () => undefined);
		expect(
			plain.element.querySelector('input[aria-label="Title 1 Box opacity"]')
		).toBeNull();
		await plain.unmount();
		const boxed = await render(
			{ ...title, backgroundColor: "#123456" },
			() => undefined
		);
		expect(
			boxed.element.querySelector('input[aria-label="Title 1 Box opacity"]')
		).not.toBeNull();
		await boxed.unmount();
	});

	test("box padding per axis and box offset edit within bounds", async () => {
		const changes: Title[] = [];
		const view = await render(
			{ ...title, backgroundColor: "#123456" },
			(next) => changes.push(next)
		);
		const commit = (label: string, value: string) =>
			act(async () => {
				const input = view.element.querySelector<HTMLInputElement>(
					`input[aria-label="Title 1 ${label}"]`
				);
				if (input) {
					input.value = value;
					input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
				}
			});
		await commit("Box horizontal padding", "0.03");
		expect(changes.at(-1)?.backgroundPaddingX).toBe(0.03);
		await commit("Box vertical padding", "0.004");
		expect(changes.at(-1)?.backgroundPaddingY).toBe(0.004);
		await commit("Box offset X", "-0.02");
		expect(changes.at(-1)?.backgroundOffsetX).toBe(-0.02);
		await commit("Box offset Y", "0.5");
		expect(changes.at(-1)?.backgroundOffsetY).toBe(0.1);
		await commit("Box offset Y", "0.01");
		expect(changes.at(-1)?.backgroundOffsetY).toBe(0.01);
		await view.unmount();
	});

	test("an unset style number shows its default and pins it on commit", async () => {
		const changes: Title[] = [];
		const view = await render(title, (next) => changes.push(next));
		const height = view.element.querySelector<HTMLInputElement>(
			'input[aria-label="Title 1 Line height"]'
		);
		expect(height?.value).toBe("");
		expect(height?.placeholder).not.toBe("");
		await act(async () => {
			if (height) {
				height.value = "1 + 0.5";
				height.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
			}
		});
		expect(changes.at(-1)?.lineHeight).toBe(1.5);
		await view.unmount();
	});

	test("dragging a style label scrubs the value", async () => {
		const changes: Title[] = [];
		const view = await render({ ...title, rotation: 10 }, (next) =>
			changes.push(next)
		);
		const input = view.element.querySelector<HTMLInputElement>(
			'input[aria-label="Title 1 Rotation (degrees)"]'
		);
		const label = input?.parentElement?.querySelector<HTMLElement>(
			".ryu-app-field__label"
		);
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
		await pointer("pointermove", 105);
		await pointer("pointermove", 112);
		await pointer("pointerup", 112);
		expect(changes.at(-1)?.rotation).toBe(22);
		await view.unmount();
	});
});
