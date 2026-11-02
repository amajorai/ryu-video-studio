import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Asset } from "../../shared/project.ts";

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
	value: true,
	configurable: true,
	writable: true,
});
// React DOM detects the DOM when it loads, so it is imported after happy-dom.
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const bridge = await import("./bridge.ts");
const { ASSET_DRAG_MIME } = await import("./search-bridge.ts");
const { activeAssetDrag } = await import("./library/drag-source.ts");
const { VisualShotSearch } = await import("./SearchPanel.tsx");
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

function setValue(
	element: HTMLInputElement | HTMLSelectElement,
	value: string
) {
	const prototype =
		element instanceof HTMLSelectElement
			? HTMLSelectElement.prototype
			: HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
		element,
		value
	);
	element.dispatchEvent(
		new Event(element instanceof HTMLSelectElement ? "change" : "input", {
			bubbles: true,
		})
	);
}

function button(container: HTMLElement, label: string) {
	const found = [...container.querySelectorAll("button")].find(
		(item) => item.textContent === label
	);
	if (!found) {
		throw new Error(`Missing button ${label}`);
	}
	return found;
}

test("visual search analyzes a video, finds shots by look and drags source ranges", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const video: Asset = {
		id: crypto.randomUUID(),
		name: "Harbor at night",
		kind: "video",
		width: 640,
		height: 360,
		duration: 12,
		hasAudio: false,
		createdAt: new Date().toISOString(),
	};
	const audio: Asset = {
		...video,
		id: crypto.randomUUID(),
		kind: "audio",
		name: "Voice",
	};
	const calls: string[] = [];
	spyOn(bridge, "request").mockImplementation(async (schema, path, method) => {
		calls.push(`${method ?? "GET"} ${path}`);
		if (path.endsWith("/shots")) {
			return schema.parse({
				format: "ryu.video-studio.shots.v1",
				assetId: video.id,
				analysisCreatedAt: new Date().toISOString(),
				revision: 0,
				sampleRate: 4,
				shots: [],
				updatedAt: new Date().toISOString(),
			});
		}
		return schema.parse({
			query: "dark blue motion",
			labels: ["dark", "blue", "motion"],
			excluded: ["muted"],
			ignored: ["boats"],
			results: [
				{
					assetId: video.id,
					assetName: video.name,
					colors: [{ hex: "#1020c0", name: "blue", weight: 0.8 }],
					end: 6,
					labels: ["dark", "motion", "blue"],
					score: 4.2,
					start: 2,
				},
			],
		});
	});
	const statuses: string[] = [];
	const ranges: [string, number, number][] = [];
	try {
		await act(async () => {
			root.render(
				<VisualShotSearch
					assets={[video, audio]}
					onIndexed={async () => undefined}
					onRange={(assetId, start, end) => ranges.push([assetId, start, end])}
					onStatus={(text) => statuses.push(text)}
					spaceName="Footage"
					spaces={undefined}
				/>
			);
		});
		const select = container.querySelector<HTMLSelectElement>(
			'select[aria-label="Video to analyze for shots"]'
		);
		expect(
			[...(select?.options ?? [])].map((option) => option.textContent)
		).toEqual(["Choose a video", "Harbor at night"]);
		expect(button(container, "Index shots in Space").disabled).toBe(true);
		await act(async () => {
			if (select) {
				setValue(select, video.id);
			}
		});
		await act(async () => {
			button(container, "Analyze shots").click();
			await Bun.sleep(10);
		});
		expect(calls).toEqual([`POST /assets/${video.id}/shots`]);
		expect(statuses.at(-1)).toContain("0 shots measured");
		const input = container.querySelector<HTMLInputElement>(
			'input[aria-label="Footage look query"]'
		);
		await act(async () => {
			if (input) {
				setValue(input, "dark blue motion boats");
			}
		});
		await act(async () => {
			button(container, "Search by look").click();
			await Bun.sleep(10);
		});
		expect(calls.at(-1)).toBe("GET /shot-search?q=dark+blue+motion+boats");
		expect(container.textContent).toContain("Not a visual term: boats");
		expect(container.textContent).toContain("Excluding: muted");
		expect(statuses.at(-1)).toContain("“dark blue motion, not muted”");
		expect(container.textContent).toContain("2.0–6.0s");
		expect(container.textContent).toContain("dark · motion · blue");
		const result = container.querySelector<HTMLElement>('[draggable="true"]');
		const data = new Map<string, string>();
		const dragStart = new Event("dragstart", { bubbles: true });
		Object.defineProperty(dragStart, "dataTransfer", {
			value: {
				effectAllowed: "none",
				setData: (type: string, value: string) => data.set(type, value),
			},
		});
		await act(async () => {
			result?.dispatchEvent(dragStart);
		});
		expect(JSON.parse(data.get(ASSET_DRAG_MIME) ?? "{}")).toEqual({
			assetId: video.id,
			sourceIn: 2,
			sourceOut: 6,
		});
		// The timeline drop target (W1-T6) previews the in-flight range.
		expect(activeAssetDrag()).toEqual({
			asset: video,
			payload: { assetId: video.id, sourceIn: 2, sourceOut: 6 },
		});
		await act(async () => {
			result?.dispatchEvent(new Event("dragend", { bubbles: true }));
		});
		expect(activeAssetDrag()).toBeNull();
		await act(async () => {
			button(container, "Add source range").click();
		});
		expect(ranges).toEqual([[video.id, 2, 6]]);
	} finally {
		await act(async () => root.unmount());
		container.remove();
		mock.restore();
	}
});
