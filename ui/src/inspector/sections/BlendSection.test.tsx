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
const { BlendSection, blendPreviewNote } = await import("./BlendSection.tsx");
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
			<BlendSection
				isAudio={!visualControls}
				onChange={(patch) => patches.push(patch)}
				segment={segment}
				visualControls={visualControls}
			/>
		);
	});
	return { container, patches };
}

const select = (container: HTMLElement) =>
	container.querySelector<HTMLSelectElement>('select[aria-label="Blend mode"]');

async function choose(container: HTMLElement, value: string) {
	const element = select(container);
	await act(async () => {
		if (element) {
			element.value = value;
			element.dispatchEvent(new Event("change", { bubbles: true }));
		}
	});
}

describe("BlendSection", () => {
	test("a legacy clip shows Normal with every mode offered", async () => {
		const { container } = await renderSection(newSegment(video));
		const element = select(container);
		expect(element?.value).toBe("normal");
		expect(element?.options).toHaveLength(20);
		expect(container.textContent).not.toContain(
			"the paused preview shows the exact frame when it can be rendered"
		);
	});

	test("choosing a mode patches blendMode; Normal clears it", async () => {
		const segment = segmentSchema.parse({
			...newSegment(video),
			blendMode: "screen",
		});
		const { container, patches } = await renderSection(segment);
		expect(select(container)?.value).toBe("screen");
		await choose(container, "multiply");
		await choose(container, "normal");
		expect(patches).toEqual([
			{ blendMode: "multiply" },
			{ blendMode: undefined },
		]);
	});

	test("modes the browser lacks say the preview is approximate", async () => {
		const segment = segmentSchema.parse({
			...newSegment(video),
			blendMode: "subtract",
		});
		const { container } = await renderSection(segment);
		expect(container.textContent).toContain(
			"and during playback: shown as Difference"
		);
	});

	test("soft light and partly transparent add are flagged", async () => {
		const soft = await renderSection(
			segmentSchema.parse({ ...newSegment(video), blendMode: "soft-light" })
		);
		expect(soft.container.textContent).toContain(
			"and during playback: the browser's soft light curve differs slightly"
		);
		const opaqueAdd = await renderSection(
			segmentSchema.parse({ ...newSegment(video), blendMode: "add" })
		);
		expect(opaqueAdd.container.textContent).not.toContain(
			"the paused preview shows the exact frame when it can be rendered"
		);
		const fadedAdd = await renderSection(
			segmentSchema.parse({
				...newSegment(video),
				blendMode: "add",
				opacity: 0.5,
			})
		);
		expect(fadedAdd.container.textContent).toContain(
			"add brightens more while the clip is partly transparent"
		);
	});

	test("a clip background makes any blended preview approximate", async () => {
		const { container } = await renderSection(
			segmentSchema.parse({
				...newSegment(video),
				background: { color: "#ffffff", type: "color" },
				blendMode: "multiply",
			})
		);
		expect(container.textContent).toContain(
			"the clip background blends separately from the clip"
		);
	});

	test("notes join every reason in order", () => {
		expect(blendPreviewNote("multiply", [])).toBeUndefined();
		expect(
			blendPreviewNote("pin-light", ["css-fallback", "clip-background"])
		).toBe(
			"Once your edits are saved, the paused preview shows the exact frame when it can be rendered. Otherwise, and during playback: shown as Hard light; the clip background blends separately from the clip. Exports and frame checks use exact pin light."
		);
		expect(blendPreviewNote("luminosity", ["component-ycbcr"])).toBe(
			"Once your edits are saved, the paused preview shows the exact frame when it can be rendered. Otherwise, and during playback: the browser mixes hue, saturation and luma in RGB rather than YCbCr. Exports and frame checks use exact luminosity."
		);
	});

	test("a clip the WebGL2 compositor can draw says when it is exact", () => {
		expect(blendPreviewNote("subtract", ["css-fallback"], true)).toBe(
			"With WebGL2 the preview shows exact subtract for this clip, playing or paused, while every clip on screen with it can be composited. Otherwise: shown as Difference; once your edits are saved, the paused preview shows the exact frame."
		);
		expect(blendPreviewNote("multiply", [], true)).toBeUndefined();
	});

	test("the note never claims the exact frame is on screen", () => {
		// Right after a blend change the edit is unsaved and the preview still
		// shows the CSS approximation; a failed frame render keeps it too.
		const note = blendPreviewNote("subtract", ["css-fallback"]) ?? "";
		expect(note).not.toMatch(/^Exact frame shown/);
		expect(note).toContain("Once your edits are saved");
		expect(note).toContain("when it can be rendered");
	});

	test("audio clips without a visualization hide the control", async () => {
		const { container } = await renderSection(newSegment(video), false);
		expect(select(container)).toBeNull();
	});
});
