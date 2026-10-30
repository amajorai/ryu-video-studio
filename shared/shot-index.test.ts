import { describe, expect, test } from "bun:test";
import {
	colorName,
	dominantColors,
	frameStats,
	MAX_RAW_SHOT_RANGES,
	MAX_SHOTS,
	motionEnergy,
	parseShotQuery,
	SHOT_FRAME_BYTES,
	SHOT_FRAME_HEIGHT,
	SHOT_FRAME_WIDTH,
	SHOT_THRESHOLDS,
	type ShotColorName,
	type ShotIndex,
	type ShotStats,
	searchShots,
	shotIndexSchema,
	shotLabels,
	shotRanges,
	shotSampleRate,
	shotStatsFromFrames,
} from "./shot-index.ts";

type Rgb = [number, number, number];

function solid([red, green, blue]: Rgb): Uint8Array {
	const frame = new Uint8Array(SHOT_FRAME_BYTES);
	for (let pixel = 0; pixel < SHOT_FRAME_BYTES / 3; pixel++) {
		frame[pixel * 3] = red;
		frame[pixel * 3 + 1] = green;
		frame[pixel * 3 + 2] = blue;
	}
	return frame;
}

/** Black and white one-pixel checkerboard: maximum edge density. */
function checker(offset = 0): Uint8Array {
	const frame = new Uint8Array(SHOT_FRAME_BYTES);
	for (let y = 0; y < SHOT_FRAME_HEIGHT; y++) {
		for (let x = 0; x < SHOT_FRAME_WIDTH; x++) {
			const value = (x + y + offset) % 2 ? 255 : 0;
			frame.fill(
				value,
				(y * SHOT_FRAME_WIDTH + x) * 3,
				(y * SHOT_FRAME_WIDTH + x) * 3 + 3
			);
		}
	}
	return frame;
}

/** Left half one color, right half another. */
function split(left: Rgb, right: Rgb, leftColumns = SHOT_FRAME_WIDTH / 2) {
	const frame = new Uint8Array(SHOT_FRAME_BYTES);
	for (let y = 0; y < SHOT_FRAME_HEIGHT; y++) {
		for (let x = 0; x < SHOT_FRAME_WIDTH; x++) {
			frame.set(x < leftColumns ? left : right, (y * SHOT_FRAME_WIDTH + x) * 3);
		}
	}
	return frame;
}

describe("color naming", () => {
	test.each([
		[[0, 0, 0], "black"],
		[[255, 255, 255], "white"],
		[[128, 128, 128], "gray"],
		[[40, 40, 44], "black"],
		[[220, 30, 30], "red"],
		[[240, 140, 20], "orange"],
		[[110, 60, 20], "brown"],
		[[240, 220, 30], "yellow"],
		[[30, 180, 60], "green"],
		[[20, 180, 180], "teal"],
		[[30, 60, 220], "blue"],
		[[20, 30, 90], "blue"],
		[[130, 40, 200], "purple"],
		[[230, 60, 160], "pink"],
		[[255, 190, 200], "pink"],
	] as [Rgb, ShotColorName][])("%p is %s", (rgb, name) => {
		expect(colorName(rgb)).toBe(name);
	});
});

describe("dominant colors", () => {
	test("k-means separates a two-color frame by pixel share", () => {
		const colors = dominantColors(split([20, 40, 200], [240, 200, 20], 24));
		const named = new Map<string, number>();
		for (const color of colors) {
			named.set(color.name, (named.get(color.name) ?? 0) + color.weight);
		}
		expect(named.get("blue")).toBeCloseTo(0.75, 3);
		expect(named.get("yellow")).toBeCloseTo(0.25, 3);
		expect(colors[0]?.name).toBe("blue");
		expect(
			colors.reduce((total, color) => total + color.weight, 0)
		).toBeCloseTo(1, 3);
	});

	test("is deterministic and drops empty clusters", () => {
		const frame = split([200, 30, 30], [30, 200, 30]);
		expect(dominantColors(frame)).toEqual(dominantColors(frame));
		expect(dominantColors(solid([10, 10, 10]))).toHaveLength(1);
		expect(dominantColors(new Uint8Array(0))).toEqual([]);
	});
});

