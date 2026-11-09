import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import type { Graphic } from "../../../shared/project.ts";

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
const { PresetGallery } = await import("./CaptionStylePanel-fields.tsx");
const { GraphicsPanel } = await import("../GraphicsPanel.tsx");
const { CaptionStylePanel } = await import("./CaptionStylePanel.tsx");
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, testProject } = await import(
	"../editor/test-runtime.ts"
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

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
	await cleanup?.();
	cleanup = null;
});

const overlays = {
	de: {
		"Applied the {label} caption style.": "Untertitelstil {label} angewendet.",
		"Graphic {number} {label}": "Grafik {number}: {label}",
		"Left edge": "Linker Rand",
		"News broadcast": "Nachrichtensendung",
		"News-style white text on a blue band.":
			"Weißer Text im Nachrichtenstil auf einem blauen Band.",
		"Top edge": "Oberer Rand",
		"Word reveal": "Wort für Wort",
	},
};

/** Renders `node` in German without the DOM localizer. */
async function renderGerman(node: ReactNode): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="de"
				manageDocument={false}
				overlays={overlays}
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

test("the caption preset gallery shows translated names and descriptions", async () => {
	const host = await renderGerman(
		<PresetGallery disabled={false} onApply={() => undefined} selected="" />
	);
	const broadcast = host.querySelector('[data-caption-preset="broadcast"]');
	expect(broadcast?.textContent).toContain("Nachrichtensendung");
	expect(broadcast?.textContent).toContain(
		"Weißer Text im Nachrichtenstil auf einem blauen Band."
	);
	expect(broadcast?.textContent).not.toContain("News-style");
	// Reveal reads as the caption sense, never the "Show" verb.
	const reveal = host.querySelector('[data-caption-preset="reveal"]');
	expect(reveal?.textContent).toContain("Wort für Wort");
});

test("graphic position fields name the edge, translated inside their labels", async () => {
	const graphic: Graphic = {
		animation: "none",
		end: 3,
		entryDuration: 0,
		fill: "#112233",
		height: 0.2,
		id: "88888888-8888-4888-8888-888888888888",
		opacity: 1,
		shape: "rectangle",
		start: 1,
		stroke: "#ffffff",
		strokeWidth: 0,
		width: 0.2,
		x: 0.1,
		y: 0.1,
	};
	const host = await renderGerman(
		<GraphicsPanel
			graphics={[graphic]}
			onChange={() => undefined}
			styleProfile="clean-professional"
			time={2}
		/>
	);
	expect(
		host.querySelector('[aria-label="Grafik 1: Oberer Rand"]')
	).not.toBeNull();
	expect(
		host.querySelector('[aria-label="Grafik 1: Linker Rand"]')
	).not.toBeNull();
	expect(host.querySelector('[aria-label$=" Top"]')).toBeNull();
	// The keyframe channel picker names the Y channel by its edge, too.
	const options = [...host.querySelectorAll("option")].map(
		(option) => option.textContent
	);
	expect(options).toContain("Oberer Rand");
	expect(options).toContain("Linker Rand");
	expect(options).not.toContain("Top");
});

test("applying a preset reports its translated name", async () => {
	const runtime = createTestRuntime(testProject().project);
	const messages: string[] = [];
	runtime.routeEdit = (_action, _body, describe) => {
		messages.push(describe({}));
		return Promise.resolve({ extras: {}, status: "ok" });
	};
	const host = await renderGerman(
		<EditorProvider value={runtime}>
			<CaptionStylePanel />
		</EditorProvider>
	);
	const broadcast = host.querySelector<HTMLButtonElement>(
		'[data-caption-preset="broadcast"]'
	);
	await act(async () => broadcast?.click());
	expect(messages).toEqual(["Untertitelstil Nachrichtensendung angewendet."]);
});
