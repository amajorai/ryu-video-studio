import { describe, expect, test } from "bun:test";
import { defaultMask, type Mask, maskOutline } from "../../../shared/masks.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Segment,
} from "../../../shared/project.ts";
import { buildRender } from "../render.ts";
import {
	exprNumber,
	maskGeqFilter,
	maskIsStatic,
	maskMatteFilters,
	maskStage,
	maskStrokeGeqFilter,
	type OutlineBand,
	type OutlineEdge,
	outlineBands,
	outlineEdges,
	outlineExpression,
	segmentMaskValue,
	shapeExpression,
	signedDistanceExpression,
	staticMaskValue,
} from "./mask.ts";
import type { RenderStageContext } from "./types.ts";

const ID = "00000000-0000-4000-8000-000000000001";
const ID2 = "00000000-0000-4000-8000-000000000002";

const asset: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 5,
	hasAudio: false,
	height: 1080,
	id: "00000000-0000-4000-8000-0000000000a1",
	kind: "video",
	name: "clip.mp4",
	width: 1920,
};

const context: RenderStageContext = {
	inputIndex: (offset) => 10 + offset,
	lutPath: (id) => `/luts/${id}.cube`,
	mediaPath: (id) => `/media/${id}`,
};

function segmentWith(patch: Partial<Segment>): Segment {
	return { ...newSegment(asset), ...patch };
}

const stage = (segment: Segment) =>
	maskStage(segment, { ...context, input: "mask1in", n: 1 });

