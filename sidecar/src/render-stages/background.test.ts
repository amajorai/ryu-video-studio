import { describe, expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
} from "../../../shared/project.ts";
import { buildRender } from "../render.ts";
import {
	baseSource,
	blurFillFilters,
	clipAlphaFilters,
	clipBackgroundFilters,
	gradientGeq,
	placedLayerSize,
} from "./background.ts";

const video: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 4,
	hasAudio: false,
	height: 360,
	id: "00000000-0000-4000-8000-000000000001",
	kind: "video",
	name: "Clip",
	width: 640,
};
const picture: Asset = {
	...video,
	id: "00000000-0000-4000-8000-000000000002",
	kind: "image",
	name: "Backdrop",
};

function fixture(fields: Partial<Project> = {}): {
	p: Project;
	s: Segment;
} {
	const s = newSegment(video);
	const p = { ...newProject("Backgrounds"), ...fields, segments: [s] };
	return { p, s };
}

/** Labels each statement writes and reads, to check the graph is wired. */
function labels(filters: string[]) {
	const produced: string[] = [];
	const consumed: string[] = [];
	for (const statement of filters) {
		const inputs = /^((?:\[[^\]]+\])+)/.exec(statement)?.[1] ?? "";
		const outputs = /((?:\[[^\]]+\])+)$/.exec(statement)?.[1] ?? "";
		consumed.push(
			...[...inputs.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1] ?? "")
		);
		produced.push(
			...[...outputs.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1] ?? "")
		);
	}
	return { consumed, produced };
}

describe("baseSource", () => {
	test("no explicit background keeps the legacy style color", () => {
		const { p } = fixture();
		expect(baseSource(p, 4, undefined)).toEqual({
			args: ["-f", "lavfi", "-i", "color=c=#000000:s=1920x1080:r=30:d=4"],
			filters: ["[0:v]format=yuv420p[base]"],
		});
	});

	test("an explicit color replaces the style color", () => {
		const { p } = fixture({ background: { color: "#336699", type: "color" } });
		expect(baseSource(p, 4, 1.5)).toEqual({
			args: [
				"-f",
				"lavfi",
				"-i",
				`color=c=#336699:s=1920x1080:r=30:d=${1 / 30}`,
			],
			filters: ["[0:v]format=yuv420p,setpts=PTS+1.5/TB[base]"],
		});
	});

	test("a project blur keeps the style color on the canvas", () => {
		const { p } = fixture({
			background: { amount: 0.5, dim: 0.2, type: "blur" },
		});
		expect(baseSource(p, 4, undefined)).toEqual(
			baseSource(fixture().p, 4, undefined)
		);
	});

	test("a gradient is evaluated on a small grid and scaled up", () => {
		const { p } = fixture({
			background: {
				angle: 90,
				color: "#000000",
				color2: "#ff8000",
				type: "gradient",
			},
		});
		const source = baseSource(p, 4, undefined);
		expect(source.args).toEqual([
			"-f",
			"lavfi",
			"-i",
			"color=c=black:s=64x36:r=30:d=4",
		]);
		expect(source.filters).toEqual([
			"[0:v]format=gbrp,geq=r='0+(255)*clip((0.015625)*X+(0)*Y+(0.0078125),0,1)':g='0+(128)*clip((0.015625)*X+(0)*Y+(0.0078125),0,1)':b='0+(0)*clip((0.015625)*X+(0)*Y+(0.0078125),0,1)',scale=1920:1080:flags=bilinear,setsar=1,format=yuv420p[base]",
		]);
	});

	test("an image covers the canvas and loops for the whole render", () => {
		const { p } = fixture({
			background: { assetId: picture.id, type: "image" },
		});
		const context = { mediaPath: (id: string) => `/media/${id}` };
		expect(baseSource(p, 4, undefined, context)).toEqual({
			args: ["-stream_loop", "-1", "-t", "4", "-i", `/media/${picture.id}`],
			filters: [
				"[0:v]setpts=PTS-STARTPTS,fps=30,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,format=yuv420p[base]",
			],
		});
		expect(baseSource(p, 4, 2, context).filters[0]).toEndWith(
			"format=yuv420p,setpts=PTS+2/TB[base]"
		);
		expect(() => baseSource(p, 4, undefined)).toThrow("media paths");
	});

	test("a frame render of a looped video canvas seeks into the loop", () => {
		const { p } = fixture({
			background: { assetId: video.id, type: "image" },
		});
		const context = {
			asset: (id: string) => [video, picture].find((item) => item.id === id),
			mediaPath: (id: string) => `/media/${id}`,
		};
		// 4 s video: 9.5 s on the timeline is 1.5 s into the loop.
		expect(baseSource(p, 10, 9.5, context).args).toEqual([
			"-stream_loop",
			"-1",
			"-ss",
			"1.5",
			"-t",
			`${1 / 30}`,
			"-i",
			`/media/${video.id}`,
		]);
		// Exports, loop starts, images and unknown media do not seek.
		expect(baseSource(p, 10, undefined, context).args).not.toContain("-ss");
		expect(baseSource(p, 10, 8, context).args).not.toContain("-ss");
		const still = fixture({
			background: { assetId: picture.id, type: "image" },
		}).p;
		expect(baseSource(still, 10, 9.5, context).args).not.toContain("-ss");
		expect(
			baseSource(p, 10, 9.5, { mediaPath: context.mediaPath }).args
		).not.toContain("-ss");
	});
});

