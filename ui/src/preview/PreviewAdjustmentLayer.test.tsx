import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AdjustmentLayer } from "../../../shared/adjustment.ts";
import { MAX_TRACK_INDEX } from "../../../shared/limits.ts";
import { newProject, type Project } from "../../../shared/project.ts";
import { defaultMask } from "../../../shared/schema/mask.ts";
import type { EditorRuntime } from "../editor/runtime.ts";

/** `.studio-title`, the highest DOM content layer in `studio.css`. */
const TITLE_Z_INDEX = 30;

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
const { EditorProvider } = await import("../editor/context.tsx");
const {
	adjustmentFilterCss,
	adjustmentLayerStyle,
	PreviewAdjustmentLayer,
	SERVER_FRAME_DELAY_MS,
	SERVER_FRAME_Z_INDEX,
} = await import("./PreviewAdjustmentLayer.tsx");
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

const uuid = (n: number) =>
	`00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function layer(overrides: Partial<AdjustmentLayer> = {}): AdjustmentLayer {
	return {
		end: 2,
		id: uuid(50),
		label: "Grade",
		opacity: 1,
		saturation: 0,
		start: 1,
		track: 1,
		...overrides,
	};
}

const project = (layers: AdjustmentLayer[]): Project => ({
	...newProject("Adjustment preview"),
	adjustmentLayers: layers,
});

const roots: { unmount: () => void }[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

async function render(
	timeline: Project,
	time: number,
	runtime?: Partial<EditorRuntime>
) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const stage = <PreviewAdjustmentLayer project={timeline} time={time} />;
	await act(async () => {
		root.render(
			runtime ? (
				<EditorProvider value={runtime as EditorRuntime}>
					{stage}
				</EditorProvider>
			) : (
				stage
			)
		);
	});
	return container;
}

describe("adjustment layer styles", () => {
	test("filters, stacking and opacity follow the layer", () => {
		const style = adjustmentLayerStyle(layer({ opacity: 0.5 }), 1.5, {
			height: 1080,
			width: 1920,
		});
		expect(style.zIndex).toBe(2);
		expect(style.opacity).toBe(0.5);
		expect(style.backdropFilter).toBe(
			"brightness(1) contrast(1) saturate(0) hue-rotate(0deg)"
		);
		expect(style.WebkitBackdropFilter).toBe(style.backdropFilter);
		expect(style).not.toHaveProperty("maskImage");
	});

	test("keyframes resolve on the project clock and CSS effects append", () => {
		const graded = layer({
			effects: [{ amount: 1, enabled: true, type: "invert" }],
			keyframes: [
				{ id: uuid(60), property: "brightness", time: 1, value: 0.5 },
			],
			saturation: 1,
			start: 2,
			end: 4,
		});
		expect(adjustmentFilterCss(graded, 2.5)).toBe(
			"brightness(1.25) contrast(1) saturate(1) hue-rotate(0deg) invert(1)"
		);
	});

	test("masks become CSS mask layers on the project frame", () => {
		const style = adjustmentLayerStyle(
			layer({ masks: [defaultMask("ellipse", uuid(70))] }),
			1.5,
			{ height: 1080, width: 1920 }
		);
		expect(String(style.maskImage)).toStartWith('url("data:image/svg+xml,');
		expect(style.maskSize).toBe("100% 100%");
	});
});

describe("PreviewAdjustmentLayer", () => {
	test("draws active layers only, without an editor", async () => {
		const timeline = project([
			layer(),
			layer({ id: uuid(51), start: 3, end: 4 }),
			layer({ id: uuid(52), saturation: undefined }),
		]);
		const inside = await render(timeline, 1.5);
		const drawn = inside.querySelectorAll("[data-adjustment-layer]");
		expect(drawn).toHaveLength(1);
		expect(drawn[0]?.getAttribute("data-adjustment-layer")).toBe(uuid(50));
		const outside = await render(timeline, 2.5);
		expect(outside.innerHTML).toBe("");
	});

	test("swaps approximate layers for the server frame while paused", async () => {
		const requests: string[] = [];
		const timeline = project([
			layer({
				effects: [{ amount: 1, enabled: true, type: "grain" }],
				track: 3,
			}),
		]);
		const container = await render(timeline, 1.5, {
			api: (path: string) => {
				requests.push(path);
				return Promise.resolve({ data: "AAAA", height: 1, width: 1 });
			},
			dirty: false,
			playing: false,
		});
		expect(
			container
				.querySelector("[data-adjustment-layer]")
				?.getAttribute("data-approximate")
		).toBe("true");
		await act(async () => {
			await Bun.sleep(SERVER_FRAME_DELAY_MS + 30);
		});
		expect(requests).toEqual([
			`/projects/${timeline.id}/inspect-frame?time=1.500`,
		]);
		const image = container.querySelector<HTMLImageElement>(
			'[data-testid="adjustment-server-frame"]'
		);
		expect(image?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
		// The frame already holds every track, title and caption, so it
		// covers all DOM content layers instead of sitting at the layer track.
		expect(image?.style.zIndex).toBe(String(SERVER_FRAME_Z_INDEX));
		expect(SERVER_FRAME_Z_INDEX).toBeGreaterThan(MAX_TRACK_INDEX + 1);
		expect(SERVER_FRAME_Z_INDEX).toBeGreaterThan(TITLE_Z_INDEX);
	});

	test("keeps the CSS approximation while playing or with unsaved edits", async () => {
		const requests: string[] = [];
		const api = (path: string) => {
			requests.push(path);
			return Promise.resolve({ data: "AAAA" });
		};
		const timeline = project([layer({ blendMode: "screen" })]);
		await render(timeline, 1.5, { api, dirty: false, playing: true });
		await render(timeline, 1.5, { api, dirty: true, playing: false });
		await act(async () => {
			await Bun.sleep(SERVER_FRAME_DELAY_MS + 30);
		});
		expect(requests).toEqual([]);
	});
});
