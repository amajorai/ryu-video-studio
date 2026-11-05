import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	type Asset,
	newProject,
	newSegment,
	type Segment,
	segmentSchema,
} from "../../../../shared/project.ts";
import type { EditorRuntime } from "../../editor/runtime.ts";

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
const { EditorProvider } = await import("../../editor/context.tsx");
const { KeySection } = await import("./KeySection.tsx");
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
	duration: 8,
	hasAudio: false,
	height: 1080,
	id: "00000000-0000-4000-8000-000000000001",
	kind: "video",
	name: "Green screen",
	width: 1920,
};

const allFilters = {
	backgroundkey: true,
	chromakey: true,
	colorkey: true,
	despill: true,
	hsvkey: true,
	lumakey: true,
};
const allEncoders = { prores_ks: true };

interface Rendered {
	container: HTMLElement;
	patches: Partial<Segment>[];
	/** Render the section again for another selected clip. */
	rerender: (next: Segment) => Promise<void>;
}

async function renderSection(
	segment: Segment,
	options: {
		asset?: Asset;
		encoders?: Record<string, boolean>;
		filters?: Record<string, boolean>;
		isAudio?: boolean;
	} = {}
): Promise<Rendered> {
	const asset = options.asset ?? video;
	const patches: Partial<Segment>[] = [];
	const project = { ...newProject("Keying"), segments: [segment] };
	const runtime = {
		act: async (operation: () => Promise<void>) => await operation(),
		api: async (path: string) => {
			await Promise.resolve();
			if (path === "/capabilities") {
				return {
					encoders: options.encoders ?? allEncoders,
					filters: options.filters ?? allFilters,
				};
			}
			throw new Error(`Unexpected request ${path}`);
		},
		assets: [asset],
		busy: false,
		project,
		setStatus: () => undefined,
		time: 1,
	} as unknown as EditorRuntime;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const draw = (current: Segment) =>
		root.render(
			<EditorProvider value={runtime}>
				<KeySection
					isAudio={options.isAudio ?? false}
					onChange={(patch) => patches.push(patch)}
					segment={current}
					visualControls={!options.isAudio}
				/>
			</EditorProvider>
		);
	await act(async () => {
		draw(segment);
	});
	// Let the capabilities request settle.
	await act(async () => {
		await Promise.resolve();
	});
	const rerender = async (next: Segment) => {
		project.segments = [next];
		await act(async () => {
			draw(next);
		});
	};
	return { container, patches, rerender };
}

const keyed = (key: Segment["key"]): Segment =>
	segmentSchema.parse({ ...newSegment(video), key });

const typeSelect = (container: HTMLElement) =>
	container.querySelector<HTMLSelectElement>('select[aria-label="Key type"]');

const button = (container: HTMLElement, label: string) =>
	[...container.querySelectorAll("button")].find(
		(element) => element.textContent?.trim() === label
	);

async function choose(container: HTMLElement, value: string) {
	const element = typeSelect(container);
	await act(async () => {
		if (element) {
			element.value = value;
			element.dispatchEvent(new Event("change", { bubbles: true }));
		}
	});
}

