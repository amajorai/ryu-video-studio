import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { HostServices } from "@ryu/app-host/rpc";
import {
	type Asset,
	newSegment,
	type Segment,
} from "../../../shared/project.ts";
import { testVideo } from "../editor/test-runtime.ts";

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
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ClipFilmstrip } = await import("./ClipFilmstrip.tsx");
const { ClipLabel } = await import("./ClipLabel.tsx");
const { ClipWaveform } = await import("./ClipWaveform.tsx");
const { ClipMetaSection } = await import(
	"../inspector/sections/ClipMetaSection.tsx"
);
const { filmstripCache, peaksCache, waveformRetryPolicy } = await import(
	"./clip-visual-cache.ts"
);

type HostRequest = Parameters<NonNullable<HostServices["appRequest"]>>[0];
const requests: HostRequest[] = [];
let analysisStatus = "completed";

const appRequest: NonNullable<HostServices["appRequest"]> = (input) => {
	requests.push(input);
	const url = new URL(input.path, "http://studio.test");
	if (url.pathname.endsWith("/filmstrip")) {
		const count = Number(url.searchParams.get("count"));
		return Promise.resolve({
			count,
			data: "AA==",
			frameHeight: 48,
			frameWidth: 85,
			times: [],
			width: 85 * count,
		});
	}
	if (url.pathname.endsWith("/analysis")) {
		return Promise.resolve({
			analysis: {
				assetId: url.pathname.split("/")[2] ?? "",
				createdAt: new Date(0).toISOString(),
				duration: 10,
				sceneCuts: [],
				status: analysisStatus,
				waveform: Array.from({ length: 100 }, (_, index) => index / 100),
			},
		});
	}
	return Promise.reject(new Error(`Unexpected request ${input.path}`));
};
const previousRyu = Object.getOwnPropertyDescriptor(window, "ryu");
Object.defineProperty(window, "ryu", {
	configurable: true,
	value: { app: { request: appRequest } },
});

afterAll(() => {
	if (previousRyu) {
		Object.defineProperty(window, "ryu", previousRyu);
	} else {
		Reflect.deleteProperty(window, "ryu");
	}
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
	requests.length = 0;
	analysisStatus = "completed";
	filmstripCache.clear();
	peaksCache.clear();
});

