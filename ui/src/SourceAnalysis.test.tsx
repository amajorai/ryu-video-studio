import { afterAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AssetBeatsResponse } from "../../shared/analysis.ts";
import type { Asset } from "../../shared/project.ts";
import * as bridge from "./bridge.ts";

GlobalRegistrator.register();
const previousActEnvironment = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	value: true,
	configurable: true,
	writable: true,
});
const { SourceAnalysis, beatMarkerNotes, beatSummary } = await import(
	"./SourceAnalysis.tsx"
);
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

const asset: Asset = {
	createdAt: new Date().toISOString(),
	duration: 10,
	hasAudio: true,
	height: 0,
	id: crypto.randomUUID(),
	kind: "audio",
	name: "Song",
	width: 0,
};

const analysis = {
	assetId: asset.id,
	createdAt: new Date().toISOString(),
	duration: 10,
	sceneCuts: [],
	status: "completed" as const,
	waveform: Array.from({ length: 20 }, (_, index) =>
		[1, 5, 9, 13, 17].includes(index) ? 0.9 : 0.08
	),
};

const detection: AssetBeatsResponse = {
	analyzedDuration: 10,
	assetId: asset.id,
	beats: [0.5, 1, 1.5, 2, 2.5],
	bpm: 120,
	confidence: 0.87,
	downbeats: [0.5, 2.5],
	method: "spectral-flux",
	times: [0.5, 1, 1.5, 2, 2.5],
};

const buttonNamed = (container: HTMLElement, name: string) =>
	[...container.querySelectorAll("button")].find(
		(button) => button.textContent === name
	);

test("beat summary prefers a requested detection, then the cache, then the estimate", () => {
	expect(beatSummary(analysis, null)).toEqual({
		bpm: undefined,
		confidence: undefined,
		detected: false,
		downbeats: [],
		times: [0.75, 2.75, 4.75, 6.75, 8.75],
	});
	expect(
		beatSummary({ ...analysis, beats: { ...detection, bpm: 100 } }, null).bpm
	).toBe(100);
	expect(beatSummary(analysis, detection)).toMatchObject({
		bpm: 120,
		detected: true,
		downbeats: [0.5, 2.5],
	});
	expect(beatSummary(analysis, { assetId: asset.id, times: [1, 2] })).toEqual({
		detected: false,
		downbeats: [],
		times: [1, 2],
	});
});

test("detects beats on request and adds beat and bar markers", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const requests = spyOn(bridge, "request").mockImplementation(
		async (schema, path) =>
			await Promise.resolve(
				schema.parse(path.endsWith("/beats") ? detection : { analysis })
			)
	);
	const markers: number[][] = [];
	const bars: number[][] = [];
	try {
		await act(async () => {
			root.render(
				<SourceAnalysis
					asset={asset}
					onBarMarkers={(times) => bars.push(times)}
					onBeatMarkers={(times) => markers.push(times)}
					onError={() => undefined}
					onMarkers={() => undefined}
					onRange={() => undefined}
					onRemoveSilence={() => undefined}
				/>
			);
		});
		await act(async () => {
			buttonNamed(container, "View analysis")?.click();
			await Bun.sleep(20);
		});
		expect(container.textContent).toContain("5 estimated beat onsets");
		await act(async () => {
			buttonNamed(container, "Detect beats")?.click();
			await Bun.sleep(20);
		});
		expect(
			requests.mock.calls.some(
				([, path]) => path === `/assets/${asset.id}/beats`
			)
		).toBe(true);
		expect(container.textContent).toContain("Detected 120 BPM");
		expect(container.textContent).toContain("87% pulse confidence");
		expect(buttonNamed(container, "Detect beats")).toBeUndefined();
		await act(async () => {
			buttonNamed(container, "Add 5 beat markers")?.click();
			buttonNamed(container, "Add 2 bar markers")?.click();
		});
		expect(markers).toEqual([detection.beats]);
		expect(bars).toEqual([detection.downbeats]);
	} finally {
		requests.mockRestore();
		act(() => root.unmount());
		container.remove();
	}
});

test("beat marker notes report partial coverage and the marker limit", () => {
	const times = Array.from({ length: 600 }, (_, index) => index * 0.5);
	const downbeats = times.filter((_, index) => index % 4 === 0);
	expect(
		beatMarkerNotes(
			{ analyzed: { from: 0, to: 300 }, detected: true, downbeats, times },
			300
		)
	).toEqual([
		"A project holds at most 500 markers, so beat markers would stop near 4:10; bar markers (150) cover more of the track.",
	]);
	expect(
		beatMarkerNotes(
			{
				analyzed: { from: 300, to: 900 },
				detected: true,
				downbeats: [301],
				times: [301, 302],
			},
			1200
		)
	).toEqual(["Detection covers 5:00–15:00 of this source."]);
	expect(
		beatMarkerNotes({ detected: false, downbeats: [], times: [1, 2] }, 1200)
	).toEqual([]);
});
