// The title timing rows read "Start time" / "End time": a bare "End" is the
// verb (de "Beenden", ja 終了) in the catalog, not the end of a time range.
import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Project } from "../../shared/project.ts";

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
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { TitlesPanel } = await import("./TitlesPanel.tsx");

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

afterEach(() => {
	registerLiteralCatalogLoader(null);
});

// The verb senses stay in the stub so a bare "Start"/"End" key would show.
const GERMAN: Record<string, string> = {
	End: "Beenden",
	"End time": "Endzeit",
	Start: "Starten",
	"Start time": "Startzeit",
	"Title {number} {field}": "Titel {number} {field}",
};

type Title = Project["titles"][number];
const title: Title = {
	animation: "fade",
	color: "#ffffff",
	end: 3,
	fadeIn: 0.2,
	fadeOut: 0.2,
	fontSize: 0.08,
	id: "00000000-0000-4000-8000-000000000001",
	start: 0,
	text: "Hallo",
	x: 0.5,
	y: 0.5,
};

test("the title timing rows render as start and end times in German", async () => {
	registerLiteralCatalogLoader((locale) =>
		locale.startsWith("de") ? GERMAN : {}
	);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="de" initialPackId={null}>
				<TitlesPanel
					narrationAvailable={false}
					onChange={() => undefined}
					time={0}
					titles={[title]}
				/>
			</I18nProvider>
		);
	});
	// Let the catalog load and the DOM localizer pass settle.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	const end = host.querySelector('input[aria-label="Titel 1 Endzeit"]');
	const start = host.querySelector('input[aria-label="Titel 1 Startzeit"]');
	expect(end).not.toBeNull();
	expect(start).not.toBeNull();
	const labels = [...host.querySelectorAll(".ryu-app-field__label")].map(
		(label) => label.textContent
	);
	expect(labels).toContain("Endzeit");
	expect(labels).toContain("Startzeit");
	expect(host.innerHTML).not.toContain("Beenden");
	expect(host.innerHTML).not.toContain("Starten");
	await act(async () => root.unmount());
	host.remove();
});
