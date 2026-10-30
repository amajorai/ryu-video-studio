import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { newProject, type Project } from "../../../shared/project.ts";

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
	configurable: true,
	value: true,
	writable: true,
});
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PreviewTitles, titleContent, titleStyle } = await import(
	"./PreviewTitles.tsx"
);
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

type Title = Project["titles"][number];
const canvas = { height: 1080, width: 1920 };
const base: Title = {
	animation: "fade",
	color: "#ffffff",
	end: 3,
	fadeIn: 0,
	fadeOut: 0,
	fontSize: 0.1,
	id: "00000000-0000-4000-8000-000000000001",
	start: 1,
	text: "Hello world",
	x: 0.5,
	y: 0.5,
};

async function render(titles: Title[], time: number) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<PreviewTitles project={{ ...newProject("T"), titles }} time={time} />
		);
	});
	return {
		container,
		unmount: async () => {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

describe("styled title CSS", () => {
	test("legacy titles keep their exact variables", () => {
		expect(Object.keys(titleStyle(base, canvas, 2)).sort()).toEqual([
			"--studio-title-color",
			"--studio-title-font-size",
			"--studio-title-left",
			"--studio-title-opacity",
			"--studio-title-top",
			"--studio-title-transform",
		]);
		expect(titleContent(base, canvas, 2)).toBe("Hello world");
	});

	test("font, weight, decorations, outline, shadow, and box map to CSS", () => {
		const style = titleStyle(
			{
				...base,
				align: "left",
				backgroundColor: "#ff0000",
				backgroundOpacity: 0.5,
				backgroundRadius: 0.5,
				fontFamily: "anton",
				fontWeight: 400,
				italic: true,
				outlineColor: "#00ff00",
				outlineWidth: 0.01,
				shadowDepth: 0.005,
				strike: true,
				underline: true,
			},
			canvas,
			2
		);
		expect(style).toMatchObject({
			backgroundColor: "rgb(255 0 0 / 0.5)",
			fontFamily: '"Studio Anton", "Anton", sans-serif',
			fontStyle: "italic",
			fontWeight: 400,
			paintOrder: "stroke fill",
			textAlign: "left",
			textDecorationLine: "underline line-through",
			// The text, not the padded box edge, sits at x (as in the export).
			transformOrigin: "0.675cqw 50%",
			WebkitTextStroke: "1.125cqw #00ff00",
		});
		expect(style["--studio-title-transform"]).toBe(
			"translate(calc(-1 * 0.675cqw), -50%) scale(1) rotate(0deg)"
		);
		expect(style.textShadow).toStartWith("0.28125cqw 0.28125cqw 0cqw");
		expect(style.borderRadius).toBeDefined();
	});

	test("boxed titles anchor their text at x for every alignment", () => {
		const boxed = {
			...base,
			backgroundColor: "#000000",
			backgroundPadding: 0.02,
		};
		const right = titleStyle({ ...boxed, align: "right" }, canvas, 2);
		expect(right.transformOrigin).toBe("calc(100% - 1.125cqw) 50%");
		expect(right["--studio-title-transform"]).toStartWith(
			"translate(calc(-100% + 1.125cqw), -50%)"
		);
		const center = titleStyle(boxed, canvas, 2);
		expect(center.transformOrigin).toBe("50% 50%");
		expect(center["--studio-title-transform"]).toStartWith(
			"translate(-50%, -50%)"
		);
		const unboxed = titleStyle({ ...base, align: "right" }, canvas, 2);
		expect(unboxed.transformOrigin).toBe("100% 50%");
		expect(unboxed["--studio-title-transform"]).toStartWith(
			"translate(-100%, -50%)"
		);
	});

	test("box padding per axis anchors on the horizontal padding", () => {
		const style = titleStyle(
			{
				...base,
				align: "left",
				backgroundColor: "#000000",
				backgroundPaddingX: 0.02,
				backgroundPaddingY: 0.01,
			},
			canvas,
			2
		);
		expect(style.padding).toBe("0.5625cqw 1.125cqw");
		expect(style.transformOrigin).toBe("1.125cqw 50%");
		expect(style.backgroundColor).toBe("rgb(0 0 0 / 1)");
		expect(style["--studio-title-box"]).toBeUndefined();
	});

	test("an offset box moves to the ::before layer; the text stays put", () => {
		const plain = titleStyle(
			{ ...base, backgroundColor: "#ff0000" },
			canvas,
			2
		);
		const shifted = titleStyle(
			{
				...base,
				backgroundColor: "#ff0000",
				backgroundOffsetX: 0.05,
				backgroundOffsetY: -0.02,
				backgroundOpacity: 0.5,
			},
			canvas,
			2
		);
		expect(shifted.backgroundColor).toBeUndefined();
		expect(shifted["--studio-title-box"]).toBe("rgb(255 0 0 / 0.5)");
		expect(shifted["--studio-title-box-x"]).toBe("5cqw");
		expect(shifted["--studio-title-box-y"]).toBe("-1.125cqw");
		expect(shifted["--studio-title-transform"]).toBe(
			plain["--studio-title-transform"]
		);
		expect(shifted.padding).toBe(plain.padding);
	});

	test("motion follows the shared curves: slide, pop, blur, rotation", () => {
		const slide = titleStyle(
			{ ...base, animationIn: "slide-up", animationInDuration: 1 },
			canvas,
			1.5
		);
		expect(slide["--studio-title-top"]).toBe(`${(0.5 + 0.04) * 100}%`);
		const pop = titleStyle(
			{ ...base, animationIn: "pop", animationInDuration: 1, rotation: 10 },
			canvas,
			1.6
		);
		expect(pop["--studio-title-transform"]).toBe(
			"translate(-50%, -50%) scale(1.15) rotate(10deg)"
		);
		const blur = titleStyle(
			{ ...base, animationIn: "blur-in", animationInDuration: 1 },
			canvas,
			1
		);
		expect(blur.filter).toStartWith("blur(");
	});
});

describe("per-glyph title content", () => {
	test("typewriter hides glyphs that are not typed yet", async () => {
		const view = await render(
			[
				{
					...base,
					animationIn: "typewriter",
					animationInDuration: 1.1,
					text: "abc",
				},
			],
			1.5
		);
		const glyphs = [
			...view.container.querySelectorAll<HTMLElement>(".studio-title-glyph"),
		];
		expect(glyphs.map((glyph) => glyph.style.visibility)).toEqual([
			"",
			"",
			"hidden",
		]);
		await view.unmount();
	});

	test("word highlight marks the active word", async () => {
		const view = await render(
			[{ ...base, animationIn: "word-highlight", highlightColor: "#00ff00" }],
			2.6
		);
		const active = [
			...view.container.querySelectorAll(
				'.studio-title-glyph[data-active="true"]'
			),
		];
		expect(active.map((glyph) => glyph.textContent).join("")).toBe("world");
		await view.unmount();
	});

	test("wave lifts glyphs and rows break", async () => {
		const view = await render(
			[{ ...base, animationLoop: "wave", text: "ab\ncd" }],
			2
		);
		const rows = view.container.querySelectorAll("[data-title-row]");
		expect(rows).toHaveLength(2);
		expect(view.container.querySelectorAll("br")).toHaveLength(1);
		const glyph = view.container.querySelector<HTMLElement>(
			".studio-title-glyph"
		);
		expect(glyph?.style.transform).toStartWith("translateY(");
		await view.unmount();
	});
});
