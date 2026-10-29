import { describe, expect, test } from "bun:test";
import type { Title } from "./project.ts";
import {
	activeWordAt,
	cubicBezier,
	easeProgress,
	glyphGroups,
	glyphOffsetAt,
	glyphVisibleAt,
	MAX_TITLE_EVENT_CHARS,
	MAX_TITLE_EVENT_TIMES,
	MAX_TITLE_EVENTS,
	piecewise,
	planTitleEvents,
	SLIDE_TRAVEL,
	titleEventTimes,
	titleKeyValue,
	titleLayout,
	titleMotionAt,
	titleTimingOf,
	usesGlyphMotion,
	WORD_SLIDE_RISE,
	wordSlideOffset,
} from "./text-animation.ts";

const base: Title = {
	animation: "fade",
	color: "#ffffff",
	end: 4,
	fadeIn: 0,
	fadeOut: 0,
	fontSize: 0.08,
	id: "00000000-0000-4000-8000-000000000001",
	start: 1,
	text: "Hello big world",
	x: 0.5,
	y: 0.5,
};

describe("title timing", () => {
	test("legacy animation runs over fadeIn; explicit animations default to 0.5s", () => {
		const legacy = titleTimingOf({
			...base,
			animation: "slide-up",
			fadeIn: 0.4,
		});
		expect(legacy).toMatchObject({ animationIn: "slide-up", inEnd: 1.4 });
		const pop = titleTimingOf({ ...base, animationIn: "pop" });
		expect(pop.inEnd).toBeCloseTo(1.5);
		expect(pop.outStart).toBe(4);
	});

	test("in and out shrink together to fit the title", () => {
		const timing = titleTimingOf({
			...base,
			animationIn: "zoom-in",
			animationInDuration: 3,
			animationOut: "zoom-out",
			animationOutDuration: 3,
		});
		expect(timing.inEnd).toBeCloseTo(2.5);
		expect(timing.outStart).toBeCloseTo(2.5);
	});
});

describe("title motion", () => {
	test("slides travel 8% toward the anchor and exits continue past it", () => {
		const title: Title = {
			...base,
			animationIn: "slide-left",
			animationInDuration: 1,
			animationOut: "slide-up",
			animationOutDuration: 1,
		};
		expect(titleMotionAt(title, 1).x).toBeCloseTo(0.5 + SLIDE_TRAVEL);
		expect(titleMotionAt(title, 1.5).x).toBeCloseTo(0.5 + SLIDE_TRAVEL / 2);
		expect(titleMotionAt(title, 2.5)).toMatchObject({ x: 0.5, y: 0.5 });
		expect(titleMotionAt(title, 4).y).toBeCloseTo(0.5 - SLIDE_TRAVEL);
	});

	test("pop overshoots then settles; zoom-out shrinks; blur-in clears", () => {
		const pop: Title = { ...base, animationIn: "pop", animationInDuration: 1 };
		expect(titleMotionAt(pop, 1).scale).toBeCloseTo(0.3);
		expect(titleMotionAt(pop, 1.6).scale).toBeCloseTo(1.15);
		expect(titleMotionAt(pop, 2).scale).toBeCloseTo(1);
		const zoom: Title = {
			...base,
			animationOut: "zoom-out",
			animationOutDuration: 1,
		};
		expect(titleMotionAt(zoom, 4).scale).toBeCloseTo(0.3);
		const blur: Title = {
			...base,
			animationIn: "blur-in",
			animationInDuration: 1,
		};
		expect(titleMotionAt(blur, 1).blur).toBeGreaterThan(0);
		expect(titleMotionAt(blur, 2).blur).toBe(0);
	});

	test("bounce starts above and lands at the anchor", () => {
		const title: Title = {
			...base,
			animationIn: "bounce",
			animationInDuration: 1,
		};
		expect(titleMotionAt(title, 1).y).toBeLessThan(0.5);
		expect(titleMotionAt(title, 1.45).y).toBeCloseTo(0.5);
		expect(titleMotionAt(title, 2).y).toBeCloseTo(0.5);
	});

	test("fades multiply keyframed opacity", () => {
		const title: Title = {
			...base,
			fadeIn: 1,
			keyframes: [
				{ id: "k1", property: "opacity", time: 0, value: 0.5 },
				{ id: "k2", property: "opacity", time: 3, value: 0.5 },
			],
		};
		expect(titleMotionAt(title, 1.5).opacity).toBeCloseTo(0.25);
		expect(titleMotionAt(title, 3).opacity).toBeCloseTo(0.5);
	});

	test("loops oscillate only between the in and out phases", () => {
		const title: Title = {
			...base,
			animationIn: "fade",
			animationInDuration: 0.5,
			animationLoop: "wobble",
		};
		expect(titleMotionAt(title, 1.2).rotation).toBe(0);
		expect(Math.abs(titleMotionAt(title, 1.7).rotation)).toBeGreaterThan(1);
		const pulse = { ...title, animationLoop: "pulse" as const };
		expect(titleMotionAt(pulse, 1.75).scale).toBeCloseTo(1.05);
	});
});