describe("mask stage", () => {
	test("clips without masks pass through", () => {
		expect(stage(segmentWith({}))).toEqual({
			filters: [],
			inputs: [],
			label: "mask1in",
		});
		expect(stage(segmentWith({ masks: [] })).label).toBe("mask1in");
	});

	test("one mask multiplies its matte into the clip alpha", () => {
		const out = stage(
			segmentWith({ masks: [{ ...defaultMask("ellipse", ID), width: 0.5 }] })
		);
		expect(out.inputs).toEqual([]);
		expect(out.label).toBe("mask1out");
		expect(out.filters).toEqual([
			"[mask1in]format=rgba,split=2[mask1c][mask1s]",
			"[mask1s]alphaextract,split=2[mask1a0][mask1s0]",
			`[mask1s0]trim=end_frame=1,geq=lum='st(0,W/2*(1+0));st(1,H/2*(1+0));st(2,max(W*0.5/2,0.5));st(3,max(H*1/2,0.5));st(4,0*PI/180);st(5,(X+0.5-ld(0))*cos(ld(4))+(Y+0.5-ld(1))*sin(ld(4)));st(6,(Y+0.5-ld(1))*cos(ld(4))-(X+0.5-ld(0))*sin(ld(4)));st(7,ld(5)/ld(2));st(8,ld(6)/ld(3));255*(1-1*(1-(lte(ld(7)*ld(7)+ld(8)*ld(8),1))))'[mask1m0]`,
			"[mask1a0][mask1m0]blend=all_mode=multiply:eof_action=repeat[mask1a1]",
			"[mask1c][mask1a1]alphamerge[mask1out]",
		]);
	});

	test("several masks chain their multiplies", () => {
		const out = stage(
			segmentWith({
				masks: [defaultMask("ellipse", ID), defaultMask("heart", ID2)],
			})
		);
		expect(out.filters[1]).toBe(
			"[mask1s]alphaextract,split=3[mask1a0][mask1s0][mask1s1]"
		);
		expect(out.filters).toContain(
			"[mask1a1][mask1m1]blend=all_mode=multiply:eof_action=repeat[mask1a2]"
		);
		expect(out.filters.at(-1)).toBe("[mask1c][mask1a2]alphamerge[mask1out]");
	});

	test("static mattes are drawn once; keyframed mattes every frame", () => {
		const still = stage(
			segmentWith({ masks: [{ ...defaultMask("star", ID), feather: 0.2 }] })
		);
		expect(still.filters[2]).toStartWith("[mask1s0]trim=end_frame=1,geq=");
		expect(still.filters[3]).toBe(
			"[mask1a0][mask1m0]blend=all_mode=multiply:eof_action=repeat[mask1a1]"
		);
		const moving = stage(
			segmentWith({
				keyframes: [
					{ id: ID2, property: "maskRotation", target: ID, time: 0, value: 0 },
				],
				masks: [defaultMask("star", ID)],
			})
		);
		expect(moving.filters[2]).toStartWith("[mask1s0]geq=");
		expect(moving.filters[3]).toBe(
			"[mask1a0][mask1m0]blend=all_mode=multiply[mask1a1]"
		);
		expect(maskIsStatic(defaultMask("star", ID), staticMaskValue)).toBe(true);
	});

	test("outline tests only the edges in the pixel's y band", () => {
		// 64 curved points flatten to 512 edges; each band keeps a few.
		const path = Array.from({ length: 64 }, (_, index) => {
			const angle = (index / 64) * 2 * Math.PI;
			return {
				outX: -0.05 * Math.sin(angle),
				outY: 0.05 * Math.cos(angle),
				x: 0.9 * Math.cos(angle),
				y: 0.9 * Math.sin(angle),
			};
		});
		const outline = maskOutline({ ...defaultMask("freeform", ID), path }) ?? [];
		expect(outline.length).toBe(512);
		const edges = outlineEdges(outline);
		const ys = outline.map((point) => point.y);
		const bands = outlineBands(edges, Math.min(...ys), Math.max(...ys));
		const leafAt = (y: number): OutlineEdge[] => {
			let band: OutlineBand = bands;
			while (!("edges" in band)) {
				band = y < band.middle ? band.below : band.above;
			}
			return [...band.edges];
		};
		const crossings = (list: readonly OutlineEdge[], x: number, y: number) =>
			list.filter(
				(edge) =>
					y > edge.minY &&
					y <= edge.maxY &&
					x <
						edge.ax +
							((y - edge.ay) * (edge.bx - edge.ax)) / (edge.by - edge.ay)
			).length;
		let total = 0;
		let rows = 0;
		for (let y = -0.9; y <= 0.9; y += 0.0137) {
			const leaf = leafAt(y);
			total += leaf.length;
			rows++;
			for (const x of [-0.95, -0.5, 0, 0.42, 0.89]) {
				expect(crossings(leaf, x, y)).toBe(crossings(edges, x, y));
			}
		}
		// A pixel tests a few dozen edges on average instead of all 512.
		expect(total / rows).toBeLessThan(40);
		expect(outlineExpression(outline)).toStartWith("if(between(ld(7),");
	});

	test("feather maps to a box blur of a tenth of the shorter side", () => {
		const out = stage(
			segmentWith({ masks: [{ ...defaultMask("star", ID), feather: 0.3 }] })
		);
		expect(out.filters[2]).toEndWith(
			",boxblur=lr='min(w,h)*0.3*0.1':lp=3[mask1m0]"
		);
	});

	test("linear and mirror masks feather analytically, without a blur", () => {
		for (const shape of ["linear", "mirror"] as const) {
			const out = stage(
				segmentWith({ masks: [{ ...defaultMask(shape, ID), feather: 0.5 }] })
			);
			expect(out.filters.join(";")).not.toContain("boxblur");
			expect(out.filters[2]).toContain("max(1,0.4*0.5*min(W,H))");
		}
	});

	test("invert and opacity shape the strength", () => {
		const inverted = maskGeqFilter(
			{ ...defaultMask("ellipse", ID), invert: true, opacity: 0.5 },
			staticMaskValue
		);
		expect(inverted).toEndWith("255*(1-0.5*(lte(ld(7)*ld(7)+ld(8)*ld(8),1)))'");
	});

	test("keyframed geometry becomes expressions of the clip clock", () => {
		const segment = segmentWith({
			keyframes: [
				{ id: ID2, property: "maskX", target: ID, time: 0, value: -0.5 },
				{
					id: "00000000-0000-4000-8000-000000000003",
					property: "maskX",
					target: ID,
					time: 2,
					value: 0.5,
				},
			],
			masks: [defaultMask("rectangle", ID)],
		});
		const out = stage(segment);
		expect(out.filters[2]).toContain(
			"st(0,W/2*(1+(if(lt(T,2),-0.5+(1)*max(0,(T-0))/2,0.5))))"
		);
		const value = segmentMaskValue(segment);
		expect(value(defaultMask("rectangle", ID), "y", "T")).toBe("0");
	});

	test("a keyframed feather crossfades a sharp and a fully feathered matte", () => {
		const segment = segmentWith({
			keyframes: [
				{ id: ID2, property: "maskFeather", target: ID, time: 0, value: 0 },
				{
					id: "00000000-0000-4000-8000-000000000003",
					property: "maskFeather",
					target: ID,
					time: 1,
					value: 0.4,
				},
			],
			masks: [defaultMask("ellipse", ID)],
		});
		const filters = stage(segment).filters;
		expect(filters[2]).toEndWith(",split=2[mask1m0h][mask1m0b]");
		expect(filters[3]).toBe(
			"[mask1m0b]boxblur=lr='min(w,h)*0.4*0.1':lp=3[mask1m0f]"
		);
		expect(filters[4]).toStartWith(
			"[mask1m0h][mask1m0f]blend=all_expr='A+(B-A)*clip((if(lt(T,1)"
		);
	});

	test("text masks draw sanitized text and move it about the frame", () => {
		const out = stage(
			segmentWith({
				masks: [
					{
						...defaultMask("text", ID),
						fontFamily: "inter",
						invert: true,
						rotation: 45,
						text: "Don't: stop",
						x: 0.5,
					},
				],
			})
		);
		expect(out.filters[2]).toBe(
			"[mask1s0]trim=end_frame=1,geq=lum=0,drawtext=font='Inter':text='Don’t stop':expansion=none:fontcolor=white:fontsize='0.8*h*1':x='(w-text_w)/2':y='(h-text_h)/2',rotate=a='45*PI/180':fillcolor=black,pad=iw*3:ih*3:iw:ih:black,crop=w=iw/3:h=ih/3:x='iw/3-0.5*iw/6':y='ih/3-0*ih/6',geq=lum='255*(1-1*(p(X,Y)/255))'[mask1m0]"
		);
	});

	test("matte filters are reusable with another prefix and resolver", () => {
		const masks: Mask[] = [defaultMask("ellipse", ID)];
		const out = maskMatteFilters({
			input: "adj1in",
			masks,
			prefix: "adjmask1",
			value: staticMaskValue,
		});
		expect(out.label).toBe("adjmask1out");
		expect(out.filters[0]).toBe(
			"[adj1in]format=rgba,split=2[adjmask1c][adjmask1s]"
		);
		expect(
			maskMatteFilters({
				input: "x",
				masks: [],
				prefix: "p",
				value: staticMaskValue,
			})
		).toEqual({ filters: [], label: "x" });
	});
});

