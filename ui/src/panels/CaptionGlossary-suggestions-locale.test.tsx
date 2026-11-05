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

const overlays = {
	de: {
		"Ryu suggests": "Ryu schlägt vor",
		"Suggested fixes": "Vorgeschlagene Korrekturen",
	},
};

test("the suggestion list is named in the reader's language without the DOM localizer", async () => {
	const runtime = createTestRuntime({
		...testProject().project,
		captions: [
			{ end: 2, id: crypto.randomUUID(), start: 0, text: "Meet cubernetes" },
		],
	});
	const previous = window.ryu;
	window.ryu = {
		model: {
			complete: () =>
				Promise.resolve('{"fixes":[{"from":"cubernetes","to":"Kubernetes"}]}'),
		},
	};
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => {
			root.render(
				<I18nProvider
					autoLocalizeDom={false}
					initialLocale="de"
					manageDocument={false}
					overlays={overlays}
				>
					<EditorProvider value={{ ...runtime }}>
						<CaptionGlossary />
					</EditorProvider>
				</I18nProvider>
			);
		});
		// The suggest button is the only one whose label mentions Ryu.
		const suggest = [...host.querySelectorAll("button")].find((candidate) =>
			candidate.textContent?.includes("Ryu")
		);
		await act(async () => {
			suggest?.click();
		});
		const list = host.querySelector(
			'[aria-label="Vorgeschlagene Korrekturen"]'
		);
		expect(list?.textContent).toContain("cubernetes");
		expect(host.querySelector('[aria-label="Suggested fixes"]')).toBeNull();
		expect(host.textContent).toContain("Ryu schlägt vor");
	} finally {
		window.ryu = previous;
		await act(async () => root.unmount());
		host.remove();
	}
});
