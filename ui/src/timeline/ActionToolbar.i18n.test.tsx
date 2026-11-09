// The timeline toolbar's short button text and its title (action name plus
// key) render in the editor's language, not as English fragments.
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
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, testProject } = await import(
	"../editor/test-runtime.ts"
);
const { ActionToolbar } = await import("./ActionToolbar.tsx");

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

const ARABIC: Record<string, string> = {
	"Razor tool": "أداة القص",
	"Ripple trim start to playhead": "قص البداية حتى رأس التشغيل مع الإزاحة",
	"Timeline tools": "أدوات المخطط الزمني",
	"Trim start": "قص البداية",
	"{label} ({key})": "{label} ← {key}",
};

test("toolbar buttons show translated short text and titles in Arabic", async () => {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("ar") ? ARABIC : {}
	);
	const runtime = createTestRuntime(testProject().project);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ar" initialPackId={null}>
				<div dir="rtl">
					<EditorProvider value={runtime}>
						<ActionToolbar />
					</EditorProvider>
				</div>
			</I18nProvider>
		);
	});
	// Let the catalog load and the DOM localizer pass settle.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	const button = (action: string) =>
		host.querySelector<HTMLButtonElement>(`[data-toolbar-action="${action}"]`);
	expect(
		host.querySelector('[role="toolbar"]')?.getAttribute("aria-label")
	).toBe("أدوات المخطط الزمني");
	expect(button("trim.startToPlayhead")?.textContent).toBe("قص البداية");
	const razorTitle = button("tool.razor")?.getAttribute("title") ?? "";
	expect(razorTitle.startsWith("أداة القص ← ")).toBe(true);
	expect(razorTitle).not.toContain("Razor tool");
	const trimTitle = button("trim.startToPlayhead")?.getAttribute("title") ?? "";
	expect(trimTitle).not.toContain("Ripple trim");
	await act(async () => root.unmount());
	host.remove();
});
