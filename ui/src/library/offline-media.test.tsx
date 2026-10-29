import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register();
const previousActEnvironment = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	configurable: true,
	value: true,
	writable: true,
});
const { newSegment } = await import("../../../shared/project.ts");
const { ClipOfflineBadge } = await import("../timeline/ClipOfflineBadge.tsx");
const {
	applyRelinked,
	candidateFiles,
	refreshOfflineMedia,
	relinkFolder,
	relinkWithFile,
	resetOfflineMedia,
	setOfflineMedia,
} = await import("./offline-media.ts");
const { batchSummaryText, RelinkDialog } = await import("./RelinkDialog.tsx");
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime } = await import("../editor/test-runtime.ts");

type Asset = import("../../../shared/project.ts").Asset;
type OfflineAssetReport =
	import("../../../shared/relink.ts").OfflineAssetReport;
type RelinkTransport = import("./offline-media.ts").RelinkTransport;

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
const roots: import("react-dom/client").Root[] = [];
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	resetOfflineMedia();
	document.body.replaceChildren();
});

function asset(overrides: Partial<Asset> = {}): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration: 4,
		hasAudio: true,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video",
		name: "Take.mp4",
		width: 640,
		...overrides,
	};
}

function report(media: Asset): OfflineAssetReport {
	return {
		assetId: media.id,
		duration: media.duration,
		kind: media.kind,
		name: media.name,
		projects: [],
		reason: "missing",
	};
}

/** Runtime slice that applies library and preview-source updates. */
function librarySlice(initial: Asset[], sources: Record<string, string> = {}) {
	const state = { assets: [...initial], sources: { ...sources } };
	return {
		runtime: {
			setAssets: (update: Asset[] | ((current: Asset[]) => Asset[])) => {
				state.assets =
					typeof update === "function" ? update(state.assets) : update;
			},
			setSources: (
				update:
					| Record<string, string>
					| ((current: Record<string, string>) => Record<string, string>)
			) => {
				state.sources =
					typeof update === "function" ? update(state.sources) : update;
			},
		},
		state,
	};
}

function fakeTransport(overrides: Partial<RelinkTransport> = {}) {
	const discarded: string[] = [];
	const uploads: string[] = [];
	const transport: RelinkTransport = {
		discard: (id) => {
			discarded.push(id);
			return Promise.resolve();
		},
		relink: () => Promise.reject(new Error("unexpected relink")),
		relinkBatch: () => Promise.reject(new Error("unexpected batch")),
		upload: (file) => {
			uploads.push(file.name);
			return Promise.resolve(asset({ name: file.name }));
		},
		...overrides,
	};
	return { discarded, transport, uploads };
}

async function render(node: React.ReactNode) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => {
		root.render(node);
	});
	return { host, root };
}

describe("offline media store", () => {
	test("refresh shares one request and keeps the last list on failure", async () => {
		const media = asset();
		let calls = 0;
		const fetchOffline = () => {
			calls++;
			return Promise.resolve({ offline: [report(media)] });
		};
		const [first, second] = await Promise.all([
			refreshOfflineMedia(fetchOffline),
			refreshOfflineMedia(fetchOffline),
		]);
		expect(calls).toBe(1);
		expect(first).toBe(second);
		expect(first.reports.map((item) => item.assetId)).toEqual([media.id]);
		const kept = await refreshOfflineMedia(() =>
			Promise.reject(new Error("sidecar down"))
		);
		expect(kept.reports).toHaveLength(1);
	});

	test("applyRelinked replaces the asset, drops the upload and its preview", () => {
		const target = asset();
		const upload = asset({ name: "upload.mp4" });
		const { runtime, state } = librarySlice([target, upload], {
			[target.id]: "blob:stale",
			other: "blob:keep",
		});
		const relinked = { ...target, width: 1280 };
		applyRelinked(runtime, { asset: relinked, removedAssetId: upload.id });
		expect(state.assets).toEqual([relinked]);
		expect(state.sources).toEqual({ other: "blob:keep" });
	});

	test("applyRelinked swaps the old proxies for the replacement's", () => {
		const target = asset();
		const upload = asset({ name: "upload.mp4" });
		const oldProxy = asset({
			derivation: "proxy",
			derivedFromAssetId: target.id,
		});
		const newProxy = asset({
			derivation: "proxy",
			derivedFromAssetId: upload.id,
		});
		const { runtime, state } = librarySlice(
			[target, upload, oldProxy, newProxy],
			{ [oldProxy.id]: "blob:old-proxy", other: "blob:keep" }
		);
		const moved = { ...newProxy, derivedFromAssetId: target.id };
		applyRelinked(runtime, {
			asset: target,
			proxyAssets: [moved],
			removedAssetId: upload.id,
			removedProxyAssetIds: [oldProxy.id],
		});
		expect(state.assets).toEqual([target, moved]);
		expect(state.sources).toEqual({ other: "blob:keep" });
	});

	test("candidateFiles keeps only files named like offline media", () => {
		const reports = [report(asset({ name: "Take.mp4" }))];
		const files = [
			new File(["a"], "take (2).MOV"),
			new File(["b"], "Other.mp4"),
		];
		expect(candidateFiles(reports, files).map((file) => file.name)).toEqual([
			"take (2).MOV",
		]);
	});
});

