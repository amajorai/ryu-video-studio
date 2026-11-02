import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Caption, Project } from "../../../shared/project.ts";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
const previousActEnvironment = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	configurable: true,
	value: true,
	writable: true,
});
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { newProject } = await import("../../../shared/project.ts");
const { effectiveCaptionStyle } = await import(
	"../../../shared/caption-style.ts"
);
const { PreviewCaptions, captionWordStyle, hexAlpha, styledCaptionStyle } =
	await import("./PreviewCaptions.tsx");

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

const SPEAKER = "aaaaaaaa-0000-4000-8000-000000000001";

function wordCaption(): Caption {
	return {
		end: 2,
		id: crypto.randomUUID(),
		start: 0,
		text: "Hello world",
		words: [
			{ end: 0.6, id: crypto.randomUUID(), start: 0, text: "Hello" },
			{ end: 1.4, id: crypto.randomUUID(), start: 0.8, text: "world" },
		],
	};
}

async function render(project: Project, time: number) {
	const element = document.createElement("div");
	document.body.append(element);
	const root = createRoot(element);
	await act(async () => {
		root.render(<PreviewCaptions project={project} time={time} />);
	});
	return {
		element,
		unmount: async () => {
			await act(async () => root.unmount());
			element.remove();
		},
	};
}

describe("PreviewCaptions", () => {
	test("legacy projects keep the legacy markup", async () => {
		const view = await render(
			{ ...newProject(), captions: [wordCaption()] },
			0.2
		);
		expect(view.element.querySelector(".studio-caption")).not.toBeNull();
		expect(view.element.querySelector(".studio-caption-styled")).toBeNull();
		expect(
			view.element.querySelector('[data-active="true"]')?.textContent
		).toBe("Hello");
		await view.unmount();
	});

	test("styled captions position, uppercase, and highlight the spoken word", async () => {
		const project = {
			...newProject(),
			captionStyle: {
				highlightColor: "#00ff00",
				positionX: 0.25,
				positionY: 0.4,
				uppercase: true,
			},
			captions: [wordCaption()],
		};
		const view = await render(project, 1);
		const block = view.element.querySelector<HTMLElement>(
			".studio-caption-styled"
		);
		expect(block?.style.left).toBe("25%");
		expect(block?.style.top).toBe("40%");
		expect(block?.textContent).toBe("HELLO WORLD");
		const active = view.element.querySelector<HTMLElement>(
			'[data-active="true"]'
		);
		expect(active?.textContent).toBe("WORLD");
		expect(active?.style.color).toBe("#00ff00");
		await view.unmount();
	});

	test("a boxed reveal caption boxes only the words already spoken, like the render", async () => {
		const caption = wordCaption();
		const project = {
			...newProject(),
			captionStyle: {
				backgroundOpacity: 0.6,
				wordAnimation: "reveal" as const,
			},
			captions: [
				{
					...caption,
					words: (caption.words ?? []).map((word, index) =>
						index === 0 ? { ...word, start: 0.3 } : word
					),
				},
			],
		};
		const boxes = async (time: number) => {
			const view = await render(project, time);
			const block = view.element.querySelector<HTMLElement>(
				".studio-caption-styled"
			);
			const spans = [
				...view.element.querySelectorAll<HTMLElement>(
					'[data-caption-box="true"]'
				),
			];
			const result = {
				blockBackground: block?.style.backgroundColor ?? "",
				shown: spans.map((span) => span.textContent?.trim()),
				spanBackground: spans[0]?.style.backgroundColor ?? "",
			};
			await view.unmount();
			return result;
		};
		// Before the first word starts the ASS box is fully transparent too.
		expect(await boxes(0.1)).toEqual({
			blockBackground: "",
			shown: [],
			spanBackground: "",
		});
		const first = await boxes(0.4);
		expect(first.blockBackground).toBe("");
		expect(first.shown).toEqual(["Hello"]);
		expect(first.spanBackground).toContain("0.6");
		expect((await boxes(1)).shown).toEqual(["Hello", "world"]);
	});

	test("a boxed caption without reveal keeps one box on the block", async () => {
		const project = {
			...newProject(),
			captionStyle: { backgroundOpacity: 0.6, wordAnimation: "pop" as const },
			captions: [wordCaption()],
		};
		const view = await render(project, 0.2);
		expect(
			view.element.querySelector<HTMLElement>(".studio-caption-styled")?.style
				.backgroundColor
		).toContain("0.6");
		expect(view.element.querySelector("[data-caption-box]")).toBeNull();
		await view.unmount();
	});

	test("speaker tint colors words without a chosen style", async () => {
		const caption = wordCaption();
		const words = caption.words ?? [];
		const project = {
			...newProject(),
			captions: [
				{
					...caption,
					words: words.map((word, index) =>
						index === 0 ? { ...word, speakerId: SPEAKER } : word
					),
				},
			],
			speakers: [{ color: "#ff00ff", id: SPEAKER, label: "Ana" }],
		};
		const view = await render(project, 1);
		const spans = view.element.querySelectorAll<HTMLElement>(
			".studio-caption-word"
		);
		expect(spans[0]?.style.color).toBe("#ff00ff");
		await view.unmount();
	});
});

