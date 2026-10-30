import { describe, expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	newSegment,
	type Segment,
} from "../../../shared/project.ts";
import { buildRender } from "../render.ts";
import {
	BLUR_STEPS,
	blurFilters,
	entryOffset,
	entryScale,
	fadeFilters,
	revealFilters,
} from "./transitions.ts";

const video: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 10,
	hasAudio: false,
	height: 1080,
	id: "00000000-0000-4000-8000-000000000001",
	kind: "video",
	name: "Clip",
	width: 1920,
};
const clip = (patch: Partial<Segment> = {}): Segment => ({
	...newSegment(video, 2),
	sourceOut: 4,
	...patch,
});

describe("transition render stage", () => {
	test("clips without W2-V10 fields keep the legacy strings", () => {
		const legacy = clip({ entryDuration: 1, entryTransition: "zoom-in" });
		expect(revealFilters(legacy, undefined, 4)).toEqual([]);
		expect(entryScale(legacy)).toBe("(0.85+0.15*clip(((t-2)+0)/1,0,1))");
		expect(entryOffset(clip({ entryTransition: "slide-left" }), "x")).toBe(
			"1*(1-clip(((t-2)+0)/0.5,0,1))"
		);
		expect(entryOffset(clip(), "y")).toBe("0");
		expect(fadeFilters(clip({ fadeIn: 1 }), 4)).toEqual([
			"fade=t=in:st=0:d=1:alpha=1",
		]);
	});

	test("a shaped reveal is a per-pixel alpha limited to its window", () => {
		const filters = revealFilters(
			clip({ transitionIn: { duration: 0.8, softness: 0, type: "wipe-left" } }),
			undefined,
			4
		);
		expect(filters).toHaveLength(1);
		expect(filters[0]).toStartWith(
			"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip("
		);
		expect(filters[0]).toContain("(X/W)");
		expect(filters[0]).toEndWith(":enable='between(t,0,0.8)'");
	});

	test("fades through a color tint the RGB channels", () => {
		const [filter] = revealFilters(
			clip({ transitionIn: { duration: 1, softness: 0, type: "fade-white" } }),
			undefined,
			4
		);
		expect(filter).toContain("r='r(X,Y)*(1-");
		expect(filter).toContain("+255*");
	});

	test("dissolves fold into one whole-frame alpha with the animation", () => {
		const filters = revealFilters(
			clip({
				animation: { in: "fade", inDuration: 0.5 },
				transitionIn: { duration: 1, softness: 0, type: "dissolve" },
			}),
			undefined,
			4
		);
		expect(filters).toHaveLength(1);
		expect(filters[0]).toContain(":enable='between(t,0,0.5)+between(t,0,1)'");
	});

	test("blur ramps step through enabled gblur filters", () => {
		const filters = revealFilters(
			clip({ transitionIn: { duration: 1, softness: 0, type: "blur" } }),
			undefined,
			4
		);
		const blurs = filters.filter((filter) => filter.startsWith("gblur="));
		expect(blurs).toHaveLength(BLUR_STEPS);
		expect(blurs[0]).toContain(":enable='between(t,0,0.125)'");
		const sigmas = blurs.map((filter) =>
			Number(/sigma=([\d.]+)/.exec(filter)?.[1])
		);
		expect(sigmas).toEqual([...sigmas].sort((a, b) => b - a));
		// Overlapping blur windows are merged, never blurred twice.
		const both = revealFilters(
			clip({
				animation: { in: "blur", inDuration: 0.5 },
				transitionIn: { duration: 1, softness: 0, type: "blur" },
			}),
			undefined,
			4
		).filter((filter) => filter.startsWith("gblur="));
		expect(both).toHaveLength(BLUR_STEPS);
		// Sigmas follow the frame height.
		const [small] = blurFilters(
			clip({ transitionIn: { duration: 1, softness: 0, type: "blur" } }),
			4,
			540
		);
		expect(Number(/sigma=([\d.]+)/.exec(small ?? "")?.[1])).toBeCloseTo(
			(sigmas[0] ?? 0) / 2
		);
	});

	test("spins and wobbles rotate inside the clip frame", () => {
		const filters = revealFilters(
			clip({ animation: { loop: "wobble" } }),
			undefined,
			4
		);
		expect(filters).toEqual([
			expect.stringMatching(
				/^rotate=a='.*sin\(.*t.*':ow=iw:oh=ih:fillcolor=black@0$/
			),
		]);
	});

	test("zoom, exits and animations multiply into the entry scale on clip time", () => {
		const scale = entryScale(
			clip({
				entryDuration: 1,
				entryTransition: "zoom-in",
				transitionIn: { duration: 1, softness: 0, type: "zoom" },
			})
		);
		expect(scale).toStartWith("(0.85+0.15*clip(((t-2)+0)/1,0,1))*");
		expect(scale).toContain("(0.6+(0.4*(clip(t,0,1)");
		expect(entryScale(clip({ animation: { in: "fade" } }))).toBe("1");
	});

	test("slides, pushes and exits add offsets on timeline time", () => {
		const offset = entryOffset(
			clip({ transitionIn: { duration: 1, softness: 0, type: "push-left" } }),
			"x"
		);
		expect(offset).toContain("(t-2)");
		expect(offset).not.toContain("T");
		const exit = entryOffset(
			clip({ exitDuration: 1, exitTransition: "slide-down" }),
			"y"
		);
		expect(exit).toContain("(4-(t-2))");
		expect(entryOffset(clip({ exitTransition: "crossfade" }), "x")).toBe("0");
	});

	test("fading exits append a fade-out over the exit window", () => {
		expect(
			fadeFilters(clip({ exitDuration: 1.5, exitTransition: "crossfade" }), 4)
		).toEqual(["fade=t=out:st=2.5:d=1.5:alpha=1"]);
		expect(fadeFilters(clip({ exitTransition: "slide-left" }), 4)).toEqual([]);
	});

	test("the graph wires every stage into the clip chain", () => {
		const outgoing = { ...newSegment(video, 0), sourceOut: 3 };
		const incoming = clip({
			animation: { loop: "spin" },
			sourceIn: 1,
			start: 2,
			transitionIn: { duration: 1, softness: 0.2, type: "circle-open" },
		});
		const args = buildRender(
			{ ...newProject("Reveal graph"), segments: [outgoing, incoming] },
			[video],
			(id) => `/media/${id}`
		);
		const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
		expect(graph).toContain("rotate=a='((360*t))*PI/180'");
		expect(graph).toContain("hypot(");
		expect(graph).toContain(":enable='between(t,0,1)',setpts=PTS+2/TB");
	});
});
