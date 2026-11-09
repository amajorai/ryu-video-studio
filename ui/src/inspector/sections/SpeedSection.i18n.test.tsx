// Clip speeds read with the reader's decimal mark ("0,25x" in German) and the
// "Change clip speed" history entry goes through the translator.
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
const { EditorProvider } = await import("../../editor/context.tsx");
const { createTestRuntime, testProject } = await import(
	"../../editor/test-runtime.ts"
);
const { changeClipSpeed, SpeedSection } = await import("./SpeedSection.tsx");

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
	document.body.replaceChildren();
});

// Stub catalogs: these strings are not translated in the shipped catalog yet.
const CATALOGS: Record<string, Record<string, string>> = {
	ar: { "Change clip speed": "تغيير سرعة المقطع" },
	de: { "Change clip speed": "Clip-Geschwindigkeit ändern" },
	ja: { "Change clip speed": "クリップの速度を変更" },
};

async function mountSpeed(locale: string) {
	registerLiteralCatalogLoader(
		(requested) => CATALOGS[requested.slice(0, 2)] ?? {}
	);
	const { first, project } = testProject();
	const runtime = createTestRuntime(project);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
				manageDocument={false}
			>
				<EditorProvider value={{ ...runtime }}>
					<SpeedSection
						isAudio={false}
						onChange={() => undefined}
						segment={first}
						visualControls
					/>
				</EditorProvider>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	const presets = [...host.querySelectorAll("button[aria-pressed]")].map(
		(button) => button.textContent ?? ""
	);
	return { first, presets, root, runtime };
}

test("German speed presets use the German decimal mark", async () => {
	const { presets, root } = await mountSpeed("de");
	expect(presets).toContain("0,25x");
	expect(presets).toContain("1,5x");
	expect(presets).not.toContain("0.25x");
	await act(async () => root.unmount());
});

test("English speed presets keep the English look", async () => {
	const { presets, root } = await mountSpeed("en");
	expect(presets).toContain("0.25x");
	expect(presets).toContain("100x");
	await act(async () => root.unmount());
});

test("the speed change history entry is translated", async () => {
	for (const [locale, label] of [
		["de", "Clip-Geschwindigkeit ändern"],
		["ja", "クリップの速度を変更"],
		["ar", "تغيير سرعة المقطع"],
	] as const) {
		const { first, root, runtime } = await mountSpeed(locale);
		changeClipSpeed(runtime, first, 2);
		expect(runtime.calls).toContainEqual(["edit", label]);
		expect(runtime.calls).not.toContainEqual(["edit", "Change clip speed"]);
		await act(async () => root.unmount());
	}
});
