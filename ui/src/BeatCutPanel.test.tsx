import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AssetBeatsResponse } from "../../shared/analysis.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
} from "../../shared/project.ts";
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
const { BeatCutPanel } = await import("./BeatCutPanel.tsx");
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

const mounted: { container: HTMLElement; root: Root }[] = [];
afterEach(() => {
	for (const { container, root } of mounted.splice(0)) {
		act(() => root.unmount());
		container.remove();
	}
});

function media(kind: "audio" | "video", duration: number): Asset {
	return {
		createdAt: new Date().toISOString(),
		duration,
		hasAudio: true,
		height: kind === "audio" ? 0 : 360,
		id: crypto.randomUUID(),
		kind,
		name: kind === "audio" ? "Song" : "Shots",
		width: kind === "audio" ? 0 : 640,
	};
}

/** Three 3 s shots cut at 3 s and 6 s over a music clip on track 2. */
function fixture() {
	const music = media("audio", 20);
	const video = media("video", 20);
	const clips = [0, 3, 6].map((start) => ({
		...newSegment(video, start, 0),
		sourceIn: start + 1,
		sourceOut: start + 4,
	}));
	const project: Project = {
		...newProject("Beat cut"),
		segments: [...clips, newSegment(music, 0, 1)],
	};
	return { assets: [music, video], clips, music, project };
}

function detected(assetId: string): AssetBeatsResponse {
	const beats = Array.from({ length: 40 }, (_, index) => index * 0.5);
	return {
		analyzedDuration: 20,
		assetId,
		beats,
		bpm: 120,
		confidence: 0.9,
		// Off the beat grid so the test can tell bar snapping from beat snapping.
		downbeats: [0, 3.2, 5.9],
		method: "spectral-flux",
		times: beats,
	};
}

async function render(
	props: Omit<Parameters<typeof BeatCutPanel>[0], "onEdit" | "onError">
) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted.push({ container, root });
	const edits: {
		describe: () => string;
		update: (current: Project) => Project;
	}[] = [];
	const errors: string[] = [];
	await act(async () => {
		root.render(
			<BeatCutPanel
				{...props}
				onEdit={(update, describe) => edits.push({ describe, update })}
				onError={(text) => errors.push(text)}
			/>
		);
	});
	return { container, edits, errors };
}

async function choose(container: HTMLElement, label: string, value: string) {
	const select = container.querySelector<HTMLSelectElement>(
		`select[aria-label="${label}"]`
	);
	if (!select) {
		throw new Error(`Missing ${label} select.`);
	}
	await act(async () => {
		select.value = value;
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

async function clickCut(container: HTMLElement) {
	const button = [...container.querySelectorAll("button")].find(
		(candidate) => candidate.textContent === "Cut to beat"
	);
	await act(async () => {
		button?.click();
		await Bun.sleep(10);
	});
}

const startOf = (project: Project, clip: Segment) =>
	project.segments.find((segment) => segment.id === clip.id)?.start;

test("cuts edits to detected bar starts and reports the tempo", async () => {
	const { assets, clips, music, project } = fixture();
	const requests = spyOn(bridge, "request").mockResolvedValue(
		detected(music.id)
	);
	try {
		const { container, edits, errors } = await render({
			assets,
			busy: false,
			project,
			selectedIds: [],
		});
		await choose(container, "Cut on", "downbeat");
		await choose(container, "Beat cut mode", "snap-edits");
		await clickCut(container);
		expect(errors).toEqual([]);
		expect(requests).toHaveBeenCalledTimes(1);
		expect(requests.mock.calls[0]?.[1]).toBe(
			`/assets/${music.id}/beats?from=0&to=20`
		);
		expect(container.textContent).toContain("Detected 120 BPM");
		const edit = edits[0];
		expect(edit).toBeDefined();
		if (!edit) {
			return;
		}
		// The edits sit on beats already; only bar snapping moves them.
		const next = edit.update(project);
		expect(startOf(next, clips[1] as Segment)).toBeCloseTo(3.2, 6);
		expect(startOf(next, clips[2] as Segment)).toBeCloseTo(5.9, 6);
		expect(edit.describe()).toContain("120 BPM");
	} finally {
		requests.mockRestore();
	}
});

test("explains the loudness fallback and still cuts every beat", async () => {
	const { assets, clips, music, project } = fixture();
	const requests = spyOn(bridge, "request").mockResolvedValue({
		assetId: music.id,
		times: [0, 2.9, 6.1, 9],
	});
	try {
		const { container, edits } = await render({
			assets,
			busy: false,
			project,
			selectedIds: [],
		});
		await clickCut(container);
		expect(container.textContent).toContain("No steady tempo detected");
		const next = edits[0]?.update(project);
		expect(next && startOf(next, clips[1] as Segment)).toBeCloseTo(2.9, 1);
		expect(edits[0]?.describe()).toContain("estimated from loudness");
	} finally {
		requests.mockRestore();
	}
});

test("surfaces a beats request failure", async () => {
	const { assets, project } = fixture();
	const requests = spyOn(bridge, "request").mockRejectedValue(
		new Error("Complete source analysis before estimating beat markers.")
	);
	try {
		const { container, edits, errors } = await render({
			assets,
			busy: false,
			project,
			selectedIds: [],
		});
		await clickCut(container);
		expect(edits).toEqual([]);
		expect(errors[0]).toContain("Analyze the music");
	} finally {
		requests.mockRestore();
	}
});

test("detects beats over the span a late music clip plays", async () => {
	const { assets, clips, music, project } = fixture();
	const long = { ...music, duration: 900 };
	const musicClip = {
		...newSegment(long, 0, 1),
		sourceIn: 700,
		sourceOut: 760,
	};
	const late = {
		...project,
		segments: [...clips, musicClip],
	};
	const beats = Array.from({ length: 120 }, (_, index) => 700 + index * 0.5);
	const requests = spyOn(bridge, "request").mockResolvedValue({
		analyzedDuration: 600,
		analyzedFrom: 300,
		assetId: music.id,
		beats,
		bpm: 120,
		confidence: 0.9,
		downbeats: beats.filter((_, index) => index % 4 === 0),
		method: "spectral-flux",
		times: beats,
	} satisfies AssetBeatsResponse);
	try {
		const { container, edits, errors } = await render({
			assets: [long, assets[1] as Asset],
			busy: false,
			project: late,
			selectedIds: [],
		});
		await clickCut(container);
		expect(errors).toEqual([]);
		expect(requests.mock.calls[0]?.[1]).toBe(
			`/assets/${music.id}/beats?from=700&to=760`
		);
		const next = edits[0]?.update(late);
		expect(next && startOf(next, clips[1] as Segment)).toBeCloseTo(3, 6);
	} finally {
		requests.mockRestore();
	}
});

test("refuses detected beats that no longer cover a re-trimmed clip", async () => {
	const { assets, music, project } = fixture();
	const requests = spyOn(bridge, "request").mockResolvedValue({
		...detected(music.id),
		analyzedDuration: 15,
		analyzedFrom: 5,
	});
	try {
		const { container, edits } = await render({
			assets,
			busy: false,
			project,
			selectedIds: [],
		});
		await clickCut(container);
		const edit = edits[0];
		expect(edit).toBeDefined();
		expect(() => edit?.update(project)).toThrow("trimmed");
	} finally {
		requests.mockRestore();
	}
});
