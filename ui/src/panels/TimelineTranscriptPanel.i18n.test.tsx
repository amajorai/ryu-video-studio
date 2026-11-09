// The "Delete N words (…)" button reads its length with the reader's decimal
// mark ("0,7s" in German) instead of `String(n)`'s English "0.7".
import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { TimelineTranscript } from "../../../shared/filler-words.ts";
import type { Project } from "../../../shared/project.ts";

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
const { numberFormatter, registerLiteralCatalogLoader } = await import(
	"@ryu/i18n/core"
);
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, testProject } = await import(
	"../editor/test-runtime.ts"
);
const { TimelineTranscriptPanel } = await import(
	"./TimelineTranscriptPanel.tsx"
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
	document.body.replaceChildren();
});

const DELETE =
	"Delete {count, plural, one {{countText} word} other {{countText} words}} ({seconds}s)";

// Stub catalogs, so the test does not depend on the shipped translations.
const CATALOGS: Record<string, Record<string, string>> = {
	ar: {
		[DELETE]:
			"حذف {count, plural, one {كلمة واحدة} other {{countText} كلمات}} ({seconds}s)",
	},
	de: {
		[DELETE]:
			"{count, plural, one {{countText} Wort} other {{countText} Wörter}} löschen ({seconds}s)",
	},
	ja: {
		[DELETE]: "{count, plural, other {{countText} 語}}を削除 ({seconds}s)",
	},
};

/** Words 0.4 s apart and 0.3 s long. */
const TEXT = "I went to the store today";

function transcriptFor(project: Project, clipId: string): TimelineTranscript {
	return {
		clips: [
			{
				assetId: crypto.randomUUID(),
				clipId,
				cues: [],
				words: TEXT.split(" ").map((text, index) => ({
					end: index * 0.4 + 0.3,
					id: crypto.randomUUID(),
					start: index * 0.4,
					text,
				})),
			},
		],
		projectId: project.id,
		revision: project.revision,
		sourceCaptions: [],
	};
}

/** Select the last two words (3.2–3.9 s merged: 0.7 s) and read the button. */
async function deleteButtonText(locale: string): Promise<string> {
	registerLiteralCatalogLoader(
		(requested) => CATALOGS[requested.slice(0, 2)] ?? {}
	);
	const { first, project } = testProject();
	const runtime = createTestRuntime(project);
	runtime.api = () => Promise.resolve(transcriptFor(project, first.id));
	const element = document.createElement("div");
	document.body.append(element);
	const root = createRoot(element);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
				manageDocument={false}
			>
				<EditorProvider value={runtime}>
					<TimelineTranscriptPanel />
				</EditorProvider>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	const words =
		element.querySelectorAll<HTMLButtonElement>("[data-token-index]");
	await act(async () => {
		words[4]?.click();
		words[5]?.dispatchEvent(
			new MouseEvent("click", { bubbles: true, shiftKey: true })
		);
	});
	const text =
		[...element.querySelectorAll("button")]
			.map((button) => button.textContent?.trim() ?? "")
			.find((label) => label.includes("(")) ?? "";
	await act(async () => root.unmount());
	return text;
}

test("English keeps the compact seconds", async () => {
	expect(await deleteButtonText("en")).toBe("Delete 2 words (0.7s)");
});

test("German reads the length with its own decimal mark", async () => {
	expect(await deleteButtonText("de")).toBe("2 Wörter löschen (0,7s)");
});

test("Japanese reads the length in its own format", async () => {
	expect(await deleteButtonText("ja")).toBe("2 語を削除 (0.7s)");
});

test("Arabic reads the length with its own number format", async () => {
	const text = await deleteButtonText("ar");
	expect(text).toContain("حذف");
	expect(text).toContain(`(${numberFormatter("ar").format(0.7)}s)`);
});
