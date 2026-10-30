import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Graphic, Title } from "../../../shared/project.ts";

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
const { TitlesPanel } = await import("../TitlesPanel.tsx");
const { GraphicsPanel } = await import("../GraphicsPanel.tsx");

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

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
	await cleanup?.();
	cleanup = null;
});

async function render(node: React.ReactNode): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(node);
	});
	cleanup = async () => {
		await act(async () => {
			root.unmount();
		});
		host.remove();
	};
	return host;
}

async function choose(host: HTMLElement, label: string, value: string) {
	const select = host.querySelector<HTMLSelectElement>(
		`select[aria-label="${label}"]`
	);
	if (!select) {
		throw new Error(`no select named ${label}`);
	}
	await act(async () => {
		select.value = value;
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

function buttonNamed(host: HTMLElement, text: string) {
	return [...host.querySelectorAll("button")].find(
		(button) => button.textContent === text
	);
}

const title: Title = {
	animation: "fade",
	color: "#ff8800",
	end: 4,
	fadeIn: 0,
	fadeOut: 0,
	fontSize: 0.06,
	id: "66666666-6666-4666-8666-666666666666",
	start: 1,
	text: "Keyed",
	x: 0.5,
	y: 0.5,
};

describe("title keyframes in the Titles panel", () => {
	test("records text size and color at the playhead", async () => {
		const changes: Title[][] = [];
		const host = await render(
			<TitlesPanel
				narrationAvailable={false}
				onChange={(titles) => changes.push(titles)}
				time={2.5}
				titles={[title]}
			/>
		);
		await choose(host, "Title 1 keyframe property", "fontSize");
		await act(async () => {
			buttonNamed(host, "Add keyframe at playhead")?.click();
		});
		expect(changes.at(-1)?.[0]?.keyframes).toEqual([
			expect.objectContaining({ property: "fontSize", time: 1.5, value: 0.06 }),
		]);
		await choose(host, "Title 1 keyframe property", "color");
		await act(async () => {
			buttonNamed(host, "Add keyframe at playhead")?.click();
		});
		expect(changes.at(-1)?.[0]?.keyframes).toEqual([
			expect.objectContaining({
				color: "#ff8800",
				property: "color",
				time: 1.5,
				value: 0,
			}),
		]);
	});

	test("lists title keyframes with value, easing and removal", async () => {
		const changes: Title[][] = [];
		const keyed: Title = {
			...title,
			keyframes: [
				{
					id: "77777777-7777-4777-8777-777777777777",
					property: "letterSpacing",
					time: 1,
					value: 0.1,
				},
			],
		};
		const host = await render(
			<TitlesPanel
				narrationAvailable={false}
				onChange={(titles) => changes.push(titles)}
				time={0}
				titles={[keyed]}
			/>
		);
		expect(host.textContent).toContain(
			"Move the playhead inside this title to add keyframes."
		);
		const value = host.querySelector<HTMLInputElement>(
			'input[aria-label="Title 1 Letter spacing keyframe at 1.00 seconds, value"]'
		);
		expect(value?.value).toBe("0.1");
		await act(async () => {
			if (value) {
				value.value = "0.3";
				value.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
			}
		});
		expect(changes.at(-1)?.[0]?.keyframes?.[0]?.value).toBe(0.3);
		await choose(
			host,
			"Letter spacing keyframe at 1.00 seconds, easing to the next keyframe",
			"ease-in"
		);
		expect(changes.at(-1)?.[0]?.keyframes?.[0]?.interpolation).toBe("ease-in");
		await act(async () => {
			host
				.querySelector<HTMLButtonElement>(
					'button[aria-label="Remove Letter spacing keyframe at 1.00 seconds"]'
				)
				?.click();
		});
		expect("keyframes" in (changes.at(-1)?.[0] ?? {})).toBe(false);
	});
});

describe("graphic shape keyframes in the Graphics panel", () => {
	test("offers scale, stroke, corner and color channels", async () => {
		const changes: Graphic[][] = [];
		const graphic: Graphic = {
			animation: "none",
			end: 3,
			entryDuration: 0,
			fill: "#112233",
			height: 0.2,
			id: "88888888-8888-4888-8888-888888888888",
			opacity: 1,
			shape: "rectangle",
			start: 1,
			stroke: "#ffffff",
			strokeWidth: 0,
			width: 0.2,
			x: 0.1,
			y: 0.1,
		};
		const host = await render(
			<GraphicsPanel
				graphics={[graphic]}
				onChange={(graphics) => changes.push(graphics)}
				styleProfile="clean-professional"
				time={2}
			/>
		);
		const options = [
			...(host.querySelector<HTMLSelectElement>(
				'select[aria-label="Vector shape 1 keyframe property"]'
			)?.options ?? []),
		].map((option) => option.value);
		expect(options).toEqual([
			"x",
			"y",
			"rotation",
			"opacity",
			"scale",
			"strokeWidth",
			"cornerRadius",
			"innerRadius",
			"fill",
			"stroke",
		]);
		await choose(host, "Vector shape 1 keyframe property", "fill");
		await act(async () => {
			buttonNamed(host, "Add keyframe at playhead")?.click();
		});
		expect(changes.at(-1)?.[0]?.keyframes).toEqual([
			expect.objectContaining({ color: "#112233", property: "fill", time: 1 }),
		]);
	});
});
