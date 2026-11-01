import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	type AdjustmentLayer,
	adjustmentLayerEditRequestSchema,
	editAdjustmentLayers,
} from "../../../shared/adjustment.ts";
import { newProject, type Project } from "../../../shared/project.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { createEditorStore } from "../editor/store.ts";

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
const { AdjustmentLayerPanel, adjustmentLayerPanelTab } = await import(
	"./AdjustmentLayerPanel.tsx"
);
const { libraryTabs, panelsFor } = await import("./registry.tsx");
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

const roots: { unmount: () => void }[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

const graded: AdjustmentLayer = {
	end: 3,
	id: uuid(50),
	label: "Night grade",
	opacity: 1,
	saturation: 0.5,
	start: 1,
	track: 2,
};

async function renderPanel(layers: AdjustmentLayer[] = []) {
	const edits: [string, Record<string, unknown>, string][] = [];
	const store = createEditorStore();
	const project: Project = {
		...newProject("Adjustments"),
		...(layers.length ? { adjustmentLayers: layers } : {}),
	};
	const runtime = {
		busy: false,
		project,
		routeEdit: (
			action: string,
			body: Record<string, unknown>,
			describe: (extras: Record<string, unknown>) => string
		) => {
			edits.push([action, body, describe({})]);
			return Promise.resolve({
				extras: body.action === "create" ? { layer: { id: uuid(99) } } : {},
				status: "ok",
			});
		},
		setStatus: () => undefined,
		store,
		time: 4,
	} as unknown as EditorRuntime;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<EditorProvider value={runtime}>
				<AdjustmentLayerPanel />
			</EditorProvider>
		);
	});
	return { container, edits, store };
}

const button = (container: HTMLElement, text: string) =>
	[...container.querySelectorAll("button")].find(
		(element) =>
			element.textContent === text ||
			element.getAttribute("aria-label") === text
	);

async function commit(container: HTMLElement, label: string, value: string) {
	const input = container.querySelector<HTMLInputElement>(
		`input[aria-label="${label}"]`
	);
	await act(async () => {
		if (input) {
			input.value = value;
			input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		}
	});
}

describe("AdjustmentLayerPanel", () => {
	test("has its own library tab", () => {
		expect(adjustmentLayerPanelTab).toEqual({
			label: "Adjustments",
			value: "adjustments",
		});
		expect(libraryTabs().map((tab) => tab.value)).toContain("adjustments");
		expect(panelsFor("adjustments").map((panel) => panel.id)).toEqual([
			"adjustment-layers",
		]);
	});

	test("adds a layer at the playhead and selects it", async () => {
		const { container, edits, store } = await renderPanel();
		expect(container.textContent).toContain("No adjustment layers yet");
		await act(async () => {
			button(container, "Add adjustment layer")?.click();
		});
		expect(edits).toEqual([
			[
				"adjustment-layers",
				{ action: "create", layer: { end: 9, start: 4 } },
				"Added an adjustment layer at the playhead.",
			],
		]);
		expect(store.getState().selection.overlayIds).toEqual([
			{ id: uuid(99), kind: "adjustmentLayers" },
		]);
	});

	test("edits the selected layer through revisioned updates", async () => {
		const { container, edits } = await renderPanel([graded]);
		expect(container.textContent).toContain("Night grade");
		expect(container.textContent).toContain("tracks 1–3");
		await commit(container, "Saturation", "0");
		await commit(container, "Applies through track", "1");
		await act(async () => {
			button(container, "Black and white")?.click();
		});
		expect(edits).toEqual([
			[
				"adjustment-layers",
				{ action: "update", layer: { saturation: 0 }, layerId: uuid(50) },
				"Set the adjustment saturation.",
			],
			[
				"adjustment-layers",
				{ action: "update", layer: { track: 0 }, layerId: uuid(50) },
				"The layer now grades tracks 1–1.",
			],
			[
				"adjustment-layers",
				{ action: "update", layer: { saturation: 0 }, layerId: uuid(50) },
				"Applied the Black and white preset.",
			],
		]);
	});

	test("adds an effect and a mask, and clears the blend mode with null", async () => {
		const { container, edits } = await renderPanel([
			{ ...graded, blendMode: "screen" },
		]);
		const select = (label: string, value: string) => {
			const element = container.querySelector<HTMLSelectElement>(
				`select[aria-label="${label}"]`
			);
			if (element) {
				element.value = value;
				element.dispatchEvent(new Event("change", { bubbles: true }));
			}
		};
		await act(async () => select("Add effect", "grain"));
		await act(async () => select("Add mask", "ellipse"));
		await act(async () => select("Layer blend mode", "normal"));
		const [effect, mask, blend] = edits.map(([, body]) => body.layer);
		expect(effect).toMatchObject({
			effects: [{ amount: 0.5, enabled: true, type: "grain" }],
		});
		expect(mask).toMatchObject({
			masks: [{ height: 0.6, invert: false, shape: "ellipse", width: 0.6 }],
		});
		expect(blend).toEqual({ blendMode: null });
	});

	test("removing a keyframed effect yields an edit that validates", async () => {
		const effectId = uuid(60);
		const animated: AdjustmentLayer = {
			...graded,
			effects: [{ amount: 0.4, enabled: true, id: effectId, type: "grain" }],
			keyframes: [
				{
					id: uuid(61),
					property: "effectAmount",
					target: effectId,
					time: 0.5,
					value: 1,
				},
			],
		};
		const { container, edits } = await renderPanel([animated]);
		const remove = [...container.querySelectorAll("button")].find(
			(element) =>
				element.getAttribute("aria-label")?.startsWith("Remove ") &&
				!element.getAttribute("aria-label")?.endsWith(" mask")
		);
		await act(async () => {
			remove?.click();
		});
		const [, body] = edits.at(-1) ?? [];
		expect(body).toMatchObject({ layer: { effects: null } });
		const { layer } = editAdjustmentLayers(
			{ ...newProject("Adjustments"), adjustmentLayers: [animated] },
			[],
			adjustmentLayerEditRequestSchema.parse({ ...body, revision: 0 })
		);
		expect(layer).not.toHaveProperty("effects");
		expect(layer).not.toHaveProperty("keyframes");
	});

	test("duplicates and deletes the selected layer", async () => {
		const { container, edits, store } = await renderPanel([graded]);
		await act(async () => {
			button(container, "Duplicate")?.click();
		});
		await act(async () => {
			button(container, "Delete")?.click();
		});
		expect(edits.map(([, body]) => body)).toEqual([
			{ action: "duplicate", layerId: uuid(50) },
			{ action: "delete", layerId: uuid(50) },
		]);
		expect(store.getState().selection.overlayIds).toEqual([]);
	});
});
