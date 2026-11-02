import { describe, expect, test } from "bun:test";
import {
	blendModes,
	isComponentBlendMode,
	type SeparableBlendMode,
} from "../../../../shared/blend.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
	segmentSchema,
} from "../../../../shared/project.ts";
import { blendFunctionGlsl, separableBlendGlsl } from "./blend-glsl.ts";
import { PreviewMediaRegistry } from "./media-registry.ts";
import {
	compositorBackgroundSupported,
	compositorPlan,
	compositorZIndex,
	OVERLAY_Z_INDEX,
} from "./plan.ts";

const asset = (id: number, width: number, height: number): Asset => ({
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 5,
	hasAudio: false,
	height,
	id: `00000000-0000-4000-8000-${id.toString(16).padStart(12, "0")}`,
	kind: "image",
	name: `asset-${id}`,
	width,
});

const wide = asset(1, 1920, 1080);
const square = asset(2, 400, 400);
const assets = [wide, square];

const clip = (source: Asset, fields: Partial<Segment> = {}): Segment =>
	segmentSchema.parse({ ...newSegment(source), sourceOut: 4, ...fields });

const projectWith = (segments: Segment[], fields: Partial<Project> = {}) =>
	({
		...newProject("Compositor"),
		height: 180,
		segments,
		width: 320,
		...fields,
	}) as Project;

function activePlan(project: Project, time = 1) {
	const plan = compositorPlan(project, assets, time);
	if (!plan.active) {
		throw new Error(`Expected an active plan, got gaps ${plan.gaps}`);
	}
	return plan;
}

describe("compositorPlan", () => {
	test("stays on the CSS path without a blended clip on screen", () => {
		const project = projectWith([
			clip(wide),
			clip(square, { blendMode: "multiply", start: 3, track: 1 }),
		]);
		expect(compositorPlan(project, assets, 1)).toEqual({
			active: false,
			gaps: [],
		});
		expect(compositorPlan(project, assets, 3.5).active).toBe(true);
	});

	test("draws every visible clip in the render's track order", () => {
		const top = clip(square, { blendMode: "screen", track: 2 });
		const base = clip(wide, { track: 0 });
		const middle = clip(wide, { blendMode: "multiply", track: 1 });
		const hidden = clip(wide, { hidden: true, track: 3 });
		const plan = activePlan(projectWith([top, hidden, middle, base]));
		expect(plan.layers.map((layer) => layer.segmentId)).toEqual([
			base.id,
			middle.id,
			top.id,
		]);
		expect(plan.layers.map((layer) => layer.mode)).toEqual([
			"normal",
			"multiply",
			"screen",
		]);
		// No background: the style profile's canvas colour (black).
		expect(plan.background).toEqual({ color: [0, 0, 0], type: "color" });
	});

	test("places fit clips like the render: even box, letterbox, offset", () => {
		const layer = clip(square, {
			blendMode: "overlay",
			rotation: 30,
			scale: 0.5,
			x: 0.5,
			y: -0.25,
		});
		const [placed] = activePlan(projectWith([layer])).layers;
		// Box 160x90; the square fits at 90x90 centred at (240, 67.5).
		expect(placed?.drawn).toEqual([90, 90]);
		expect(placed?.center).toEqual([240, 67.5]);
		expect(placed?.rotation).toBeCloseTo(Math.PI / 6, 9);
		// `rotate=…:ow=iw:oh=ih` clips a fit clip's corners.
		expect(placed?.clipUnrotated).toBe(true);
		expect(placed?.source).toEqual({ height: 1, left: 0, top: 0, width: 1 });
	});

	test("fill crops to the box aspect after the user crop; stretch fills the box", () => {
		const fill = clip(square, {
			blendMode: "screen",
			crop: { bottom: 0, left: 0.2, right: 0, top: 0 },
			fit: "fill",
			rotation: 10,
		});
		const [filled] = activePlan(projectWith([fill])).layers;
		expect(filled?.drawn).toEqual([320, 180]);
		expect(filled?.clipUnrotated).toBe(false);
		// The 320x400 crop window keeps a centred 320x180 band.
		expect(filled?.source.left).toBeCloseTo(0.2, 9);
		expect(filled?.source.width).toBeCloseTo(0.8, 9);
		expect(filled?.source.height).toBeCloseTo(180 / 400, 6);
		expect(filled?.source.top).toBeCloseTo((1 - 180 / 400) / 2, 6);
		expect(filled?.maskWindow.top).toBeCloseTo((1 - 180 / 400) / 2, 6);

		const stretch = clip(square, {
			blendMode: "screen",
			fit: "stretch",
			flipH: true,
			scale: 0.5,
			scaleX: 0.5,
		});
		const [stretched] = activePlan(projectWith([stretch])).layers;
		expect(stretched?.drawn).toEqual([80, 90]);
		expect(stretched?.flip).toEqual([true, false]);
	});

	test("keyframed crop keeps the widest window and hides the rest", () => {
		const layer = clip(wide, {
			blendMode: "difference",
			keyframes: [
				{ id: crypto.randomUUID(), property: "cropLeft", time: 0, value: 0 },
				{ id: crypto.randomUUID(), property: "cropLeft", time: 2, value: 0.4 },
			],
		});
		const [placed] = activePlan(projectWith([layer])).layers;
		expect(placed?.source.left).toBe(0);
		expect(placed?.visible.left).toBeCloseTo(0.2, 6);
	});

	test("opacity multiplies fades and keyframes", () => {
		const layer = clip(wide, {
			blendMode: "add",
			fadeIn: 2,
			opacity: 0.8,
		});
		const [placed] = activePlan(projectWith([layer])).layers;
		expect(placed?.opacity).toBeCloseTo(0.4, 9);
	});

	test("colour and gradient canvases are drawn; image backgrounds are not", () => {
		const layer = clip(wide, { blendMode: "screen" });
		const colored = activePlan(
			projectWith([layer], { background: { color: "#336699", type: "color" } })
		);
		expect(colored.background).toEqual({
			color: [0x33 / 255, 0x66 / 255, 0x99 / 255],
			type: "color",
		});
		const gradient = activePlan(
			projectWith([layer], {
				background: {
					angle: 90,
					color: "#000000",
					color2: "#ffffff",
					type: "gradient",
				},
			})
		);
		expect(gradient.background.type).toBe("gradient");
		const image = projectWith([layer], {
			background: { assetId: wide.id, type: "image" },
		} as Partial<Project>);
		expect(compositorBackgroundSupported(image)).toBe(false);
		expect(compositorPlan(image, assets, 1)).toEqual({
			active: false,
			gaps: ["canvas-background"],
		});
	});

	test("stages it cannot draw keep the CSS stack and say why", () => {
		const blended = clip(wide, { blendMode: "screen" });
		const edges = clip(wide, { edgeRounding: 0.2, track: 1 });
		expect(compositorPlan(projectWith([blended, edges]), assets, 1)).toEqual({
			active: false,
			gaps: ["edges"],
		});
		const effect = clip(wide, { track: 1, visualEffect: "sepia" });
		expect(compositorPlan(projectWith([blended, effect]), assets, 1)).toEqual({
			active: false,
			gaps: ["css-filter"],
		});
		// Basic colour without an advanced grade is a CSS filter too.
		const brighter = clip(wide, { brightness: 0.2, track: 1 });
		expect(compositorPlan(projectWith([blended, brighter]), assets, 1)).toEqual(
			{ active: false, gaps: ["css-filter"] }
		);
		const unsized: Asset = { ...wide, height: 0, width: 0 };
		expect(compositorPlan(projectWith([blended]), [unsized], 1)).toEqual({
			active: false,
			gaps: ["media-size"],
		});
	});

	test("sits above its on-screen clips and below titles, graphics and captions", () => {
		const music: Asset = { ...asset(3, 0, 0), kind: "audio" };
		const withMusic = [...assets, music];
		const base = clip(wide, { track: 0 });
		const blended = clip(square, { blendMode: "multiply", track: 1 });
		// Off-screen and audio clips on high tracks do not raise the canvas.
		const later = clip(wide, { start: 10, track: 20 });
		const audio = clip(music, { track: 14 });
		const plan = compositorPlan(
			projectWith([base, blended, later, audio]),
			withMusic,
			1
		);
		if (!plan.active) {
			throw new Error(`Expected an active plan, got gaps ${plan.gaps}`);
		}
		expect(plan.layers.map((layer) => layer.track)).toEqual([0, 1]);
		expect(compositorZIndex(plan)).toBe(3);
		// A high on-screen track is clamped below the lowest overlay.
		const high = activePlan(
			projectWith([base, clip(square, { blendMode: "screen", track: 25 })])
		);
		expect(compositorZIndex(high)).toBe(OVERLAY_Z_INDEX - 1);
	});

	test("always composites a normal stack when asked", () => {
		const project = projectWith([clip(wide)]);
		expect(compositorPlan(project, assets, 1, { always: true }).active).toBe(
			true
		);
	});
});