describe("frame measurements", () => {
	test("brightness, saturation and edge density", () => {
		const black = frameStats(solid([0, 0, 0]));
		expect(black).toEqual({ brightness: 0, edgeDensity: 0, saturation: 0 });
		const red = frameStats(solid([255, 0, 0]));
		expect(red.saturation).toBe(1);
		expect(red.brightness).toBeCloseTo(0.2126, 4);
		expect(frameStats(checker()).edgeDensity).toBe(1);
		expect(() => frameStats(new Uint8Array(10))).toThrow();
	});

	test("motion energy is the mean absolute luma change", () => {
		expect(motionEnergy([solid([0, 0, 0])])).toBe(0);
		expect(motionEnergy([solid([50, 50, 50]), solid([50, 50, 50])])).toBe(0);
		expect(
			motionEnergy([solid([0, 0, 0]), solid([255, 255, 255])])
		).toBeCloseTo(1, 6);
		expect(motionEnergy([checker(0), checker(1)])).toBeCloseTo(1, 6);
	});
});

describe("label thresholds", () => {
	const base: Pick<
		ShotStats,
		| "brightness"
		| "colors"
		| "edgeDensity"
		| "end"
		| "motion"
		| "saturation"
		| "start"
	> = {
		brightness: 0.45,
		colors: [],
		edgeDensity: 0.15,
		end: 5,
		motion: 0.02,
		saturation: 0.3,
		start: 0,
	};

	test("a neutral middle shot has no descriptive labels", () => {
		expect(shotLabels(base)).toEqual([]);
	});

	test("each threshold is inclusive on its labelled side", () => {
		const t = SHOT_THRESHOLDS;
		expect(shotLabels({ ...base, brightness: t.bright })).toContain("bright");
		expect(shotLabels({ ...base, brightness: t.bright - 0.001 })).not.toContain(
			"bright"
		);
		expect(shotLabels({ ...base, brightness: t.dark })).toContain("dark");
		expect(shotLabels({ ...base, brightness: t.dark + 0.001 })).not.toContain(
			"dark"
		);
		expect(shotLabels({ ...base, saturation: t.vivid })).toContain("vivid");
		expect(shotLabels({ ...base, saturation: t.muted })).toContain("muted");
		expect(
			shotLabels({ ...base, edgeDensity: t.closeUpEdges - 0.001 })
		).toContain("close-up");
		expect(shotLabels({ ...base, edgeDensity: t.closeUpEdges })).not.toContain(
			"close-up"
		);
		expect(shotLabels({ ...base, edgeDensity: t.wideEdges })).toContain("wide");
		expect(shotLabels({ ...base, motion: t.static - 0.001 })).toContain(
			"static"
		);
		expect(shotLabels({ ...base, motion: t.static })).not.toContain("static");
		expect(shotLabels({ ...base, motion: t.motion })).toContain("motion");
		expect(shotLabels({ ...base, end: t.shortSeconds - 0.01 })).toContain(
			"short"
		);
		expect(shotLabels({ ...base, end: t.longSeconds })).toContain("long");
	});

	test("colors need a minimum share and merge clusters with one name", () => {
		const labels = shotLabels({
			...base,
			colors: [
				{ hex: "#1020c0", name: "blue", weight: 0.1 },
				{ hex: "#2030e0", name: "blue", weight: 0.1 },
				{ hex: "#c02020", name: "red", weight: 0.14 },
			],
		});
		expect(labels).toContain("blue");
		expect(labels).not.toContain("red");
	});
});

describe("shot ranges", () => {
	test("cuts become ordered, deduplicated ranges covering the source", () => {
		expect(shotRanges([4, 2, 2, 0, 10, 12], 10)).toEqual([
			{ start: 0, end: 2 },
			{ start: 2, end: 4 },
			{ start: 4, end: 10 },
		]);
		expect(shotRanges([], 3)).toEqual([{ start: 0, end: 3 }]);
		expect(shotRanges([3, 3.04, 6, 8.9], 9)).toEqual([
			{ start: 0, end: 3 },
			{ start: 3, end: 6 },
			{ start: 6, end: 9 },
		]);
		expect(shotRanges([1], 0)).toEqual([]);
	});

	test("raw ranges are bounded by the scene-cut cap, not the shot cap", () => {
		const cuts = Array.from({ length: 450 }, (_, index) => (index + 1) * 0.5);
		expect(shotRanges(cuts, 300)).toHaveLength(451);
		const tooMany = Array.from(
			{ length: MAX_RAW_SHOT_RANGES },
			(_, index) => index + 1
		);
		expect(() => shotRanges(tooMany, MAX_RAW_SHOT_RANGES + 2)).toThrow(
			String(MAX_RAW_SHOT_RANGES)
		);
	});

	test("sample rate thins long sources", () => {
		expect(shotSampleRate(60)).toBe(4);
		expect(shotSampleRate(7200)).toBeCloseTo(1.666, 3);
		expect(shotSampleRate(0)).toBe(4);
	});
});