describe("title keyframes", () => {
	test("absolute values start from the base and ease between keys", () => {
		const title: Title = {
			...base,
			keyframes: [
				{
					id: "a",
					interpolation: "ease-in",
					property: "x",
					time: 1,
					value: 0.2,
				},
				{ id: "b", property: "x", time: 2, value: 0.8 },
				{
					id: "c",
					interpolation: "hold",
					property: "scale",
					time: 0,
					value: 1,
				},
				{ id: "d", property: "scale", time: 2, value: 2 },
			],
		};
		expect(titleKeyValue(title, "x", 0)).toBe(0.5);
		expect(titleKeyValue(title, "x", 0.5)).toBeCloseTo(0.35);
		expect(titleKeyValue(title, "x", 1.5)).toBeLessThan(0.5);
		expect(titleKeyValue(title, "x", 3)).toBe(0.8);
		expect(titleKeyValue(title, "scale", 1.99)).toBe(1);
		expect(titleKeyValue(title, "scale", 2)).toBe(2);
		expect(titleKeyValue({ ...base, rotation: 12 }, "rotation", 1)).toBe(12);
	});

	test("easing curves", () => {
		expect(easeProgress(undefined, 0.3)).toBe(0.3);
		expect(easeProgress("hold", 0.9)).toBe(0);
		expect(easeProgress("ease-in", 0.5)).toBeLessThan(0.5);
		expect(easeProgress("ease-out", 0.5)).toBeGreaterThan(0.5);
		expect(cubicBezier(0.42, 0, 0.58, 1, 0.5)).toBeCloseTo(0.5);
		expect(easeProgress("bezier", 0.5, [0, 0, 1, 1])).toBeCloseTo(0.5);
		expect(
			piecewise(
				[
					[0, 1],
					[1, 3],
				],
				2
			)
		).toBe(3);
	});
});

