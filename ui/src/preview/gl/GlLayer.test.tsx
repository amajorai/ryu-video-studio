import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { segmentSchema } from "../../../../shared/project.ts";
import { mediaLayerFixtures } from "../__fixtures__/media-layer-segments.ts";
import {
	type GlPass,
	glPassesKey,
	glPassOrder,
	orderedGlPasses,
} from "./pass.ts";
import * as realPipeline from "./pipeline.ts";
import { type GlPipeline, glFragmentSource, glSourceSize } from "./pipeline.ts";
import { segmentGlPasses } from "./segment-passes.ts";

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
const { act, createRef } = await import("react");
const { createRoot } = await import("react-dom/client");
// Real pipeline unless a test installs a fake (happy-dom has no WebGL2).
// Capture the real factory first: mock.module rebinds the namespace.
const { createGlPipeline } = realPipeline;
let fakePipeline: (() => GlPipeline) | null = null;
mock.module("./pipeline.ts", () => ({
	...realPipeline,
	createGlPipeline: (canvas: HTMLCanvasElement) =>
		fakePipeline ? fakePipeline() : createGlPipeline(canvas),
}));
const { GlLayer } = await import("./GlLayer.tsx");
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

const pass = (id: string): GlPass => ({
	fragment: "void main() { outColor = texture(u_source, v_uv); }",
	id,
	uniforms: {},
});

async function mount(element: React.ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(element);
	});
	return {
		container,
		async rerender(next: React.ReactNode) {
			await act(async () => {
				root.render(next);
			});
		},
		async unmount() {
			await act(async () => {
				root.unmount();
			});
			container.remove();
		},
	};
}

describe("GlLayer", () => {
	test("renders nothing when no pass is active", async () => {
		const source = createRef<HTMLVideoElement>();
		const view = await mount(
			<GlLayer
				label="Clip"
				passes={[]}
				playing={false}
				source={source}
				time={0}
			/>
		);
		expect(view.container.innerHTML).toBe("");
		await view.unmount();
	});

	test("draws a labelled canvas and reports when WebGL2 is unavailable", async () => {
		const source = createRef<HTMLVideoElement>();
		const messages: string[] = [];
		const view = await mount(
			<GlLayer
				className="studio-media-layer"
				label="Clip"
				onUnavailable={(message) => messages.push(message)}
				passes={[pass("copy")]}
				playing={false}
				source={source}
				time={0}
			/>
		);
		const canvas = view.container.querySelector("canvas");
		expect(canvas?.getAttribute("aria-label")).toBe("Clip");
		expect(canvas?.className).toBe("studio-media-layer");
		// happy-dom has no WebGL2, which is exactly the fallback path.
		expect(messages).toEqual([
			"WebGL2 is unavailable, so this effect is not previewed.",
		]);
		await view.unmount();
	});
});

/** A pipeline that records draws and reports "no frame yet". */
function recordingPipeline() {
	const calls: { passes: readonly GlPass[]; time: number }[] = [];
	fakePipeline = () => ({
		dispose() {
			// Nothing to release.
		},
		render(_source, passes, time) {
			calls.push({ passes, time });
			return false;
		},
	});
	return calls;
}

