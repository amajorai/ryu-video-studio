import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	type Asset,
	newSegment,
	type Segment,
	segmentSchema,
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
const { TransformSection } = await import("./TransformSection.tsx");
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

const video: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 4,
	hasAudio: false,
	height: 1080,
	id: "00000000-0000-4000-8000-000000000001",
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
			<TransformSection
				isAudio={!visualControls}
				onChange={(patch) => patches.push(patch)}
				segment={segment}
				visualControls={visualControls}
			/>
		);
	});
	return { container, patches };
}

describe("TransformSection flip, scale and fit", () => {
	test("shows defaults for a legacy clip", async () => {
		const { container } = await renderSection(newSegment(video));
		const flipH = container.querySelector('[aria-label="Flip horizontally"]');
		expect(flipH?.getAttribute("aria-pressed")).toBe("false");
		const fit = container.querySelector<HTMLSelectElement>(
			'select[aria-label="Fit"]'
		);
		expect(fit?.value).toBe("fit");
		const scaleX = container.querySelector<HTMLInputElement>(
			'input[aria-label="Scale X"]'
		);
		expect(scaleX?.value).toBe("1");
	});
	test("patches flips, fit and scale X", async () => {
		const segment = segmentSchema.parse({
			...newSegment(video),
			flipV: true,
		});
		const { container, patches } = await renderSection(segment);
		expect(
			container
				.querySelector('[aria-label="Flip vertically"]')
				?.getAttribute("aria-pressed")
		).toBe("true");
		const flipH = container.querySelector<HTMLElement>(
			'[aria-label="Flip horizontally"]'
		);
		await act(async () => {
			flipH?.click();
		});
		const fit = container.querySelector<HTMLSelectElement>(
			'select[aria-label="Fit"]'
		);
		await act(async () => {
			if (fit) {
				fit.value = "fill";
				fit.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		const scaleX = container.querySelector<HTMLInputElement>(
			'input[aria-label="Scale X"]'
		);
		await act(async () => {
			if (scaleX) {
				scaleX.value = "0.5";
				scaleX.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
				scaleX.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
			}
		});
		expect(patches).toContainEqual({ flipH: true });
		expect(patches).toContainEqual({ fit: "fill" });
		expect(patches).toContainEqual({ scaleX: 0.5 });
	});
	test("audio clips without a visualization hide the controls", async () => {
		const { container } = await renderSection(newSegment(video), false);
		expect(container.querySelector('[aria-label="Fit"]')).toBeNull();
	});
});
