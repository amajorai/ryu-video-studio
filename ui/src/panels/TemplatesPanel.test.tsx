import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { newProject, type Project } from "../../../shared/project.ts";
import {
	BUILT_IN_TEMPLATES,
	builtInTemplateSummary,
} from "../../../shared/template-library.ts";

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
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, lastStatus, testProject, testVideo } = await import(
	"../editor/test-runtime.ts"
);
const {
	formatTemplateSeconds,
	instanceStatus,
	pickableAssets,
	TemplatesPanel,
	templatesPanelTab,
	togglePicked,
} = await import("./TemplatesPanel.tsx");

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
	Reflect.deleteProperty(window, "ryu");
	document.body.replaceChildren();
});

interface Call {
	body?: unknown;
	method: string;
	path: string;
}

const summaries = BUILT_IN_TEMPLATES.slice(0, 2).map(builtInTemplateSummary);

function installSidecar(created: Project) {
	const calls: Call[] = [];
	const requestStub = (input: Call) => {
		calls.push(input);
		const { method = "GET", path } = input;
		if (path === "/templates") {
			return Promise.resolve({ templates: summaries });
		}
		if (path === "/template-instances" && method === "POST") {
			return Promise.resolve({
				adjustments: [],
				assignments: [
					{
						slotId: summaries[0]?.slots[0]?.id,
						assetId: (input.body as { assetIds: string[] }).assetIds[0],
					},
				],
				createdAssets: [],
				project: created,
				unfilledSlotIds: summaries[0]?.slots.slice(1).map((slot) => slot.id),
				unusedAssetIds: [],
			});
		}
		const save = path.match(/^\/projects\/([^/]+)\/save-template$/);
		if (save && method === "POST") {
			const template = {
				...newProject("Saved template"),
				template: { slots: [] },
			};
			return Promise.resolve({
				project: template,
				template: {
					...summaries[0],
					builtIn: false,
					id: template.id,
					title: "Saved template",
				},
			});
		}
		return Promise.resolve({ code: "NOT_FOUND", message: path });
	};
	Object.defineProperty(window, "ryu", {
		configurable: true,
		value: { app: { request: requestStub } },
		writable: true,
	});
	return calls;
}

async function flush() {
	for (let index = 0; index < 6; index++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
}

async function mount(runtime: ReturnType<typeof createTestRuntime>) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<EditorProvider value={{ ...runtime }}>
				<TemplatesPanel />
			</EditorProvider>
		);
	});
	await flush();
	return host;
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
	const match = [...scope.querySelectorAll("button")].find((node) =>
		node.textContent?.replace(/\s+/g, " ").trim().startsWith(label)
	);
	if (!match) {
		throw new Error(`Missing button ${label}.`);
	}
	return match;
}

describe("helpers", () => {
	test("togglePicked keeps pick order", () => {
		expect(togglePicked(["a"], "b")).toEqual(["a", "b"]);
		expect(togglePicked(["a", "b", "c"], "b")).toEqual(["a", "c"]);
	});

	test("formatTemplateSeconds rounds to a tenth", () => {
		expect(formatTemplateSeconds(11.6129)).toBe("11.6 s");
	});

	test("instanceStatus summarizes fills and leftovers", () => {
		const id = crypto.randomUUID();
		expect(
			instanceStatus(
				{
					adjustments: [{ segmentId: id, change: "retimed" }],
					assignments: [{ slotId: id, assetId: id }],
					unfilledSlotIds: [id],
					unusedAssetIds: [id, id],
				},
				"Promo"
			)
		).toBe(
			'Created "Promo" with 1 of 2 slots filled. 1 kept their placeholder; replace them on the timeline. 2 media items were not used. 1 short clips were slowed to fill their slot.'
		);
	});

	test("pickableAssets hides preview proxies", () => {
		const source = testVideo();
		const proxy = { ...testVideo(), derivation: "proxy" as const };
		expect(pickableAssets([source, proxy])).toEqual([source]);
	});

	test("declares its own library tab", () => {
		expect(templatesPanelTab).toEqual({
			label: "Templates",
			value: "templates",
		});
	});
});

describe("TemplatesPanel", () => {
	test("lists templates and creates a project from picked media", async () => {
		const { asset, project } = testProject();
		const created = { ...newProject("Vlog intro"), revision: 1 };
		const calls = installSidecar(created);
		const runtime = createTestRuntime(project, [asset]);
		const host = await mount(runtime);
		const titles = [
			...host.querySelectorAll(
				'[aria-label="Templates"] [data-template-title]'
			),
		].map((node) => node.textContent);
		expect(titles).toEqual(["Vlog intro", "Product promo"]);
		const first = host.querySelector<HTMLElement>(
			`[data-template-id="${summaries[0]?.id}"]`
		);
		await act(async () => {
			button(first ?? host, "Use template").click();
		});
		const pick = host.querySelector<HTMLButtonElement>(
			`[aria-label="Use ${asset.name}"]`
		);
		await act(async () => {
			pick?.click();
		});
		expect(host.textContent).toContain("#1");
		await act(async () => {
			button(host, "Create project").click();
		});
		await flush();
		const instance = calls.find((call) => call.path === "/template-instances");
		expect(instance?.body).toEqual({
			templateId: summaries[0]?.id,
			assetIds: [asset.id],
			music: true,
		});
		expect(runtime.calls).toContainEqual(["setProject", created]);
		expect(lastStatus(runtime)).toContain('Created "Vlog intro" with 1 of');
	});

	test("saves the selected clips as a template", async () => {
		const { first, project } = testProject();
		const calls = installSidecar(newProject("unused"));
		const runtime = createTestRuntime(project);
		runtime.setSelected(first.id);
		runtime.refresh();
		const host = await mount(runtime);
		await act(async () => {
			button(host, "Save 1 selected clip").click();
		});
		await flush();
		const save = calls.find((call) => call.path.endsWith("/save-template"));
		expect(save?.body).toEqual({
			slots: [{ segmentId: first.id }],
			revision: project.revision,
		});
		expect(lastStatus(runtime)).toBe('Saved "Saved template" with 5 slots.');
		expect(
			calls.filter((call) => call.path === "/templates").length
		).toBeGreaterThan(1);
	});
});
