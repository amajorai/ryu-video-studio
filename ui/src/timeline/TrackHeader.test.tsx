import { afterAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	newSegment,
	type Project,
	trackSettingFor,
} from "../../../shared/project.ts";

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
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, testProject, testVideo } = await import(
	"../editor/test-runtime.ts"
);
const { TRACK_HEIGHT_PX, TrackHeader, trackHeightPx } = await import(
	"./TrackHeader.tsx"
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

type Runtime = ReturnType<typeof createTestRuntime>;

async function render(runtime: Runtime, track: number) {
	const host = document.createElement("div");
	host.className = "studio-track";
	document.body.append(host);
	const root = createRoot(host);
	const draw = async () => {
		const project = runtime.project as Project;
		await act(async () => {
			root.render(
				<EditorProvider value={{ ...runtime }}>
					<TrackHeader
						isBottom={track === 0}
						isTop={false}
						setting={trackSettingFor(project, track)}
						track={track}
					/>
				</EditorProvider>
			);
		});
	};
	await draw();
	return {
		draw,
		host,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
	const found = [...host.querySelectorAll("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === label
	);
	if (!found) {
		throw new Error(`No button labelled ${label}`);
	}
	return found;
}

describe("TrackHeader", () => {
	test("hides the track picture and reflects it after a redraw", async () => {
		const video = testVideo();
		const project: Project = {
			...testProject().project,
			segments: [newSegment(video, 0, 1)],
		};
		const runtime = createTestRuntime(project, [video]);
		const view = await render(runtime, 1);
		const eye = button(view.host, "Hide Track 2");
		expect(eye.getAttribute("aria-pressed")).toBe("false");
		await act(async () => eye.click());
		expect(trackSettingFor(runtime.project as Project, 1).hidden).toBe(true);
		await view.draw();
		expect(button(view.host, "Show Track 2").getAttribute("aria-pressed")).toBe(
			"true"
		);
		expect(
			view.host
				.querySelector(".studio-track-label")
				?.getAttribute("data-track-hidden")
		).toBe("true");
		await view.unmount();
	});

	test("toggles sync lock off and back on", async () => {
		const { asset, project } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		const view = await render(runtime, 0);
		const chain = button(view.host, "Turn off sync lock for Track 1");
		expect(chain.getAttribute("aria-pressed")).toBe("true");
		await act(async () => chain.click());
		expect(trackSettingFor(runtime.project as Project, 0).syncLocked).toBe(
			false
		);
		await view.draw();
		await act(async () =>
			button(view.host, "Turn on sync lock for Track 1").click()
		);
		expect(trackSettingFor(runtime.project as Project, 0).syncLocked).toBe(
			true
		);
		await view.unmount();
	});

	test("keeps mute, solo, lock, rename, and the options menu", async () => {
		const { asset, project } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		const view = await render(runtime, 0);
		await act(async () => button(view.host, "Mute Track 1").click());
		expect(trackSettingFor(runtime.project as Project, 0).muted).toBe(true);
		expect(button(view.host, "Solo Track 1")).toBeDefined();
		expect(button(view.host, "Lock Track 1")).toBeDefined();
		expect(button(view.host, "More actions for Track 1")).toBeDefined();
		const name = view.host.querySelector("input");
		expect(name?.getAttribute("aria-label")).toBe("Track 1 name");
		await view.unmount();
	});
});

test("trackHeightPx maps the stored height, defaulting to medium", () => {
	expect(trackHeightPx({})).toBe(54);
	expect(trackHeightPx({ height: "small" })).toBeLessThan(54);
	expect(trackHeightPx({ height: "large" })).toBeGreaterThan(54);
});

describe("lane height", () => {
	const laneCss = async () => {
		const css = await readFile(new URL("./TrackHeader.css", import.meta.url), {
			encoding: "utf8",
		});
		const style = document.createElement("style");
		style.textContent = `.studio-track { height: ${TRACK_HEIGHT_PX.medium}px; }\n${css}`;
		document.head.append(style);
		return style;
	};

	test("the height menu setting resizes the lane row", async () => {
		const style = await laneCss();
		const { asset, project } = testProject();
		for (const height of ["small", "medium", "large"] as const) {
			const sized: Project = {
				...project,
				trackSettings: [{ ...trackSettingFor(project, 0), height }],
			};
			const runtime = createTestRuntime(sized, [asset]);
			const view = await render(runtime, 0);
			expect(
				view.host
					.querySelector(".studio-track-label")
					?.getAttribute("data-track-height")
			).toBe(height);
			expect(getComputedStyle(view.host).height).toBe(
				`${trackHeightPx({ height })}px`
			);
			await view.unmount();
		}
		style.remove();
	});

	test("TrackHeader.css matches TRACK_HEIGHT_PX", async () => {
		const css = await readFile(new URL("./TrackHeader.css", import.meta.url), {
			encoding: "utf8",
		});
		for (const height of ["small", "large"] as const) {
			const rule = new RegExp(
				`data-track-height="${height}"\\]\\)\\s*\\{\\s*height:\\s*(\\d+)px`
			).exec(css);
			expect(Number(rule?.[1])).toBe(TRACK_HEIGHT_PX[height]);
		}
	});
});