describe("shape expressions", () => {
	test("numbers never use exponents", () => {
		expect(exprNumber(1e-7)).toBe("0");
		expect(exprNumber(-0)).toBe("0");
		expect(exprNumber(Math.PI)).toBe("3.141593");
	});

	test("every non-text shape has an expression", () => {
		for (const shape of [
			"rectangle",
			"ellipse",
			"linear",
			"mirror",
			"polygon",
			"star",
			"heart",
			"freeform",
		] as const) {
			expect(shapeExpression(defaultMask(shape, ID), staticMaskValue)).not.toBe(
				""
			);
		}
		expect(
			shapeExpression(
				{ ...defaultMask("rectangle", ID), cornerRadius: 0.2 },
				staticMaskValue
			)
		).toStartWith("st(9,0.4*min(ld(2),ld(3)))");
	});

	test("freeform paths become a bounded crossing sum", () => {
		const expression = shapeExpression(
			defaultMask("freeform", ID),
			staticMaskValue
		);
		expect(expression).toStartWith(
			"if(between(ld(7),-0.5,0.5)*between(ld(8),-0.5,0.5),mod("
		);
	});
});

describe("buildRender with masks", () => {
	test("the masked clip splits its chain around the mask statements", () => {
		const project = newProject("Masks");
		project.segments = [segmentWith({ masks: [defaultMask("ellipse", ID)] })];
		const args = buildRender(
			project,
			[asset],
			() => "/media/clip.mp4",
			undefined,
			[],
			1
		);
		const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
		expect(graph).toContain("[mask1in];[mask1in]format=rgba,split=2");
		expect(graph).toContain("[mask1c][mask1a1]alphamerge[mask1out];[mask1out]");
	});
});

