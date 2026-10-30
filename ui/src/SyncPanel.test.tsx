import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type Asset, newProject, newSegment } from "../../shared/project.ts";
import * as bridge from "./bridge.ts";
import { createTestRuntime } from "./editor/test-runtime.ts";

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
const { SyncPanel, driftSummary } = await import("./SyncPanel.tsx");
const { EditorProvider } = await import("./editor/context.tsx");
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

function media(name: string): Asset {
	return {
		createdAt: new Date().toISOString(),
		duration: 120,
		hasAudio: true,
		height: 0,
		id: crypto.randomUUID(),
		kind: "audio",
		name,
		width: 0,
	};
}

function fixture() {
	const camera = media("Camera");
	const recorder = media("Recorder");
	const reference = newSegment(camera, 0, 0);
	const target = newSegment(recorder, 0, 1);
	const project = {
		...newProject("Drift panel"),
		segments: [reference, target],
	};
	return { assets: [camera, recorder], project, reference, target };
}

async function render(withRuntime: boolean) {
	const { assets, project, reference, target } = fixture();
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted.push({ container, root });
	const synced: unknown[] = [];
	const runtime = createTestRuntime(project, assets);
	const panel = (
		<SyncPanel
			assets={assets}
			busy={false}
			onSync={(input) => synced.push(input)}
			project={project}
		/>
	);
	await act(async () => {
		root.render(
			withRuntime ? (
				<EditorProvider value={runtime}>{panel}</EditorProvider>
			) : (
				panel
			)
		);
	});
	const button = (label: string) =>
		[...container.querySelectorAll("button")].find(
			(candidate) => candidate.textContent === label
		);
	const click = async (element: Element | undefined | null) => {
		await act(async () => {
			(element as HTMLElement | null | undefined)?.click();
			await Bun.sleep(10);
		});
	};
	await click(button("Recorder · Track 2 · 0.00s"));
	return { button, click, container, project, reference, synced, target };
}

test("drift summaries explain every measured outcome", () => {
	expect(
		driftSummary({
			driftPercent: 0.2,
			spanSeconds: 110,
			speed: 1.002,
			status: "corrected",
		})
	).toBe("+0.200% over 110 s · corrected with speed 1.0020");
	expect(
		driftSummary({
			driftPercent: -0.8,
			endErrorFrames: 28.8,
			spanSeconds: 110,
			status: "too-large",
		})
	).toContain("beyond ±0.5%, not corrected (28.8 frames apart");
	expect(
		driftSummary({ reason: "Drift needs at least 20 s", status: "too-short" })
	).toBe("Drift needs at least 20 s");
	expect(driftSummary(undefined)).toContain("audio correlation only");
});

test("the drift switch travels with the sync request", async () => {
	const { button, click, container, reference, synced, target } =
		await render(false);
	expect(button("Measure drift")).toBeUndefined();
	await click(container.querySelector('[aria-label="Correct clock drift"]'));
	await click(button("Align selected clips"));
	expect(synced).toEqual([
		{
			driftCorrection: false,
			mode: "auto",
			referenceClipId: reference.id,
			targetClipIds: [target.id],
		},
	]);
});

test("measure drift runs a dry-run sync and shows the readout", async () => {
	const requests = spyOn(bridge, "request");
	try {
		const { button, click, container, project, reference, target } =
			await render(true);
		requests.mockResolvedValue({
			matches: [
				{
					clipId: target.id,
					confidence: 0.9,
					drift: {
						driftPercent: 0.2,
						spanSeconds: 110,
						speed: 1.002,
						status: "corrected",
					},
				},
			],
			warnings: [],
		});
		await click(button("Measure drift"));
		expect(requests.mock.calls[0]?.[1]).toBe(`/projects/${project.id}/sync`);
		expect(requests.mock.calls[0]?.[3]).toEqual({
			driftCorrection: true,
			dryRun: true,
			mode: "auto",
			referenceClipId: reference.id,
			revision: project.revision,
			targetClipIds: [target.id],
		});
		expect(
			container.querySelector('[aria-label="Measured clock drift"]')
				?.textContent
		).toContain("+0.200% over 110 s · corrected with speed 1.0020");
	} finally {
		requests.mockRestore();
	}
});
