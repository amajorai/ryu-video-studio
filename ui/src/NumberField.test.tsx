import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

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
const { NumberField } = await import("./NumberField.tsx");

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

type Root = ReturnType<typeof createRoot>;
let mounted: { container: HTMLElement; root: Root } | null = null;

afterEach(() => {
	if (mounted) {
		const { container, root } = mounted;
		act(() => root.unmount());
		container.remove();
		mounted = null;
	}
});

interface Harness {
	changes: number[];
	clears: () => number;
	input: () => HTMLInputElement;
	label: () => HTMLElement;
	rerender: (value: number) => void;
}

function renderField({
	ariaLabel,
	blank,
	clearable = false,
	disabled,
	max = 10,
	min = 0,
	step = 0.1,
	value = 1,
}: {
	ariaLabel?: string;
	blank?: boolean;
	clearable?: boolean;
	disabled?: boolean;
	max?: number;
	min?: number;
	step?: number;
	value?: number;
} = {}): Harness {
	let clearCount = 0;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	const changes: number[] = [];
	const render = (current: number) =>
		act(() =>
			root.render(
				<NumberField
					ariaLabel={ariaLabel}
					blank={blank}
					disabled={disabled}
					label="Opacity"
					max={max}
					min={min}
					onChange={(next) => changes.push(next)}
					onClear={
						clearable
							? () => {
									clearCount += 1;
								}
							: undefined
					}
					placeholder={clearable ? "Default" : undefined}
					step={step}
					value={current}
				/>
			)
		);
	render(value);
	return {
		changes,
		clears: () => clearCount,
		input: () => {
			const input = container.querySelector("input");
			if (!input) {
				throw new Error("input missing");
			}
			return input;
		},
		label: () => {
			const label = container.querySelector<HTMLElement>(
				".ryu-app-field__label"
			);
			if (!label) {
				throw new Error("label missing");
			}
			return label;
		},
		rerender: render,
	};
}

function type(input: HTMLInputElement, text: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	act(() => {
		setter?.call(input, text);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function key(
	target: EventTarget,
	name: string,
	modifiers: { altKey?: boolean; shiftKey?: boolean } = {}
) {
	act(() => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				key: name,
				...modifiers,
			})
		);
	});
}

function pointer(
	target: EventTarget,
	kind: "pointercancel" | "pointerdown" | "pointermove" | "pointerup",
	clientX: number,
	modifiers: { altKey?: boolean; shiftKey?: boolean } = {}
) {
	act(() => {
		target.dispatchEvent(
			new PointerEvent(kind, {
				bubbles: true,
				button: 0,
				cancelable: true,
				clientX,
				pointerId: 1,
				...modifiers,
			})
		);
	});
}

