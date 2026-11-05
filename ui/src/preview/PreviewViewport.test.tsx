import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import { newProject, type Project } from "../../../shared/project.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { createTestRuntime } from "../editor/test-runtime.ts";

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
const { EditorProvider } = await import("../editor/context.tsx");
const { PreviewViewport } = await import("./PreviewViewport.tsx");
const { PreviewGuides } = await import("./overlays/PreviewGuides.tsx");
const { PreviewToolbar, fitZoomLabel } = await import("./PreviewToolbar.tsx");

const originalRect = HTMLElement.prototype.getBoundingClientRect;
afterAll(() => {
	HTMLElement.prototype.getBoundingClientRect = originalRect;
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

/** Every element measures as a 960 x 540 stage (half of a 1080p frame at fit). */
function stubStageSize() {
	HTMLElement.prototype.getBoundingClientRect = () =>
		({
			bottom: 540,
			height: 540,
			left: 0,
			right: 960,
			toJSON: () => ({}),
			top: 0,
			width: 960,
			x: 0,
			y: 0,
		}) as DOMRect;
}

function frameProject(): Project {
	return { ...newProject("Viewport"), height: 1080, width: 1920 };
}

async function render(node: ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(node);
	});
	return {
		container,
		async unmount() {
			await act(async () => {
				root.unmount();
			});
			container.remove();
		},
	};
}

function editorView(runtime: EditorRuntime, project: Project) {
	return render(
		<EditorProvider value={runtime}>
			<PreviewViewport project={project}>
				<div className="studio-preview-frame">
					<PreviewGuides playing={false} project={project} time={0} />
				</div>
			</PreviewViewport>
		</EditorProvider>
	);
}