describe("text units", () => {
	test("layout splits rows, glyphs, and words", () => {
		const layout = titleLayout("ab c\nde");
		expect(layout.count).toBe(6);
		expect(layout.words).toBe(3);
		expect(layout.rows[1]?.map((glyph) => [glyph.char, glyph.word])).toEqual([
			["d", 2],
			["e", 2],
		]);
		expect(layout.rows[0]?.[2]?.word).toBe(-1);
	});

	test("typewriter reveals characters and word-reveal reveals words", () => {
		const typed = titleTimingOf({
			...base,
			animationIn: "typewriter",
			animationInDuration: 1.5,
		});
		const layout = titleLayout(base.text);
		const glyphs = layout.rows[0] ?? [];
		const visible = (t: number) =>
			glyphs.filter((glyph) => glyphVisibleAt(typed, layout, glyph, t)).length;
		expect(visible(1)).toBe(1);
		expect(visible(1.75)).toBe(8);
		expect(visible(2.5)).toBe(15);
		const words = titleTimingOf({
			...base,
			animationIn: "word-reveal",
			animationInDuration: 1.5,
		});
		const third = glyphs.at(-1);
		expect(third && glyphVisibleAt(words, layout, third, 1.9)).toBe(false);
		expect(third && glyphVisibleAt(words, layout, third, 2)).toBe(true);
	});

	test("word-highlight walks through every word before the out phase", () => {
		const timing = titleTimingOf({ ...base, animationIn: "word-highlight" });
		const layout = titleLayout(base.text);
		expect(activeWordAt(timing, layout, 1)).toBe(0);
		expect(activeWordAt(timing, layout, 2.5)).toBe(1);
		expect(activeWordAt(timing, layout, 3.99)).toBe(2);
		expect(activeWordAt(timing, layout, 4)).toBeNull();
	});

	test("wave offsets glyphs in sequence", () => {
		const timing = titleTimingOf({
			...base,
			animationIn: "wave",
			animationInDuration: 1,
			animationLoop: "wave",
		});
		expect(usesGlyphMotion(timing)).toBe(true);
		const layout = titleLayout(base.text);
		const [first, , , , , , , , , , , , , , last] = layout.rows[0] ?? [];
		if (!(first && last)) {
			throw new Error("glyphs missing");
		}
		expect(glyphOffsetAt(timing, layout, first, 1.15)).toBeLessThan(0);
		expect(glyphOffsetAt(timing, layout, last, 1.15)).toBe(0);
		expect(glyphOffsetAt(timing, layout, first, 2.5)).not.toBe(
			glyphOffsetAt(timing, layout, last, 2.5)
		);
	});
});

describe("event times", () => {
	test("static styled titles split only at fades", () => {
		expect(
			titleEventTimes({ ...base, fadeIn: 0.25, fadeOut: 0.5 }, 30)
		).toEqual([1, 1.25, 3.5, 4]);
	});

	test("pop knots, reveal steps, and eased keyframes add boundaries", () => {
		const pop = titleEventTimes(
			{ ...base, animationIn: "pop", animationInDuration: 1 },
			30
		);
		expect(pop).toEqual([1, 1.6, 2, 4]);
		const typed = titleEventTimes(
			{ ...base, animationIn: "typewriter", animationInDuration: 1.5 },
			30
		);
		// 14 character steps plus the start, the end of typing, and the end.
		expect(typed).toHaveLength(17);
		const eased = titleEventTimes(
			{
				...base,
				keyframes: [
					{
						id: "a",
						interpolation: "ease-in-out",
						property: "y",
						time: 0,
						value: 0.2,
					},
					{ id: "b", property: "y", time: 1, value: 0.8 },
				],
			},
			30
		);
		expect(eased.length).toBeGreaterThan(10);
		expect(
			eased.every(
				(time, index) => index === 0 || time > (eased[index - 1] ?? 0)
			)
		).toBe(true);
	});

	test("long loops stay bounded", () => {
		const times = titleEventTimes(
			{ ...base, animationLoop: "wave", end: 600, start: 0 },
			60
		);
		expect(times.length).toBeLessThanOrEqual(MAX_TITLE_EVENT_TIMES);
		expect(times[0]).toBe(0);
		expect(times.at(-1)).toBe(600);
	});
});