describe("NumberField typing", () => {
	test("shows the value trimmed to field precision", () => {
		const field = renderField({ value: 0.1 + 0.2 });
		expect(field.input().value).toBe("0.3");
		expect(field.input().getAttribute("inputmode")).toBe("decimal");
	});

	test("Enter commits an arithmetic expression", () => {
		const field = renderField();
		type(field.input(), "(2 + 4) / 3");
		key(field.input(), "Enter");
		expect(field.changes).toEqual([2]);
	});

	test("commits are clamped to the range", () => {
		const field = renderField();
		type(field.input(), "5 * 5");
		key(field.input(), "Enter");
		type(field.input(), "-3");
		key(field.input(), "Enter");
		expect(field.changes).toEqual([10, 0]);
	});

	test("invalid Enter keeps the draft and flags it", () => {
		const field = renderField();
		type(field.input(), "2 +");
		key(field.input(), "Enter");
		expect(field.changes).toEqual([]);
		expect(field.input().value).toBe("2 +");
		expect(field.input().getAttribute("aria-invalid")).toBe("true");
		type(field.input(), "2 + 1");
		expect(field.input().hasAttribute("aria-invalid")).toBe(false);
	});

	test("Escape reverts the draft", () => {
		const field = renderField({ value: 4 });
		type(field.input(), "9");
		key(field.input(), "Escape");
		expect(field.input().value).toBe("4");
		field.input().focus();
		act(() => field.input().blur());
		expect(field.changes).toEqual([]);
	});

	test("blur commits valid drafts and reverts invalid ones", () => {
		const field = renderField({ value: 4 });
		field.input().focus();
		type(field.input(), "abc");
		act(() => field.input().blur());
		expect(field.changes).toEqual([]);
		expect(field.input().value).toBe("4");
		field.input().focus();
		type(field.input(), "7.5");
		act(() => field.input().blur());
		expect(field.changes).toEqual([7.5]);
	});

	test("blur without edits never rewrites a high-precision value", () => {
		const field = renderField({ value: 1.234_567 });
		field.input().focus();
		act(() => field.input().blur());
		key(field.input(), "Enter");
		expect(field.changes).toEqual([]);
	});

	test("arrow keys nudge by step with modifiers", () => {
		const field = renderField({ step: 0.5, value: 2 });
		key(field.input(), "ArrowUp");
		key(field.input(), "ArrowDown", { shiftKey: true });
		key(field.input(), "ArrowUp", { altKey: true });
		expect(field.changes).toEqual([2.5, 1.95, 7]);
	});

	test("a changed value prop refreshes the display", () => {
		const field = renderField({ value: 1 });
		field.rerender(3);
		expect(field.input().value).toBe("3");
	});

	test("external values update the same focused input until the user types", () => {
		// A playhead field re-renders every animation frame: the input must not
		// remount (losing focus), and typed text must never be replaced mid-edit.
		const field = renderField({ step: 0.01, value: 1 });
		const input = field.input();
		field.rerender(2.123_45);
		expect(field.input()).toBe(input);
		expect(input.value).toBe("2.123");

		act(() => input.focus());
		field.rerender(2.5);
		expect(field.input()).toBe(input);
		expect(input.value).toBe("2.5");
		expect(input.ownerDocument.activeElement).toBe(input);

		type(input, "7");
		field.rerender(3);
		expect(field.input()).toBe(input);
		expect(input.value).toBe("7");

		act(() => input.blur());
		expect(field.changes).toEqual([7]);
		field.rerender(7);
		expect(input.value).toBe("7");
	});

	test("an out-of-range draft survives external updates and commits clamped on blur", () => {
		const field = renderField({ step: 0.01, value: 2 });
		const input = field.input();
		act(() => input.focus());
		type(input, "99");
		field.rerender(4.0004);
		expect(input.value).toBe("99");

		act(() => input.blur());
		expect(field.changes).toEqual([10]);
	});
});

describe("NumberField label scrub", () => {
	test("dragging the label scrubs one step per pixel", () => {
		const field = renderField({ step: 0.1, value: 1 });
		pointer(field.label(), "pointerdown", 100);
		pointer(field.label(), "pointermove", 110);
		pointer(field.label(), "pointermove", 120);
		expect(field.input().value).toBe("3");
		expect(field.changes).toEqual([]);
		pointer(field.label(), "pointerup", 120);
		expect(field.changes).toEqual([3]);
	});

	test("Shift scrubs finer and Alt scrubs coarser", () => {
		const fine = renderField({ step: 0.1, value: 1 });
		pointer(fine.label(), "pointerdown", 0);
		pointer(fine.label(), "pointermove", 20, { shiftKey: true });
		pointer(fine.label(), "pointerup", 20);
		expect(fine.changes).toEqual([1.2]);
		act(() => mounted?.root.unmount());
		mounted?.container.remove();
		mounted = null;

		const coarse = renderField({ step: 0.1, value: 1 });
		pointer(coarse.label(), "pointerdown", 0);
		pointer(coarse.label(), "pointermove", 5, { altKey: true });
		pointer(coarse.label(), "pointerup", 5);
		expect(coarse.changes).toEqual([6]);
	});

	test("scrubbing clamps to the range", () => {
		const field = renderField({ max: 2, step: 0.1, value: 1 });
		pointer(field.label(), "pointerdown", 0);
		pointer(field.label(), "pointermove", 500);
		pointer(field.label(), "pointerup", 500);
		expect(field.changes).toEqual([2]);
	});

	test("Escape and pointercancel abandon a scrub", () => {
		const field = renderField({ value: 1 });
		pointer(field.label(), "pointerdown", 0);
		pointer(field.label(), "pointermove", 30);
		key(window, "Escape");
		expect(field.input().value).toBe("1");
		pointer(field.label(), "pointerup", 30);
		pointer(field.label(), "pointerdown", 0);
		pointer(field.label(), "pointermove", 30);
		pointer(field.label(), "pointercancel", 30);
		expect(field.changes).toEqual([]);
		expect(field.input().value).toBe("1");
	});

	test("a click without travel focuses the input instead", () => {
		const field = renderField({ value: 1 });
		pointer(field.label(), "pointerdown", 10);
		pointer(field.label(), "pointermove", 11);
		pointer(field.label(), "pointerup", 11);
		expect(field.changes).toEqual([]);
		expect(document.activeElement).toBe(field.input());
	});

	test("pressing on the input does not start a scrub", () => {
		const field = renderField({ value: 1 });
		pointer(field.input(), "pointerdown", 0);
		pointer(field.input(), "pointermove", 50);
		pointer(field.input(), "pointerup", 50);
		expect(field.changes).toEqual([]);
	});

	test("Escape cancelling a scrub never reaches app shortcuts", () => {
		const field = renderField({ value: 1 });
		let reached = 0;
		const listener = () => {
			reached += 1;
		};
		window.addEventListener("keydown", listener);
		try {
			pointer(field.label(), "pointerdown", 0);
			pointer(field.label(), "pointermove", 30);
			key(document.body, "Escape");
			expect(reached).toBe(0);
			expect(field.input().value).toBe("1");
			key(document.body, "Escape");
			expect(reached).toBe(1);
		} finally {
			window.removeEventListener("keydown", listener);
		}
	});

	test("overshooting a limit leaves no hidden slack", () => {
		const field = renderField({ max: 2, step: 0.1, value: 1 });
		pointer(field.label(), "pointerdown", 0);
		pointer(field.label(), "pointermove", 500);
		expect(field.input().value).toBe("2");
		// 10px back at 0.1 per pixel moves a full unit off the limit at once.
		pointer(field.label(), "pointermove", 490);
		expect(field.input().value).toBe("1");
		pointer(field.label(), "pointermove", 491);
		pointer(field.label(), "pointerup", 491);
		expect(field.changes).toEqual([1.1]);
	});

	test("pixels spent crossing the drag threshold still count", () => {
		const field = renderField({ step: 0.1, value: 1 });
		pointer(field.label(), "pointerdown", 0);
		pointer(field.label(), "pointermove", 1);
		pointer(field.label(), "pointermove", 2);
		pointer(field.label(), "pointermove", 3);
		pointer(field.label(), "pointerup", 3);
		expect(field.changes).toEqual([1.3]);
	});
});

