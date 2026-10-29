import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Project } from "../../../shared/project.ts";
import {
	previewAssets,
	previewProject,
	previewSources,
} from "./__fixtures__/preview-project.ts";
import { captionBoxStyle } from "./PreviewCaptions.tsx";
import { graphicStyle } from "./PreviewGraphics.tsx";
import { titleStyle } from "./PreviewTitles.tsx";

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
const { Preview } = await import("../Preview.tsx");
const { PreviewStage } = await import("./PreviewStage.tsx");
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

async function renderFrame(
	time: number,
	options: { overlays?: React.ReactNode; project?: Project } = {}
) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<PreviewStage
				assets={previewAssets}
				overlays={options.overlays}
				playing={false}
				project={options.project ?? previewProject()}
				sources={previewSources}
				time={time}
			/>
		);
	});
	const frame = container.querySelector(".studio-preview-frame");
	return {
		frame,
		async unmount() {
			await act(async () => {
				root.unmount();
			});
			container.remove();
		},
	};
}

const layerKind = (element: Element) =>
	element.tagName === "VIDEO" || element.tagName === "IMG"
		? element.tagName.toLowerCase()
		: (element.getAttribute("class") ?? "").split(" ").at(-1);

describe("PreviewStage", () => {
	test("keeps the original Preview export", () => {
		expect(Preview).toBe(PreviewStage);
	});

	test("orders layers: media, titles, graphics, avatars, stage, meshes, captions, overlays", async () => {
		const view = await renderFrame(2, {
			overlays: <div className="test-overlay" />,
		});
		expect(view.frame?.getAttribute("data-style-profile")).toBe(
			"clean-professional"
		);
		const kinds = [...(view.frame?.children ?? [])].map(layerKind);
		expect(kinds).toEqual([
			"img",
			"studio-vignette-overlay",
			"video",
			"video",
			"studio-media-layer",
			"studio-title",
			"studio-graphic",
			"studio-graphic",
			"studio-avatar",
			"studio-stage-object",
			"studio-mesh-layer",
			"studio-caption",
			"test-overlay",
		]);
		await view.unmount();
	});

	test("hides inactive overlays and keeps media mounted but transparent", async () => {
		const view = await renderFrame(0.5);
		const kinds = [...(view.frame?.children ?? [])].map(layerKind);
		expect(kinds).toEqual([
			"img",
			"studio-vignette-overlay",
			"video",
			"video",
			"studio-media-layer",
			"studio-graphic",
		]);
		await view.unmount();
		const late = await renderFrame(6);
		const image = late.frame?.querySelector("img");
		expect(image?.getAttribute("style")).toContain("--studio-media-opacity: 0");
		await late.unmount();
	});

	test("highlights the active caption word", async () => {
		const view = await renderFrame(2);
		const words = [
			...(view.frame?.querySelectorAll(".studio-caption-word") ?? []),
		];
		expect(words.map((word) => word.textContent)).toEqual(["Hello", " there"]);
		expect(words.map((word) => word.getAttribute("data-active"))).toEqual([
			null,
			"true",
		]);
		await view.unmount();
	});
});

describe("overlay element styles", () => {
	const project = previewProject();

	test("titles slide and fade in", () => {
		const title = project.titles[0];
		if (!title) {
			throw new Error("fixture title missing");
		}
		expect(titleStyle(title, project, 1.5)).toEqual({
			"--studio-title-color": "#ffcc00",
			"--studio-title-font-size": `${((0.08 * 1080) / 1920) * 100}cqw`,
			"--studio-title-left": "50%",
			"--studio-title-opacity": "0.5",
			"--studio-title-top": "30%",
			"--studio-title-transform": "translateX(4%)",
		});
		expect(titleStyle(title, project, 3)["--studio-title-transform"]).toBe(
			"translateX(0%)"
		);
	});

	test("graphics draw lines from their stroke and triangles as polygons", () => {
		const [triangle, line] = project.graphics;
		if (!(triangle && line)) {
			throw new Error("fixture graphics missing");
		}
		const triangleStyle = graphicStyle(triangle, 1);
		expect(triangleStyle["--studio-graphic-clip-path"]).toBe(
			"polygon(50% 0%, 100% 100%, 0% 100%)"
		);
		expect(triangleStyle["--studio-graphic-transform"]).toBe("translateY(8%)");
		expect(triangleStyle["--studio-graphic-border"]).toBe("1% solid #ffffff");
		const lineStyle = graphicStyle(line, 1);
		expect(lineStyle["--studio-graphic-background"]).toBe("#0000ff");
		expect(lineStyle["--studio-graphic-height"]).toBe("0.6%");
		expect(lineStyle["--studio-graphic-border"]).toBe("0 solid transparent");
		expect(lineStyle["--studio-graphic-transform"]).toBe("none");
	});

	test("captions scale with the project frame", () => {
		expect(captionBoxStyle(project)).toEqual({
			"--studio-caption-font-size": `${(49 / 1920) * 100}cqw`,
			"--studio-caption-inset": `${(40 / 1920) * 100}%`,
		});
	});
});