async function changeSelect(select: HTMLSelectElement, value: string) {
	await act(async () => {
		select.value = value;
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

async function pointer(
	target: Element,
	type: string,
	init: { button?: number; clientX: number; clientY: number }
) {
	await act(async () => {
		target.dispatchEvent(
			new PointerEvent(type, { bubbles: true, pointerId: 7, ...init })
		);
	});
}

describe("PreviewViewport", () => {
	test("adds no DOM outside an editor", async () => {
		const project = frameProject();
		const view = await render(
			<PreviewViewport project={project}>
				<div className="studio-preview-frame" />
			</PreviewViewport>
		);
		expect(view.container.firstElementChild?.className).toBe(
			"studio-preview-frame"
		);
		expect(view.container.querySelector("[data-preview-toolbar]")).toBeNull();
		await view.unmount();
	});

	test("the toolbar drives zoom; rate and quality stay hidden until applied", async () => {
		stubStageSize();
		const project = frameProject();
		const runtime = createTestRuntime(project);
		const view = await editorView(runtime, project);
		const select = (label: string) =>
			view.container.querySelector(
				`select[aria-label="${label}"]`
			) as HTMLSelectElement | null;

		expect(select("Preview zoom")?.selectedOptions[0]?.textContent).toBe(
			"Fit (50%)"
		);
		await changeSelect(select("Preview zoom") as HTMLSelectElement, "2");
		expect(runtime.store.getState().previewZoom).toBe(2);
		const layer = view.container.querySelector(
			"[data-preview-zoom]"
		) as HTMLElement;
		// 200% of a frame that fits at 50% is a 4x CSS scale.
		expect(layer.style.transform).toBe("translate(0px, 0px) scale(4)");

		// The media layer and GPU passes apply these, so the viewport offers them.
		expect(select("Playback rate") === null).toBe(false);
		expect(select("Preview quality") === null).toBe(false);
		expect(
			[...document.querySelectorAll("button")].some(
				(button) => button.textContent === "Use proxies"
			)
		).toBe(true);

		await act(async () => {
			runtime.store.setState({ previewQuality: "half" });
		});
		const viewport = view.container.querySelector(
			"[data-preview-viewport]"
		) as HTMLElement;
		expect(viewport.dataset.previewQuality).toBe("half");
		const stage = view.container.querySelector(
			'[data-shortcut-scope="preview"]'
		) as HTMLElement;
		expect(stage.style.getPropertyValue("--studio-preview-quality-scale")).toBe(
			"0.5"
		);
		await view.unmount();
	});

	test("the rate and quality menus write the store once enabled", async () => {
		const project = frameProject();
		const runtime = createTestRuntime(project);
		const view = await render(
			<PreviewToolbar
				fitScale={0.5}
				fullscreen={false}
				runtime={runtime}
				showPlaybackRate
				showQuality
			/>
		);
		const select = (label: string) =>
			view.container.querySelector(
				`select[aria-label="${label}"]`
			) as HTMLSelectElement;
		await changeSelect(select("Playback rate"), "0.25");
		expect(runtime.store.getState().playbackRate).toBe(0.25);
		await changeSelect(select("Preview quality"), "quarter");
		expect(runtime.store.getState().previewQuality).toBe("quarter");
		await view.unmount();
	});

	test("the fit label shows the real fit scale outside the zoom range", () => {
		// A 4K frame in a 640 x 360 pane fits at 1/6.
		expect(fitZoomLabel(640 / 3840)).toBe("Fit (17%)");
		expect(fitZoomLabel(6)).toBe("Fit (600%)");
		expect(fitZoomLabel(0)).toBe("Fit");
		expect(fitZoomLabel(Number.NaN)).toBe("Fit");
	});

	test("middle-button drag pans a zoomed frame within its limits", async () => {
		stubStageSize();
		const project = frameProject();
		const runtime = createTestRuntime(project);
		runtime.store.setState({ previewZoom: 1 });
		const view = await editorView(runtime, project);
		const stage = view.container.querySelector(
			'[data-shortcut-scope="preview"]'
		) as HTMLElement;
		const layer = view.container.querySelector(
			"[data-preview-zoom]"
		) as HTMLElement;

		await pointer(stage, "pointerdown", {
			button: 1,
			clientX: 100,
			clientY: 100,
		});
		await pointer(stage, "pointermove", { clientX: 160, clientY: 70 });
		expect(layer.style.transform).toBe("translate(60px, -30px) scale(2)");
		// At 100% the 1920 x 1080 frame overflows the 960 x 540 stage by 480 x 270.
		await pointer(stage, "pointermove", { clientX: 2000, clientY: -2000 });
		expect(layer.style.transform).toBe("translate(480px, -270px) scale(2)");
		await pointer(stage, "pointerup", { clientX: 2000, clientY: -2000 });
		await pointer(stage, "pointermove", { clientX: 0, clientY: 0 });
		expect(layer.style.transform).toBe("translate(480px, -270px) scale(2)");

		// Returning to fit drops the transform and the pan.
		await act(async () => {
			runtime.store.setState({ previewZoom: "fit" });
		});
		expect(layer.style.transform).toBe("");
		await view.unmount();
	});

	test("a primary drag without Space does not pan", async () => {
		stubStageSize();
		const project = frameProject();
		const runtime = createTestRuntime(project);
		runtime.store.setState({ previewZoom: 1 });
		const view = await editorView(runtime, project);
		const stage = view.container.querySelector(
			'[data-shortcut-scope="preview"]'
		) as HTMLElement;
		const layer = view.container.querySelector(
			"[data-preview-zoom]"
		) as HTMLElement;
		await pointer(stage, "pointerdown", {
			button: 0,
			clientX: 100,
			clientY: 100,
		});
		await pointer(stage, "pointermove", { clientX: 160, clientY: 160 });
		expect(layer.style.transform).toBe("translate(0px, 0px) scale(2)");
		await view.unmount();
	});

	test("Space over a zoomed preview is taken for panning", async () => {
		stubStageSize();
		const project = frameProject();
		const runtime = createTestRuntime(project);
		runtime.store.setState({ previewZoom: 1 });
		const view = await editorView(runtime, project);
		const stage = view.container.querySelector(
			'[data-shortcut-scope="preview"]'
		) as HTMLElement;
		const layer = view.container.querySelector(
			"[data-preview-zoom]"
		) as HTMLElement;
		const reachedWindow: string[] = [];
		const listener = (event: KeyboardEvent) => reachedWindow.push(event.code);
		window.addEventListener("keydown", listener);

		// React derives pointer enter from pointerover.
		await pointer(stage, "pointerover", { clientX: 10, clientY: 10 });
		await act(async () => {
			window.dispatchEvent(
				new KeyboardEvent("keydown", { code: "Space", key: " " })
			);
		});
		await pointer(stage, "pointerdown", {
			button: 0,
			clientX: 100,
			clientY: 100,
		});
		await pointer(stage, "pointermove", { clientX: 120, clientY: 110 });
		expect(layer.style.transform).toBe("translate(20px, 10px) scale(2)");
		await act(async () => {
			window.dispatchEvent(
				new KeyboardEvent("keyup", { code: "Space", key: " " })
			);
		});
		window.removeEventListener("keydown", listener);
		expect(reachedWindow).toEqual([]);
		await view.unmount();
	});

	test("the guides menu toggles guides drawn over the frame", async () => {
		stubStageSize();
		const project = frameProject();
		const runtime = createTestRuntime(project);
		const view = await editorView(runtime, project);
		expect(view.container.querySelector("[data-preview-guides]")).toBeNull();
		const button = [...view.container.querySelectorAll("button")].find(
			(element) => element.textContent === "Guides"
		) as HTMLButtonElement;
		await act(async () => {
			button.click();
		});
		expect(button.getAttribute("aria-expanded")).toBe("true");
		const thirdsLabel = [...view.container.querySelectorAll("label")].find(
			(label) => label.textContent === "Rule of thirds"
		);
		await act(async () => {
			thirdsLabel?.click();
		});
		expect([...runtime.store.getState().guides]).toEqual(["thirds"]);
		const svg = view.container.querySelector("[data-preview-guides]");
		expect(svg?.getAttribute("viewBox")).toBe("0 0 1920 1080");
		expect(svg?.querySelectorAll("line")).toHaveLength(4);
		await view.unmount();
	});

	test("the fullscreen button requests fullscreen on the viewport", async () => {
		stubStageSize();
		const project = frameProject();
		const runtime = createTestRuntime(project);
		const requested: Element[] = [];
		const original = HTMLElement.prototype.requestFullscreen;
		HTMLElement.prototype.requestFullscreen = function request(
			this: HTMLElement
		) {
			requested.push(this);
			return Promise.resolve();
		};
		const view = await editorView(runtime, project);
		const button = [...view.container.querySelectorAll("button")].find(
			(element) => element.textContent === "Fullscreen"
		) as HTMLButtonElement;
		await act(async () => {
			button.click();
		});
		HTMLElement.prototype.requestFullscreen = original;
		expect(requested).toEqual([
			view.container.querySelector("[data-preview-viewport]") as Element,
		]);
		await view.unmount();
	});

	test("Space inside a plaintext-only editor over a zoomed preview types a space", async () => {
		stubStageSize();
		const project = frameProject();
		const runtime = createTestRuntime(project);
		runtime.store.setState({ previewZoom: 2 });
		const view = await render(
			<EditorProvider value={runtime}>
				<PreviewViewport project={project}>
					<div className="studio-preview-frame">
						<div
							contentEditable="plaintext-only"
							data-testid="title-editor"
							role="textbox"
							suppressContentEditableWarning
							tabIndex={0}
						>
							Title
						</div>
					</div>
				</PreviewViewport>
			</EditorProvider>
		);
		const editor = view.container.querySelector(
			'[data-testid="title-editor"]'
		) as HTMLElement;
		const stage = view.container.querySelector(
			'[data-shortcut-scope="preview"]'
		) as HTMLElement;
		await pointer(editor, "pointerover", { clientX: 10, clientY: 10 });
		editor.focus();
		const press = new KeyboardEvent("keydown", {
			bubbles: true,
			cancelable: true,
			code: "Space",
			key: " ",
		});
		await act(async () => {
			editor.dispatchEvent(press);
		});
		expect(press.defaultPrevented).toBe(false);
		expect(stage.style.cursor).toBe("");
		await view.unmount();
	});

	test("a click inside a focused editor keeps its focus", async () => {
		stubStageSize();
		const project = frameProject();
		const runtime = createTestRuntime(project);
		let blurs = 0;
		const view = await render(
			<EditorProvider value={runtime}>
				<PreviewViewport project={project}>
					<div className="studio-preview-frame">
						<div
							contentEditable="plaintext-only"
							data-testid="title-editor"
							onBlur={() => {
								blurs += 1;
							}}
							role="textbox"
							suppressContentEditableWarning
							tabIndex={0}
						>
							Title
						</div>
					</div>
				</PreviewViewport>
			</EditorProvider>
		);
		const editor = view.container.querySelector(
			'[data-testid="title-editor"]'
		) as HTMLElement;
		const stage = view.container.querySelector(
			'[data-shortcut-scope="preview"]'
		) as HTMLElement;
		await act(async () => {
			editor.focus();
		});
		await pointer(editor, "pointerdown", { button: 0, clientX: 5, clientY: 5 });
		expect(document.activeElement).toBe(editor);
		expect(blurs).toBe(0);

		// A click on the bare stage still focuses it for preview shortcuts.
		await act(async () => {
			editor.blur();
		});
		await pointer(stage, "pointerdown", { button: 0, clientX: 5, clientY: 5 });
		expect(document.activeElement).toBe(stage);
		await view.unmount();
	});
});
