import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	applyLayout,
	type Layout,
	type LayoutOptions,
} from "../../shared/layouts.ts";
import { type Asset, newProject, newSegment } from "../../shared/project.ts";

GlobalRegistrator.register();
const previousActEnvironment = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	value: true,
	configurable: true,
	writable: true,
});
const { LayoutPanel } = await import("./LayoutPanel.tsx");
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

const videoAsset = (name: string): Asset => ({
	createdAt: new Date().toISOString(),
	duration: 4,
	hasAudio: false,
	height: 1080,
	id: crypto.randomUUID(),
	kind: "video",
	name,
	width: 1920,
});

function selectValue(select: HTMLSelectElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLSelectElement.prototype,
		"value"
	)?.set;
	setter?.call(select, value);
	select.dispatchEvent(new Event("change", { bubbles: true }));
}

test("lists every layout and applies three-up with fill", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const assets = ["A", "B", "C"].map(videoAsset);
	const project = newProject("Layouts");
	project.segments = assets.map((asset, index) => newSegment(asset, 0, index));
	const onApply =
		mock<(layout: Layout, ids: string[], options: LayoutOptions) => void>();
	await act(async () => {
		root.render(
			<LayoutPanel
				assets={assets}
				busy={false}
				onApply={onApply}
				project={project}
			/>
		);
	});
	const preset = container.querySelector<HTMLSelectElement>(
		'select[aria-label="Layout preset"]'
	);
	const framing = container.querySelector<HTMLSelectElement>(
		'select[aria-label="Cell framing"]'
	);
	expect(preset?.options.length).toBe(14);
	expect(
		[...(preset?.options ?? [])].some((option) => option.value === "three-up")
	).toBe(true);
	await act(async () => {
		selectValue(preset!, "three-up");
		selectValue(framing!, "fill");
	});
	expect(container.textContent).toContain("Fill replaces each clip's crop");
	const clipButtons = [...container.querySelectorAll("button")].filter(
		(button) => button.textContent?.includes("· Track")
	);
	for (const button of clipButtons) {
		await act(async () => {
			button.click();
		});
	}
	const apply = [...container.querySelectorAll("button")].find(
		(button) => button.textContent === "Apply layout"
	);
	expect(apply?.disabled).toBe(false);
	await act(async () => {
		apply?.click();
	});
	expect(onApply).toHaveBeenCalledTimes(1);
	const [layout, ids, options] = onApply.mock.calls[0]!;
	expect(layout).toBe("three-up");
	expect(options.fit).toBe("fill");
	const next = applyLayout(project, ids, layout, options);
	for (const segment of next.segments) {
		expect(segment.fit).toBe("fill");
		expect(segment.crop.left).toBeGreaterThan(0);
	}
	await act(async () => {
		root.unmount();
	});
	container.remove();
});

test("keeping framing passes no fit", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const assets = ["A", "B"].map(videoAsset);
	const project = newProject("Keep");
	project.segments = assets.map((asset, index) => newSegment(asset, 0, index));
	const onApply =
		mock<(layout: Layout, ids: string[], options: LayoutOptions) => void>();
	await act(async () => {
		root.render(
			<LayoutPanel
				assets={assets}
				busy={false}
				onApply={onApply}
				project={project}
			/>
		);
	});
	for (const button of [...container.querySelectorAll("button")].filter(
		(item) => item.textContent?.includes("· Track")
	)) {
		await act(async () => {
			button.click();
		});
	}
	await act(async () => {
		[...container.querySelectorAll("button")]
			.find((button) => button.textContent === "Apply layout")
			?.click();
	});
	expect(onApply.mock.calls[0]?.[0]).toBe("side-by-side");
	expect(onApply.mock.calls[0]?.[2].fit).toBeUndefined();
	await act(async () => {
		root.unmount();
	});
	container.remove();
});
