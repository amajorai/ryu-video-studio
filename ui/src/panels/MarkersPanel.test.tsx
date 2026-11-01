import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { newProject, type Project } from "../../../shared/project.ts";

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
const { createTestRuntime } = await import("../editor/test-runtime.ts");
const { markerPreferences } = await import("../markers/marker-preferences.ts");
const { PreviewMarkers } = await import(
	"../preview/overlays/PreviewMarkers.tsx"
);
const { MarkersPanel } = await import("./MarkersPanel.tsx");
const { onAgentHandoffRequest } = await import("../editor/actions/ai.ts");

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

const open = { id: crypto.randomUUID(), label: "Intro", time: 1 };
const resolved = {
	comment: "Done",
	id: crypto.randomUUID(),
	label: "Outro",
	status: "resolved" as const,
	time: 6,
};
const review = {
	duration: 2,
	id: crypto.randomUUID(),
	label: "Middle",
	status: "review" as const,
	time: 3,
};

function fixture() {
	const project: Project = {
		...newProject("Marker panel"),
		markers: [resolved, open, review],
	};
	return createTestRuntime(project);
}

type Runtime = ReturnType<typeof fixture>;

async function mount(runtime: Runtime) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const draw = async () => {
		await act(async () => {
			root.render(
				<EditorProvider value={{ ...runtime }}>
					<MarkersPanel />
				</EditorProvider>
			);
		});
	};
	await draw();
	return {
		draw,
		host,
		labels: () =>
			[
				...host.querySelectorAll<HTMLElement>(
					'[aria-label="Timeline markers"] li'
				),
			].map((row) => row.querySelector("button span")?.textContent?.trim()),
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

/** Set a form control's value so React's change tracking sees the edit. */
function setNativeValue(
	element: HTMLSelectElement | HTMLTextAreaElement,
	value: string
) {
	const prototype = Object.getPrototypeOf(element) as object;
	Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
		element,
		value
	);
}

function control<T extends Element>(host: ParentNode, label: string): T {
	const element = host.querySelector<T>(`[aria-label="${label}"]`);
	if (!element) {
		throw new Error(`Missing ${label}.`);
	}
	return element;
}

describe("MarkersPanel", () => {
	test("Ask agent hands one marker to the agent", async () => {
		const runtime = fixture();
		const scopes: { markerIds?: string[] }[] = [];
		const stop = onAgentHandoffRequest((scope) => scopes.push(scope));
		try {
			const view = await mount(runtime);
			const middle = runtime.project?.markers.find(
				(marker) => marker.label === "Middle"
			);
			await act(async () => {
				control<HTMLButtonElement>(
					view.host,
					"Ask agent about marker Middle"
				).click();
			});
			expect(scopes).toHaveLength(1);
			expect(scopes[0]?.markerIds).toEqual([middle?.id ?? ""]);
			await view.unmount();
		} finally {
			stop();
		}
	});

	test("lists markers in time order and filters by status", async () => {
		const runtime = fixture();
		const view = await mount(runtime);
		expect(view.labels()).toEqual(["Intro", "Middle", "Outro"]);
		const filter = control<HTMLSelectElement>(
			view.host,
			"Marker status filter"
		);
		await act(async () => {
			setNativeValue(filter, "open");
			filter.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(runtime.store.getState().markerStatusFilter).toBe("open");
		expect(view.labels()).toEqual(["Intro", "Middle"]);
		await act(async () => {
			runtime.store.setState({ markerStatusFilter: "resolved" });
		});
		expect(view.labels()).toEqual(["Outro"]);
		await view.unmount();
	});

	test("comments save on blur and status changes save immediately", async () => {
		const runtime = fixture();
		const view = await mount(runtime);
		const comment = control<HTMLTextAreaElement>(view.host, "Comment on Intro");
		await act(async () => {
			setNativeValue(comment, "Trim the pause");
			comment.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(runtime.project?.markers.find((m) => m.id === open.id)).toEqual(
			open
		);
		await act(async () => {
			comment.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		});
		// App rebuilds the runtime after every edit; redraw to match.
		await view.draw();
		const status = control<HTMLSelectElement>(view.host, "Status of Intro");
		await act(async () => {
			setNativeValue(status, "review");
			status.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(
			runtime.project?.markers.find((m) => m.id === open.id)
		).toMatchObject({ comment: "Trim the pause", status: "review" });
		await view.unmount();
	});

	test("saving a comment keeps the row mounted, and undo still updates it", async () => {
		const runtime = fixture();
		const view = await mount(runtime);
		const comment = control<HTMLTextAreaElement>(view.host, "Comment on Intro");
		const remove = control<HTMLButtonElement>(view.host, "Delete marker Intro");
		const status = control<HTMLSelectElement>(view.host, "Status of Intro");
		await act(async () => {
			setNativeValue(comment, "Trim");
			comment.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			comment.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		});
		await view.draw();
		// The controls the user was pressing or tabbing to survive the save.
		expect(comment.isConnected).toBe(true);
		expect(remove.isConnected).toBe(true);
		expect(status.isConnected).toBe(true);
		expect(
			runtime.project?.markers.find((m) => m.id === open.id)?.comment
		).toBe("Trim");
		await act(async () => {
			runtime.undo();
		});
		await view.draw();
		expect(comment.isConnected).toBe(true);
		expect(comment.value).toBe("");
		// An outside edit never overwrites a draft that is still being typed.
		await act(async () => {
			setNativeValue(comment, "Draft");
			comment.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			runtime.redo();
		});
		await view.draw();
		expect(comment.value).toBe("Draft");
		await view.unmount();
	});

	test("navigation, delete, and the ripple toggle edit the project", async () => {
		const runtime = fixture();
		runtime.time = 2;
		const view = await mount(runtime);
		const next = [...view.host.querySelectorAll("button")].find(
			(button) => button.textContent === "Next"
		);
		await act(async () => {
			next?.click();
		});
		expect(runtime.time).toBe(3);
		await act(async () => {
			control<HTMLButtonElement>(view.host, "Ripple markers").click();
		});
		expect(runtime.project?.rippleMarkers).toBe(false);
		await view.draw();
		await act(async () => {
			control<HTMLButtonElement>(view.host, "Delete marker Outro").click();
		});
		expect(runtime.project?.markers.map((m) => m.label)).toEqual([
			"Intro",
			"Middle",
		]);
		await view.unmount();
	});

	test("an empty project explains the shortcuts", async () => {
		const runtime = createTestRuntime(newProject("Empty"));
		const view = await mount(runtime);
		expect(view.host.textContent).toContain("No markers yet");
		expect(view.host.textContent).toContain("Alt+M");
		await view.unmount();
	});
});

describe("PreviewMarkers", () => {
	async function preview(time: number) {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		const project = fixture().project as Project;
		await act(async () => {
			root.render(
				<PreviewMarkers playing={false} project={project} time={time} />
			);
		});
		const text = host.textContent ?? "";
		await act(async () => root.unmount());
		host.remove();
		return text;
	}

	test("labels show only while the viewer toggle is on", async () => {
		const preferences = markerPreferences();
		preferences.set(false);
		expect(await preview(3.5)).toBe("");
		preferences.set(true);
		const inRange = await preview(3.5);
		expect(inRange).toContain("Middle");
		expect(inRange).toContain("In review");
		expect(await preview(5.5)).toBe("");
		expect(await preview(6.2)).toContain("Done");
		preferences.set(false);
	});
});