describe("clipBackgroundFilters", () => {
	test("clips without a background pass through", () => {
		const { p, s } = fixture();
		expect(clipBackgroundFilters(s, p, "v1")).toEqual({
			filters: [],
			label: "v1",
		});
	});

	test("a color fill sits under the placed clip", () => {
		const { p, s } = fixture();
		const colored = {
			...s,
			background: { color: "#102030", type: "color" as const },
		};
		expect(clipBackgroundFilters(colored, p, "v1")).toEqual({
			filters: [
				"[v1]split=2[v1bgfront][v1bgsource]",
				"[v1bgsource]format=rgba,lutrgb=r=16:g=32:b=48:a=255[v1bgfill]",
				"[v1bgfill][v1bgfront]overlay=x=0:y=0:format=auto,format=rgba[v1bg]",
			],
			label: "v1bg",
		});
	});

	test("a gradient is drawn at the placed layer's size", () => {
		const { p, s } = fixture();
		const scaled = {
			...s,
			background: {
				angle: 0,
				color: "#000000",
				color2: "#ffffff",
				type: "gradient" as const,
			},
			scale: 1.5,
		};
		const layer = placedLayerSize(scaled, p);
		expect(layer).toEqual({ height: 1620, width: 2880 });
		const output = clipBackgroundFilters(scaled, p, "v2");
		expect(output.filters[1]).toBe(
			`[v2bgsource]scale=64:36,format=gbrp,${gradientGeq(scaled.background, layer, { height: 36, width: 64 })},scale=2880:1620:flags=bilinear,format=rgba[v2bgfill]`
		);
	});

	test("a project blur fills base-track clips and a clip blur any track", () => {
		const { p, s } = fixture({
			background: { amount: 0.5, dim: 0.25, type: "blur" },
		});
		const base = clipBackgroundFilters(s, p, "v1");
		expect(base.label).toBe("v1bg");
		expect(base.filters).toContain(
			"[v1bgsource]format=gbrap,premultiply=inplace=1,scale=96:54:flags=area[v1bgfillp0]"
		);
		const upper = { ...s, track: 1 };
		expect(clipBackgroundFilters(upper, p, "v1").filters).toEqual([]);
		const own = {
			...upper,
			background: { amount: 1, dim: 0, type: "blur" as const },
		};
		expect(clipBackgroundFilters(own, fixture().p, "v1").label).toBe("v1bg");
	});

	test("a transparent canvas drops the project blur but keeps a clip's own fill", () => {
		const { p, s } = fixture({
			background: { amount: 0.5, dim: 0.25, type: "blur" },
		});
		expect(
			clipBackgroundFilters(s, p, "v1", { transparentCanvas: true })
		).toEqual({ filters: [], label: "v1" });
		const own = {
			...s,
			background: { color: "#102030", type: "color" as const },
		};
		expect(
			clipBackgroundFilters(own, p, "v1", { transparentCanvas: true }).label
		).toBe("v1bg");
	});

	test("an always-opaque clip has no alpha chain for its fill", () => {
		expect(clipAlphaFilters(fixture().s)).toEqual([]);
	});

	test("the fill takes the clip's opacity, fades and crossfade", () => {
		const { p, s } = fixture();
		const faded = {
			...s,
			background: { color: "#102030", type: "color" as const },
			entryDuration: 1,
			entryTransition: "crossfade" as const,
			fadeOut: 0.5,
			opacity: 0.4,
			start: 2,
		};
		expect(clipAlphaFilters(faded)).toEqual([
			"setpts=PTS-2/TB",
			"colorchannelmixer=aa=0.4",
			"fade=t=in:st=0:d=1:alpha=1",
			"fade=t=out:st=3.5:d=0.5:alpha=1",
			"setpts=PTS+2/TB",
		]);
		const output = clipBackgroundFilters(faded, p, "v1");
		expect(output).toEqual({
			filters: [
				"[v1]split=3[v1bgfront][v1bgsource][v1bgcover]",
				"[v1bgsource]format=rgba,lutrgb=r=16:g=32:b=48:a=255[v1bgfill]",
				`[v1bgfill]${clipAlphaFilters(faded).join(",")},format=gbrap[v1bgfaded]`,
				"[v1bgcover]format=gbrap[v1bgcoverp]",
				"[v1bgfaded][v1bgcoverp]blend=c0_mode=normal:c1_mode=normal:c2_mode=normal:c3_mode=subtract,premultiply=inplace=1[v1bgrest]",
				"[v1bgfront]format=gbrap,premultiply=inplace=1[v1bgfrontp]",
				"[v1bgrest][v1bgfrontp]blend=all_mode=addition,unpremultiply=inplace=1,format=rgba[v1bg]",
			],
			label: "v1bg",
		});
		const { consumed, produced } = labels(output.filters);
		expect(new Set(produced).size).toBe(produced.length);
		expect(new Set(consumed).size).toBe(consumed.length);
		for (const label of produced.filter((name) => name !== "v1bg")) {
			expect(consumed).toContain(label);
		}
	});

	test("waveform, keyed and masked clips get no project blur", () => {
		const { p, s } = fixture({
			background: { amount: 0.5, dim: 0.25, type: "blur" },
		});
		for (const clip of [
			{ ...s, visualization: "waveform" as const },
			{ ...s, masks: [{ id: "m1" }] } as unknown as Segment,
			{ ...s, key: { type: "chroma" } } as unknown as Segment,
		]) {
			expect(clipBackgroundFilters(clip, p, "v1")).toEqual({
				filters: [],
				label: "v1",
			});
		}
	});

	test("clip-level images cover the clip box under the clip", () => {
		const { p, s } = fixture();
		const pictured = {
			...s,
			background: { assetId: picture.id, type: "image" as const },
		};
		expect(() => clipBackgroundFilters(pictured, p, "v3")).toThrow(
			"media paths"
		);
		const result = clipBackgroundFilters(pictured, p, "v3", {
			mediaPath: (id) => `/media/${id}`,
		});
		expect(result.label).toBe("v3bg");
		const graph = result.filters.join(";");
		expect(graph).toContain(
			`movie=filename=/media/${picture.id},trim=end_frame=1,scale=`
		);
		expect(graph).toContain(":force_original_aspect_ratio=increase,crop=");
		expect(graph).toContain("overlay=x=0:y=0:eof_action=repeat");
	});
});

