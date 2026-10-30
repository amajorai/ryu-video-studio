import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// React DOM decides at load time whether the `input` event exists, so it is
// imported only after happy-dom registers the browser globals.
GlobalRegistrator.register();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const previousActEnvironment = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	configurable: true,
	value: true,
	writable: true,
});
const { newProject } = await import("../../../shared/project.ts");
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime } = await import("../editor/test-runtime.ts");
const { createMatte, importLottieFile, NewMediaMenu, parseMatteEdge } =
	await import("./NewMediaMenu.tsx");

type Asset = import("../../../shared/project.ts").Asset;

afterAll(() => {
	GlobalRegistrator.unregister();
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

function asset(overrides: Partial<Asset>): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration: 5,
		hasAudio: false,
		height: 1080,
		id: crypto.randomUUID(),
		kind: "image",
		name: "Color matte #112233",
		width: 1920,
		...overrides,
	};
}

/** A runtime slice that records library additions and status messages. */
function recorder() {
	const library: Asset[] = [];
	const statuses: string[] = [];
	return {
		library,
		runtime: {
			act: async (operation: () => Promise<void>) => {
				try {
					await operation();
				} catch (error) {
					statuses.push(error instanceof Error ? error.message : "failed");
				}
			},
			setAssets: (update: Asset[] | ((current: Asset[]) => Asset[])) => {
				const next = typeof update === "function" ? update(library) : update;
				library.splice(0, library.length, ...next);
			},
			setStatus: (status: string) => {
				statuses.push(status);
			},
		},
		statuses,
	};
}

describe("new media actions", () => {
	test("createMatte posts a validated body and adds the asset", async () => {
		const { library, runtime, statuses } = recorder();
		const bodies: unknown[] = [];
		const matte = asset({ derivation: "matte" });
		await createMatte(
			runtime,
			{ color: "#112233", height: 1080, width: 1920 },
			(body) => {
				bodies.push(body);
				return Promise.resolve(matte);
			}
		);
		expect(bodies).toEqual([{ color: "#112233", height: 1080, width: 1920 }]);
		expect(library).toEqual([matte]);
		expect(statuses.at(-1)).toContain("Color matte #112233 created");
	});

	test("importLottieFile reports invalid files without calling the sidecar", async () => {
		const { library, runtime, statuses } = recorder();
		let calls = 0;
		await importLottieFile(runtime, new File(["{}"], "broken.json"), 30, {
			send: () => {
				calls++;
				return Promise.reject(new Error("unexpected"));
			},
		});
		expect(calls).toBe(0);
		expect(library).toEqual([]);
		expect(statuses.at(-1)).toContain("not a Lottie animation");
	});

	test("importLottieFile renders, uploads and adds the alpha video and its preview", async () => {
		const { library, runtime, statuses } = recorder();
		const video = asset({
			derivation: "lottie",
			kind: "video",
			name: "Loader",
		});
		const preview = asset({
			derivation: "proxy",
			derivedFromAssetId: video.id,
			kind: "video",
			name: "Loader (preview)",
		});
		let encoding = 0;
		let received = 0;
		await importLottieFile(
			runtime,
			new File(
				[JSON.stringify({ fr: 30, h: 64, ip: 0, layers: [], op: 3, w: 64 })],
				"Loader.json"
			),
			30,
			{
				createRenderer: () =>
					Promise.resolve({
						destroy: () => undefined,
						render: () => Promise.resolve("AAAA"),
					}),
				send: (schema, path, _method, body) => {
					if (path === "/lottie-frames") {
						received += Array.isArray(body?.frames) ? body.frames.length : 0;
						return Promise.resolve(
							schema.parse({
								frameCount: 3,
								received,
								sessionId: body?.sessionId,
							})
						);
					}
					return Promise.resolve(schema.parse({ asset: video, preview }));
				},
				onEncoding: () => {
					encoding++;
				},
			}
		);
		expect(encoding).toBe(1);
		expect(library).toEqual([video, preview]);
		expect(statuses).toContain("Encoding Loader.json with alpha…");
		expect(statuses.at(-1)).toContain("Loader imported as a video");
	});
});

describe("matte edge parsing", () => {
	test("accepts whole pixels in range and nothing else", () => {
		expect(parseMatteEdge("1920")).toBe(1920);
		expect(parseMatteEdge(" 2 ")).toBe(2);
		expect(parseMatteEdge("8192")).toBe(8192);
		for (const text of ["", "1", "0", "8193", "19.5", "-4", "1e3", "abc"]) {
			expect(parseMatteEdge(text)).toBeUndefined();
		}
	});
});