describe("event budget", () => {
	const times = (count: number) =>
		Array.from({ length: count }, (_, index) => index / 10);
	const cost = { boxChars: 0, boxLines: 0, passes: 2 };

	test("glyph groups skip whitespace and cut consecutive runs", () => {
		const [row = []] = titleLayout("ab cde").rows;
		expect(
			glyphGroups(row, 2).map((group) => group.map((g) => g.char).join(""))
		).toEqual(["ab ", "cd", "e"]);
		expect(glyphGroups(row, 1)).toHaveLength(5);
		const [padded = []] = titleLayout("  a b  ").rows;
		expect(
			glyphGroups(padded, 1).map((group) => group.map((g) => g.char).join(""))
		).toEqual(["  a ", "b  "]);
		const [blank = []] = titleLayout("   ").rows;
		expect(glyphGroups(blank, 3)).toEqual([]);
	});

	test("small titles keep exact per-glyph motion and every boundary", () => {
		const plan = planTitleEvents(titleLayout("Hello"), times(100), true, cost);
		expect(plan).toEqual({ glyphGroup: 1, times: times(100) });
	});

	test("long per-glyph titles group glyphs to fit the budget", () => {
		const layout = titleLayout("x".repeat(499));
		const plan = planTitleEvents(layout, times(400), true, cost);
		const intervals = plan.times.length - 1;
		const groups = Math.ceil(499 / plan.glyphGroup);
		expect(groups * 2 * intervals).toBeLessThanOrEqual(MAX_TITLE_EVENTS);
		expect(groups * (499 + 64) * 2 * intervals).toBeLessThanOrEqual(
			MAX_TITLE_EVENT_CHARS
		);
		expect(plan.times[0]).toBe(0);
		expect(plan.times.at(-1)).toBe(39.9);
	});

	test("many rows thin the boundaries when whole rows still do not fit", () => {
		const layout = titleLayout(
			Array.from({ length: 200 }, () => "a").join("\n")
		);
		const plan = planTitleEvents(layout, times(400), false, {
			boxChars: 200,
			boxLines: 200,
			passes: 2,
		});
		expect(plan.times.length - 1).toBeLessThanOrEqual(
			Math.floor(MAX_TITLE_EVENTS / 600)
		);
		expect(plan.times[0]).toBe(0);
		expect(plan.times.at(-1)).toBe(39.9);
	});

	test("plans are deterministic", () => {
		const layout = titleLayout("y".repeat(300));
		expect(planTitleEvents(layout, times(300), true, cost)).toEqual(
			planTitleEvents(layout, times(300), true, cost)
		);
	});
});

describe("word slide and word highlight block", () => {
	test("word slide reveals words in turn and raises each into place", () => {
		const title: Title = {
			...base,
			animationIn: "word-slide",
			animationInDuration: 1.5,
		};
		const timing = titleTimingOf(title);
		const layout = titleLayout(title.text);
		expect(usesGlyphMotion(timing)).toBe(true);
		const [hello] = layout.rows[0] ?? [];
		const world = layout.rows[0]?.find((glyph) => glyph.word === 2);
		expect(hello && glyphVisibleAt(timing, layout, hello, 1)).toBe(true);
		expect(world && glyphVisibleAt(timing, layout, world, 1.9)).toBe(false);
		expect(world && glyphVisibleAt(timing, layout, world, 2.01)).toBe(true);
		// Word 0 starts a full rise below its place and settles after 2/3 s.
		expect(wordSlideOffset(timing, layout, 0, 1)).toBeCloseTo(
			WORD_SLIDE_RISE,
			9
		);
		expect(wordSlideOffset(timing, layout, 0, 2)).toBe(0);
		expect(hello && glyphOffsetAt(timing, layout, hello, 1.25)).toBeGreaterThan(
			0
		);
		// Event times sample the motion, not only the reveal boundaries.
		expect(titleEventTimes(title, 30).length).toBeGreaterThan(10);
	});

	test("word highlight block steps through the words like word highlight", () => {
		const title: Title = { ...base, animationIn: "word-highlight-block" };
		const timing = titleTimingOf(title);
		const layout = titleLayout(title.text);
		expect(activeWordAt(timing, layout, 1.1)).toBe(0);
		expect(activeWordAt(timing, layout, 3.9)).toBe(2);
		expect(usesGlyphMotion(timing)).toBe(false);
	});
});