describe("GlLayer redraws", () => {
	test("draws again once a paused video's frame loads or a seek lands", async () => {
		const calls = recordingPipeline();
		const source = createRef<HTMLVideoElement>();
		const video = document.createElement("video");
		Object.assign(source, { current: video });
		const view = await mount(
			<GlLayer
				label="Clip"
				passes={[pass("copy")]}
				playing={false}
				source={source}
				time={1}
			/>
		);
		const before = calls.length;
		expect(before).toBe(1);
		video.dispatchEvent(new Event("loadeddata"));
		expect(calls.length).toBe(before + 1);
		// A paused scrub: the parent seeks after this layer's draw.
		await view.rerender(
			<GlLayer
				label="Clip"
				passes={[pass("copy")]}
				playing={false}
				source={source}
				time={2}
			/>
		);
		expect(calls.at(-1)?.time).toBe(2);
		const afterScrub = calls.length;
		video.dispatchEvent(new Event("seeked"));
		expect(calls.length).toBe(afterScrub + 1);
		expect(calls.at(-1)?.time).toBe(2);
		await view.unmount();
		video.dispatchEvent(new Event("seeked"));
		expect(calls.length).toBe(afterScrub + 1);
		fakePipeline = null;
	});

	test("draws again once a paused image loads", async () => {
		const calls = recordingPipeline();
		const source = createRef<HTMLImageElement>();
		const image = document.createElement("img");
		Object.assign(source, { current: image });
		const view = await mount(
			<GlLayer
				label="Still"
				passes={[pass("copy")]}
				playing={false}
				source={source}
				time={0}
			/>
		);
		expect(calls.length).toBe(1);
		image.dispatchEvent(new Event("load"));
		expect(calls.length).toBe(2);
		await view.unmount();
		fakePipeline = null;
	});

	test("does not redraw for a rebuilt but identical pass list", async () => {
		const calls = recordingPipeline();
		const source = createRef<HTMLVideoElement>();
		Object.assign(source, { current: document.createElement("video") });
		const layer = (uniform: number) => (
			<GlLayer
				label="Clip"
				passes={[{ ...pass("grade"), uniforms: { u_amount: uniform } }]}
				playing={false}
				source={source}
				time={1}
			/>
		);
		const view = await mount(layer(0.5));
		expect(calls.length).toBe(1);
		await view.rerender(layer(0.5));
		expect(calls.length).toBe(1);
		await view.rerender(layer(0.75));
		expect(calls.length).toBe(2);
		expect(calls.at(-1)?.passes[0]?.uniforms).toEqual({ u_amount: 0.75 });
		await view.unmount();
		fakePipeline = null;
	});
});

describe("GL passes", () => {
	test("key passes by id, shader and uniforms, ignoring uniform order", () => {
		const a: GlPass = { ...pass("grade"), uniforms: { u_a: 1, u_b: [1, 2] } };
		const b: GlPass = { ...pass("grade"), uniforms: { u_b: [1, 2], u_a: 1 } };
		expect(glPassesKey([a])).toBe(glPassesKey([b]));
		expect(glPassesKey([a])).not.toBe(
			glPassesKey([{ ...a, uniforms: { u_a: 2, u_b: [1, 2] } }])
		);
		expect(glPassesKey([a])).not.toBe(glPassesKey([{ ...a, id: "key" }]));
		expect(glPassesKey([])).toBe("[]");
	});

	test("keep the render stage order and drop inactive stages", () => {
		expect(glPassOrder).toEqual(["key", "grade", "effects"]);
		expect(
			orderedGlPasses({
				effects: pass("effects"),
				grade: null,
				key: pass("key"),
			}).map((entry) => entry.id)
		).toEqual(["key", "effects"]);
		expect(orderedGlPasses({})).toEqual([]);
	});

	test("are all inactive for current projects", () => {
		for (const fixture of mediaLayerFixtures) {
			const segment = segmentSchema.parse(fixture.segment);
			expect(segmentGlPasses(segment, fixture.time - segment.start)).toEqual(
				[]
			);
		}
	});

	test("prefix pass bodies with the shared shader header", () => {
		const source = glFragmentSource(pass("copy"));
		expect(source.startsWith("#version 300 es\n")).toBe(true);
		for (const declaration of [
			"uniform sampler2D u_source;",
			"uniform vec2 u_resolution;",
			"uniform float u_time;",
			"in vec2 v_uv;",
			"out vec4 outColor;",
		]) {
			expect(source).toContain(declaration);
		}
		expect(source.endsWith(pass("copy").fragment)).toBe(true);
	});

	test("wait for a decodable frame before uploading a source", () => {
		const video = document.createElement("video");
		expect(glSourceSize(video)).toBeNull();
		const image = document.createElement("img");
		expect(glSourceSize(image)).toBeNull();
	});
});
