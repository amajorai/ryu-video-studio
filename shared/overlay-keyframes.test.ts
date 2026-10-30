import { describe, expect, test } from "bun:test";
import { setKeyframes, setKeyframesRequestSchema } from "./keyframe-edits.ts";
import {
	addOverlayKeyframe,
	graphicChannelSample,
	overlayKeyframeBounds,
	removeOverlayKeyframe,
	setOverlayKeyframeInterpolation,
	setOverlayKeyframeValue,
	titleChannelSample,
} from "./overlay-keyframes.ts";
import {
	type Graphic,
	graphicSchema,
	newProject,
	newSegment,
	type Project,
	type Title,
	validateProject,
} from "./project.ts";
import { mixKeyframeColor } from "./schema/keyframe.ts";
import {
	graphicColorValue,
	graphicFramePoints,
	graphicFrameState,
	graphicShapeAt,
	hasGraphicShapeKeyframes,
	usesLegacyDrawbox,
} from "./shape-geometry.ts";
import {
	hasTitleStyleKeyframes,
	STYLE_EASE_PIECES,
	sampledStyleChannels,
	titleAt,
	titleColorKeyValue,
	titleEventTimes,
	titleStyleKeyValue,
} from "./text-animation.ts";

const id = () => crypto.randomUUID();

function title(patch: Partial<Title> = {}): Title {
	return {
		animation: "fade",
		color: "#ffffff",
		end: 4,
		fadeIn: 0,
		fadeOut: 0,
		fontSize: 0.08,
		id: id(),
		start: 2,
		text: "Keyed",
		x: 0.5,
		y: 0.5,
		...patch,
	};
}

function graphic(patch: Partial<Graphic> = {}): Graphic {
	return graphicSchema.parse({
		animation: "none",
		end: 3,
		entryDuration: 0,
		fill: "#ff0000",
		height: 0.2,
		id: id(),
		opacity: 1,
		shape: "rectangle",
		start: 1,
		width: 0.2,
		x: 0.4,
		y: 0.4,
		...patch,
	});
}

describe("title style and color keyframes", () => {
	const keyed = title({
		keyframes: [
			{ id: id(), property: "fontSize", time: 1, value: 0.12 },
			{ id: id(), property: "letterSpacing", time: 0, value: 0 },
			{
				id: id(),
				interpolation: "hold",
				property: "letterSpacing",
				time: 1,
				value: 0.2,
			},
			{ id: id(), property: "letterSpacing", time: 2, value: 0.4 },
			{ color: "#ff0000", id: id(), property: "color", time: 0, value: 0 },
			{ color: "#0000ff", id: id(), property: "color", time: 2, value: 0 },
			{
				color: "#00ff00",
				id: id(),
				property: "backgroundColor",
				time: 1,
				value: 0,
			},
		],
	});

	test("numeric channels start from the static field and ease", () => {
		expect(titleStyleKeyValue(keyed, "fontSize", 0)).toBe(0.08);
		expect(titleStyleKeyValue(keyed, "fontSize", 0.5)).toBeCloseTo(0.1, 9);
		expect(titleStyleKeyValue(keyed, "fontSize", 1.5)).toBe(0.12);
		// `hold` keeps the value until the next keyframe.
		expect(titleStyleKeyValue(keyed, "letterSpacing", 1.5)).toBe(0.2);
		expect(titleStyleKeyValue(keyed, "letterSpacing", 2)).toBe(0.4);
		// Unkeyed channels keep their resolved default.
		expect(titleStyleKeyValue(keyed, "lineHeight", 1)).toBe(
			titleStyleKeyValue(title(), "lineHeight", 1)
		);
	});

	test("colors mix per RGB channel; a missing base takes the first key", () => {
		expect(titleColorKeyValue(keyed, "color", 1)).toBe(
			mixKeyframeColor("#ff0000", "#0000ff", 0.5)
		);
		expect(titleColorKeyValue(keyed, "color", 1)).toBe("#800080");
		expect(titleColorKeyValue(keyed, "backgroundColor", 0)).toBe("#00ff00");
		expect(titleColorKeyValue(title(), "backgroundColor", 0)).toBeUndefined();
	});

	test("titleAt resolves every keyed style field at a timeline time", () => {
		const resolved = titleAt(keyed, 3);
		expect(resolved.fontSize).toBe(0.12);
		expect(resolved.letterSpacing).toBe(0.2);
		expect(resolved.color).toBe("#800080");
		expect(resolved.backgroundColor).toBe("#00ff00");
		expect(resolved.lineHeight).toBeUndefined();
		const plain = title();
		expect(titleAt(plain, 3)).toBe(plain);
		expect(hasTitleStyleKeyframes(keyed)).toBe(true);
		expect(hasTitleStyleKeyframes(plain)).toBe(false);
	});

	test("event times cut only eased style intervals, into a few pieces", () => {
		const times = titleEventTimes(keyed, 30);
		// Linear style ramps animate inside one event (libass \\t), so there
		// are no steps between the keys; holds have none either.
		expect(times.filter((time) => time > 2 && time < 3)).toEqual([]);
		expect(times).toContain(3);
		expect(times).toContain(4);
		const eased = title({
			keyframes: [
				{
					id: id(),
					interpolation: "ease-in-out",
					property: "fontSize",
					time: 0,
					value: 0.08,
				},
				{ id: id(), property: "fontSize", time: 2, value: 0.12 },
			],
		});
		const pieces = titleEventTimes(eased, 30).filter(
			(time) => time > 2 && time < 4
		);
		expect(pieces).toHaveLength(STYLE_EASE_PIECES - 1);
	});

	test("a rounded box keeps sampling its geometry", () => {
		const rounded = title({
			backgroundColor: "#000000",
			backgroundRadius: 0.2,
			keyframes: [
				{ id: id(), property: "fontSize", time: 0, value: 0.08 },
				{ id: id(), property: "fontSize", time: 2, value: 0.12 },
			],
		});
		expect(sampledStyleChannels(rounded).has("fontSize")).toBe(true);
		expect(
			titleEventTimes(rounded, 30).filter((time) => time > 2 && time < 4).length
		).toBeGreaterThan(STYLE_EASE_PIECES);
	});
});