describe("stats from frames", () => {
	const frames = [
		...Array.from({ length: 8 }, () => solid([15, 25, 110])),
		...Array.from({ length: 8 }, (_, index) => checker(index)),
		solid([250, 250, 250]),
	];
	const shots = shotStatsFromFrames(frames, 4, [
		{ start: 0, end: 2 },
		{ start: 2, end: 4 },
		{ start: 4, end: 4.1 },
	]);

	test("frames map to shots by sample time", () => {
		expect(shots).toHaveLength(3);
		const [dark, busy, flash] = shots;
		expect(dark?.labels).toEqual(
			expect.arrayContaining(["dark", "close-up", "static", "blue"])
		);
		expect(busy?.labels).toEqual(
			expect.arrayContaining(["wide", "motion", "black", "white"])
		);
		expect(busy?.motion).toBeCloseTo(1, 4);
		expect(flash?.labels).toEqual(
			expect.arrayContaining(["bright", "white", "short"])
		);
	});

	test("results fit the stored schema", () => {
		const index: ShotIndex = {
			format: "ryu.video-studio.shots.v1",
			assetId: crypto.randomUUID(),
			analysisCreatedAt: new Date().toISOString(),
			revision: 0,
			sampleRate: 4,
			shots,
			updatedAt: new Date().toISOString(),
		};
		expect(shotIndexSchema.parse(index)).toEqual(index);
	});

	test("flicker cuts inside one continuous shot merge back", () => {
		const orange = Array.from({ length: 12 }, (_, index) =>
			split([250, 120, 0], [70, 25, 0], 20 + (index % 3))
		);
		const ranges = [
			{ start: 0, end: 1 },
			{ start: 1, end: 1.5 },
			{ start: 1.5, end: 3 },
		];
		const merged = shotStatsFromFrames(orange, 4, ranges);
		expect(merged.map((shot) => [shot.start, shot.end])).toEqual([[0, 3]]);
		expect(
			shotStatsFromFrames(orange, 4, ranges, { merge: false })
		).toHaveLength(3);
		const cut = shotStatsFromFrames(
			[
				...orange.slice(0, 4),
				...Array.from({ length: 4 }, () => solid([20, 40, 200])),
			],
			4,
			[
				{ start: 0, end: 1 },
				{ start: 1, end: 2 },
			]
		);
		expect(cut).toHaveLength(2);
	});

	test("a merged shot measures the same as its range measured directly", () => {
		const frames = Array.from({ length: 12 }, (_, index) =>
			split([250, 120, 0], [70, 25, 0], 20 + (index % 3))
		);
		const [merged] = shotStatsFromFrames(frames, 4, [
			{ start: 0, end: 1 },
			{ start: 1, end: 1.5 },
			{ start: 1.5, end: 3 },
		]);
		const [direct] = shotStatsFromFrames(frames, 4, [{ start: 0, end: 3 }], {
			merge: false,
		});
		expect(merged).toEqual(direct as ShotStats);
		expect(direct?.motion).toBeCloseTo(motionEnergy(frames), 4);
	});

	test("more than 400 raw cuts that merge below the cap succeed", () => {
		const frames = Array.from({ length: 1201 }, () => solid([40, 60, 160]));
		const cuts = Array.from({ length: 450 }, (_, index) => (index + 1) * 0.5);
		const shots = shotStatsFromFrames(frames, 4, shotRanges(cuts, 300));
		expect(shots.map((shot) => [shot.start, shot.end])).toEqual([[0, 300]]);
	});

	test("more than 400 distinct shots after merging are refused", () => {
		const palette: Rgb[] = [
			[230, 30, 30],
			[20, 20, 200],
		];
		const frames = Array.from({ length: 1604 }, (_, index) =>
			solid(palette[Math.floor(index / 4) % 2] ?? [0, 0, 0])
		);
		const cuts = Array.from({ length: MAX_SHOTS }, (_, index) => index + 1);
		expect(() =>
			shotStatsFromFrames(frames, 4, shotRanges(cuts, MAX_SHOTS + 1))
		).toThrow(`${MAX_SHOTS + 1} distinct shots`);
	});

	test("merging many continuous shots stays linear in frames", () => {
		// The review repro: a 2 h source at the thinned rate, 400 mergeable
		// shots over 12,000 near-uniform frames. Re-measuring every merge from
		// the shot start made this take ~30 s; prefix sums keep it well under 2 s.
		const rate = shotSampleRate(7200);
		const frames = Array.from({ length: 11_996 }, (_, index) =>
			solid([100 + (index % 3), 110, 120])
		);
		const cuts = Array.from({ length: 399 }, (_, index) => (index + 1) * 18);
		const started = performance.now();
		const shots = shotStatsFromFrames(frames, rate, shotRanges(cuts, 7200));
		const elapsed = performance.now() - started;
		expect(shots).toHaveLength(1);
		expect(elapsed).toBeLessThan(2000);
	});

	test("single-frame shots carry no motion label", () => {
		const [single] = shotStatsFromFrames([solid([90, 90, 90])], 4, [
			{ start: 0, end: 0.25 },
		]);
		expect(single?.labels).not.toContain("static");
		expect(single?.labels).not.toContain("motion");
	});

	test("a shot between samples uses the nearest frame", () => {
		const [only] = shotStatsFromFrames(
			[solid([0, 0, 0]), solid([255, 255, 255])],
			1,
			[{ start: 0.6, end: 0.9 }]
		);
		expect(only?.labels).toContain("white");
		expect(() => shotStatsFromFrames([], 4, [{ start: 0, end: 1 }])).toThrow();
	});
});