describe("relinkWithFile", () => {
	test("uploads, relinks and applies the result", async () => {
		const target = asset();
		const relinked = { ...target, duration: 4.2 };
		const { runtime, state } = librarySlice([target]);
		setOfflineMedia([report(target)]);
		const { discarded, transport } = fakeTransport({
			relink: (assetId, sourceAssetId) =>
				Promise.resolve({
					asset: { ...relinked, id: assetId },
					dryRun: false,
					proxyAssets: [],
					removedAssetId: sourceAssetId,
					removedProxyAssetIds: [],
					warnings: ["The frame size changes."],
				}),
		});
		window.ryu = {
			app: { request: () => Promise.resolve({ offline: [] }) },
		};
		const warnings = await relinkWithFile(
			runtime,
			report(target),
			new File(["x"], "Take.mp4"),
			undefined,
			transport
		);
		expect(warnings).toEqual(["The frame size changes."]);
		expect(state.assets).toEqual([relinked]);
		expect(discarded).toEqual([]);
	});

	test("a refused replacement is discarded and the error rethrown", async () => {
		const target = asset();
		const { runtime } = librarySlice([target]);
		const { discarded, transport } = fakeTransport({
			relink: () => Promise.reject(new Error("The replacement lasts 9 s.")),
		});
		await expect(
			relinkWithFile(
				runtime,
				report(target),
				new File(["x"], "Take.mp4"),
				undefined,
				transport
			)
		).rejects.toThrow("lasts 9 s");
		expect(discarded).toHaveLength(1);
	});
});

describe("relinkFolder", () => {
	test("uploads candidates, relinks matches and discards leftovers", async () => {
		const take = asset({ name: "Take.mp4" });
		const voice = asset({ kind: "audio", name: "Voice.wav" });
		const { runtime, state } = librarySlice([take, voice]);
		const ids: string[] = [];
		const targets: string[] = [];
		const { discarded, transport, uploads } = fakeTransport({
			relinkBatch: (sourceAssetIds, targetAssetIds) => {
				ids.push(...sourceAssetIds);
				targets.push(...targetAssetIds);
				return Promise.resolve({
					failures: [
						{
							assetId: voice.id,
							reason: "Voice.wav is audio.",
							sourceAssetId: sourceAssetIds[1] ?? "",
						},
					],
					relinked: [
						{
							asset: { ...take, width: 1920 },
							dryRun: false,
							proxyAssets: [],
							removedAssetId: sourceAssetIds[0] ?? null,
							removedProxyAssetIds: [],
							warnings: [],
						},
					],
					unmatched: [],
					unusedSourceAssetIds: [],
				});
			},
		});
		window.ryu = {
			app: { request: () => Promise.resolve({ offline: [] }) },
		};
		const summary = await relinkFolder(
			runtime,
			[report(take), report(voice)],
			[
				new File(["a"], "Take.mp4"),
				new File(["b"], "voice.wav"),
				new File(["c"], "Unrelated.mp4"),
			],
			undefined,
			transport
		);
		expect(uploads).toEqual(["Take.mp4", "voice.wav"]);
		expect(ids).toHaveLength(2);
		expect(targets).toEqual([take.id, voice.id]);
		expect(discarded).toEqual(ids.slice(1));
		expect(state.assets[0]?.width).toBe(1920);
		expect(summary).toEqual({
			failed: ["Voice.wav is audio."],
			relinked: 1,
			unmatched: 0,
			uploaded: 2,
		});
		expect(batchSummaryText(summary)).toBe(
			"Relinked 1 of 2 offline files. Voice.wav is audio."
		);
	});

	test("a failed upload discards the uploads already made", async () => {
		const { runtime } = librarySlice([]);
		const made: string[] = [];
		const { discarded, transport } = fakeTransport({
			relinkBatch: () => Promise.reject(new Error("must not run")),
			upload: (file) => {
				if (made.length) {
					return Promise.reject(new Error("Quota exceeded."));
				}
				const uploaded = asset({ name: file.name });
				made.push(uploaded.id);
				return Promise.resolve(uploaded);
			},
		});
		await expect(
			relinkFolder(
				runtime,
				[report(asset({ name: "A.mp4" })), report(asset({ name: "B.mp4" }))],
				[new File(["a"], "A.mp4"), new File(["b"], "B.mp4")],
				undefined,
				transport
			)
		).rejects.toThrow("Quota exceeded.");
		expect(made).toHaveLength(1);
		expect(discarded).toEqual(made);
	});

	test("nothing is uploaded when no file name matches", async () => {
		const { runtime } = librarySlice([]);
		const { transport, uploads } = fakeTransport();
		const summary = await relinkFolder(
			runtime,
			[report(asset())],
			[new File(["a"], "Other.mp4")],
			undefined,
			transport
		);
		expect(uploads).toEqual([]);
		expect(batchSummaryText(summary)).toContain("No chosen file");
	});
});