describe("graphic shape keyframes", () => {
	const keyed = graphic({
		keyframes: [
			{ id: id(), property: "scale", time: 0, value: 1 },
			{ id: id(), property: "scale", time: 2, value: 2 },
			{ id: id(), property: "strokeWidth", time: 2, value: 0.04 },
			{ id: id(), property: "cornerRadius", time: 2, value: 0.5 },
			{ color: "#0000ff", id: id(), property: "fill", time: 2, value: 0 },
		],
	});

	test("graphicShapeAt scales the box and resolves shape fields", () => {
		const shape = graphicShapeAt(keyed, 1);
		expect(shape.width).toBeCloseTo(0.3, 9);
		expect(shape.height).toBeCloseTo(0.3, 9);
		expect(shape.strokeWidth).toBeCloseTo(0.02, 9);
		expect(shape.cornerRadius).toBeCloseTo(0.25, 9);
		expect(shape.fill).toBe("#800080");
		expect(graphicColorValue(keyed, "fill", 2)).toBe("#0000ff");
		expect(hasGraphicShapeKeyframes(keyed)).toBe(true);
		expect(usesLegacyDrawbox(keyed)).toBe(false);
		const plain = graphic();
		expect(graphicShapeAt(plain, 1)).toBe(plain);
	});

	test("scale keeps the box centre fixed in the preview outline", () => {
		const frame = { height: 1000, width: 1000 };
		const state = graphicFrameState(keyed, 2);
		// Elapsed 1 s: scale 1.5, so the 0.2-wide box grows 0.05 on each side.
		expect(state.x).toBeCloseTo(0.35, 9);
		const points = graphicFramePoints(
			graphic({
				keyframes: [{ id: id(), property: "scale", time: 0, value: 2 }],
			}),
			frame,
			1
		);
		const xs = points.map((point) => point.x);
		const ys = points.map((point) => point.y);
		expect(Math.min(...xs)).toBeCloseTo(300, 6);
		expect(Math.max(...xs)).toBeCloseTo(700, 6);
		expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(500, 6);
	});
});

describe("overlay keyframe authoring", () => {
	test("add records the channel value at the playhead, clamped", () => {
		const item = title();
		const added = addOverlayKeyframe(
			item,
			"fontSize",
			titleChannelSample(item, "fontSize", 1),
			3,
			id()
		);
		expect(added.keyframes).toMatchObject([
			{ property: "fontSize", time: 1, value: 0.08 },
		]);
		const color = addOverlayKeyframe(
			added,
			"color",
			{ color: "#ABCDEF" },
			2.5,
			id()
		);
		expect(color.keyframes?.[0]).toMatchObject({
			color: "#abcdef",
			property: "color",
			time: 0.5,
			value: 0,
		});
		expect(addOverlayKeyframe(item, "x", { value: 0.2 }, 9, id())).toBe(item);
		const clamped = addOverlayKeyframe(
			item,
			"x",
			{ value: 4 },
			2,
			id(),
			overlayKeyframeBounds("title", "x")
		);
		expect(clamped.keyframes?.[0]?.value).toBe(1);
	});

	test("value, easing and removal edit one keyframe", () => {
		const frameId = id();
		const item = graphic({
			keyframes: [
				{ id: frameId, property: "strokeWidth", time: 1, value: 0.01 },
			],
		});
		const valued = setOverlayKeyframeValue(item, frameId, { value: 0.5 });
		expect(valued.keyframes?.[0]?.value).toBe(0.08);
		const eased = setOverlayKeyframeInterpolation(valued, frameId, "ease-out");
		expect(eased.keyframes?.[0]?.interpolation).toBe("ease-out");
		const removed = removeOverlayKeyframe(eased, frameId);
		expect("keyframes" in removed).toBe(false);
		expect(graphicChannelSample(item, "fill", 0)).toEqual({ color: "#ff0000" });
		expect(graphicChannelSample(item, "scale", 0)).toEqual({ value: 1 });
	});
});

