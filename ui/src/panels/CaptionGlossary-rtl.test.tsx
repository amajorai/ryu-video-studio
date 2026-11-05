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
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, testProject } = await import(
	"../editor/test-runtime.ts"
);
const { CaptionGlossary } = await import("./CaptionGlossary.tsx");

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

// The Arabic catalog mirrors the arrow, as it does for "{from} → {to}".
const overlays = {
	ar: {
		"{from} → {to}": "{from} ← {to}",
	},
};

async function renderIn(locale: string) {
	const runtime = createTestRuntime({
		...testProject().project,
		captionGlossary: [{ from: "رايو", to: "Ryu" }],
	});
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
					<CaptionGlossary />
				</EditorProvider>
			</I18nProvider>
		);
	});
	const list = host.querySelector('[aria-label="Name and term fixes"] li');
	const read = {
		isolated: [...(list?.querySelectorAll("bdi") ?? [])].map(
			(node) => node.textContent
		),
		struck: list?.querySelector("s")?.textContent ?? "",
		text: list?.querySelector("span")?.textContent ?? "",
	};
	await act(async () => root.unmount());
	host.remove();
	return read;
}

test("glossary pairs isolate each word and take the catalog's arrow", async () => {
	const ar = await renderIn("ar");
	expect(ar.text).toBe("رايو ← Ryu");
	expect(ar.isolated).toEqual(["رايو", "Ryu"]);
	expect(ar.struck).toBe("رايو");
});

test("English glossary pairs read wrong → right", async () => {
	const en = await renderIn("en");
	expect(en.text).toBe("رايو → Ryu");
	expect(en.isolated).toEqual(["رايو", "Ryu"]);
});
