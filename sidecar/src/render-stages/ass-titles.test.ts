import { describe, expect, test } from "bun:test";
import {
	newProject,
	type Project,
	type Title,
} from "../../../shared/project.ts";
import {
	MAX_TITLE_EVENTS,
	STYLE_EASE_PIECES,
	titleMotionAt,
} from "../../../shared/text-animation.ts";
import { assCaptions } from "../render-ass.ts";
import {
	rotatePoint,
	roundedRectPath,
	titleEvents,
	titleStyles,
} from "./ass-titles.ts";

type Point = [number, number];

/** Seconds of an ASS `h:mm:ss.cc` timestamp. */
const seconds = (stamp: string) => {
	const [h, m, s] = stamp.split(":").map(Number) as [number, number, number];
	return h * 3600 + m * 60 + s;
};
const eventSpan = (event: string): [number, number] => {
	const [, from = "", to = ""] = event.split(",");
	return [seconds(from), seconds(to)];
};
const numbers = (event: string, tag: string) => {
	const match = new RegExp(`\\\\${tag}\\(([^)]*)\\)`).exec(event);
	return match?.[1]?.split(",").map(Number) ?? [];
};
/** Rotation at the start and end of an event, from `\frz` and its `\t`. */
const rotations = (event: string): [number, number] => {
	const all = [...event.matchAll(/\\frz(-?[\d.]+)/g)].map((m) => -Number(m[1]));
	return [all[0] ?? 0, all.at(-1) ?? 0];
};
/**
 * Where libass draws the event's position at progress `p`: the linear
 * `\move` point rotated around the fixed `\org` (clockwise degrees).
 */
const drawnAt = (event: string, p: number): Point => {
	const move = numbers(event, "move");
	const pos = numbers(event, "pos");
	const [x0, y0, x1, y1] =
		move.length >= 4 ? move : [pos[0], pos[1], pos[0], pos[1]];
	const point: Point = [
		(x0 as number) + ((x1 as number) - (x0 as number)) * p,
		(y0 as number) + ((y1 as number) - (y0 as number)) * p,
	];
	const org = numbers(event, "org");
	if (org.length < 2) {
		return point;
	}
	const [a, b] = rotations(event);
	const turned = rotatePoint(
		[point[0] - (org[0] as number), point[1] - (org[1] as number)],
		a + (b - a) * p
	);
	return [turned[0] + (org[0] as number), turned[1] + (org[1] as number)];
};
const drawnAnchors = (event: string) => ({
	end: drawnAt(event, 1),
	start: drawnAt(event, 0),
});

const id = "00000000-0000-4000-8000-000000000001";
const project = (titles: Title[]): Project => ({
	...newProject("ASS"),
	fps: 30,
	height: 1080,
	titles,
	width: 1920,
});
const base: Title = {
	animation: "fade",
	color: "#ff0000",
	end: 3,
	fadeIn: 0,
	fadeOut: 0,
	fontSize: 0.1,
	id,
	start: 1,
	text: "Hello world",
	x: 0.5,
	y: 0.5,
};

describe("title styles", () => {
	test("legacy titles add no style lines", () => {
		expect(titleStyles(project([base]))).toEqual([]);
	});

	test("styled titles get a T_ style with font, flags, spacing, outline, and shadow", () => {
		const [line] = titleStyles(
			project([
				{
					...base,
					align: "left",
					fontFamily: "playfair-display",
					fontWeight: 700,
					italic: true,
					letterSpacing: 0.1,
					outlineColor: "#00ff00",
					outlineWidth: 0.004,
					shadowColor: "#0000ff",
					shadowDepth: 0.002,
					strike: true,
					underline: true,
				},
			])
		);
		expect(line).toBe(
			`Style: T_${id},Playfair Display,108,&H000000FF,&H003BD4FF,&H0000FF00,&H80FF0000,-1,-1,-1,-1,100,100,10.8,0,1,4.32,2.16,4,0,0,0,1`
		);
	});

	test("a system font styles the title by family; an imported font wins", () => {
		const [system] = titleStyles(
			project([{ ...base, fontFamily: "anton", systemFont: "DejaVu Sans" }])
		);
		expect(system).toStartWith(`Style: T_${id},DejaVu Sans,108,`);
		const [imported] = titleStyles(
			project([
				{
					...base,
					customFont: {
						family: "Ryufont",
						id: "6f1d2b8e-6f0a-4a43-9b0c-2f0f6a1d2c3e",
					},
					systemFont: "DejaVu Sans",
				},
			])
		);
		expect(imported).toStartWith(`Style: T_${id},Ryufont,108,`);
	});

	test("square boxes get a BorderStyle 3 style colored by OutlineColour", () => {
		const lines = titleStyles(
			project([
				{
					...base,
					backgroundColor: "#112233",
					backgroundOpacity: 0.5,
					backgroundPadding: 0.01,
				},
			])
		);
		expect(lines[1]).toBe(
			`Style: TB_${id},Arial,108,&HFF0000FF,&H003BD4FF,&H80332211,&HFF332211,-1,0,0,0,100,100,0,0,3,10.8,0,5,0,0,0,1`
		);
		const rounded = titleStyles(
			project([{ ...base, backgroundColor: "#112233", backgroundRadius: 0.5 }])
		);
		expect(rounded).toHaveLength(1);
	});

	test("square boxes with zero padding keep a 1px outline so libass draws them", () => {
		const [, box] = titleStyles(
			project([{ ...base, backgroundColor: "#ff00ff", backgroundPadding: 0 }])
		);
		expect(box).toContain(",3,1,0,5,");
	});
});

