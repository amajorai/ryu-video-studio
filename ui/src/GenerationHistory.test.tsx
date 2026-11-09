// Gateway cost and budget counters print with the reader's digit grouping
// ("1,250,000" in English, "1.250.000" in German) instead of a bare
// `String(micro)` that keeps every locale on "1250000".
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
const { GenerationHistory } = await import("./GenerationHistory.tsx");

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
	document.body.replaceChildren();
});

// Stub catalogs: the shipped catalog is not under test here.
const CATALOGS: Record<string, Record<string, string>> = {
	de: {
		"{amount} micro-USD": "{amount} Mikro-USD",
		"Actual Gateway cost: {cost}": "Tatsächliche Gateway-Kosten: {cost}",
	},
	ja: {
		"{amount} micro-USD": "{amount} マイクロUSD",
		"Actual Gateway cost: {cost}": "実際のGatewayコスト: {cost}",
	},
};

const auditEntry = {
	cost_micro_usd: 1_250_000,
	error: null,
	event_type: "completion",
	feature: null,
	id: "entry-1",
	model: "model-a",
	provider: "provider-a",
	request_id: "request-1",
	timestamp: "2026-01-01T00:00:00.000Z",
};

const JOB_ID = "7f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7";
const PROJECT_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

/** A finished narration request recorded at 1.25× with a matching receipt. */
const audioJob = {
	assetIds: [],
	createdAt: "2026-01-01T00:00:00.000Z",
	id: JOB_ID,
	message: "",
	projectRevision: 1,
	request: {
		id: JOB_ID,
		kind: "audio",
		language: "en",
		projectId: PROJECT_ID,
		prompt: "Hello",
		speed: 1.25,
		voice: "alto",
	},
	status: "completed",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

function installSidecar(jobs: unknown[] = []) {
	Object.defineProperty(window, "ryu", {
		configurable: true,
		value: {
			app: {
				request: ({ path }: { path: string }) => {
					if (path === "/budget") {
						return Promise.resolve({ reachable: true, unit: "micro_usd" });
					}
					if (path === "/budget/audit") {
						return Promise.resolve({
							entries: [
								auditEntry,
								{
									...auditEntry,
									cost_micro_usd: 2_500_000,
									id: "entry-2",
									request_id: JOB_ID,
								},
							],
							reachable: true,
						});
					}
					return Promise.resolve({ jobs });
				},
			},
		},
		writable: true,
	});
}

async function renderedLines(
	locale: string,
	jobs: unknown[] = []
): Promise<string[]> {
	registerLiteralCatalogLoader(
		(requested) => CATALOGS[requested.slice(0, 2)] ?? {}
	);
	installSidecar(jobs);
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
				<GenerationHistory
					assets={[]}
					onStatus={() => undefined}
					projectId={PROJECT_ID}
					revision={0}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	const lines = [...host.querySelectorAll("p")].map(
		(node) => node.textContent ?? ""
	);
	await act(async () => root.unmount());
	return lines;
}

async function costLine(locale: string): Promise<string> {
	const lines = await renderedLines(locale);
	return lines.find((text) => text.includes("USD")) ?? "";
}

test("English groups the micro-USD cost", async () => {
	expect(await costLine("en")).toBe("Actual Gateway cost: 1,250,000 micro-USD");
});

test("German groups the micro-USD cost with its own separator", async () => {
	const line = await costLine("de");
	expect(line).toBe("Tatsächliche Gateway-Kosten: 1.250.000 Mikro-USD");
	expect(line).not.toContain("1250000");
});

test("Japanese groups the micro-USD cost", async () => {
	expect(await costLine("ja")).toBe(
		"実際のGatewayコスト: 1,250,000 マイクロUSD"
	);
});

test("German groups the receipt cost and writes the voice rate with a comma", async () => {
	const lines = await renderedLines("de", [audioJob]);
	expect(lines).toContain("Gateway receipt: provider-a · 2.500.000 Mikro-USD");
	expect(lines).toContain("Voice: alto · Language: en · Rate: 1,25×");
});
