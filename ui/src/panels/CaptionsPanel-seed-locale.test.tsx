import { afterAll, expect, test } from "bun:test";
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
const { activeCaptions } = await import("../../../shared/project.ts");
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, testProject } = await import(
	"../editor/test-runtime.ts"
);
const { CaptionsPanel } = await import("./CaptionsPanel.tsx");

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

const overlays = {
	ar: { "New caption": "تسمية توضيحية جديدة" },
	de: { "New caption": "Neue Untertitel" },
	ja: { "New caption": "新しい字幕" },
};

/** Click "Add caption" under `locale` and return the inserted cue's text. */
async function addCaptionIn(locale: string): Promise<string | undefined> {
	const runtime = createTestRuntime(testProject().project);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				manageDocument={false}
				overlays={overlays}
			>
				<EditorProvider value={{ ...runtime }}>
					<CaptionsPanel />
				</EditorProvider>
			</I18nProvider>
		);
	});
	const add = [...host.querySelectorAll("button")].find(
		(button) => button.textContent?.trim() === "Add caption"
	);
	await act(async () => add?.click());
	await act(async () => root.unmount());
	host.remove();
	return runtime.project ? activeCaptions(runtime.project).at(-1)?.text : "";
}

test("a new caption is seeded in the UI language", async () => {
	expect(await addCaptionIn("ja")).toBe("新しい字幕");
	expect(await addCaptionIn("ar")).toBe("تسمية توضيحية جديدة");
	expect(await addCaptionIn("de")).toBe("Neue Untertitel");
});

test("an English UI seeds the English caption", async () => {
	expect(await addCaptionIn("en")).toBe("New caption");
});