describe("caption preview styles", () => {
	const project = { ...newProject(), height: 1080, width: 1920 };

	test("the block mirrors the ASS anchor and box", () => {
		const style = effectiveCaptionStyle({
			...project,
			captionStyle: { backgroundColor: "#102030", backgroundOpacity: 0.5 },
		});
		const css = styledCaptionStyle(style, project);
		expect(css.transform).toBe("translate(-50%, -100%)");
		expect(css.backgroundColor).toBe("rgb(16 32 48 / 0.5)");
		expect(css.WebkitTextStroke).toBeUndefined();
		const outlined = styledCaptionStyle(
			effectiveCaptionStyle({
				...project,
				captionStyle: { shadowDepth: 0.01 },
			}),
			project
		);
		expect(outlined.paintOrder).toBe("stroke fill");
		expect(outlined.textShadow).toContain("rgb(0 0 0 / 0.5)");
		expect(hexAlpha("#ffffff", 1)).toBe("rgb(255 255 255 / 1)");
	});

	test("an imported or system caption font is named before the fallback", () => {
		const customFont = {
			family: "Ryufont",
			id: "6f1d2b8e-6f0a-4a43-9b0c-2f0f6a1d2c3e",
		};
		const imported = styledCaptionStyle(
			effectiveCaptionStyle({
				...project,
				captionStyle: { customFont, fontFamily: "inter" },
			}),
			project
		);
		expect(imported.fontFamily).toStartWith(`"ryu-font-${customFont.id}", `);
		const system = styledCaptionStyle(
			effectiveCaptionStyle({
				...project,
				captionStyle: { systemFont: "DejaVu Sans" },
			}),
			project
		);
		expect(system.fontFamily).toStartWith('"DejaVu Sans", ');
	});

	test("word styles follow the animation", () => {
		const style = (wordAnimation: "pop" | "karaoke" | "reveal" | "box") =>
			effectiveCaptionStyle({ ...project, captionStyle: { wordAnimation } });
		const word = { end: 1.5, start: 1 };
		expect(
			captionWordStyle(style("pop"), 1.08, word, "#fff", "#0f0").transform
		).toBe("scale(1.18)");
		const karaoke = captionWordStyle(
			style("karaoke"),
			1.25,
			word,
			"#fff",
			"#0f0"
		);
		expect(karaoke.backgroundImage).toBe(
			"linear-gradient(90deg, #0f0 50%, #fff 50%)"
		);
		expect(
			captionWordStyle(style("reveal"), 0.5, word, "#fff", "#0f0").visibility
		).toBe("hidden");
		expect(
			captionWordStyle(style("box"), 1.2, word, "#fff", "#0f0").backgroundColor
		).toBe("#0f0");
	});
});
