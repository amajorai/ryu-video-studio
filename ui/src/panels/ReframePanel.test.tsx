import { afterAll, describe, expect, test } from "bun:test";
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
const { newProject, newSegment } = await import("../../../shared/project.ts");
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, testVideo } = await import(
	"../editor/test-runtime.ts"
);
const { ReframePanel, reframePanelTab, reframeScope, reframeSummary } =
	await import("./ReframePanel.tsx");

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

function fixture() {
	const video = testVideo();
	const audio = {
		...testVideo("music.mp3"),
		height: 0,
		kind: "audio" as const,
		width: 0,
	};
	const full = newSegment(video);
	const inset = { ...newSegment(video, 0, 1), scale: 0.3 };
	const music = newSegment(audio, 0, 2);
	const project = {
		...newProject("Reframe UI"),
		segments: [full, inset, music],
	};
	return { assets: [video, audio], full, inset, music, project };
}

describe("reframe panel helpers", () => {
	test("summary counts tracked clips and fallbacks", () => {
		expect(
			reframeSummary({
				clips: [
					{ clipId: "a", mode: "track" },
					{
						clipId: "b",
						mode: "center",
						note: "No subject track was measured.",
					},
				],
				height: 1920,
				width: 1080,
			})
		).toBe(
			"Reframed 2 clips at 1080×1920; 1 tracked; 1 centred (not tracked)."
		);
		expect(reframeSummary({})).toBe("Reframed 0 clips.");
		expect(
			reframeSummary({
				clips: [{ clipId: "a", mode: "track" }],
				stabilized: [
					{ assetId: "s", clipId: "a" },
					{ clipId: "b", skipped: "Only video is stabilized." },
				],
			})
		).toBe("Reframed 1 clip; 1 stabilized first; 1 tracked.");
	});

	test("scope uses full-frame clips or the visual selection", () => {
		const { assets, full, inset, music, project } = fixture();
		expect(reframeScope(project, assets, [], false)).toEqual({ count: 1 });
		expect(reframeScope(project, assets, [inset.id, music.id], true)).toEqual({
			clipIds: [inset.id],
			count: 1,
		});
		expect(reframeScope(project, assets, [full.id], true).count).toBe(1);
		const locked = {
			...project,
			trackSettings: [
				{
					locked: true,
					muted: false,
					name: "Track 1",
					solo: false,
					track: full.track,
				},
			],
		};
		expect(reframeScope(locked, assets, [full.id], true).count).toBe(0);
		expect(reframeScope(locked, assets, [], false).count).toBe(0);
	});

	test("mounts inside Layouts", () => {
		expect(reframePanelTab).toBeNull();
	});
});

describe("reframe panel", () => {
	test("sends the chosen aspect, mode and smoothing", async () => {
		const { assets, project } = fixture();
		const runtime = createTestRuntime(project, assets);
		const sent: [string, Record<string, unknown>][] = [];
		runtime.routeEdit = (action, body) => {
			sent.push([action, body]);
			return Promise.resolve({ extras: {}, status: "ok" });
		};
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		await act(async () => {
			root.render(
				<EditorProvider value={{ ...runtime }}>
					<ReframePanel />
				</EditorProvider>
			);
		});
		expect(host.textContent).toContain("The canvas becomes 1080×1920.");
		const aspect = host.querySelector(
			'select[aria-label="Reframe aspect ratio"]'
		);
		if (!(aspect instanceof HTMLSelectElement)) {
			throw new Error("missing aspect select");
		}
		await act(async () => {
			aspect.value = "1:1";
			aspect.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(host.textContent).toContain("The canvas becomes 1080×1080.");
		const button = [...host.querySelectorAll("button")].find((element) =>
			element.textContent?.includes("Reframe to 1:1")
		);
		if (!button) {
			throw new Error("missing reframe button");
		}
		await act(async () => {
			button.click();
		});
		expect(sent).toEqual([
			["reframe", { aspect: "1:1", mode: "track", smoothing: 0.5 }],
		]);
		const stabilize = host.querySelector(
			'select[aria-label="Reframe image stabilization"]'
		);
		if (!(stabilize instanceof HTMLSelectElement)) {
			throw new Error("missing stabilize select");
		}
		expect([...stabilize.options].map((option) => option.value)).toEqual([
			"off",
			"low",
			"medium",
			"high",
		]);
		await act(async () => {
			stabilize.value = "medium";
			stabilize.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await act(async () => {
			button.click();
		});
		expect(sent.at(-1)).toEqual([
			"reframe",
			{ aspect: "1:1", mode: "track", smoothing: 0.5, stabilize: "medium" },
		]);
		await act(async () => root.unmount());
		host.remove();
	});
});