describe("title events", () => {
	test("a static styled title is one positioned event", () => {
		expect(titleEvents({ ...base, fontFamily: "inter" }, project([]))).toEqual([
			`Dialogue: 3,0:00:01.00,0:00:03.00,T_${id},,0,0,0,,{\\an5\\pos(960,540)\\1a&H00&\\3a&H00&\\4a&H80&}Hello world`,
		]);
	});

	test("pop scales through its overshoot with one transform per event", () => {
		const events = titleEvents(
			{ ...base, animationIn: "pop", animationInDuration: 1 },
			project([])
		);
		expect(events).toHaveLength(3);
		expect(events[0]).toContain("\\fscx30\\fscy30");
		expect(events[0]).toContain("\\t(0,600,\\fscx115\\fscy115)");
		expect(events[1]).toContain("\\t(0,400,\\fscx100\\fscy100)");
	});

	test("fades become alpha transforms and slides become moves", () => {
		const [first] = titleEvents(
			{
				...base,
				animationIn: "slide-up",
				animationInDuration: 0.5,
				fadeIn: 0.5,
			},
			project([])
		);
		expect(first).toContain("\\move(960,626.4,960,540)");
		expect(first).toContain("\\1a&HFF&");
		expect(first).toContain("\\t(0,500,\\1a&H00&\\3a&H00&\\4a&H80&)");
	});

	test("typewriter hides the unrevealed suffix without changing layout", () => {
		const events = titleEvents(
			{
				...base,
				animationIn: "typewriter",
				animationInDuration: 1.1,
				text: "abc",
			},
			project([])
		);
		expect(events[0]).toEndWith("}a{\\alpha&HFF&}bc");
		expect(events[1]).toEndWith("}ab{\\alpha&HFF&}c");
		expect(events.at(-1)).toEndWith("}abc");
	});

	test("word-highlight colors the active word with the highlight color", () => {
		const events = titleEvents(
			{ ...base, animationIn: "word-highlight", highlightColor: "#00ff00" },
			project([])
		);
		expect(events[0]).toEndWith("}{\\1c&H00ff00&}Hello{\\1c&H0000ff&} world");
		expect(events.at(-1)).toEndWith("}Hello {\\1c&H00ff00&}world");
	});

	test("wave emits one event per visible glyph with a vertical move", () => {
		const events = titleEvents(
			{ ...base, animationIn: "wave", animationInDuration: 0.5, text: "ab" },
			project([])
		);
		const first = events.filter((event) => event.includes("0:00:01.00,"));
		expect(first).toHaveLength(2);
		expect(first[0]).toEndWith("}a{\\alpha&HFF&}b");
		expect(first[1]).toMatch(/^.*\{\\alpha&HFF&\}a\{.*\}b$/);
		expect(first[0]).toContain("\\move(");
	});

	test("rows are spaced by line height around the anchor", () => {
		const events = titleEvents(
			{ ...base, lineHeight: 1.5, text: "top\nbottom" },
			project([])
		);
		expect(events).toHaveLength(2);
		expect(events[0]).toContain("\\pos(960,459)");
		expect(events[1]).toContain("\\pos(960,621)");
		expect(events[0]).not.toContain("\\org(");
	});

	test("boxes draw under the text: BorderStyle 3 rows or a rounded drawing", () => {
		const square = titleEvents(
			{ ...base, backgroundColor: "#112233" },
			project([])
		);
		expect(square[0]).toStartWith(`Dialogue: 1,0:00:01.00,0:00:03.00,TB_${id}`);
		expect(square[0]).toContain("\\1a&HFF&");
		const rounded = titleEvents(
			{ ...base, backgroundColor: "#112233", backgroundRadius: 0.5 },
			project([])
		);
		expect(rounded[0]).toContain("\\p1}m ");
		expect(rounded[0]).toContain("\\1c&H332211&");
	});

	test("square boxes pad each axis and shift by the box offset", () => {
		const title: Title = {
			...base,
			backgroundColor: "#112233",
			backgroundOffsetX: 0.01,
			backgroundOffsetY: -0.02,
			backgroundPaddingX: 0.02,
			backgroundPaddingY: 0.005,
		};
		const [, style] = titleStyles(project([title]));
		expect(style).toContain(",3,5.4,0,5,");
		const [box, text] = titleEvents(title, project([]));
		// The vertical padding is the style's Outline, so only x is overridden.
		expect(box).toContain("\\xbord21.6\\3a");
		expect(box).toContain("\\pos(979.2,518.4)");
		// The text keeps its anchor; only the box moves.
		expect(text).toContain("\\pos(960,540)");
		const even = titleEvents(
			{ ...title, backgroundPaddingX: 0.005 },
			project([])
		);
		expect(even[0]).not.toContain("bord");
	});

	test("rounded boxes widen by the horizontal padding and follow the offset", () => {
		const extent = (event: string) =>
			Math.max(
				...(event.split("\\p1}")[1] ?? "")
					.split(" ")
					.map(Number)
					.filter(Number.isFinite)
			);
		const rounded: Title = {
			...base,
			backgroundColor: "#112233",
			backgroundPaddingX: 0,
			backgroundPaddingY: 0.01,
			backgroundRadius: 0.5,
		};
		const [narrow] = titleEvents(rounded, project([]));
		const [wide] = titleEvents(
			{ ...rounded, backgroundOffsetY: 0.05, backgroundPaddingX: 0.02 },
			project([])
		);
		expect(extent(wide ?? "") - extent(narrow ?? "")).toBeCloseTo(43.2, 1);
		expect(narrow).toContain("\\pos(960,540)");
		expect(wide).toContain("\\pos(960,594)");
	});

	test("soft shadows render as a blurred pass under the text", () => {
		const events = titleEvents(
			{ ...base, shadowBlur: 4, shadowColor: "#00ffff", shadowDepth: 0.01 },
			project([])
		);
		expect(events).toHaveLength(2);
		expect(events[0]).toStartWith("Dialogue: 2,");
		expect(events[0]).toContain("\\pos(970.8,550.8)");
		expect(events[0]).toContain("\\blur4");
		expect(events[0]).toContain("\\1c&Hffff00&");
	});

	test("keyframed rotation and position split into sub-events that follow the anchor", () => {
		const title: Title = {
			...base,
			keyframes: [
				{ id: "a", property: "rotation", time: 0, value: 0 },
				{ id: "b", property: "rotation", time: 2, value: 90 },
				{ id: "c", property: "x", time: 2, value: 0.25 },
			],
		};
		const events = titleEvents(title, project([]));
		// 2 s at 30 fps in 2-frame sub-events.
		expect(events).toHaveLength(30);
		expect(events[0]).toContain("\\move(960,540,");
		expect(events[0]).toContain("\\org(960,540)\\frz0\\1a");
		for (const event of events) {
			const { end, start } = drawnAnchors(event);
			const [from, to] = eventSpan(event);
			const expectedStart = titleMotionAt(title, from);
			const expectedEnd = titleMotionAt(title, to - 1e-7);
			expect(start[0]).toBeCloseTo(expectedStart.x * 1920, 0);
			expect(end[0]).toBeCloseTo(expectedEnd.x * 1920, 0);
			expect(end[1]).toBeCloseTo(540, 0);
		}
	});

	test("a rotated title that moves rotates around its own anchor, not the start point", () => {
		const title: Title = {
			...base,
			end: 2,
			keyframes: [
				{ id: "a", property: "x", time: 0, value: 0.2 },
				{ id: "b", property: "x", time: 2, value: 0.8 },
			],
			rotation: 45,
			start: 0,
			text: "XX",
			x: 0.2,
		};
		const canvas = { ...project([]), height: 360, width: 640 };
		const events = titleEvents(title, canvas);
		expect(events).toHaveLength(1);
		const event = events[0] as string;
		expect(event).toContain("\\org(128,180)");
		// The end point is pre-rotated so libass's fixed pivot draws x=512.
		expect(event).not.toContain("\\move(128,180,512,180)");
		const { end, start } = drawnAnchors(event);
		expect(start).toEqual([128, 180]);
		expect(end[0]).toBeCloseTo(512, 0);
		expect(end[1]).toBeCloseTo(180, 0);
		// Halfway, linear interpolation of the drawn point lands on the path.
		const middle = drawnAt(event, 0.5);
		expect(middle[0]).toBeCloseTo(320, 0);
		expect(middle[1]).toBeCloseTo(180, 0);
	});

	test("rotated multi-row titles keep rows around the moving anchor", () => {
		const title: Title = {
			...base,
			end: 2,
			keyframes: [{ id: "a", property: "y", time: 2, value: 0.7 }],
			rotation: 90,
			start: 0,
			text: "top\nbottom",
		};
		const events = titleEvents(title, project([]));
		const [top, bottom] = events as [string, string];
		// At 90 degrees clockwise the rows sit left/right of the anchor.
		const topEnd = drawnAnchors(top).end;
		const bottomEnd = drawnAnchors(bottom).end;
		expect((topEnd[0] + bottomEnd[0]) / 2).toBeCloseTo(960, 0);
		expect(topEnd[1]).toBeCloseTo(756, 0);
		expect(topEnd[0]).toBeGreaterThan(bottomEnd[0]);
	});

	test("long per-glyph titles stay inside the event and size budget", () => {
		const text = "wave ".repeat(100).slice(0, 499);
		const started = performance.now();
		const events = titleEvents(
			{
				...base,
				animationLoop: "wave",
				end: 60,
				shadowBlur: 2,
				shadowDepth: 0.002,
				start: 0,
				text,
			},
			project([])
		);
		const elapsed = performance.now() - started;
		const bytes = events.reduce((total, event) => total + event.length, 0);
		expect(events.length).toBeLessThanOrEqual(MAX_TITLE_EVENTS);
		expect(bytes).toBeLessThan(1_000_000);
		expect(elapsed).toBeLessThan(2000);
	});

	test("short wave titles keep exact per-glyph events", () => {
		const events = titleEvents(
			{ ...base, animationLoop: "wave", text: "Hi you" },
			project([])
		);
		const first = events.filter((event) => event.includes("0:00:01.00,"));
		// 5 non-space glyphs, one event each.
		expect(first).toHaveLength(5);
	});

	test("the ASS script carries the title styles", () => {
		const script = assCaptions(project([{ ...base, fontFamily: "anton" }]));
		expect(script).toContain(`Style: T_${id},Anton,`);
	});

	test("rounded rectangle paths close at the start", () => {
		const path = roundedRectPath(100, 40, 10);
		expect(path).toStartWith("m 10 0 l 90 0 b");
		expect(path).toEndWith("10 0");
		expect(roundedRectPath(10, 10, 50)).toStartWith("m 5 0");
	});
});