describe("ClipOfflineBadge", () => {
	test("renders a hatched badge only for offline media", async () => {
		const offline = asset({ name: "Gone.mp4" });
		const online = asset({ name: "Here.mp4" });
		setOfflineMedia([report(offline)]);
		const slot = (media: Asset) => ({
			asset: media,
			fps: 30,
			locked: false,
			segment: newSegment(media, 0),
			selected: false,
			zoom: 70,
		});
		const { host } = await render(
			<>
				<ClipOfflineBadge {...slot(offline)} />
				<ClipOfflineBadge {...slot(online)} />
			</>
		);
		const badges = host.querySelectorAll('[data-testid="clip-offline-badge"]');
		expect(badges).toHaveLength(1);
		expect(badges[0]?.getAttribute("data-offline-reason")).toBe("missing");
		expect(badges[0]?.getAttribute("title")).toContain("missing");
		expect(badges[0]?.textContent).toContain("Offline");
		await act(async () => {
			setOfflineMedia([]);
		});
		expect(
			host.querySelectorAll('[data-testid="clip-offline-badge"]')
		).toHaveLength(0);
	});
});

describe("RelinkDialog", () => {
	test("lists offline media and relinks a chosen replacement", async () => {
		const target = asset({ name: "Gone.mp4" });
		const requests: unknown[] = [];
		let offline = [
			{
				...report(target),
				projects: [
					{ clipCount: 2, projectId: crypto.randomUUID(), title: "Cut" },
				],
			},
		];
		window.ryu = {
			app: {
				request: (input) => {
					requests.push(input);
					return Promise.resolve({ offline });
				},
			},
		};
		const runtime = createTestRuntime(null, [target]);
		const { discarded, transport } = fakeTransport({
			relink: (assetId, sourceAssetId) => {
				offline = [];
				return Promise.resolve({
					asset: { ...target, id: assetId },
					dryRun: false,
					proxyAssets: [],
					removedAssetId: sourceAssetId,
					removedProxyAssetIds: [],
					warnings: [],
				});
			},
		});
		await render(
			<EditorProvider value={{ ...runtime }}>
				<RelinkDialog onClose={() => undefined} open transport={transport} />
			</EditorProvider>
		);
		await act(async () => {
			await Promise.resolve();
		});
		const text = document.body.textContent ?? "";
		expect(text).toContain("Relink offline media");
		expect(text).toContain("Gone.mp4");
		expect(text).toContain("Used in Cut (2 clips).");
		expect(text).toContain("The stored media file is missing.");
		const input = document.querySelector(
			'input[aria-label="Replacement file for Gone.mp4"]'
		);
		if (!(input instanceof HTMLInputElement)) {
			throw new Error("missing replacement input");
		}
		expect(input.accept).toBe("video/*");
		Object.defineProperty(input, "files", {
			configurable: true,
			value: [new File(["x"], "Gone.mp4")],
		});
		await act(async () => {
			input.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await act(async () => {
			await Promise.resolve();
		});
		expect(document.body.textContent).toContain(
			"Gone.mp4 relinked to Gone.mp4."
		);
		expect(document.body.textContent).toContain("All library media is online.");
		expect(discarded).toEqual([]);
		expect(
			requests.some(
				(item) =>
					typeof item === "object" &&
					item !== null &&
					"path" in item &&
					item.path === "/offline-assets"
			)
		).toBe(true);
	});

	test("the folder picker is a directory picker once the dialog opens", async () => {
		window.ryu = {
			app: {
				request: () =>
					Promise.resolve({ offline: [report(asset({ name: "Gone.mp4" }))] }),
			},
		};
		const runtime = createTestRuntime(null, []);
		const { transport } = fakeTransport();
		const tree = (open: boolean) => (
			<EditorProvider value={{ ...runtime }}>
				<RelinkDialog
					onClose={() => undefined}
					open={open}
					transport={transport}
				/>
			</EditorProvider>
		);
		const { root } = await render(tree(false));
		expect(
			document.querySelector(
				'input[aria-label="Folder with replacement files"]'
			)
		).toBeNull();
		await act(async () => {
			root.render(tree(true));
		});
		const folder = document.querySelector(
			'input[aria-label="Folder with replacement files"]'
		);
		expect(folder?.hasAttribute("webkitdirectory")).toBe(true);
	});
});
