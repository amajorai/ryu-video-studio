import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { HostServices } from "@ryu/app-host/rpc";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
} from "../../../shared/project.ts";

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
const { AssetLibrary } = await import("./AssetLibrary.tsx");
const { LIBRARY_PREFERENCES_KEY } = await import("./sort.ts");
const { VIEWER_STORAGE_PREFIX } = await import("../editor/viewer-storage.ts");

type AppRequest = NonNullable<HostServices["appRequest"]>;
const received: Parameters<AppRequest>[0][] = [];
let respond: (input: Parameters<AppRequest>[0]) => unknown = () => null;
// Other suites define `window.ryu` as non-writable, so redefine it per test.
const installHost = () =>
	Object.defineProperty(window, "ryu", {
		configurable: true,
		value: {
			app: {
				request: (input: Parameters<AppRequest>[0]) => {
					received.push(input);
					return Promise.resolve(respond(input));
				},
			},
		},
		writable: true,
	});
installHost();

afterAll(() => {
	Reflect.deleteProperty(window, "ryu");
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

beforeEach(() => {
	installHost();
	received.length = 0;
	respond = () => null;
	localStorage.clear();
});

function media(name: string, createdAt: string, kind: Asset["kind"]): Asset {
	return {
		createdAt,
		duration: kind === "image" ? 5 : 12,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : 360,
		id: crypto.randomUUID(),
		kind,
		name,
		width: kind === "audio" ? 0 : 640,
	};
}

function fixture() {
	const beach = media("Beach", "2026-01-01T00:00:00.000Z", "video");
	const anthem = media("Anthem", "2026-01-03T00:00:00.000Z", "audio");
	const cliff = media("Cliff", "2026-01-02T00:00:00.000Z", "image");
	const project: Project = {
		...newProject("Holiday"),
		segments: [newSegment(beach)],
	};
	const runtime = createTestRuntime(project, [beach, anthem, cliff]);
	const removed: string[] = [];
	runtime.previewSources = {
		...runtime.previewSources,
		remove: (id: string) => {
			removed.push(id);
		},
		snapshot: () => ({}),
	} as typeof runtime.previewSources;
	return { anthem, beach, cliff, project, removed, runtime };
}

type Runtime = ReturnType<typeof fixture>["runtime"];

async function mount(runtime: Runtime) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<EditorProvider value={{ ...runtime }}>
				<AssetLibrary
					filters={{ importUrl: "", mediaFolder: "", query: "" }}
					onFiltersChange={() => undefined}
				/>
			</EditorProvider>
		);
	});
	return {
		host,
		names: () =>
			[...host.querySelectorAll<HTMLElement>("[data-asset-id] strong")].map(
				(node) => node.textContent
			),
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

function control<T extends Element>(host: ParentNode, label: string): T {
	const element = host.querySelector<T>(`[aria-label="${label}"]`);
	if (!element) {
		throw new Error(`Missing ${label}.`);
	}
	return element;
}

function button(label: string): HTMLButtonElement {
	const match = [...document.querySelectorAll("button")].find(
		(candidate) => candidate.textContent?.trim() === label
	);
	if (!match) {
		throw new Error(`Missing button ${label}.`);
	}
	return match;
}

async function choose(select: HTMLSelectElement, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLSelectElement.prototype,
			"value"
		)?.set?.call(select, value);
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

describe("AssetLibrary", () => {
	test("opens with the library column scrolled to the top", async () => {
		const { runtime } = fixture();
		const column = document.createElement("aside");
		column.className = "studio-library";
		document.body.append(column);
		// A column left scrolled by an earlier layout or a late-sizing tile.
		column.scrollTop = 240;
		const root = createRoot(column);
		await act(async () => {
			root.render(
				<EditorProvider value={{ ...runtime }}>
					<AssetLibrary
						filters={{ importUrl: "", mediaFolder: "", query: "" }}
						onFiltersChange={() => undefined}
					/>
				</EditorProvider>
			);
		});
		expect(column.scrollTop).toBe(0);
		await act(async () => root.unmount());
		column.remove();
	});

	test("sorts newest first, re-sorts by name, and remembers the choice", async () => {
		const { runtime } = fixture();
		const view = await mount(runtime);
		expect(view.names()).toEqual(["Anthem", "Cliff", "Beach"]);
		await choose(control(view.host, "Sort media by"), "name");
		expect(view.names()).toEqual(["Anthem", "Beach", "Cliff"]);
		await act(async () => {
			control<HTMLButtonElement>(
				view.host,
				"Sort ascending; switch to descending"
			).click();
		});
		expect(view.names()).toEqual(["Cliff", "Beach", "Anthem"]);
		expect(
			JSON.parse(
				localStorage.getItem(VIEWER_STORAGE_PREFIX + LIBRARY_PREFERENCES_KEY) ??
					"null"
			)
		).toEqual({ direction: "desc", sort: "name", view: "list" });
		await view.unmount();
		// A new mount reads the remembered order.
		const again = await mount(runtime);
		expect(again.names()).toEqual(["Cliff", "Beach", "Anthem"]);
		await again.unmount();
	});

	test("switches between list and grid views", async () => {
		const { runtime } = fixture();
		const view = await mount(runtime);
		const container = () =>
			view.host.querySelector<HTMLElement>("[data-library-view]");
		expect(container()?.dataset.libraryView).toBe("list");
		await act(async () => {
			control<HTMLButtonElement>(view.host, "Grid view").click();
		});
		expect(container()?.dataset.libraryView).toBe("grid");
		// Grid tiles keep placement actions but drop the heavy panels.
		expect(
			view.host.querySelector('[aria-label="Add Beach to timeline"]')
		).not.toBeNull();
		expect(view.host.textContent).not.toContain("2× upscale");
		await view.unmount();
	});

	test("multi-selects with Shift and deletes only unused media", async () => {
		const { anthem, beach, cliff, removed, runtime } = fixture();
		const view = await mount(runtime);
		await act(async () => {
			control<HTMLElement>(view.host, "Select Anthem").click();
		});
		await act(async () => {
			view.host
				.querySelector<HTMLElement>(`[data-asset-id="${beach.id}"]`)
				?.dispatchEvent(
					new MouseEvent("click", { bubbles: true, shiftKey: true })
				);
		});
		expect(view.host.textContent).toContain("3 of 3 selected");
		await act(async () => button("Delete selected").click());
		expect(document.body.textContent).toContain("Beach stays: used in Holiday");
		respond = () => ({
			deleted: [anthem.id, cliff.id],
			refused: [
				{
					id: beach.id,
					name: "Beach",
					projects: [{ id: runtime.project?.id, title: "Holiday" }],
					reason: "in-use",
				},
			],
		});
		await act(async () => {
			button("Delete 2 items").click();
			await Promise.resolve();
		});
		await act(async () => {
			await Promise.resolve();
		});
		// The relink button's offline-media check is the only other request.
		expect(
			received.filter((input) => input.path !== "/offline-assets")
		).toEqual([
			{
				body: { ids: [anthem.id, cliff.id, beach.id] },
				method: "POST",
				path: "/assets-delete-many",
			},
		]);
		expect(removed.sort()).toEqual([anthem.id, cliff.id].sort());
		const statuses = runtime.calls
			.filter(([name]) => name === "setStatus")
			.map(([, text]) => text);
		expect(statuses.at(-1)).toBe(
			"Deleted 2 media items. Kept 1 in use: Beach (used in Holiday). Remove their clips first."
		);
		const assetUpdate = runtime.calls
			.filter(([name]) => name === "setAssets")
			.at(-1)?.[1] as (current: Asset[]) => Asset[];
		expect(assetUpdate([anthem, beach, cliff])).toEqual([beach]);
		await view.unmount();
	});

	test("I/O marks in the source viewer feed Insert at playhead and the drag", async () => {
		const { beach, runtime } = fixture();
		runtime.time = 3;
		respond = () => ({ data: "AAAA", time: 0 });
		const view = await mount(runtime);
		await act(async () => {
			control<HTMLButtonElement>(view.host, "Preview Beach").click();
		});
		const slider = control<HTMLInputElement>(
			document.body,
			"Source position in Beach"
		);
		const key = async (value: string) => {
			await act(async () => {
				slider.dispatchEvent(
					new KeyboardEvent("keydown", { bubbles: true, key: value })
				);
			});
		};
		const seek = async (value: string) => {
			await act(async () => {
				Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value"
				)?.set?.call(slider, value);
				slider.dispatchEvent(new Event("input", { bubbles: true }));
			});
		};
		await seek("0.25");
		await key("i");
		await seek("0.75");
		await key("o");
		expect(document.body.textContent).toContain("Marked 0:03.0");
		await act(async () => button("Close preview").click());
		await act(async () => {
			control<HTMLButtonElement>(view.host, "Insert Beach at playhead").click();
		});
		const inserted = runtime.project?.segments.find(
			(segment) => segment.start === 3 && segment.assetId === beach.id
		);
		expect(inserted?.sourceIn).toBe(3);
		expect(inserted?.sourceOut).toBe(9);
		// The tile drag carries the same marked range.
		const data = new Map<string, string>();
		const drag = new Event("dragstart", { bubbles: true }) as DragEvent;
		Object.defineProperty(drag, "dataTransfer", {
			value: {
				effectAllowed: "none",
				setData: (type: string, value: string) => data.set(type, value),
			},
		});
		await act(async () => {
			view.host
				.querySelector(`[data-asset-id="${beach.id}"]`)
				?.dispatchEvent(drag);
		});
		const payload = JSON.parse(data.get("application/x-ryu-asset") ?? "{}");
		expect(payload.assetId).toBe(beach.id);
		expect(payload.sourceIn).toBe(3);
		expect(payload.sourceOut).toBe(9);
		await view.unmount();
	});
	test("clicks and drags inside the preview dialog leave the tile alone", async () => {
		const { anthem, beach, runtime } = fixture();
		respond = () => ({ data: "AAAA", time: 0 });
		const view = await mount(runtime);
		const selectedIds = () =>
			[...view.host.querySelectorAll<HTMLElement>("[data-selected]")].map(
				(node) => node.dataset.assetId
			);
		await act(async () => {
			control<HTMLElement>(view.host, "Select Anthem").click();
		});
		expect(selectedIds()).toEqual([anthem.id]);
		await act(async () => {
			control<HTMLButtonElement>(view.host, "Preview Beach").click();
		});
		const dialog = document.body.querySelector('[role="dialog"]');
		const text = dialog?.querySelector("p, h2");
		expect(text).toBeTruthy();
		await act(async () => {
			text?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			dialog?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(selectedIds()).toEqual([anthem.id]);
		const data = new Map<string, string>();
		const drag = new Event("dragstart", { bubbles: true }) as DragEvent;
		Object.defineProperty(drag, "dataTransfer", {
			value: {
				effectAllowed: "none",
				setData: (type: string, value: string) => data.set(type, value),
			},
		});
		await act(async () => {
			text?.dispatchEvent(drag);
		});
		expect(data.size).toBe(0);
		await act(async () => button("Close preview").click());
		// A click on the tile body itself still selects.
		await act(async () => {
			view.host
				.querySelector<HTMLElement>(`[data-asset-id="${beach.id}"] strong`)
				?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(selectedIds()).toEqual([beach.id]);
		await view.unmount();
	});

	test("Add with a marked audio range keeps audio on the audio track", async () => {
		const { anthem, runtime } = fixture();
		const view = await mount(runtime);
		await act(async () => {
			control<HTMLButtonElement>(view.host, "Preview Anthem").click();
		});
		const slider = control<HTMLInputElement>(
			document.body,
			"Source position in Anthem"
		);
		const seekAndKey = async (value: string, key: string) => {
			await act(async () => {
				Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value"
				)?.set?.call(slider, value);
				slider.dispatchEvent(new Event("input", { bubbles: true }));
			});
			await act(async () => {
				slider.dispatchEvent(
					new KeyboardEvent("keydown", { bubbles: true, key })
				);
			});
		};
		await seekAndKey("0.25", "i");
		await seekAndKey("0.5", "o");
		await act(async () => button("Close preview").click());
		await act(async () => {
			control<HTMLButtonElement>(view.host, "Add Anthem to timeline").click();
		});
		const added = runtime.project?.segments.find(
			(segment) => segment.assetId === anthem.id
		);
		expect(added?.track).toBe(1);
		expect(added?.sourceIn).toBe(3);
		expect(added?.sourceOut).toBe(6);
		await view.unmount();
	});
});