describe("KeySection", () => {
	test("renders nothing for audio clips", async () => {
		const { container } = await renderSection(newSegment(video), {
			isAudio: true,
		});
		expect(container.innerHTML).toBe("");
	});

	test("a legacy clip shows Off and every key type", async () => {
		const { container } = await renderSection(newSegment(video));
		const select = typeSelect(container);
		expect(select?.value).toBe("off");
		expect([...(select?.options ?? [])].map((option) => option.value)).toEqual([
			"off",
			"chroma",
			"color",
			"hsv",
			"luma",
		]);
		expect(button(container, "Pick from preview")).toBeUndefined();
	});

	test("choosing a key sets a green-screen key; Off clears it", async () => {
		const { container, patches } = await renderSection(newSegment(video));
		await choose(container, "chroma");
		expect(patches.at(-1)).toEqual({
			key: { color: "#00ff00", type: "chroma" },
		});
		await choose(container, "luma");
		expect(patches.at(-1)).toEqual({ key: { type: "luma" } });
		await choose(container, "off");
		expect(patches.at(-1)).toEqual({ key: undefined });
	});

	test("colour keys offer the eyedropper and spill; luma keys do not", async () => {
		const chroma = await renderSection(
			keyed({ color: "#00ff00", type: "chroma" })
		);
		expect(button(chroma.container, "Pick from preview")).toBeDefined();
		expect(
			chroma.container.querySelector('input[aria-label="Green spill"]')
		).not.toBeNull();
		expect(
			chroma.container.querySelector('input[aria-label="Similarity"]')
		).not.toBeNull();
		const luma = await renderSection(keyed({ type: "luma" }));
		expect(button(luma.container, "Pick from preview")).toBeUndefined();
		expect(
			luma.container.querySelector('input[aria-label="Luma low"]')
		).not.toBeNull();
		expect(
			luma.container.querySelector('input[aria-label="Softness"]')
		).not.toBeNull();
	});

	test("missing filters disable key types and explain fallbacks", async () => {
		const { container } = await renderSection(
			keyed({ color: "#00ff00", spill: 0.5, type: "hsv" }),
			{ filters: { ...allFilters, despill: false, hsvkey: false } }
		);
		const hsv = [...(typeSelect(container)?.options ?? [])].find(
			(option) => option.value === "hsv"
		);
		expect(hsv?.textContent).toContain("unavailable in this FFmpeg");
		expect(container.textContent).toContain("renders as a chroma key");
		expect(container.textContent).toContain("spill suppression is skipped");
		expect(
			container.querySelector('input[aria-label="Green spill"]')
		).toBeNull();
	});

	test("the cutout is gated on backgroundkey and an alpha encoder", async () => {
		const ready = await renderSection(newSegment(video));
		expect(
			button(ready.container, "Swap clip to cutout")?.hasAttribute("disabled")
		).toBe(false);
		const noFilter = await renderSection(newSegment(video), {
			filters: { ...allFilters, backgroundkey: false },
		});
		expect(
			button(noFilter.container, "Swap clip to cutout")?.hasAttribute(
				"disabled"
			)
		).toBe(true);
		expect(noFilter.container.textContent).toContain("no backgroundkey filter");
		// VP9 alone is not enough: exports would decode it without alpha.
		const noEncoder = await renderSection(newSegment(video), {
			encoders: { "libvpx-vp9": true, prores_ks: false },
		});
		expect(noEncoder.container.textContent).toContain("no prores_ks encoder");
		expect(
			button(noEncoder.container, "Swap clip to cutout")?.hasAttribute(
				"disabled"
			)
		).toBe(true);
	});

	test("the cutout refuses media too long for its resolution", async () => {
		const long: Asset = { ...video, duration: 300, frameRate: 30 };
		const { container } = await renderSection(newSegment(long), {
			asset: long,
		});
		expect(container.textContent).toContain("1920×1080 media up to 115 s");
		expect(
			button(container, "Swap clip to cutout")?.hasAttribute("disabled")
		).toBe(true);
	});

	test("Cancel picking disarms the eyedropper instead of re-arming it", async () => {
		const { container } = await renderSection(
			keyed({ color: "#00ff00", type: "chroma" })
		);
		await act(async () => {
			button(container, "Pick from preview")?.click();
		});
		const armed = button(container, "Cancel picking");
		expect(armed?.getAttribute("aria-pressed")).toBe("true");
		// A real press fires pointerdown on the button (the topmost element
		// under the pointer, outside the preview) before its click.
		const original = document.elementsFromPoint;
		document.elementsFromPoint = () => (armed ? [armed] : []);
		try {
			// Separate acts: the browser re-renders between the two events.
			await act(async () => {
				armed?.dispatchEvent(
					new PointerEvent("pointerdown", { bubbles: true, button: 0 })
				);
			});
			await act(async () => {
				armed?.click();
			});
		} finally {
			document.elementsFromPoint = original;
		}
		const idle = button(container, "Pick from preview");
		expect(idle?.getAttribute("aria-pressed")).toBe("false");
		// Disarmed for real: a later press elsewhere changes nothing.
		await act(async () => {
			document.body.dispatchEvent(
				new PointerEvent("pointerdown", { bubbles: true, button: 0 })
			);
		});
		expect(button(container, "Pick from preview")).toBeDefined();
	});

	test("selecting another clip resets cutout and eyedropper state", async () => {
		const first = keyed({ color: "#00ff00", type: "chroma" });
		const second = keyed({ color: "#00ff00", type: "chroma" });
		const { container, rerender } = await renderSection(first);
		const plate = () =>
			container.querySelector<HTMLInputElement>(
				'input[aria-label="Clean plate (source s)"]'
			);
		await act(async () => {
			const input = plate();
			if (input) {
				input.value = "7.5";
				input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
			}
		});
		expect(plate()?.value).toBe("7.5");
		await act(async () => {
			button(container, "Pick from preview")?.click();
		});
		expect(button(container, "Cancel picking")).toBeDefined();
		await rerender(second);
		// The playhead (1 s) over the new clip, not the old clip's 7.5.
		expect(plate()?.value).toBe("1");
		expect(button(container, "Pick from preview")).toBeDefined();
	});

	test("a cutout clip is not cut out again", async () => {
		const cutout: Asset = { ...video, derivation: "cutout" };
		const { container } = await renderSection(newSegment(cutout), {
			asset: cutout,
		});
		expect(container.textContent).toContain(
			"already plays a background cutout"
		);
		expect(button(container, "Swap clip to cutout")).toBeUndefined();
	});
});