describe("NumberField errors", () => {
	test("an invalid expression is announced through the input", () => {
		const field = renderField();
		type(field.input(), "1/0");
		key(field.input(), "Enter");
		const describedBy = field.input().getAttribute("aria-describedby");
		expect(describedBy).toBeTruthy();
		expect(field.input().getAttribute("aria-errormessage")).toBe(describedBy);
		const message = document.getElementById(describedBy ?? "");
		expect(message?.textContent).toMatch(/zero/i);
		type(field.input(), "1/2");
		expect(field.input().hasAttribute("aria-describedby")).toBe(false);
		expect(document.getElementById(describedBy ?? "")).toBeNull();
	});
});

describe("NumberField options", () => {
	test("ariaLabel names the input apart from the visible label", () => {
		const field = renderField({ ariaLabel: "Title 1 Opacity" });
		expect(field.input().getAttribute("aria-label")).toBe("Title 1 Opacity");
		expect(field.label().textContent).toBe("Opacity");
	});

	test("a blank field shows its placeholder and commits even the base value", () => {
		const field = renderField({ blank: true, clearable: true, value: 1 });
		expect(field.input().value).toBe("");
		expect(field.input().placeholder).toBe("Default");
		type(field.input(), "2 / 2");
		key(field.input(), "Enter");
		expect(field.changes).toEqual([1]);
	});

	test("a blank field scrubs from its base value", () => {
		const field = renderField({ blank: true, clearable: true, value: 1 });
		pointer(field.label(), "pointerdown", 100);
		pointer(field.label(), "pointermove", 105);
		expect(field.input().value).toBe("1.5");
		pointer(field.label(), "pointerup", 105);
		expect(field.changes).toEqual([1.5]);
	});

	test("an emptied clearable field clears; others revert", () => {
		const clearable = renderField({ clearable: true, value: 4 });
		type(clearable.input(), "  ");
		key(clearable.input(), "Enter");
		expect(clearable.clears()).toBe(1);
		expect(clearable.changes).toEqual([]);
		act(() => mounted?.root.unmount());
		mounted?.container.remove();
		mounted = null;
		const plain = renderField({ value: 4 });
		type(plain.input(), "");
		plain.input().focus();
		act(() => plain.input().blur());
		expect(plain.changes).toEqual([]);
		expect(plain.input().value).toBe("4");
	});

	test("a disabled field neither edits nor scrubs", () => {
		const field = renderField({ disabled: true, value: 1 });
		expect(field.input().disabled).toBe(true);
		pointer(field.label(), "pointerdown", 100);
		pointer(field.label(), "pointermove", 140);
		pointer(field.label(), "pointerup", 140);
		expect(field.changes).toEqual([]);
		expect(field.input().value).toBe("1");
	});
});