describe("gradient fill, text blur and word highlight block", () => {
	test("a gradient colors each glyph and a blur splits outline and fill", () => {
		const title: Title = {
			...base,
			color: "#000000",
			fillMode: "gradient",
			gradientColor: "#ffffff",
			outlineWidth: 0.002,
			text: "abc",
			textBlur: 0.005,
		};
		const events = titleEvents(title, project([]));
		// Outline pass (fill hidden), then the bare blurred fill.
		expect(events).toHaveLength(2);
		expect(events[0]).toContain("\\1a&HFF&");
		expect(events[1]).toContain("\\bord0\\shad0");
		for (const event of events) {
			expect(event).toContain("\\blur5.4");
		}
		// The first glyph keeps the style's (title) color.
		expect(events[1]).toMatch(/\}a\{\\1c&H808080&\}b\{\\1c&Hffffff&\}c$/);
	});

	test("word highlight block draws a box behind only the active word", () => {
		const title: Title = {
			...base,
			animationIn: "word-highlight-block",
			highlightColor: "#00ff00",
			text: "one two",
		};
		const canvas = project([]);
		const styles = titleStyles({ ...canvas, titles: [title] });
		expect(
			styles.some((line) => line.startsWith(`Style: TH_${title.id}`))
		).toBe(true);
		const events = titleEvents(title, canvas);
		const boxes = events.filter((event) => event.includes(`TH_${title.id}`));
		expect(boxes.length).toBeGreaterThanOrEqual(2);
		expect(boxes.some((box) => box.endsWith("one{\\3a&HFF&} two"))).toBe(true);
		expect(
			boxes.some((box) => /\{\\3a&HFF&\}one \{\\3a&H00&\}two$/.test(box))
		).toBe(true);
		// The text keeps its own color: no highlight fill on the active word.
		expect(events.join("\n")).not.toContain("\\1c&H00ff00&");
	});
});