describe("visual query search", () => {
	test("query words map to labels, with synonyms and ignored words", () => {
		expect(parseShotQuery("Dim navy moving shot")).toEqual({
			excluded: [],
			ignored: [],
			labels: ["dark", "blue", "motion"],
		});
		expect(parseShotQuery("close up of a cyan sunset").labels).toEqual([
			"close-up",
			"teal",
		]);
		expect(parseShotQuery("close up of a cyan sunset").ignored).toEqual([
			"sunset",
		]);
		expect(parseShotQuery("wide shot, grey").labels).toEqual(["wide", "gray"]);
	});

	test("look phrases keep their meaning instead of word-by-word mapping", () => {
		for (const query of [
			"low light",
			"low-light",
			"lowlight",
			"dimly lit interior",
			"poorly-lit",
			"low key",
		]) {
			expect(parseShotQuery(query).labels).toEqual(["dark"]);
		}
		expect(parseShotQuery("dimly lit interior").ignored).toEqual(["interior"]);
		expect(parseShotQuery("well-lit wide").labels).toEqual(["bright", "wide"]);
		expect(parseShotQuery("brightly lit").labels).toEqual(["bright"]);
	});

	test("hyphenated compounds split into words, except close-up", () => {
		expect(parseShotQuery("dark-blue motion")).toEqual({
			excluded: [],
			ignored: [],
			labels: ["dark", "blue", "motion"],
		});
		expect(parseShotQuery("close-up, blue-green").labels).toEqual([
			"close-up",
			"blue",
			"green",
		]);
	});

	test("negated terms are excluded, never searched for", () => {
		expect(parseShotQuery("not dark")).toEqual({
			excluded: ["dark"],
			ignored: [],
			labels: [],
		});
		expect(parseShotQuery("blue without the motion, no red")).toEqual({
			excluded: ["motion", "red"],
			ignored: [],
			labels: ["blue"],
		});
		expect(parseShotQuery("not people").ignored).toEqual(["not people"]);
		expect(parseShotQuery("dark not dark").labels).toEqual([]);
	});

	const assetId = crypto.randomUUID();
	const stat = (
		start: number,
		labels: ShotStats["labels"],
		blue = 0.5
	): ShotStats => ({
		start,
		end: start + 3,
		brightness: 0.2,
		saturation: 0.4,
		motion: 0.08,
		edgeDensity: 0.1,
		colors: [{ hex: "#1020c0", name: "blue", weight: blue }],
		labels,
	});
	const index: ShotIndex = {
		format: "ryu.video-studio.shots.v1",
		assetId,
		analysisCreatedAt: new Date().toISOString(),
		revision: 1,
		sampleRate: 4,
		shots: [
			stat(0, ["dark", "motion", "blue"], 0.4),
			stat(3, ["bright", "static"]),
			stat(6, ["dark", "motion", "blue"], 0.9),
			stat(9, ["dark", "static", "blue"]),
		],
		updatedAt: new Date().toISOString(),
	};

	test("every recognized label must match; stronger matches rank first", () => {
		const found = searchShots([index], "dark blue motion");
		expect(found.results.map((match) => match.start)).toEqual([6, 0]);
		expect(found.results[0]).toMatchObject({ assetId, end: 9 });
	});

	test("unrecognized queries match nothing and filters apply", () => {
		expect(searchShots([index], "birthday cake").results).toEqual([]);
		const notDark = searchShots([index], "not dark").results;
		expect(notDark.length).toBeGreaterThan(0);
		expect(notDark.every((match) => !match.labels.includes("dark"))).toBe(true);
		expect(
			searchShots([index], "low light").results.every((match) =>
				match.labels.includes("dark")
			)
		).toBe(true);
		expect(
			searchShots([index], "dark", { assetId: crypto.randomUUID() }).results
		).toEqual([]);
		expect(searchShots([index], "dark", { limit: 1 }).results).toHaveLength(1);
	});
});
