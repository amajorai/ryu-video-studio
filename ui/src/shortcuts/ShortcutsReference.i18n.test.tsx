import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The printed sheet's key caps are not prose. A bare "Space" reached the page
// localizer as the noun ("Bereich"), and a "Delete" cap read as the verb.

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
const { ShortcutsReference } = await import("./ShortcutsReference.tsx");

/** Stand-ins for the catalog: the wrong senses on the bare key words. */
const DE: Record<string, string> = {
	Delete: "Löschen",
	"Play or pause": "Wiedergabe oder Pause",
	Space: "Bereich",
};

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

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

async function renderSheetInGerman() {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("de") ? DE : {}));
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<I18nProvider
				initialLocale="de"
				initialPackId={null}
				manageDocument={false}
			>
				<ShortcutsReference
					bindings={[
						{
							action: "playback.toggle",
							id: "play",
							keys: [{ key: " " }],
							source: "legacy",
						},
						{
							action: "clip.delete",
							id: "delete",
							keys: [{ key: "Delete" }],
							source: "legacy",
						},
					]}
					platform="other"
				/>
			</I18nProvider>
		);
	});
	// Let the catalog load and the page localizer pass settle.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	return {
		host,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

test("the German sheet shows the space bar as a key cap, not 'Bereich'", async () => {
	const { host, unmount } = await renderSheetInGerman();
	const rows = [...host.querySelectorAll("tr")].map((row) => ({
		combo: row.querySelector("td")?.textContent ?? "",
		label: row.querySelector("th")?.textContent ?? "",
	}));
	// The action names are prose and are localized.
	expect(rows).toContainEqual({ combo: "␣", label: "Wiedergabe oder Pause" });
	// The key caps keep their legends.
	expect(rows.map((row) => row.combo)).toContain("Delete");
	expect(host.textContent).not.toContain("Bereich");
	expect(host.textContent).not.toContain("Löschen");
	await unmount();
});
