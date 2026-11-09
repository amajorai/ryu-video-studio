import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import type { CanvasBackground } from "../../../shared/background.ts";

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
const { I18nProvider } = await import("@ryu/i18n/react");
const { BackgroundFields } = await import("./BackgroundFields.tsx");
const { backgroundFieldLabels } = await import("./BackgroundFields-labels.ts");

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

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
	await cleanup?.();
	cleanup = null;
});

const german = {
	"Canvas end color": "Endfarbe der Arbeitsfläche",
	"Canvas start color": "Startfarbe der Arbeitsfläche",
	"Clip color": "Clip-Farbe",
	"Clip end color": "Endfarbe des Clips",
	"Clip start color": "Startfarbe des Clips",
	"{label} background": "Hintergrund: {label}",
	"{label} gradient angle (°)": "Verlaufswinkel (°): {label}",
	Canvas: "Arbeitsfläche",
	"Canvas color": "Farbe der Arbeitsfläche",
	Clip: "Clip",
};

/** Records the source of every message so a test can see the catalog keys. */
const recordingTl = (seen: string[]) =>
	((source: string, values: Record<string, unknown> = {}) => {
		seen.push(source);
		return source.replace(/\{(\w+)\}/g, (_, name: string) =>
			String(values[name] ?? "")
		);
	}) as Parameters<typeof backgroundFieldLabels>[0];

const japanese = {
	"Canvas start color": "キャンバスの開始色",
	"Canvas end color": "キャンバスの終了色",
	"{label} background": "{label} の背景",
	Canvas: "キャンバス",
};

const arabic = {
	"Clip start color": "لون بداية المقطع",
	"Clip end color": "لون نهاية المقطع",
	"{label} background": "خلفية {label}",
	Clip: "المقطع",
};

async function renderIn(
	locale: string,
	messages: Record<string, string>,
	node: ReactNode
): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				manageDocument={false}
				overlays={{ [locale]: messages }}
			>
				{node}
			</I18nProvider>
		);
	});
	cleanup = async () => {
		await act(async () => root.unmount());
		host.remove();
	};
	return host;
}

const gradient: CanvasBackground = {
	angle: 45,
	color: "#112233",
	color2: "#445566",
	type: "gradient",
};

const renderFields = (
	label: string,
	value: CanvasBackground,
	locale = "de",
	messages: Record<string, string> = german
) =>
	renderIn(
		locale,
		messages,
		<BackgroundFields
			fallbackColor="#000000"
			imageAssets={[]}
			label={label}
			noneLabel="None"
			onChange={() => undefined}
			types={["color", "gradient"]}
			value={value}
		/>
	);

const ariaLabels = (host: HTMLElement) =>
	[...host.querySelectorAll("[aria-label]")].map((element) =>
		element.getAttribute("aria-label")
	);

describe("backgroundFieldLabels", () => {
	test("each owner and color field is one whole catalog message", () => {
		const expected = {
			Canvas: {
				color: "Canvas color",
				end: "Canvas end color",
				start: "Canvas start color",
			},
			Clip: {
				color: "Clip color",
				end: "Clip end color",
				start: "Clip start color",
			},
		};
		for (const [owner, colors] of Object.entries(expected)) {
			const seen: string[] = [];
			const labels = backgroundFieldLabels(recordingTl(seen), owner);
			expect(seen).toEqual([colors.color, colors.end, colors.start, owner]);
			expect(labels.colors).toEqual(colors);
			expect(labels.owner).toBe(owner);
		}
	});

	test("an unknown owner keeps its name inside whole-sentence templates", () => {
		const seen: string[] = [];
		const labels = backgroundFieldLabels(recordingTl(seen), "Title");
		expect(labels.colors).toEqual({
			color: "Title color",
			end: "Title end color",
			start: "Title start color",
		});
		expect(seen).toEqual([
			"{label} color",
			"{label} end color",
			"{label} start color",
		]);
		expect(labels.owner).toBe("Title");
	});
});

describe("BackgroundFields in German", () => {
	test("canvas gradient stops and the type picker get translated names", async () => {
		const host = await renderFields("Canvas", gradient);
		const labels = ariaLabels(host);
		expect(labels).toContain("Hintergrund: Arbeitsfläche");
		expect(labels).toContain("Startfarbe der Arbeitsfläche");
		expect(labels).toContain("Endfarbe der Arbeitsfläche");
		expect(labels.join("\n")).not.toMatch(/canvas|start color|end color/i);
	});

	test("canvas fill and clip gradient stops get translated names", async () => {
		const canvas = await renderFields("Canvas", {
			color: "#112233",
			type: "color",
		});
		expect(ariaLabels(canvas)).toContain("Farbe der Arbeitsfläche");
		await cleanup?.();
		cleanup = null;
		const clip = await renderFields("Clip", gradient);
		const labels = ariaLabels(clip);
		expect(labels).toContain("Startfarbe des Clips");
		expect(labels).toContain("Endfarbe des Clips");
	});
});

describe("BackgroundFields in Japanese and Arabic", () => {
	test("Japanese canvas gradient stops read as whole sentences", async () => {
		const host = await renderFields("Canvas", gradient, "ja", japanese);
		const labels = ariaLabels(host);
		expect(labels).toContain("キャンバス の背景");
		expect(labels).toContain("キャンバスの開始色");
		expect(labels).toContain("キャンバスの終了色");
		expect(labels.join("\n")).not.toMatch(/canvas|color/i);
	});

	test("Arabic clip gradient stops read as whole sentences", async () => {
		const host = await renderFields("Clip", gradient, "ar", arabic);
		const labels = ariaLabels(host);
		expect(labels).toContain("خلفية المقطع");
		expect(labels).toContain("لون بداية المقطع");
		expect(labels).toContain("لون نهاية المقطع");
		expect(labels.join("\n")).not.toMatch(/clip|color/i);
	});
});
