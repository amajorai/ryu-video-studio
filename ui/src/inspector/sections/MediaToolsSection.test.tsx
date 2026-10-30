import { afterAll, beforeEach, describe, expect, test } from "bun:test";
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
const { newProject, newSegment } = await import(
	"../../../../shared/project.ts"
);
const { EditorProvider } = await import("../../editor/context.tsx");
const { createTestRuntime, testVideo } = await import(
	"../../editor/test-runtime.ts"
);
const { MediaToolsSection } = await import("./MediaToolsSection.tsx");
const {
	applyMediaTool,
	derivativeSource,
	loadMediaToolSupport,
	mediaToolCall,
	renderSmoothSlowMotion,
	resetMediaToolSupport,
	smoothSlowMotionReady,
	withAsset,
} = await import("./media-tools.ts");

type Segment = ReturnType<typeof newSegment>;
type Asset = ReturnType<typeof testVideo>;

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

beforeEach(() => {
	resetMediaToolSupport();
});

describe("media tool helpers", () => {
	test("derivatives are made from the original media", () => {
		const original = testVideo("shot.mp4");
		const stabilized: Asset = {
			...testVideo("shot stabilized"),
			derivation: "stabilize",
			derivedFromAssetId: original.id,
		};
		const reversed: Asset = {
			...testVideo("shot reversed"),
			derivation: "reverse",
			derivedFromAssetId: original.id,
		};
		expect(derivativeSource(stabilized, [original, stabilized]).id).toBe(
			original.id
		);
		expect(derivativeSource(reversed, [original, reversed]).id).toBe(
			reversed.id
		);
		expect(derivativeSource(original, [original]).id).toBe(original.id);
	});

	test("request paths and bodies per tool", () => {
		const source = { id: "a1" };
		expect(mediaToolCall(source, { kind: "stabilize", level: "high" })).toEqual(
			{
				body: { level: "high" },
				path: "/assets/a1/stabilize",
			}
		);
		expect(
			mediaToolCall(source, { fps: 60, kind: "interpolate", mode: "blend" })
		).toEqual({
			body: { fps: 60, mode: "blend" },
			path: "/assets/a1/interpolate",
		});
		expect(mediaToolCall(source, { factor: 4, kind: "enhance" })).toEqual({
			body: { enhance: true, factor: 4 },
			path: "/assets/a1/upscale",
		});
	});

	test("smooth slow motion needs a slow clip and a mode", () => {
		expect(
			smoothSlowMotionReady({ frameInterpolation: "blend", speed: 0.5 })
		).toBe(true);
		expect(
			smoothSlowMotionReady({ frameInterpolation: "none", speed: 0.5 })
		).toBe(false);
		expect(smoothSlowMotionReady({ speed: 0.5 })).toBe(false);
		expect(
			smoothSlowMotionReady({ frameInterpolation: "blend", speed: 1 })
		).toBe(false);
	});

	test("library list adds a derivative once", () => {
		const one = testVideo();
		const two = testVideo();
		expect(withAsset([one], two).map((asset) => asset.id)).toEqual([
			two.id,
			one.id,
		]);
		expect(withAsset([one, two], two)).toHaveLength(2);
	});

	test("capability probe reads minterpolate and vidstab once", async () => {
		let calls = 0;
		const probe = () => {
			calls++;
			return Promise.resolve({
				filters: {
					minterpolate: false,
					vidstabdetect: true,
					vidstabtransform: true,
				},
			});
		};
		expect(await loadMediaToolSupport(probe)).toEqual({
			opticalFlow: false,
			vidstab: true,
		});
		await loadMediaToolSupport(probe);
		expect(calls).toBe(1);
		resetMediaToolSupport();
		expect(
			await loadMediaToolSupport(() => Promise.reject(new Error("offline")))
		).toEqual({ opticalFlow: undefined, vidstab: undefined });
	});
});

