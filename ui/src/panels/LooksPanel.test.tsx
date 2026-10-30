import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type Asset, newProject, newSegment } from "../../../shared/project.ts";
import type { EditorRuntime } from "../editor/runtime.ts";

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
const { LooksPanel, looksPanelTab } = await import("./LooksPanel.tsx");
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

const asset = (kind: Asset["kind"], id: string): Asset => ({
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 8,
	hasAudio: kind !== "image",
	height: 1080,
	id,
	kind,
	name: kind,
	width: 1920,
});
const video = asset("video", "00000000-0000-4000-8000-000000000001");
const audio = asset("audio", "00000000-0000-4000-8000-000000000002");

const roots: { unmount: () => void }[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

async function renderPanel(selected: "video" | "both" | "none") {
	const clip = newSegment(video);
	const sound = { ...newSegment(audio), track: 1 };
	const edits: [string, Record<string, unknown>, string][] = [];
	const apiCalls: string[] = [];
	const runtime = {
		api: (path: string) => {
			apiCalls.push(path);
			return Promise.resolve({ data: "", height: 1, width: 1 });
		},
		assets: [video, audio],
		busy: false,
		project: { ...newProject("Looks"), segments: [clip, sound] },
		routeEdit: (
			action: string,
			body: Record<string, unknown>,
			describe: (extras: Record<string, unknown>) => string
		) => {
			edits.push([action, body, describe({})]);
			return Promise.resolve({ extras: {}, status: "ok" });
		},
		selectedIds:
			selected === "none"
				? []
				: selected === "video"
					? [clip.id]
					: [clip.id, sound.id],
		setStatus: () => undefined,
		time: 2,
	} as unknown as EditorRuntime;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<EditorProvider value={runtime}>
				<LooksPanel />
			</EditorProvider>
		);
	});
	return { apiCalls, clip, container, edits };
}

const lookButton = (container: HTMLElement, name: string) =>
	[...container.querySelectorAll("button")].find((element) =>
		element.getAttribute("aria-label")?.startsWith(`Apply ${name}:`)
	);

describe("LooksPanel", () => {
	test("has its own library tab and lists twelve looks", async () => {
		expect(looksPanelTab).toEqual({ label: "Looks", value: "looks" });
		const { container } = await renderPanel("video");
		expect(
			container.querySelectorAll('[data-testid="looks-grid"] li')
		).toHaveLength(12);
	});

	test("applies a look at the chosen intensity to visual selected clips", async () => {
		const { clip, container, edits } = await renderPanel("both");
		const intensity = container.querySelector<HTMLInputElement>(
			'input[aria-label="Look intensity"]'
		);
		await act(async () => {
			if (intensity) {
				intensity.value = "0.5";
				intensity.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
			}
		});
		await act(async () => {
			lookButton(container, "Noir")?.click();
		});
		expect(edits).toEqual([
			[
				"color",
				{ clipIds: [clip.id], look: { id: "noir", intensity: 0.5 } },
				"Applied the Noir look to the clip.",
			],
		]);
	});

	test("previews without a selection render the frame as it is", async () => {
		const { apiCalls, container } = await renderPanel("none");
		const previewButton = [...container.querySelectorAll("button")].find(
			(element) => element.textContent === "Preview looks at the playhead"
		);
		await act(async () => {
			previewButton?.click();
			await Promise.resolve();
		});
		expect(apiCalls[0]).toMatch(/\/inspect-frame\?time=2\.000$/);
	});

	test("looks are disabled without a visual selection", async () => {
		const { container } = await renderPanel("none");
		expect(lookButton(container, "Vivid")?.hasAttribute("disabled")).toBe(true);
		expect(container.textContent).toContain("Select one or more visual clips");
	});

	test("previews render the frame under the playhead", async () => {
		const { apiCalls, clip, container } = await renderPanel("video");
		const previewButton = [...container.querySelectorAll("button")].find(
			(element) => element.textContent === "Preview looks at the playhead"
		);
		await act(async () => {
			previewButton?.click();
			await Promise.resolve();
		});
		// The selected clip renders ungraded: a look replaces its grade.
		expect(apiCalls[0]).toMatch(
			/\/projects\/.+\/inspect-frame\?time=2\.000&ungraded=[0-9a-f-]{36}$/
		);
		expect(apiCalls[0]).toEndWith(`ungraded=${clip.id}`);
	});
});
