import { afterAll, describe, expect, test } from "bun:test";
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
const { StoryboardPanel } = await import("../panels/StoryboardPanel.tsx");
const { READINESS_STATUS_LABEL, readinessCheckValues, statusWordLabel } =
	await import("./readiness-labels.ts");

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

const readiness = {
	checks: [
		{
			detail: "Select a saved media take for every scene.",
			id: "assets",
			label: "Scene assets",
			status: "blocked",
		},
	],
	exportReady: false,
	ready: false,
};

const overlays = {
	de: {
		"{label}: {status} · {detail}": "{label}: {status} – {detail}",
		Blocked: "Blockiert",
		Pending: "Ausstehend",
		"Scene assets": "Szenenmedien",
		"Select a saved media take for every scene.":
			"Wähle für jede Szene eine gespeicherte Aufnahme.",
	},
};

describe("readiness labels", () => {
	test("every status code has a label, never the bare code", () => {
		for (const [code, label] of Object.entries(READINESS_STATUS_LABEL)) {
			expect(label).not.toBe(code);
		}
		const values = readinessCheckValues((text) => `[${text}]`, {
			detail: "d",
			id: "x",
			label: "l",
			status: "optional",
		});
		expect(values).toEqual({
			detail: "[d]",
			label: "[l]",
			status: "[Optional]",
		});
	});

	test("stage, activity and transcript codes show their label", () => {
		const tl = (text: string) => `[${text}]`;
		expect(statusWordLabel(tl, "blocked")).toBe("[Blocked]");
		expect(statusWordLabel(tl, "canceled")).toBe("[Canceled]");
		expect(statusWordLabel(tl, "interrupted")).toBe("[Interrupted]");
		// Unknown codes show as reported; inherited keys are not labels.
		expect(statusWordLabel(tl, "rewinding")).toBe("rewinding");
		expect(statusWordLabel(tl, "toString")).toBe("toString");
	});

	test("a blocked readiness row reads in the reader's language", async () => {
		const runtime = createTestRuntime(testProject().project);
		const previous = window.ryu;
		window.ryu = {
			app: {
				request: (input) =>
					input.path.endsWith("/readiness")
						? Promise.resolve(readiness)
						: Promise.reject(new Error("not under test")),
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
							<StoryboardPanel />
						</EditorProvider>
					</I18nProvider>
				);
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			const row = [...host.querySelectorAll("li")].find((item) =>
				item.textContent?.includes("Szenenmedien")
			);
			expect(row?.textContent).toBe(
				"Szenenmedien: Blockiert – Wähle für jede Szene eine gespeicherte Aufnahme."
			);
			expect(row?.textContent).not.toContain("blocked");
			// Pipeline checkpoints show their status label, not the code.
			const stageStatus = [
				...host.querySelectorAll(".studio-activity-status-pending"),
			].map((item) => item.textContent);
			expect(stageStatus.length).toBeGreaterThan(0);
			expect(new Set(stageStatus)).toEqual(new Set(["Ausstehend"]));
		} finally {
			window.ryu = previous;
			await act(async () => root.unmount());
			host.remove();
		}
	});
});