async function mount(node: React.ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(node);
		await Promise.resolve();
	});
	// Let serialized cache loads settle and their state updates commit.
	for (let round = 0; round < 5; round++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
	return {
		container,
		rerender: async (next: React.ReactNode) => {
			await act(async () => {
				root.render(next);
				await Promise.resolve();
			});
		},
		unmount: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

const slot = (asset: Asset, segment: Segment, zoom = 50) => ({
	asset,
	fps: 30,
	locked: false,
	segment,
	selected: false,
	zoom,
});

const filmstripRequests = () =>
	requests.filter((request) => request.path.includes("/filmstrip"));

describe("filmstrips", () => {
	test("ten clips render filmstrips without duplicate requests", async () => {
		const asset = testVideo("camera.mp4", 30);
		const segments = Array.from({ length: 10 }, (_, index) => ({
			...newSegment(asset, index * 4),
			// Two distinct source ranges shared by five clips each.
			sourceIn: index % 2 === 0 ? 0 : 4,
			sourceOut: index % 2 === 0 ? 4 : 8,
		}));
		const row = (zoom: number) =>
			segments.map((segment) => (
				<ClipFilmstrip key={segment.id} {...slot(asset, segment, zoom)} />
			));
		const view = await mount(<div>{row(50)}</div>);
		expect(filmstripRequests()).toHaveLength(2);
		const strips = view.container.querySelectorAll("[data-filmstrip]");
		expect(strips).toHaveLength(10);
		// 4 s at 50 px/s is 200 px: four 57 px thumbnails, one per frame.
		const tiles = strips[0]?.querySelectorAll("[data-frame]") ?? [];
		expect([...tiles].map((tile) => tile.getAttribute("data-frame"))).toEqual([
			"0",
			"1",
			"2",
			"3",
		]);
		// Zooming within the same frame bucket reuses the cached sprites.
		await view.rerender(<div>{row(55)}</div>);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(filmstripRequests()).toHaveLength(2);
		view.unmount();
	});

	test("the sprite URL is set once per strip, not per tile", async () => {
		const asset = testVideo("long.mp4", 60);
		const view = await mount(
			<ClipFilmstrip {...slot(asset, newSegment(asset, 0), 600)} />
		);
		const strip = view.container.querySelector<HTMLElement>("[data-filmstrip]");
		expect(strip?.style.getPropertyValue("--studio-filmstrip-image")).toContain(
			"data:image/png;base64,"
		);
		const tiles = view.container.querySelectorAll("[data-frame]");
		expect(tiles).toHaveLength(240);
		expect(view.container.innerHTML.split("data:image/png").length - 1).toBe(1);
		expect(tiles[239]?.getAttribute("data-frame")).toBe("59");
		view.unmount();
	});

	test("audio clips have no filmstrip", async () => {
		const asset: Asset = { ...testVideo("voice.wav"), kind: "audio" };
		const view = await mount(
			<ClipFilmstrip {...slot(asset, newSegment(asset, 0))} />
		);
		expect(filmstripRequests()).toHaveLength(0);
		expect(view.container.innerHTML).toBe("");
		view.unmount();
	});
});

describe("waveforms", () => {
	test("audio clips draw a full-height waveform from one analysis read", async () => {
		const asset: Asset = { ...testVideo("voice.wav", 10), kind: "audio" };
		const segments = [0, 1, 2].map((index) => ({
			...newSegment(asset, index * 5),
			sourceOut: 2,
			speed: 2,
		}));
		const view = await mount(
			<div>
				{segments.map((segment) => (
					<ClipWaveform key={segment.id} {...slot(asset, segment, 100)} />
				))}
			</div>
		);
		expect(
			requests.filter((request) => request.path.includes("/analysis"))
		).toHaveLength(1);
		const canvases = view.container.querySelectorAll("canvas");
		expect(canvases).toHaveLength(3);
		// 2 source seconds at 2x last 1 s: 100 px in 2 px columns.
		expect(canvases[0]?.getAttribute("data-waveform-columns")).toBe("50");
		expect(canvases[0]?.getAttribute("width")).toBe("100");
		expect(canvases[0]?.getAttribute("height")).toBe("32");
		view.unmount();
	});

	test("nothing is drawn until the analysis completes", async () => {
		analysisStatus = "running";
		const asset = testVideo("camera.mp4", 10);
		const view = await mount(
			<ClipWaveform {...slot(asset, newSegment(asset, 0))} />
		);
		expect(view.container.querySelector("canvas")).toBe(null);
		expect(peaksCache.size).toBe(0);
		view.unmount();
	});

	test("a mounted clip draws once its analysis completes", async () => {
		const policy = { ...waveformRetryPolicy };
		waveformRetryPolicy.baseMs = 5;
		waveformRetryPolicy.maxMs = 5;
		analysisStatus = "running";
		const asset = testVideo("camera.mp4", 10);
		const segment = newSegment(asset, 0);
		const view = await mount(<ClipWaveform {...slot(asset, segment)} />);
		expect(view.container.querySelector("canvas")).toBe(null);
		analysisStatus = "completed";
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 40));
		});
		expect(view.container.querySelector("canvas")).not.toBe(null);
		const reads = requests.filter((request) =>
			request.path.includes("/analysis")
		).length;
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
		});
		// Polling stops once the peaks have loaded.
		expect(
			requests.filter((request) => request.path.includes("/analysis"))
		).toHaveLength(reads);
		Object.assign(waveformRetryPolicy, policy);
		view.unmount();
	});

	test("silent video draws nothing and reads no analysis", async () => {
		const asset = { ...testVideo("silent.mp4"), hasAudio: false };
		const view = await mount(
			<ClipWaveform {...slot(asset, newSegment(asset, 0))} />
		);
		expect(requests).toHaveLength(0);
		view.unmount();
	});
});

