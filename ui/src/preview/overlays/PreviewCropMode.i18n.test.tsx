// The unconstrained crop preset reads "Freeform": the shared preset's bare
// "Free" label is the price sense in the catalog (ja 無料, de "Kostenlos").
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
const { directManipulationStore } = await import("./direct-manipulation.ts");
const { PreviewCropMode } = await import("./PreviewCropMode.tsx");

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

// The price sense stays in the stub so a bare "Free" key would show.
const JAPANESE: Record<string, string> = {
	Free: "無料",
	Freeform: "フリーフォーム",
};

async function renderCropToolbar(locale: string) {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("ja") ? JAPANESE : {}
	);
	const { first, project, asset } = testProject();
	const runtime = createTestRuntime(project, [asset]);
	runtime.setSelected(first.id);
	directManipulationStore(runtime.store).setState({
		cropMode: true,
		cropTargetId: first.id,
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<EditorProvider value={runtime}>
					<div className="studio-preview-frame">
						<PreviewCropMode playing={false} project={project} time={1} />
					</div>
				</EditorProvider>
			</I18nProvider>
		);
	});
	// Let the catalog load and the DOM localizer pass settle.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	const free = host.querySelector('[data-crop-aspect="free"]')?.textContent;
	await act(async () => root.unmount());
	host.remove();
	return free;
}

test("the freeform crop preset renders in its shape sense in Japanese", async () => {
	const free = await renderCropToolbar("ja");
	expect(free).toBe("フリーフォーム");
	expect(free).not.toContain("無料");
});

test("English shows the freeform preset by name", async () => {
	expect(await renderCropToolbar("en")).toBe("Freeform");
});