describe("blend shaders", () => {
	test("every mode has a blendColor function", () => {
		for (const mode of blendModes) {
			const source = blendFunctionGlsl(mode);
			expect(source).toContain("vec3 blendColor(vec3 base, vec3 layer)");
			if (isComponentBlendMode(mode)) {
				expect(source).toContain("toYcc");
			} else {
				expect(source).toContain(
					separableBlendGlsl[mode as SeparableBlendMode]
				);
			}
		}
	});

	test("component modes pick luma and chroma like componentBlendOf", () => {
		expect(blendFunctionGlsl("color")).toContain(
			"vec3 direction = hi;\n\tvec3 amount = hi;"
		);
		expect(blendFunctionGlsl("luminosity")).toContain("vec3(hi.x,");
		expect(blendFunctionGlsl("hue")).toContain(
			"vec3 direction = hi;\n\tvec3 amount = lo;"
		);
	});
});

describe("PreviewMediaRegistry", () => {
	test("registers elements and notifies on frames and removal", () => {
		const registry = new PreviewMediaRegistry();
		let calls = 0;
		const unsubscribe = registry.subscribe(() => {
			calls++;
		});
		const listeners = new Map<string, () => void>();
		const element = {
			addEventListener: (name: string, listener: () => void) =>
				listeners.set(name, listener),
			removeEventListener: (name: string) => listeners.delete(name),
		} as unknown as HTMLImageElement;
		const unregister = registry.register("clip", element);
		expect(registry.get("clip")).toBe(element);
		expect(calls).toBe(1);
		listeners.get("seeked")?.();
		expect(calls).toBe(2);
		unregister();
		expect(registry.get("clip")).toBeUndefined();
		expect(listeners.size).toBe(0);
		expect(calls).toBe(3);
		unsubscribe();
	});
});