describe("blurFillFilters", () => {
	test("every pyramid label is written once and read once", () => {
		const filters = blurFillFilters(
			{ amount: 0.5, dim: 0.2, type: "blur" },
			{ height: 1920, width: 1080 },
			"src",
			"fill"
		);
		const { consumed, produced } = labels(filters);
		expect(new Set(produced).size).toBe(produced.length);
		expect(new Set(consumed).size).toBe(consumed.length);
		expect(produced.filter((label) => !consumed.includes(label))).toEqual([
			"fill",
		]);
		expect(consumed.filter((label) => !produced.includes(label))).toEqual([
			"src",
		]);
		expect(filters.at(-1)).toBe(
			"[fillfill0]gblur=sigma=2.666666667,colorchannelmixer=rr=0.8:gg=0.8:bb=0.8,scale=1080:1920:flags=bicubic,format=rgba[fill]"
		);
	});

	test("amount 0 skips the extra blur", () => {
		const filters = blurFillFilters(
			{ amount: 0, dim: 0, type: "blur" },
			{ height: 64, width: 64 },
			"src",
			"out"
		);
		expect(filters.at(-1)).toBe(
			"[outfill0]colorchannelmixer=rr=1:gg=1:bb=1,scale=64:64:flags=bicubic,format=rgba[out]"
		);
	});
});

describe("buildRender", () => {
	test("the clip background feeds the composite", () => {
		const { p, s } = fixture({
			background: { amount: 0.4, dim: 0.1, type: "blur" },
		});
		const args = buildRender(p, [video], () => "/media/clip.mp4");
		const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
		expect(graph).toContain("[v1]split=2[v1bgfront][v1bgsource]");
		expect(graph).toContain("[base][v1bg]overlay=");
		expect(s.track).toBe(0);
	});

	test("an image canvas uses the media path as input 0", () => {
		const { p } = fixture({
			background: { assetId: picture.id, type: "image" },
		});
		const args = buildRender(p, [video, picture], (id) => `/media/${id}`);
		const first = args.indexOf("-i");
		expect(args[first + 1]).toBe(`/media/${picture.id}`);
		expect(args.slice(first - 4, first)).toEqual([
			"-stream_loop",
			"-1",
			"-t",
			"4",
		]);
	});
});
