// The sound effect picker names each kind as a sound ("Pop sound"): a bare
// "Pop", "Impact" or "Hit" is another sense in the catalog (ru "Появление",
// "Влияние", "Попад.").
import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

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
const { SoundtrackSfxSection } = await import(
	"./SoundtrackPanel-sfx-section.tsx"
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

afterEach(() => {
	registerLiteralCatalogLoader(null);
});

// The wrong senses stay in the stub so a bare kind key would show.
const RUSSIAN: Record<string, string> = {
	Hit: "Попад.",
	"Hit sound": "Звук удара",
	Impact: "Влияние",
	"Impact sound": "Звук столкновения",
	Pop: "Появление",
	"Pop sound": "Звук хлопка",
};

async function kindOptions(locale: string): Promise<Map<string, string>> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("ru") ? RUSSIAN : {}
	);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const ignore = () => undefined;
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<SoundtrackSfxSection
					busy={false}
					generatedReason={() => undefined}
					generateSfx={() => Promise.resolve()}
					generateWithModel={() => Promise.resolve()}
					setSfxChoice={ignore}
					setSfxDescription={ignore}
					setSfxDuration={ignore}
					setSfxKind={ignore}
					setSfxSeed={ignore}
					setSfxSource={ignore}
					sfxChoice={{ model: "", provider: "", providerInput: {} }}
					sfxDescription=""
					sfxDuration={undefined}
					sfxKind="pop"
					sfxSeed={1}
					sfxSource="procedural"
					working={false}
				/>
			</I18nProvider>
		);
	});
	// Let the catalog load and the DOM localizer pass settle.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	const select = host.querySelector<HTMLSelectElement>(
		'select[aria-label="Sound effect kind"]'
	);
	const options = new Map(
		[...(select?.options ?? [])].map((option) => [
			option.value,
			option.textContent ?? "",
		])
	);
	await act(async () => root.unmount());
	host.remove();
	return options;
}

test("the sound effect kinds render in their sound sense in Russian", async () => {
	const options = await kindOptions("ru");
	expect(options.get("pop")).toBe("Звук хлопка");
	expect(options.get("impact")).toBe("Звук столкновения");
	expect(options.get("hit")).toBe("Звук удара");
	const text = [...options.values()].join(" ");
	expect(text).not.toContain("Появление");
	expect(text).not.toContain("Влияние");
});

test("English names each kind as a sound", async () => {
	const options = await kindOptions("en");
	expect(options.get("pop")).toBe("Pop sound");
	expect(options.get("ding")).toBe("Ding sound");
});