describe("wide clips", () => {
	test("a long clip at high zoom draws only near the draw window", async () => {
		const asset = testVideo("long.mp4", 600);
		const segment = { ...newSegment(asset, 0), sourceOut: 600 };
		// 600 s at 100 px/s is a 60 000 px clip; the window covers 30 s.
		const props = {
			...slot(asset, segment, 100),
			drawWindow: { end: 130, start: 100 },
		};
		const view = await mount(
			<div>
				<ClipFilmstrip {...props} />
				<ClipWaveform {...props} />
			</div>
		);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		const tiles = [
			...view.container.querySelectorAll<HTMLElement>("[data-frame]"),
		];
		expect(tiles.length).toBeGreaterThan(0);
		const lefts = tiles.map((tile) => Number.parseFloat(tile.style.left));
		expect(Math.min(...lefts)).toBeGreaterThanOrEqual(10_000 - 100);
		expect(Math.max(...lefts)).toBeLessThan(13_000);
		const canvas = view.container.querySelector("canvas");
		// 30 s at 100 px/s in 2 px columns: 1 500 columns from column 5 000.
		expect(canvas?.getAttribute("data-waveform-columns")).toBe("1500");
		expect(canvas?.getAttribute("width")).toBe("3000");
		const band = canvas?.parentElement;
		expect(band?.getAttribute("data-waveform-first")).toBe("5000");
		expect(band?.style.left).toBe(`${(5000 / 30_000) * 100}%`);
		expect(band?.style.width).toBe("5%");
		view.unmount();
	});
});

describe("labels and colors", () => {
	test("the clip shows its color tag and label chip", async () => {
		const asset = testVideo();
		const segment: Segment = {
			...newSegment(asset, 0),
			color: "teal",
			label: "Interview A",
		};
		const view = await mount(<ClipLabel {...slot(asset, segment)} />);
		const tag = view.container.querySelector("[data-clip-color]");
		expect(tag?.getAttribute("data-clip-color")).toBe("teal");
		expect(view.container.querySelector("[data-clip-label]")?.textContent).toBe(
			"Interview A"
		);
		view.unmount();
		const plain = await mount(
			<ClipLabel {...slot(asset, newSegment(asset, 0))} />
		);
		expect(plain.container.innerHTML).toBe("");
		plain.unmount();
	});

	test("the inspector renames and recolors through onChange", async () => {
		const asset = testVideo();
		const segment: Segment = { ...newSegment(asset, 0), label: "Old" };
		const patches: Partial<Segment>[] = [];
		const view = await mount(
			<ClipMetaSection
				isAudio={false}
				onChange={(patch) => patches.push(patch)}
				segment={segment}
				visualControls
			/>
		);
		const input = view.container.querySelector<HTMLInputElement>(
			"input[aria-label='Clip label']"
		);
		expect(input?.value).toBe("Old");
		await act(async () => {
			if (input) {
				input.focus();
				input.value = "  New   name ";
				input.blur();
			}
			await Promise.resolve();
		});
		expect(patches).toEqual([{ label: "New name" }]);

		const teal = view.container.querySelector<HTMLButtonElement>(
			"[role='radio'][aria-label='Teal']"
		);
		await act(async () => {
			teal?.click();
			await Promise.resolve();
		});
		expect(patches.at(-1)).toEqual({ color: "teal" });
		const none = [
			...view.container.querySelectorAll<HTMLButtonElement>("[role='radio']"),
		].find((button) => button.textContent === "None");
		expect(none?.getAttribute("aria-checked")).toBe("true");
		await act(async () => {
			none?.click();
			await Promise.resolve();
		});
		// Already untagged: clearing again records nothing.
		expect(patches).toHaveLength(2);
		view.unmount();
	});
});
