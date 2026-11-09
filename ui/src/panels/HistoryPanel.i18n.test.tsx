// Undo steps are recorded in the language the editor shows: a Japanese editor
// lists "ギャップをリップル削除", not "Ripple delete gap", and the "Jumped to"
// notice quotes the same translated label.
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
const { newProject, newSegment } = await import("../../../shared/project.ts");
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, lastStatus, testVideo } = await import(
	"../editor/test-runtime.ts"
);
const { rippleDeleteGapAt } = await import("../editor/actions/ripple.ts");
const { HistoryPanel } = await import("./HistoryPanel.tsx");

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
	Reflect.deleteProperty(window, "ryu");
});

const JAPANESE: Record<string, string> = {
	"Jumped to “{label}”.": "「{label}」に移動しました。",
	Opened: "開いた時点",
	"Ripple delete gap": "ギャップをリップル削除",
	"Start of this session": "このセッションの開始",
};

function gapRuntime() {
	const video = testVideo("clip.mp4", 30);
	const first = { ...newSegment(video, 0, 0), sourceOut: 2 };
	const second = { ...newSegment(video, 5, 0), sourceOut: 2 };
	return createTestRuntime(
		{ ...newProject("Gap"), segments: [first, second] },
		[video]
	);
}

test("a Japanese editor records and jumps to translated undo labels", async () => {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("ja") ? JAPANESE : {}
	);
	Object.defineProperty(window, "ryu", {
		configurable: true,
		value: { app: { request: () => Promise.resolve({ revisions: [] }) } },
	});
	const runtime = gapRuntime();
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const draw = async () => {
		await act(async () => {
			root.render(
				<I18nProvider initialLocale="ja" initialPackId={null}>
					<EditorProvider value={{ ...runtime }}>
						<HistoryPanel />
					</EditorProvider>
				</I18nProvider>
			);
		});
	};
	await draw();
	// Let the catalog load and the DOM localizer pass settle.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});

	// A keyboard-style call passes no `tl`, so the label follows the host locale.
	await act(async () => {
		rippleDeleteGapAt(runtime, 0, 3);
	});
	await draw();
	const recorded = runtime.store.getState().history.past.at(-1)?.label;
	expect(recorded).toBe("ギャップをリップル削除");

	const row = (index: number) =>
		host.querySelector<HTMLElement>(`[data-history-index="${index}"]`);
	expect(row(1)?.textContent).toContain("ギャップをリップル削除");
	expect(row(0)?.textContent).toContain("このセッションの開始");
	expect(host.textContent).not.toContain("Ripple delete gap");
	expect(host.textContent).not.toContain("Start of this session");

	await act(async () => {
		row(0)?.click();
	});
	expect(lastStatus(runtime)).toBe("「開いた時点」に移動しました。");
	await draw();
	await act(async () => {
		row(1)?.click();
	});
	expect(lastStatus(runtime)).toBe(
		"「ギャップをリップル削除」に移動しました。"
	);

	await act(async () => root.unmount());
	host.remove();
});
