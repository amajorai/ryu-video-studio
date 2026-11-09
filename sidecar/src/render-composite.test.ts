import { describe, expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	newSegment,
	segmentSchema,
} from "../../shared/project.ts";
import { buildRender } from "./render.ts";
import { compositeLayer } from "./render-composite.ts";

const placement = {
	base: "base",
	enable: "between(t,1,3)",
	layer: "bg2",
	out: "out2",
	x: "(W-w)/2",
	y: "(H-h)/2",
};

describe("compositeLayer blend modes", () => {
	test("normal and absent modes keep the legacy overlay byte for byte", () => {
		const legacy = [
			"[base][bg2]overlay=x='(W-w)/2':y='(H-h)/2':eof_action=pass:enable='between(t,1,3)'[out2]",
		];
		expect(compositeLayer({ ...placement, s: {} })).toEqual(legacy);
		expect(
			compositeLayer({ ...placement, s: { blendMode: "normal" } })
		).toEqual(legacy);
	});

	test("a blended layer is placed on a clear canvas, blended in RGB and masked by its alpha", () => {
		expect(
			compositeLayer({ ...placement, s: { blendMode: "multiply" } })
		).toEqual([
			"[base]split=3[out2under][out2below][out2canvas]",
			"[out2canvas]format=rgba,colorchannelmixer=aa=0[out2clear]",
			"[out2clear][bg2]overlay=x='(W-w)/2':y='(H-h)/2':format=rgb:eof_action=pass:enable='between(t,1,3)'[out2placed]",
			"[out2placed]split=2[out2color][out2alpha]",
			"[out2below]format=gbrp[out2backdrop]",
			"[out2color]format=gbrp[out2source]",
			"[out2backdrop][out2source]blend=all_mode=multiply:all_opacity=1:enable='between(t,1,3)',format=gbrap[out2mixed]",
			"[out2alpha]alphaextract[out2mask]",
			"[out2mixed][out2mask]alphamerge[out2blended]",
			"[out2under][out2blended]overlay=x=0:y=0:eof_action=pass:enable='between(t,1,3)'[out2]",
		]);
	});

	test("dodge, burn and linear light put the layer first", () => {
		for (const [mode, name] of [
			["color-dodge", "dodge"],
			["color-burn", "burn"],
			["linear-light", "linearlight"],
		] as const) {
			const filters = compositeLayer({ ...placement, s: { blendMode: mode } });
			expect(filters).toContain(
				`[out2source][out2backdrop]blend=all_mode=${name}:all_opacity=1:enable='between(t,1,3)',format=gbrap[out2mixed]`
			);
		}
		const screen = compositeLayer({ ...placement, s: { blendMode: "add" } });
		expect(screen.join(";")).toContain(
			"[out2backdrop][out2source]blend=all_mode=addition"
		);
	});

	test("color and luminosity rebuild YCbCr planes with mergeplanes", () => {
		const color = compositeLayer({ ...placement, s: { blendMode: "color" } });
		expect(color).toContain(
			"[out2below]scale=out_color_matrix=bt601:out_range=full,format=yuv444p[out2baseycc0]"
		);
		expect(color).toContain(
			"[out2baseycc0][out2layerycc0]mergeplanes=map0s=0:map0p=0:map1s=1:map1p=1:map2s=1:map2p=2:format=yuv444p,scale=in_color_matrix=bt601:in_range=full,format=gbrap[out2mixed]"
		);
		expect(color.join(";")).not.toContain("blend=");
		const luminosity = compositeLayer({
			...placement,
			s: { blendMode: "luminosity" },
		});
		expect(luminosity.join(";")).toContain(
			"[out2layerycc0][out2baseycc0]mergeplanes="
		);
	});

	test("hue and saturation rescale the chroma vector to the other input's length", () => {
		const hue = compositeLayer({ ...placement, s: { blendMode: "hue" } });
		expect(hue).toContain(
			"[out2below]scale=out_color_matrix=bt601:out_range=full,format=yuv444p,split=2[out2baseycc0][out2baseycc1]"
		);
		expect(hue).toContain(
			"[out2baseycc1]geq=lum='hypot(cb(X,Y)-128,cr(X,Y)-128)':cb=128:cr=128[out2length]"
		);
		const merge = hue.find((filter) => filter.includes("mergeplanes")) ?? "";
		expect(merge.startsWith("[out2baseycc0][out2layerycc0][out2length]")).toBe(
			true
		);
		expect(merge).toContain("format=yuva444p,geq=");
		expect(merge.endsWith("[out2mixed]")).toBe(true);
		const saturation = compositeLayer({
			...placement,
			s: { blendMode: "saturation" },
		});
		expect(saturation).toContain(
			"[out2layerycc0]geq=lum='hypot(cb(X,Y)-128,cr(X,Y)-128)':cb=128:cr=128[out2length]"
		);
		expect(saturation.join(";")).toContain(
			"[out2baseycc0][out2baseycc1][out2length]mergeplanes="
		);
		for (const filters of [hue, saturation]) {
			expect(filters.at(-1)).toBe(
				"[out2under][out2blended]overlay=x=0:y=0:eof_action=pass:enable='between(t,1,3)'[out2]"
			);
		}
	});

	test("labels are unique per output, so several blended layers can chain", () => {
		const first = compositeLayer({ ...placement, s: { blendMode: "screen" } });
		const second = compositeLayer({
			...placement,
			base: "out2",
			layer: "bg3",
			out: "out3",
			s: { blendMode: "overlay" },
		});
		const labels = (filters: string[]) =>
			new Set(
				filters.flatMap((filter) =>
					[...filter.matchAll(/\[(\w+)\]/g)].map((match) => match[1])
				)
			);
		const shared = [...labels(first)].filter((label) =>
			labels(second).has(label)
		);
		expect(shared).toEqual(["out2"]);
		expect(second[0]).toBe("[out2]split=3[out3under][out3below][out3canvas]");
	});

	test("graphics and other overlays can pass just a blend mode", () => {
		const filters = compositeLayer({
			...placement,
			s: { blendMode: "difference" },
		});
		expect(filters.join(";")).toContain("blend=all_mode=difference");
	});
});

describe("buildRender with blend modes", () => {
	const asset: Asset = {
		createdAt: "2026-01-01T00:00:00.000Z",
		duration: 4,
		hasAudio: false,
		height: 1080,
		id: "00000000-0000-4000-8000-000000000001",
		kind: "image",
		name: "card.png",
		width: 1920,
	};

	test("only the blended clip changes the graph", () => {
		const project = newProject("Blend");
		project.segments = [
			segmentSchema.parse({ ...newSegment(asset), id: crypto.randomUUID() }),
			segmentSchema.parse({
				...newSegment(asset),
				blendMode: "screen",
				id: crypto.randomUUID(),
				track: 1,
			}),
		];
		const args = buildRender(project, [asset], () => "card.png");
		const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
		expect(graph).toContain("[base][v1]overlay=");
		expect(graph).toContain("[out1]split=3[out2under][out2below][out2canvas]");
		expect(graph).toContain("blend=all_mode=screen");
		expect(graph.match(/blend=all_mode=/g)).toHaveLength(1);
	});
});
