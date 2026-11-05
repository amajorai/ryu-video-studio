import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { defaultMask } from "../../../../shared/masks.ts";
import {
	type Asset,
	newSegment,
	type Segment,
} from "../../../../shared/project.ts";

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
	value: true,
	configurable: true,
	writable: true,
});
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MaskSection } = await import("./MaskSection.tsx");
const { getActiveMask, setActiveMask } = await import("./mask-selection.ts");
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

const ID = "00000000-0000-4000-8000-000000000001";
const ID2 = "00000000-0000-4000-8000-000000000002";

const video: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 4,
	hasAudio: false,
	height: 1080,
	id: "00000000-0000-4000-8000-0000000000a1",
	kind: "video",
	name: "Clip",
	width: 1920,
};

async function renderSection(
	segment: Segment,
	visualControls = true
): Promise<{ container: HTMLElement; patches: Partial<Segment>[] }> {
	const patches: Partial<Segment>[] = [];
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<MaskSection
				isAudio={!visualControls}
				onChange={(patch) => patches.push(patch)}
				segment={segment}
				visualControls={visualControls}
			/>
		);
	});
	return { container, patches };
}

async function change(element: HTMLSelectElement | null, value: string) {
	await act(async () => {
		if (element) {
			element.value = value;
			element.dispatchEvent(new Event("change", { bubbles: true }));
		}
	});
}

async function blurWith(element: HTMLInputElement | null, value: string) {
	await act(async () => {
		if (element) {
			element.value = value;
			element.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
			element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		}
	});
}

beforeEach(() => {
	setActiveMask(null);
});

describe("MaskSection", () => {
	test("adds a mask of the chosen shape and makes it active", async () => {
		const segment = newSegment(video);
		const { container, patches } = await renderSection(segment);
		expect(container.querySelector('[aria-label="Mask shape"]')).toBeNull();
		await change(
			container.querySelector<HTMLSelectElement>(
				'select[aria-label="New mask shape"]'
			),
			"star"
		);
		const add = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Add mask"
		);
		await act(async () => {
			add?.click();
		});
		const masks = patches.at(-1)?.masks;
		expect(masks).toHaveLength(1);
		expect(masks?.[0]).toMatchObject({ points: 5, shape: "star" });
		expect(getActiveMask()).toEqual({
			maskId: masks?.[0]?.id ?? "",
			segmentId: segment.id,
		});
	});

	test("edits the active mask's fields", async () => {
		const segment: Segment = {
			...newSegment(video),
			masks: [defaultMask("ellipse", ID), defaultMask("rectangle", ID2)],
		};
		const { container, patches } = await renderSection(segment);
		const shape = container.querySelector<HTMLSelectElement>(
			'select[aria-label="Mask shape"]'
		);
		expect(shape?.value).toBe("ellipse");
		await blurWith(
			container.querySelector<HTMLInputElement>(
				'input[aria-label="Mask feather"]'
			),
			"0.4"
		);
		expect(patches.at(-1)?.masks?.[0]).toMatchObject({ feather: 0.4, id: ID });
		await act(async () => {
			container
				.querySelector<HTMLElement>('[aria-label="Invert mask"]')
				?.click();
		});
		expect(patches.at(-1)?.masks?.[0]).toMatchObject({ invert: true });
		await change(shape, "polygon");
		expect(patches.at(-1)?.masks?.[0]).toMatchObject({
			shape: "polygon",
			sides: 6,
		});
	});

	test("edits the active mask's outline stroke", async () => {
		const segment: Segment = {
			...newSegment(video),
			masks: [defaultMask("rectangle", ID)],
		};
		const { container, patches } = await renderSection(segment);
		const align = container.querySelector<HTMLSelectElement>(
			'select[aria-label="Mask stroke alignment"]'
		);
		expect(align?.value).toBe("center");
		expect(align?.disabled).toBe(true);
		expect(
			container.querySelector('[aria-label="Mask stroke color"]')
		).not.toBeNull();
		await blurWith(
			container.querySelector<HTMLInputElement>(
				'input[aria-label="Mask stroke width"]'
			),
			"0.02"
		);
		expect(patches.at(-1)?.masks?.[0]).toMatchObject({
			id: ID,
			strokeWidth: 0.02,
		});
		await change(align, "outside");
		expect(patches.at(-1)?.masks?.[0]).toMatchObject({
			strokeAlign: "outside",
		});
	});

	test("text masks offer no stroke", async () => {
		const { container } = await renderSection({
			...newSegment(video),
			masks: [defaultMask("text", ID)],
		});
		expect(
			container.querySelector('input[aria-label="Mask stroke width"]')
		).toBeNull();
		expect(container.textContent).toContain(
			"Text masks have no outline stroke."
		);
	});

	test("switches the active mask and removes it", async () => {
		const segment: Segment = {
			...newSegment(video),
			masks: [defaultMask("ellipse", ID), defaultMask("text", ID2)],
		};
		const { container, patches } = await renderSection(segment);
		await act(async () => {
			container
				.querySelector<HTMLElement>('[aria-label="Edit mask 2: Text"]')
				?.click();
		});
		expect(getActiveMask()).toEqual({ maskId: ID2, segmentId: segment.id });
		expect(
			container.querySelector<HTMLInputElement>('input[aria-label="Mask text"]')
				?.value
		).toBe("Text");
		await act(async () => {
			container
				.querySelector<HTMLElement>('[aria-label="Remove mask"]')
				?.click();
		});
		expect(patches.at(-1)).toEqual({ masks: [defaultMask("ellipse", ID)] });
	});

	test("removing a keyframed mask drops its keyframes", async () => {
		const keyframes: Segment["keyframes"] = [
			{
				id: "00000000-0000-4000-8000-0000000000b1",
				property: "maskX",
				target: ID,
				time: 0,
				value: 0.2,
			},
			{
				id: "00000000-0000-4000-8000-0000000000b2",
				property: "maskFeather",
				target: ID2,
				time: 0,
				value: 0.1,
			},
			{
				id: "00000000-0000-4000-8000-0000000000b3",
				property: "opacity",
				time: 0,
				value: 1,
			},
		];
		const segment: Segment = {
			...newSegment(video),
			keyframes,
			masks: [defaultMask("ellipse", ID), defaultMask("rectangle", ID2)],
		};
		setActiveMask({ maskId: ID, segmentId: segment.id });
		const { container, patches } = await renderSection(segment);
		await act(async () => {
			container
				.querySelector<HTMLElement>('[aria-label="Remove mask"]')
				?.click();
		});
		expect(patches.at(-1)).toEqual({
			keyframes: keyframes.slice(1),
			masks: [defaultMask("rectangle", ID2)],
		});
	});

	test("the add control is disabled at four masks", async () => {
		const ids = [1, 2, 3, 4].map(
			(index) => `00000000-0000-4000-8000-00000000000${index}`
		);
		const { container } = await renderSection({
			...newSegment(video),
			masks: ids.map((id) => defaultMask("ellipse", id)),
		});
		const add = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Add mask"
		);
		expect(add?.disabled).toBe(true);
	});

	test("audio clips without a visualization hide the controls", async () => {
		const { container } = await renderSection(newSegment(video), false);
		expect(container.innerHTML).toBe("");
	});
});