describe("media tool actions", () => {
	test("renders a derivative from the original and swaps the clip", async () => {
		const original = testVideo("shot.mp4");
		const segment = newSegment(original);
		const runtime = createTestRuntime(
			{ ...newProject("Tools"), segments: [segment] },
			[original]
		);
		const derivative: Asset = {
			...testVideo("shot.mp4 · stabilized (medium)"),
			derivation: "stabilize",
			derivedFromAssetId: original.id,
		};
		const requests: [string, unknown][] = [];
		runtime.api = (path, body) => {
			requests.push([path, body]);
			return Promise.resolve({
				asset: derivative,
				created: true,
				method: "translate",
			});
		};
		await applyMediaTool(runtime, segment, {
			kind: "stabilize",
			level: "medium",
		});
		expect(requests).toEqual([
			[`/assets/${original.id}/stabilize`, { level: "medium" }],
		]);
		expect(runtime.calls.map(([name]) => name)).toContain("setAssets");
		expect(runtime.calls).toContainEqual(["routeEdit", "swap-clip-media"]);
	});

	test("a failed render does not swap", async () => {
		const original = testVideo();
		const segment = newSegment(original);
		const runtime = createTestRuntime(
			{ ...newProject("Tools"), segments: [segment] },
			[original]
		);
		runtime.api = () =>
			Promise.reject(new Error("Two media operations are already running."));
		await applyMediaTool(runtime, segment, { factor: 2, kind: "enhance" });
		expect(runtime.calls.some(([name]) => name === "routeEdit")).toBe(false);
	});

	test("smooth slow motion is a route edit", async () => {
		const original = testVideo();
		const segment = { ...newSegment(original), speed: 0.5 };
		const runtime = createTestRuntime(
			{ ...newProject("Tools"), segments: [segment] },
			[original]
		);
		await renderSmoothSlowMotion(runtime, segment);
		expect(runtime.calls).toContainEqual(["routeEdit", "smooth-slow-motion"]);
	});
});

async function render(segment: Segment, asset: Asset) {
	const project = { ...newProject("Tools"), segments: [segment] };
	const runtime = createTestRuntime(project, [asset]);
	const patches: Partial<Segment>[] = [];
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<EditorProvider value={{ ...runtime }}>
				<MediaToolsSection
					isAudio={asset.kind === "audio"}
					onChange={(patch) => patches.push(patch)}
					segment={segment}
					visualControls={asset.kind !== "audio"}
				/>
			</EditorProvider>
		);
	});
	return {
		host,
		patches,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

function select(host: HTMLElement, label: string): HTMLSelectElement {
	const element = host.querySelector(`select[aria-label="${label}"]`);
	if (!(element instanceof HTMLSelectElement)) {
		throw new Error(`missing select ${label}`);
	}
	return element;
}

describe("MediaToolsSection", () => {
	test("video clips get every tool and optical flow is gated", async () => {
		await loadMediaToolSupport(() =>
			Promise.resolve({
				filters: {
					minterpolate: false,
					vidstabdetect: false,
					vidstabtransform: false,
				},
			})
		);
		const asset = testVideo();
		const segment = { ...newSegment(asset), speed: 0.5 };
		const view = await render(segment, asset);
		expect(view.host.textContent).toContain("Stabilize clip");
		expect(view.host.textContent).toContain("built-in two-pass tracker");
		expect(view.host.textContent).toContain("renders 60 fps media");
		expect(view.host.textContent).toContain("minterpolate");
		expect(select(view.host, "Interpolation method").value).toBe("blend");
		const opticalFlow = select(view.host, "Frame interpolation").querySelector(
			'option[value="optical-flow"]'
		);
		expect(opticalFlow?.hasAttribute("disabled")).toBe(true);
		const button = [...view.host.querySelectorAll("button")].find((element) =>
			element.textContent?.includes("Render smooth slow motion")
		);
		expect(button?.hasAttribute("disabled")).toBe(true);
		const interpolation = select(view.host, "Frame interpolation");
		await act(async () => {
			interpolation.value = "blend";
			interpolation.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(view.patches).toEqual([{ frameInterpolation: "blend" }]);
		await view.unmount();
	});

	test("stills only offer enhance and audio offers nothing", async () => {
		const still = { ...testVideo("still.png"), kind: "image" as const };
		const view = await render(newSegment(still), still);
		expect(view.host.textContent).toContain("Enhance 2×");
		expect(view.host.textContent).not.toContain("Stabilize");
		await view.unmount();
		const sound = { ...testVideo("voice.wav"), kind: "audio" as const };
		const audio = await render(newSegment(sound), sound);
		expect(audio.host.textContent).toBe("");
		await audio.unmount();
	});
});
