import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// React DOM decides at import time whether `input` events exist, so it loads
// after the DOM is registered (typing would otherwise never reach onChange).
GlobalRegistrator.register();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const previousActEnvironment = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	configurable: true,
	value: true,
	writable: true,
});
const { assetSchema } = await import("../../../shared/project.ts");
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, testProject } = await import(
	"../editor/test-runtime.ts"
);
const { StickerPanel, STICKER_GRID_LIMIT } = await import("./StickerPanel.tsx");
const panelSlot = await import("../panels/StickerPanel.tsx");
const { STICKER_CATALOG } = await import("../../../shared/stickers/catalog.ts");

type Dependencies = NonNullable<
	Parameters<typeof StickerPanel>[0]
>["dependencies"];

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

async function mount(
	runtime: ReturnType<typeof createTestRuntime>,
	dependencies?: Dependencies
) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<EditorProvider value={{ ...runtime }}>
				<StickerPanel dependencies={dependencies} />
			</EditorProvider>
		);
	});
	return {
		host,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

const stickerButtons = (host: HTMLElement) =>
	Array.from(
		host.querySelectorAll<HTMLButtonElement>(
			'button[aria-label^="Add sticker"]'
		)
	);

async function typeSearch(host: HTMLElement, value: string) {
	const input = host.querySelector<HTMLInputElement>(
		'input[aria-label="Search stickers"]'
	);
	if (!input) {
		throw new Error("missing search");
	}
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set;
		setter?.call(input, value);
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}

describe("StickerPanel", () => {
	test("declares its own library tab and re-exports the panel", () => {
		expect(panelSlot.stickerPanelTab).toEqual({
			label: "Stickers",
			value: "stickers",
		});
		expect(panelSlot.StickerPanel).toBe(StickerPanel);
	});

	test("lists stickers up to the grid limit and searches by keyword", async () => {
		const { asset, project } = testProject();
		const view = await mount(createTestRuntime(project, [asset]));
		expect(stickerButtons(view.host)).toHaveLength(
			Math.min(STICKER_GRID_LIMIT, STICKER_CATALOG.length)
		);
		expect(view.host.textContent).toContain(
			`Showing ${STICKER_GRID_LIMIT} of ${STICKER_CATALOG.length}`
		);
		expect(view.host.textContent).toContain("CC-BY 4.0");
		await typeSearch(view.host, "japan");
		expect(stickerButtons(view.host).map((button) => button.title)).toContain(
			"Flag of Japan"
		);
		await typeSearch(view.host, "qqqqqq");
		expect(stickerButtons(view.host)).toHaveLength(0);
		expect(view.host.textContent).toContain("No stickers match");
		await view.unmount();
	});

	test("choosing a sticker imports it and places a clip at the playhead", async () => {
		const { asset, project } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		runtime.time = 4;
		const imported: unknown[] = [];
		const dependencies: Dependencies = {
			importAsset: (body) => {
				imported.push(body);
				return Promise.resolve(
					assetSchema.parse({
						createdAt: new Date(0).toISOString(),
						duration: 5,
						hasAudio: false,
						height: 1024,
						id: crypto.randomUUID(),
						kind: "image",
						name: body.name,
						origin: body.origin,
						width: 1024,
					})
				);
			},
			rasterize: () => Promise.resolve(new Blob([new Uint8Array([1, 2, 3])])),
		};
		const view = await mount(runtime, dependencies);
		await typeSearch(view.host, "hexagon");
		const [hexagon] = stickerButtons(view.host);
		expect(hexagon?.title).toBe("Hexagon");
		await act(async () => {
			hexagon?.click();
			await Promise.resolve();
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(imported).toHaveLength(1);
		const placed = runtime.project?.segments.at(-1);
		expect(placed).toMatchObject({ start: 4, track: 1 });
		expect(placed?.animation?.in).toBe("pop");
		await view.unmount();
	});
});
