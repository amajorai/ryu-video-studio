import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	type Keyframe,
	newProject,
	newSegment,
	type Project,
	type Segment,
} from "../../../../shared/project.ts";

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
const { EditorProvider } = await import("../../editor/context.tsx");
const { createTestRuntime, lastStatus, testVideo } = await import(
	"../../editor/test-runtime.ts"
);
const { KeyframesSection } = await import("./KeyframesSection.tsx");
const { keyframeClipboard, setKeyframeClipboard } = await import(
	"./keyframe-list.ts"
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

function fixture() {
	const video = testVideo("clip.mp4", 10);
	const segment: Segment = {
		...newSegment(video),
		keyframes: [
			{ id: crypto.randomUUID(), property: "opacity", time: 0.5, value: 0.2 },
			{
				id: crypto.randomUUID(),
				interpolation: "ease-out",
				property: "opacity",
				time: 1.5,
				value: 1,
			},
		] satisfies Keyframe[],
	};
	const project: Project = { ...newProject("Keyframes"), segments: [segment] };
	return { project, segment, video };
}

async function render(segment: Segment, time = 0) {
	const { project, video } = fixture();
	const runtime = createTestRuntime({ ...project, segments: [segment] }, [
		video,
	]);
	runtime.time = time;
	const patches: Partial<Segment>[] = [];
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<EditorProvider value={runtime}>
				<KeyframesSection
					isAudio={false}
					onChange={(patch) => patches.push(patch)}
					onPropertyChange={() => undefined}
					property="opacity"
					segment={segment}
					visualControls
				/>
			</EditorProvider>
		);
	});
	const unmount = async () => {
		await act(async () => {
			root.unmount();
		});
		host.remove();
	};
	return { host, patches, runtime, unmount };
}

const press = (target: Element, key: string) =>
	act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key })
		);
	});

describe("KeyframesSection", () => {
	test("lists the new properties and each keyframe's curve", async () => {
		const { segment } = fixture();
		const view = await render(segment);
		const property = view.host.querySelector<HTMLSelectElement>(
			'select[aria-label="Animation property"]'
		);
		const values = [...(property?.options ?? [])].map((option) => option.value);
		expect(values).toContain("cropLeft");
		expect(values).toContain("brightness");
		expect(values.at(-1)).toBe("volume");
		const curves = [
			...view.host.querySelectorAll<HTMLSelectElement>(
				'select[aria-label^="Curve after"]'
			),
		].map((select) => select.value);
		expect(curves).toEqual(["linear", "ease-out"]);
		await view.unmount();
	});

	test("choosing a curve writes interpolation and Bezier controls", async () => {
		const { segment } = fixture();
		const view = await render(segment);
		const select = view.host.querySelector<HTMLSelectElement>(
			'select[aria-label^="Curve after"]'
		);
		await act(async () => {
			if (select) {
				select.value = "bezier";
				select.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		expect(view.patches.at(-1)?.keyframes?.[0]).toMatchObject({
			bezier: [0.25, 0.1, 0.25, 1],
			interpolation: "bezier",
		});
		await view.unmount();
	});

	test("Ctrl+C and Ctrl+V in the list copy and paste at the playhead", async () => {
		setKeyframeClipboard(null);
		const { segment } = fixture();
		const view = await render(segment, 4);
		let leaked = 0;
		const listener = () => {
			leaked++;
		};
		window.addEventListener("keydown", listener);
		const list = view.host.querySelector(
			'[role="group"][aria-label="Keyframes"]'
		);
		expect(list).not.toBeNull();
		await press(list as Element, "c");
		expect(keyframeClipboard()?.items).toHaveLength(2);
		expect(lastStatus(view.runtime)).toBe("Copied 2 keyframes.");
		await press(list as Element, "v");
		const pasted = view.patches.at(-1)?.keyframes ?? [];
		expect(
			pasted
				.filter((item) => item.property === "opacity")
				.map((item) => item.time)
				.sort((a, b) => a - b)
		).toEqual([0.5, 1.5, 4, 5]);
		expect(leaked).toBe(0);
		window.removeEventListener("keydown", listener);
		await view.unmount();
	});

	test("selected keyframes copy alone", async () => {
		setKeyframeClipboard(null);
		const { segment } = fixture();
		const view = await render(segment);
		const checkbox =
			view.host.querySelectorAll<HTMLElement>('[role="checkbox"]')[1];
		await act(async () => {
			checkbox?.click();
		});
		const copy = [...view.host.querySelectorAll("button")].find(
			(button) => button.textContent === "Copy 1 selected"
		);
		await act(async () => {
			copy?.click();
		});
		expect(keyframeClipboard()?.items).toEqual([
			{ interpolation: "ease-out", offset: 0, property: "opacity", value: 1 },
		]);
		await view.unmount();
	});

	test("Ctrl+C and Ctrl+V work with a selection checkbox focused", async () => {
		setKeyframeClipboard(null);
		const { segment } = fixture();
		const view = await render(segment, 4);
		let leaked = 0;
		const listener = () => {
			leaked++;
		};
		window.addEventListener("keydown", listener);
		const checkbox = view.host.querySelectorAll<HTMLElement>(
			'[role="checkbox"]'
		)[1] as HTMLInputElement;
		await act(async () => {
			checkbox.click();
			checkbox.focus();
		});
		await press(checkbox, "c");
		expect(keyframeClipboard()?.items).toEqual([
			{ interpolation: "ease-out", offset: 0, property: "opacity", value: 1 },
		]);
		const before = view.patches.length;
		await press(checkbox, "v");
		expect(view.patches.length).toBe(before + 1);
		const curve = view.host.querySelector<HTMLSelectElement>(
			'select[aria-label^="Curve after"]'
		) as HTMLSelectElement;
		await press(curve, "c");
		expect(keyframeClipboard()?.items).toHaveLength(1);
		expect(leaked).toBe(0);
		window.removeEventListener("keydown", listener);
		await view.unmount();
	});

	test("Ctrl+C in a number field stays with the field", async () => {
		setKeyframeClipboard(null);
		const { segment } = fixture();
		const view = await render(segment, 4);
		const field = [
			...view.host.querySelectorAll<HTMLInputElement>("input"),
		].find((input) => input.type !== "checkbox");
		expect(field).toBeDefined();
		await press(field as HTMLInputElement, "c");
		expect(keyframeClipboard()).toBeNull();
		await view.unmount();
	});

	test("paste outside the clip is refused with a status", async () => {
		const { segment } = fixture();
		setKeyframeClipboard({
			items: [{ offset: 0, property: "opacity", value: 0.5 }],
			span: 0,
		});
		const view = await render(segment, 30);
		const list = view.host.querySelector('[role="group"]');
		await press(list as Element, "v");
		expect(view.patches).toHaveLength(0);
		expect(lastStatus(view.runtime)).toBe(
			"Move the playhead inside the clip to paste keyframes."
		);
		await view.unmount();
		setKeyframeClipboard(null);
	});
});
