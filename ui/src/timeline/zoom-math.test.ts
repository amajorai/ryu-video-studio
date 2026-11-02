import { describe, expect, test } from "bun:test";
import {
	anchoredScrollLeft,
	clampZoom,
	fitZoom,
	MAX_RULER_TICKS,
	MAX_ZOOM_PX_PER_SEC,
	MIN_LABEL_SPACING_PX,
	MIN_ZOOM_PX_PER_SEC,
	rulerLabel,
	rulerScale,
	rulerTicks,
	sliderToZoom,
	stepZoom,
	timeAtViewportX,
	WHEEL_DELTA_LINE,
	WHEEL_DELTA_PAGE,
	wheelDeltaPx,
	wheelZoom,
	zoomToSlider,
} from "./zoom-math.ts";

describe("zoom range and slider", () => {
	test("clamps to 5..600 px/s", () => {
		expect(clampZoom(1)).toBe(MIN_ZOOM_PX_PER_SEC);
		expect(clampZoom(10_000)).toBe(MAX_ZOOM_PX_PER_SEC);
		expect(clampZoom(70)).toBe(70);
		expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM_PX_PER_SEC);
	});

	test("the slider is logarithmic and round-trips", () => {
		expect(zoomToSlider(5)).toBe(0);
		expect(zoomToSlider(600)).toBeCloseTo(1, 12);
		expect(sliderToZoom(0)).toBe(5);
		expect(sliderToZoom(1)).toBe(600);
		// The geometric midpoint sits at the slider midpoint.
		expect(sliderToZoom(0.5)).toBeCloseTo(Math.sqrt(5 * 600), 1);
		for (const zoom of [5, 20, 70, 120, 600]) {
			expect(sliderToZoom(zoomToSlider(zoom))).toBeCloseTo(zoom, 1);
		}
		expect(sliderToZoom(-1)).toBe(5);
		expect(sliderToZoom(2)).toBe(600);
	});

	test("keyboard steps multiply and stay in range", () => {
		expect(stepZoom(80, 1)).toBe(100);
		expect(stepZoom(100, -1)).toBe(80);
		expect(stepZoom(590, 1)).toBe(600);
		expect(stepZoom(5, -1)).toBe(5);
	});
});

describe("wheel zoom", () => {
	test("scrolling up zooms in, down zooms out", () => {
		expect(wheelZoom(100, -100)).toBeGreaterThan(100);
		expect(wheelZoom(100, 100)).toBeLessThan(100);
		expect(wheelZoom(100, 0)).toBe(100);
	});

	test("opposite deltas cancel out", () => {
		expect(wheelZoom(wheelZoom(100, -40), 40)).toBeCloseTo(100, 1);
	});

	test("one event never more than doubles or halves the zoom", () => {
		expect(wheelZoom(100, -100_000)).toBe(200);
		expect(wheelZoom(100, 100_000)).toBe(50);
	});

	test("line and page deltas are converted to pixels", () => {
		expect(wheelDeltaPx(3, WHEEL_DELTA_LINE)).toBe(48);
		expect(wheelDeltaPx(1, WHEEL_DELTA_PAGE)).toBe(800);
		expect(wheelDeltaPx(5, 0)).toBe(5);
		expect(wheelZoom(100, -3, WHEEL_DELTA_LINE)).toBe(wheelZoom(100, -48));
	});
});

describe("zoom anchor", () => {
	const lanesOffset = 192;

	test("keeps the time under the pointer fixed when zooming", () => {
		const scrollLeft = 300;
		const viewportX = 500;
		const zoom = 70;
		const time = timeAtViewportX({ lanesOffset, scrollLeft, viewportX, zoom });
		for (const next of [5, 35, 140, 600]) {
			const nextScroll = anchoredScrollLeft({
				anchorTime: time,
				lanesOffset,
				viewportX,
				zoom: next,
			});
			if (nextScroll > 0) {
				expect(
					timeAtViewportX({
						lanesOffset,
						scrollLeft: nextScroll,
						viewportX,
						zoom: next,
					})
				).toBeCloseTo(time, 9);
			}
		}
	});

	test("anchoring is the identity at an unchanged zoom", () => {
		const time = timeAtViewportX({
			lanesOffset,
			scrollLeft: 1234,
			viewportX: 321,
			zoom: 90,
		});
		expect(
			anchoredScrollLeft({
				anchorTime: time,
				lanesOffset,
				viewportX: 321,
				zoom: 90,
			})
		).toBeCloseTo(1234, 9);
	});

	test("never scrolls before the start", () => {
		expect(
			anchoredScrollLeft({
				anchorTime: 0.5,
				lanesOffset,
				viewportX: 600,
				zoom: 10,
			})
		).toBe(0);
		expect(
			timeAtViewportX({ lanesOffset, scrollLeft: 0, viewportX: 10, zoom: 70 })
		).toBe(0);
	});
});