/** Type into a React-controlled input the way a browser does. */
function typeInto(input: HTMLInputElement, text: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	setter?.call(input, text);
	input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

describe("NewMediaMenu", () => {
	test("the matte form defaults to the project canvas and creates a matte", async () => {
		const project = { ...newProject("Mattes"), height: 720, width: 1280 };
		const runtime = createTestRuntime(project);
		const requests: unknown[] = [];
		const matte = asset({ derivation: "matte", height: 720, width: 1280 });
		window.ryu = {
			app: {
				request: (input) => {
					requests.push(input);
					return Promise.resolve(matte);
				},
			},
		};
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		await act(async () => {
			root.render(
				<EditorProvider value={{ ...runtime }}>
					<NewMediaMenu />
				</EditorProvider>
			);
		});
		const buttons = () => [...host.querySelectorAll("button")];
		const button = (label: string) => {
			const found = buttons().find((item) => item.textContent === label);
			if (!found) {
				throw new Error(`missing button ${label}`);
			}
			return found;
		};
		expect(buttons().map((item) => item.textContent)).toEqual([
			"New color matte",
			"Import Lottie",
		]);
		expect(
			host
				.querySelector('input[aria-label="Lottie JSON or .lottie file"]')
				?.getAttribute("accept")
		).toBe("application/json,.json,.lottie");
		await act(async () => button("New color matte").click());
		const width = host.querySelector('input[aria-label="Matte width"]');
		const height = host.querySelector('input[aria-label="Matte height"]');
		expect(width instanceof HTMLInputElement && width.value).toBe("1280");
		expect(height instanceof HTMLInputElement && height.value).toBe("720");
		await act(async () => button("Create matte").click());
		expect(requests).toEqual([
			{
				body: { color: "#000000", height: 720, width: 1280 },
				method: "POST",
				path: "/matte",
			},
		]);
		expect(runtime.calls.some(([name]) => name === "setAssets")).toBe(true);
		await act(async () => root.unmount());
		host.remove();
		Reflect.deleteProperty(window, "ryu");
	});

	test("width and height keep typed text and gate Create until valid", async () => {
		const project = { ...newProject("Typing"), height: 720, width: 1280 };
		const runtime = createTestRuntime(project);
		const requests: unknown[] = [];
		window.ryu = {
			app: {
				request: (input) => {
					requests.push(input);
					return Promise.resolve(
						asset({ derivation: "matte", height: 1080, width: 1920 })
					);
				},
			},
		};
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		await act(async () => {
			root.render(
				<EditorProvider value={{ ...runtime }}>
					<NewMediaMenu />
				</EditorProvider>
			);
		});
		const button = (label: string) => {
			const found = [...host.querySelectorAll("button")].find(
				(item) => item.textContent === label
			);
			if (!found) {
				throw new Error(`missing button ${label}`);
			}
			return found;
		};
		await act(async () => button("New color matte").click());
		const field = (label: string) => {
			const found = host.querySelector(`input[aria-label="${label}"]`);
			if (!(found instanceof HTMLInputElement)) {
				throw new Error(`missing field ${label}`);
			}
			return found;
		};
		// A partial value is shown as typed (not clamped to 2) and blocks Create.
		await act(async () => typeInto(field("Matte width"), "1"));
		expect(field("Matte width").value).toBe("1");
		expect(field("Matte width").getAttribute("aria-invalid")).toBe("true");
		expect(button("Create matte").disabled).toBe(true);
		await act(async () => typeInto(field("Matte width"), "1920"));
		await act(async () => typeInto(field("Matte height"), ""));
		expect(field("Matte height").value).toBe("");
		expect(button("Create matte").disabled).toBe(true);
		await act(async () => typeInto(field("Matte height"), "1080"));
		expect(field("Matte width").value).toBe("1920");
		expect(button("Create matte").disabled).toBe(false);
		await act(async () => button("Create matte").click());
		expect(requests).toEqual([
			{
				body: { color: "#000000", height: 1080, width: 1920 },
				method: "POST",
				path: "/matte",
			},
		]);
		await act(async () => root.unmount());
		host.remove();
		Reflect.deleteProperty(window, "ryu");
	});
});
