import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

GlobalRegistrator.register();
const previousActEnvironment = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	configurable: true,
	value: true,
	writable: true,
});
// React DOM detects input-event support when it loads, so it loads after the DOM.
const { createRoot } = await import("react-dom/client");
const { ImportedFontField } = await import("./ImportedFontField.tsx");
const {
	fontChoiceCss,
	importFontFile,
	resetImportedFontFaces,
	systemFontNames,
	titleFontCss,
} = await import("./imported-fonts.ts");

const previousRyu = window.ryu;
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
afterEach(() => {
	window.ryu = previousRyu;
	resetImportedFontFaces();
	document.body.innerHTML = "";
});

const font = {
	createdAt: "2026-10-15T00:00:00.000Z",
	family: "Acme Sans",
	format: "truetype" as const,
	id: "6f1d2b8e-6f0a-4a43-9b0c-2f0f6a1d2c3e",
	name: "Acme",
	size: 1234,
};

describe("imported fonts", () => {
	test("the preview names the imported face first, then the fallback", () => {
		expect(titleFontCss(null, "Inter, sans-serif")).toBe("Inter, sans-serif");
		expect(titleFontCss({ family: "Acme Sans", id: font.id }, "serif")).toBe(
			`"ryu-font-${font.id}", serif`
		);
	});

	test("a system font is named in CSS before the fallback; imported wins", () => {
		expect(fontChoiceCss({ systemFont: "DejaVu Sans" }, "serif")).toBe(
			'"DejaVu Sans", serif'
		);
		expect(
			fontChoiceCss(
				{
					customFont: { family: "Acme Sans", id: font.id },
					systemFont: "DejaVu Sans",
				},
				"serif"
			)
		).toBe(`"ryu-font-${font.id}", serif`);
		expect(fontChoiceCss({ customFont: null, systemFont: null }, "serif")).toBe(
			"serif"
		);
	});

	test("system font names are validated, de-duplicated and sorted", () => {
		expect(
			systemFontNames(["Noto Sans", "carlito", "Noto Sans", 'Bad"Name', ""])
		).toEqual(["carlito", "Noto Sans"]);
	});

	test("an oversized file is refused before it is sent", async () => {
		const file = new File([new Uint8Array(24_000_001)], "huge.ttf");
		await expect(importFontFile(file)).rejects.toThrow(/import limit/);
	});

	test("choosing a library font sets the title's customFont", async () => {
		const requests: { method?: string; path: string }[] = [];
		window.ryu = {
			app: {
				request: (input) => {
					requests.push(input);
					return Promise.resolve({ fonts: [font] });
				},
			},
		};
		const changes: unknown[] = [];
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => {
			root.render(
				<ImportedFontField
					label="Title 1"
					onChange={(next) => changes.push(next)}
					value={{}}
				/>
			);
			await Promise.resolve();
		});
		const select = container.querySelector<HTMLSelectElement>(
			'[aria-label="Title 1 Imported or system font"]'
		);
		expect(select).not.toBeNull();
		expect([...(select?.options ?? [])].map((option) => option.text)).toEqual([
			"None (use Font)",
			"Acme Sans",
		]);
		await act(async () => {
			if (select) {
				select.value = font.id;
				select.dispatchEvent(new Event("change", { bubbles: true }));
			}
			await Promise.resolve();
		});
		expect(changes).toEqual([
			{ customFont: { family: "Acme Sans", id: font.id } },
		]);
		expect(requests.map((item) => item.path).sort()).toEqual([
			"/fonts",
			"/system-fonts",
		]);
		await act(async () => {
			root.unmount();
			await Promise.resolve();
		});
	});

	test("a title whose font left the library says it falls back", async () => {
		window.ryu = {
			app: { request: () => Promise.resolve({ fonts: [] }) },
		};
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => {
			root.render(
				<ImportedFontField
					label="Title 1"
					onChange={() => undefined}
					value={{ customFont: { family: "Gone Sans", id: font.id } }}
				/>
			);
			await Promise.resolve();
		});
		expect(container.textContent).toContain("Gone Sans (missing)");
		expect(container.textContent).toContain("no longer in the library");
		await act(async () => {
			root.unmount();
			await Promise.resolve();
		});
	});

	test("installed fonts are listed in a System fonts group and picked by family", async () => {
		window.ryu = {
			app: {
				request: (input) =>
					input.path === "/system-fonts"
						? Promise.resolve({
								available: true,
								fonts: ["DejaVu Sans", "Carlito"],
							})
						: Promise.resolve({ fonts: [font] }),
			},
		};
		const changes: unknown[] = [];
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => {
			root.render(
				<ImportedFontField
					label="Caption"
					onChange={(next) => changes.push(next)}
					value={{ systemFont: "Carlito" }}
				/>
			);
			await Promise.resolve();
			await Promise.resolve();
		});
		const select = container.querySelector<HTMLSelectElement>(
			'[aria-label="Caption Imported or system font"]'
		);
		const group = select?.querySelector("optgroup");
		expect(group?.label).toBe("System fonts");
		expect(
			[...(group?.children ?? [])].map((option) => option.textContent)
		).toEqual(["Carlito", "DejaVu Sans"]);
		expect(select?.value).toBe("system:Carlito");
		await act(async () => {
			if (select) {
				select.value = "system:DejaVu Sans";
				select.dispatchEvent(new Event("change", { bubbles: true }));
			}
			await Promise.resolve();
		});
		expect(changes).toEqual([{ systemFont: "DejaVu Sans" }]);
		await act(async () => {
			if (select) {
				select.value = "";
				select.dispatchEvent(new Event("change", { bubbles: true }));
			}
			await Promise.resolve();
		});
		expect(changes.at(-1)).toEqual({});
		await act(async () => {
			root.unmount();
			await Promise.resolve();
		});
	});
});