describe("mask strokes", () => {
	const strokedMask = (patch: Partial<Mask> = {}): Mask => ({
		...defaultMask("ellipse", ID),
		strokeColor: "#ff8000",
		strokeWidth: 0.05,
		...patch,
	});

	test("masks without a stroke keep the plain matte chain", () => {
		const { filters } = maskMatteFilters({
			input: "in",
			masks: [defaultMask("ellipse", ID)],
			prefix: "m",
			value: staticMaskValue,
		});
		expect(filters[0]).toBe("[in]format=rgba,split=2[mc][ms]");
		expect(filters.at(-1)).toBe("[mc][ma1]alphamerge[mout]");
		expect(filters.join(";")).not.toContain("overlay");
	});

	test("a static stroke is drawn once and overlaid over the masked clip", () => {
		const { filters, label } = maskMatteFilters({
			input: "in",
			masks: [defaultMask("rectangle", ID2), strokedMask()],
			prefix: "m",
			value: staticMaskValue,
		});
		expect(label).toBe("mout");
		expect(filters[0]).toBe("[in]format=rgba,split=3[mc][ms][mk1]");
		expect(filters).toContain("[mc][ma2]alphamerge[mmerged]");
		const stroke = filters.find((filter) => filter.startsWith("[mk1]"));
		expect(stroke).toStartWith("[mk1]trim=end_frame=1,geq=r=255:g=128:b=0:a='");
		expect(stroke).toEndWith("[mg1]");
		expect(filters.at(-1)).toBe(
			"[mmerged][mg1]overlay=format=rgb:eof_action=repeat[mout]"
		);
	});

	test("alignment sets the band and a keyframed mask strokes every frame", () => {
		const inside = maskStrokeGeqFilter(
			strokedMask({ strokeAlign: "inside" }),
			staticMaskValue
		);
		expect(inside).toContain("clip(0.5-(ld(0)-(0)),0,1)");
		expect(inside).toContain("clip(0.5-(ld(0)-(-0.05*H)),0,1)");
		const outside = maskStrokeGeqFilter(
			strokedMask({ strokeAlign: "outside" }),
			staticMaskValue
		);
		expect(outside).toContain("clip(0.5-(ld(0)-(0.05*H)),0,1)");
		const segment = segmentWith({
			keyframes: [
				{ id: ID2, property: "maskX", target: ID, time: 0, value: -0.5 },
				{
					id: "00000000-0000-4000-8000-000000000003",
					property: "maskX",
					target: ID,
					time: 1,
					value: 0.5,
				},
			],
			masks: [strokedMask()],
		});
		const { filters } = stage(segment);
		const stroke = filters.find((filter) => filter.startsWith("[mask1k0]"));
		expect(stroke).toStartWith("[mask1k0]geq=");
		expect(filters.at(-1)).toBe(
			"[mask1merged][mask1g0]overlay=format=rgb[mask1out]"
		);
	});

	test("every stroked shape has a signed distance", () => {
		for (const shape of [
			"rectangle",
			"ellipse",
			"linear",
			"mirror",
			"polygon",
			"star",
			"heart",
			"freeform",
		] as const) {
			expect(signedDistanceExpression(defaultMask(shape, ID), "(10)")).not.toBe(
				""
			);
		}
		expect(
			signedDistanceExpression(defaultMask("polygon", ID), "(10)")
		).toStartWith(
			"st(1,(10)+1);st(7,ld(2)*ld(2));st(8,ld(3)*ld(3));if(between(ld(5),"
		);
		expect(signedDistanceExpression(defaultMask("linear", ID), "(10)")).toBe(
			"ld(6)"
		);
	});
});
