import { describe, expect, test } from "bun:test";
import type { AdjustmentLayer } from "../../../shared/adjustment.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
} from "../../../shared/project.ts";
import { defaultMask } from "../../../shared/schema/mask.ts";
import { buildRender } from "../render.ts";
import {
	adjustmentAfterTrack,
	adjustmentLayerFilters,
	layerFilterChain,
	layerOpacityFilters,
} from "./adjustment.ts";

const uuid = (n: number) =>
	`00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const asset: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 10,
	hasAudio: false,
	height: 720,
	id: uuid(1),
	kind: "video",
	name: "clip.mp4",
	width: 1280,
};

function layer(overrides: Partial<AdjustmentLayer> = {}): AdjustmentLayer {
	return {
		end: 2,
		id: uuid(50),
		label: "Grade",
		opacity: 1,
		start: 1,
		track: 0,
		...overrides,
	};
}

function project(layers: AdjustmentLayer[] = []): Project {
	const base: Project = {
		...newProject("Adjustment render"),
		segments: [
			{ ...newSegment(asset, 0, 0), id: uuid(10), sourceOut: 3 },
			{ ...newSegment(asset, 0, 1), id: uuid(11), scale: 0.5, sourceOut: 3 },
		],
	};
	return layers.length ? { ...base, adjustmentLayers: layers } : base;
}

describe("adjustmentAfterTrack", () => {
	test("is a no-op without layers, for other tracks and for neutral layers", () => {
		expect(adjustmentAfterTrack(project(), 0, "out1", 0)).toEqual({
			filters: [],
			last: "out1",
		});
		const graded = project([layer({ saturation: 0, track: 1 })]);
		expect(adjustmentAfterTrack(graded, 0, "out1", 0).filters).toEqual([]);
		expect(
			adjustmentAfterTrack(project([layer()]), 0, "out1", 0).filters
		).toEqual([]);
	});

	test("grades a split of the composite inside the layer window", () => {
		const result = adjustmentAfterTrack(
			project([layer({ saturation: 0 })]),
			0,
			"out1",
			3
		);
		expect(result).toEqual({
			filters: [
				"[out1]split=2[adj3_0keep][adj3_0fx]",
				"[adj3_0fx]eq=brightness=0:contrast=1:saturation=0,format=rgba[adj3_0graded]",
				"[adj3_0keep][adj3_0graded]overlay=x='0':y='0':eof_action=pass:enable='between(t,1,2)'[adj3_0out]",
			],
			last: "adj3_0out",
		});
	});

	test("chains several layers on one track in start order", () => {
		const result = adjustmentAfterTrack(
			project([
				layer({ end: 5, id: uuid(51), saturation: 0, start: 3 }),
				layer({ brightness: 0.1 }),
			]),
			0,
			"out1",
			0
		);
		expect(result.last).toBe("adj0_1out");
		expect(result.filters[0]).toBe("[out1]split=2[adj0_0keep][adj0_0fx]");
		expect(result.filters[2]).toContain("enable='between(t,1,2)'");
		expect(result.filters[3]).toBe("[adj0_0out]split=2[adj0_1keep][adj0_1fx]");
		expect(result.filters[5]).toContain("enable='between(t,3,5)'");
	});

	test("never drops graded frames before a late start (no trim)", () => {
		// A trimmed branch stalls the overlay and buffers every frame up to
		// `start`; only the inclusive `enable` window may bound the layer.
		const late = adjustmentAfterTrack(
			project([layer({ end: 605, saturation: 0, start: 600 })]),
			0,
			"out1",
			0
		);
		const graph = late.filters.join(";");
		expect(graph).not.toMatch(/\btrim=|\bselect=|\bsetpts=/);
		expect(late.filters[1]).toBe(
			"[adj0_0fx]eq=brightness=0:contrast=1:saturation=0,format=rgba[adj0_0graded]"
		);
		expect(graph).toContain("enable='between(t,600,605)'");
	});

	test("formats sub-microsecond times without exponent notation", () => {
		const tiny = layerFilterChain(
			layer({ end: 2, saturation: 0, start: 5e-7 })
		).join(",");
		expect(tiny).not.toMatch(/\de-\d/);
		const { filters } = adjustmentLayerFilters(
			layer({ end: 2, saturation: 0, start: 5e-7 }),
			"out1",
			"adj0_0"
		);
		expect(filters.join(";")).toContain("enable='between(t,0.000001,2)'");
		expect(filters.join(";")).not.toMatch(/\de-\d/);
	});

	test("reuses the mask matte and the blend-aware composite", () => {
		const mask = defaultMask("ellipse", uuid(70));
		const { filters, last } = adjustmentLayerFilters(
			layer({ blendMode: "multiply", masks: [mask], saturation: 0 }),
			"out2",
			"adj1_0"
		);
		const graph = filters.join(";");
		expect(graph).toContain("[adj1_0graded]format=rgba,split=2");
		expect(graph).toContain("alphamerge[adj1_0mout]");
		expect(graph).toContain("blend=all_mode=multiply");
		expect(graph).toContain("[adj1_0keep]split=3");
		expect(last).toBe("adj1_0out");
	});

	test("keyframed mask positions are expressions of project time", () => {
		const mask = defaultMask("rectangle", uuid(71));
		const { filters } = adjustmentLayerFilters(
			layer({
				keyframes: [
					{
						id: uuid(72),
						property: "maskX",
						target: mask.id,
						time: 1,
						value: 0.5,
					},
				],
				masks: [mask],
				saturation: 0,
				start: 2,
				end: 4,
			}),
			"out1",
			"adj0_0"
		);
		// Anchor at the layer start (2 s), keyframe at 2 + 1 = 3 s.
		expect(filters.join(";")).toContain(
			"if(lt(T,2),0+(0)*max(0,(T-0))/2,if(lt(T,3),0+(0.5)*max(0,(T-2))/1,0.5))"
		);
	});
});

describe("layer chains", () => {
	test("static and keyframed opacity", () => {
		expect(layerOpacityFilters(layer())).toEqual([]);
		expect(layerOpacityFilters(layer({ opacity: 0.25 }))).toEqual([
			"colorchannelmixer=aa=0.25",
		]);
		const [geq] = layerOpacityFilters(
			layer({
				keyframes: [{ id: uuid(73), property: "opacity", time: 1, value: 0 }],
				start: 1,
				end: 3,
			})
		);
		expect(geq).toStartWith(
			"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip("
		);
		expect(geq).toContain("if(lt(T,1)");
	});

	test("keyframed brightness uses per-frame eq expressions", () => {
		const chain = layerFilterChain(
			layer({
				keyframes: [
					{ id: uuid(74), property: "brightness", time: 0.5, value: 0.4 },
				],
				start: 1,
				end: 3,
			})
		);
		expect(chain[0]).toStartWith("eq=brightness='(if(lt(t,1)");
		expect(chain[0]).toEndWith(":eval=frame");
	});

	test("effects reuse the effect stack with layer-scoped labels", () => {
		const chain = layerFilterChain(
			layer({
				effects: [{ amount: 1, enabled: true, type: "invert" }],
			})
		);
		expect(chain).toContain("format=rgba");
		expect(chain.join(",")).toContain("negate");
	});

	test("a LUT needs the orchestrator's resolver", () => {
		const graded = layer({
			colorGrade: {
				exposure: 0,
				lut: { intensity: 1, lutId: uuid(90) },
				temperature: 0,
				tint: 0,
				vibrance: 0,
			},
		});
		expect(() => layerFilterChain(graded)).toThrow(
			"used by an adjustment layer"
		);
		expect(
			layerFilterChain(graded, { lutPath: (id) => `/luts/${id}.cube` }).join(
				","
			)
		).toContain(`lut3d=file=/luts/${uuid(90)}.cube`);
	});
});

describe("buildRender", () => {
	test("applies a track-0 layer between the track-0 and track-1 clips", () => {
		const args = buildRender(
			project([layer({ saturation: 0 })]),
			[asset],
			(id) => `/media/${id}`
		);
		const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
		const statements = graph.split(";");
		const out1 = statements.findIndex((s) => s.endsWith("[out1]"));
		const split = statements.indexOf("[out1]split=2[adj0_0keep][adj0_0fx]");
		const layerOut = statements.findIndex((s) => s.endsWith("[adj0_0out]"));
		const clip2 = statements.findIndex((s) => s.startsWith("[adj0_0out][v2]"));
		expect(out1).toBeGreaterThanOrEqual(0);
		expect(split).toBe(out1 + 1);
		expect(layerOut).toBeGreaterThan(split);
		expect(clip2).toBeGreaterThan(layerOut);
	});

	test("projects without layers render exactly as before", () => {
		const plain = buildRender(project(), [asset], (id) => `/media/${id}`);
		const neutral = buildRender(
			project([layer()]),
			[asset],
			(id) => `/media/${id}`
		);
		expect(neutral).toEqual(plain);
	});
});