describe("text-style keyframes", () => {
	const project = { ...newProject("Style keys"), height: 1000, width: 1000 };
	const keyed: Title = {
		animation: "fade",
		backgroundColor: "#00ff00",
		backgroundPadding: 0.01,
		color: "#ff0000",
		end: 2,
		fadeIn: 0,
		fadeOut: 0,
		fontSize: 0.05,
		id: "00000000-0000-4000-8000-0000000000b1",
		keyframes: [
			{
				id: "00000000-0000-4000-8000-0000000000b2",
				property: "fontSize",
				time: 2,
				value: 0.1,
			},
			{
				color: "#0000ff",
				id: "00000000-0000-4000-8000-0000000000b3",
				property: "color",
				time: 2,
				value: 0,
			},
			{
				color: "#ffff00",
				id: "00000000-0000-4000-8000-0000000000b4",
				property: "backgroundColor",
				time: 2,
				value: 0,
			},
			{
				id: "00000000-0000-4000-8000-0000000000b5",
				property: "backgroundPadding",
				time: 2,
				value: 0.04,
			},
		],
		start: 0,
		text: "Grow",
		x: 0.5,
		y: 0.5,
	};

	test("style lines hold the start values; events override what changed", () => {
		const styles = titleStyles({ ...project, titles: [keyed] });
		expect(styles[0]).toContain(`T_${keyed.id},`);
		expect(styles[0]?.split(",")[2]).toBe("50");
		const events = titleEvents(keyed, project);
		const text = events.filter((event) => event.startsWith("Dialogue: 3,"));
		const box = events.filter((event) => event.startsWith("Dialogue: 1,"));
		// Linear style keyframes are one event each: libass interpolates the
		// `\\t` targets every frame instead of the renderer sampling them.
		expect(text).toHaveLength(1);
		const last = text.at(-1) ?? "";
		expect(last).toContain("\\t(0,2000,\\fs100)");
		// Red to blue, in ASS BGR order.
		expect(last.toLowerCase()).toContain("\\t(0,2000,\\1c&hff0000&)");
		const lastBox = box.at(-1) ?? "";
		// Green to yellow and the padding growing from 10 to 40 px.
		expect(lastBox).toContain("\\t(0,2000,\\bord40)");
		// The box starts green (its style line) and turns yellow.
		expect(lastBox.toLowerCase()).toContain("\\t(0,2000,\\3c&h00ffff&)");
		// Spans are contiguous and cover the title.
		expect(eventSpan(text[0] ?? "")[0]).toBe(0);
		expect(eventSpan(last)[1]).toBe(2);
	});

	test("eased style keyframes are a few accelerated pieces, not frame samples", () => {
		const eased: Title = {
			...keyed,
			keyframes: [
				{
					id: "00000000-0000-4000-8000-0000000000c1",
					interpolation: "ease-in-out",
					property: "fontSize",
					time: 0,
					value: 0.05,
				},
				{
					id: "00000000-0000-4000-8000-0000000000c2",
					property: "fontSize",
					time: 2,
					value: 0.1,
				},
			],
		};
		const text = titleEvents(eased, project).filter((event) =>
			event.startsWith("Dialogue: 3,")
		);
		expect(text).toHaveLength(STYLE_EASE_PIECES);
		// Each piece accelerates along the ease: slow in, fast out.
		const accels = text.map((event) =>
			Number(/\\t\(0,\d+,([\d.]+),\\fs/.exec(event)?.[1] ?? 1)
		);
		expect(accels[0]).toBeGreaterThan(1);
		expect(accels.at(-1)).toBeLessThan(1);
	});
});