describe("zoom to fit", () => {
	test("fits the duration with a margin", () => {
		const zoom = fitZoom(60, 1000);
		expect(zoom * 60).toBeLessThanOrEqual(1000);
		expect(zoom * 60).toBeGreaterThan(900);
	});

	test("clamps very long and very short timelines", () => {
		expect(fitZoom(100_000, 800)).toBe(MIN_ZOOM_PX_PER_SEC);
		expect(fitZoom(0.01, 800)).toBe(MAX_ZOOM_PX_PER_SEC);
	});

	test("an empty timeline or viewport still gives a valid zoom", () => {
		expect(fitZoom(0, 800)).toBe(80);
		expect(fitZoom(10, 0)).toBe(MIN_ZOOM_PX_PER_SEC);
	});
});

describe("ruler ticks", () => {
	test("labels stay at least the minimum spacing apart at every zoom", () => {
		for (const fps of [24, 29.97, 30, 60]) {
			for (const zoom of [5, 13, 70, 200, 600]) {
				const scale = rulerScale(zoom, fps);
				expect(scale.major * zoom).toBeGreaterThanOrEqual(
					MIN_LABEL_SPACING_PX - 1e-9
				);
				expect(scale.major / scale.minor).toBeCloseTo(scale.subdivisions, 9);
			}
		}
	});

	test("uses frame intervals when zoomed in and seconds when zoomed out", () => {
		const close = rulerScale(600, 30);
		expect(close.unit).toBe("frames");
		// 5 frames at 30 fps is 100 px at 600 px/s.
		expect(close.major).toBeCloseTo(5 / 30, 12);
		expect(close.subdivisions).toBe(5);
		const far = rulerScale(5, 30);
		expect(far.unit).toBe("seconds");
		expect(far.major).toBe(15);
		expect(rulerScale(70, 30)).toMatchObject({ major: 2, unit: "seconds" });
	});

	test("frame majors subdivide only into whole frames", () => {
		for (const zoom of [300, 450, 600]) {
			const scale = rulerScale(zoom, 24);
			if (scale.unit === "frames") {
				expect((scale.minor * 24) % 1).toBeCloseTo(0, 9);
			}
		}
	});

	test("ticks cover the window and majors are labelled", () => {
		const { scale, ticks } = rulerTicks({
			endTime: 10,
			fps: 30,
			startTime: 4,
			zoom: 70,
		});
		expect(ticks[0]?.time).toBeLessThanOrEqual(4);
		expect(ticks.at(-1)?.time).toBeGreaterThanOrEqual(10);
		for (const tick of ticks) {
			expect(tick.x).toBeCloseTo(tick.time * 70, 9);
			expect(Boolean(tick.label)).toBe(tick.major);
		}
		const majors = ticks.filter((tick) => tick.major).map((tick) => tick.label);
		expect(majors).toEqual(["0:04", "0:06", "0:08", "0:10"]);
		expect(scale.major).toBe(2);
	});

	test("ticks never drift on long timelines", () => {
		const { ticks } = rulerTicks({
			endTime: 7201,
			fps: 30,
			startTime: 7190,
			zoom: 70,
		});
		const majors = ticks.filter((tick) => tick.major);
		for (const tick of majors) {
			expect(Number.isInteger(tick.time)).toBe(true);
		}
		expect(majors.at(-1)?.label).toBe("2:00:00");
	});

	test("the tick count is capped and empty windows have none", () => {
		const { ticks } = rulerTicks({
			endTime: 1_000_000,
			fps: 30,
			startTime: 0,
			zoom: 600,
		});
		expect(ticks.length).toBe(MAX_RULER_TICKS);
		expect(
			rulerTicks({ endTime: 1, fps: 30, startTime: 1, zoom: 70 }).ticks
		).toEqual([]);
	});

	test("labels format frames, minutes, and hours", () => {
		expect(rulerLabel(1.5, "frames", 30)).toBe("0:01:15");
		expect(rulerLabel(65, "seconds", 30)).toBe("1:05");
		expect(rulerLabel(3725, "seconds", 30)).toBe("1:02:05");
		expect(rulerLabel(30 / 29.97, "frames", 29.97)).toBe("0:01:00");
	});
});