describe("validation and the /keyframes route", () => {
	function project(): Project {
		return {
			...newProject("Overlay keys"),
			graphics: [graphic()],
			titles: [title()],
		};
	}

	test("clips refuse title and graphic channels; colors need a color", () => {
		const source = {
			createdAt: new Date().toISOString(),
			duration: 8,
			hasAudio: false,
			height: 360,
			id: id(),
			kind: "video" as const,
			name: "Clip",
			width: 640,
		};
		const clip = newSegment(source);
		clip.keyframes = [{ id: id(), property: "fontSize", time: 0, value: 0.1 }];
		expect(() =>
			validateProject({ ...newProject("x"), segments: [clip] }, [source])
		).toThrow("A clip cannot carry fontSize keyframes.");
		const base = project();
		const noColor = {
			...base,
			titles: [
				{
					...title(),
					keyframes: [
						{ id: id(), property: "color" as const, time: 0, value: 0 },
					],
				},
			],
		};
		expect(() => validateProject(noColor, [])).toThrow("Color keyframes");
		const titleFill = {
			...base,
			titles: [
				{
					...title(),
					keyframes: [
						{
							color: "#ffffff",
							id: id(),
							property: "fill" as const,
							time: 0,
							value: 0,
						},
					],
				},
			],
		};
		expect(() => validateProject(titleFill, [])).toThrow(
			"A title cannot carry fill keyframes."
		);
	});

	test("titleId and graphicId replace one overlay channel", () => {
		const base = project();
		const titleId = base.titles[0]?.id as string;
		const graphicId = base.graphics[0]?.id as string;
		const withTitle = setKeyframes(base, [], {
			keyframes: [
				{ color: "#ff0000", time: 0 },
				{ color: "#00ff00", interpolation: "ease-in", time: 1 },
			],
			property: "color",
			revision: base.revision,
			titleId,
		});
		expect(withTitle.titles[0]?.keyframes).toMatchObject([
			{ color: "#ff0000", property: "color", time: 0, value: 0 },
			{ color: "#00ff00", interpolation: "ease-in", time: 1, value: 0 },
		]);
		const withGraphic = setKeyframes(withTitle, [], {
			graphicId,
			keyframes: [{ time: 0.5, value: 1.5 }],
			property: "scale",
			revision: withTitle.revision,
		});
		expect(withGraphic.graphics[0]?.keyframes).toMatchObject([
			{ property: "scale", time: 0.5, value: 1.5 },
		]);
		const cleared = setKeyframes(withGraphic, [], {
			graphicId,
			keyframes: [],
			property: "scale",
			revision: withGraphic.revision,
		});
		expect("keyframes" in (cleared.graphics[0] ?? {})).toBe(false);
	});

	test("the request names exactly one owner and an allowed channel", () => {
		const titleId = id();
		const parse = (input: Record<string, unknown>) =>
			setKeyframesRequestSchema.safeParse({
				keyframes: [{ time: 0, value: 0.1 }],
				property: "fontSize",
				revision: 0,
				...input,
			}).success;
		expect(parse({ titleId })).toBe(true);
		expect(parse({})).toBe(false);
		expect(parse({ clipId: id(), titleId })).toBe(false);
		expect(parse({ clipId: id() })).toBe(false);
		expect(parse({ graphicId: id() })).toBe(false);
		expect(
			parse({
				keyframes: [{ time: 0, value: 0.1 }],
				property: "fill",
				graphicId: id(),
			})
		).toBe(false);
		expect(
			parse({
				graphicId: id(),
				keyframes: [{ color: "#123456", time: 0 }],
				property: "fill",
			})
		).toBe(true);
		expect(() =>
			setKeyframes(project(), [], {
				keyframes: [{ time: 0, value: 0.1 }],
				property: "fontSize",
				revision: 0,
				titleId,
			})
		).toThrow("Title not found");
	});
});
