import { describe, expect, test } from "bun:test";
import { animatedValue } from "../../../shared/animation.ts";
import { compileFfmpegExpression } from "../../../shared/ffmpeg-expression-eval.ts";
import {
	type Keyframe,
	newSegment,
	type Segment,
} from "../../../shared/project.ts";
import {
	basicColorFilters,
	TEMPERATURE_COMMAND_BUDGET,
	temperatureStep,
} from "./color-basic.ts";
import { cropFilters } from "./crop.ts";

const asset = {
	createdAt: new Date().toISOString(),
	duration: 10,
	hasAudio: false,
	height: 360,
	id: crypto.randomUUID(),
	kind: "video" as const,
	name: "Clip",
	width: 640,
};

function clip(keyframes: Omit<Keyframe, "id">[], patch: Partial<Segment> = {}) {
	return {
		...newSegment(asset),
		sourceOut: 4,
		...patch,
		keyframes: keyframes.map((frame) => ({
			...frame,
			id: crypto.randomUUID(),
		})),
	};
}

/** The quoted value of `key=` inside a filter string. */
function option(filter: string, key: string): string {
	const match = new RegExp(`${key}='([^']*)'`).exec(filter);
	if (!match?.[1]) {
		throw new Error(`No ${key} in ${filter}`);
	}
	return match[1];
}

/**
 * Animated crop (the chosen approach): FFmpeg `crop` fixes w/h per stream,
 * so the stage crops once to the widest window (each edge's minimum over the
 * clip) and a per-frame `geq` alpha mask hides the remaining crop. These
 * tests evaluate that mask with the expression shim and compare it with the
 * JS keyframe curve the preview's `inset()` uses.
 */
describe("keyframed crop", () => {
	const segment = clip(
		[
			{
				property: "cropLeft",
				time: 0,
				value: 0.1,
				interpolation: "ease-in-out",
			},
			{ property: "cropLeft", time: 2, value: 0.4 },
			{ property: "cropTop", time: 1, value: 0.3, interpolation: "hold" },
			{ property: "cropTop", time: 3, value: 0 },
		],
		{ crop: { bottom: 0.2, left: 0.1, right: 0.05, top: 0.1 } }
	);
	const filters = cropFilters(segment);

	test("crops to the widest window, then masks per frame", () => {
		expect(filters[0]).toBe("crop=w='iw*0.85':h='ih*0.8':x='iw*0.1':y='ih*0'");
		expect(filters[1]).toBe("format=yuva444p");
		expect(filters[2]).toStartWith(
			"geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*"
		);
		expect(filters).toHaveLength(3);
	});

	test("the mask follows the eased edge curves", () => {
		const mask = compileFfmpegExpression(
			option(filters[2] as string, "a").replace("alpha(X,Y)", "1")
		);
		const W = 850;
		const H = 800;
		for (let i = 0; i <= 50; i++) {
			const T = (i / 50) * 4;
			const left = animatedValue(segment, "cropLeft", T);
			const top = animatedValue(segment, "cropTop", T);
			for (const sourceX of [0.12, 0.2, 0.3, 0.38, 0.42, 0.6, 0.94, 0.96]) {
				const X = Math.round(((sourceX - 0.1) / 0.85) * W);
				const visible = mask({ H, T, W, X, Y: H / 2 }) === 1;
				const expected = (X / W) * 0.85 + 0.1;
				if (Math.abs(expected - left) > 0.005 && expected < 0.95 - 0.005) {
					expect(visible).toBe(expected > left);
				}
			}
			for (const sourceY of [0.05, 0.2, 0.35, 0.79, 0.81]) {
				const Y = Math.round((sourceY / 0.8) * H);
				const visible = mask({ H, T, W, X: W / 2, Y }) === 1;
				const expected = (Y / H) * 0.8;
				if (Math.abs(expected - top) > 0.005 && expected < 0.8 - 0.005) {
					expect(visible).toBe(expected > top);
				}
			}
		}
	});

	test("static crop keeps the historical filter", () => {
		expect(cropFilters(clip([]))).toEqual(["null"]);
		expect(
			cropFilters(
				clip([], { crop: { bottom: 0.1, left: 0.2, right: 0, top: 0 } })
			)
		).toEqual(["crop=w='iw*(1-0.2)':h='ih*(1-0.1)':x='iw*0.2':y='ih*0'"]);
	});

	test("animation from an uncropped edge skips the fixed crop", () => {
		const filters = cropFilters(
			clip([
				{ property: "cropRight", time: 0, value: 0 },
				{ property: "cropRight", time: 2, value: 0.5 },
			])
		);
		expect(filters[0]).toBe("format=yuva444p");
	});

	test("an overshooting curve is clamped to 90% like the preview", () => {
		const overshoot = clip([
			{
				bezier: [0.5, 0, 0.5, 2],
				interpolation: "bezier",
				property: "cropLeft",
				time: 0,
				value: 0,
			},
			{ property: "cropLeft", time: 2, value: 0.9 },
		]);
		const mask = compileFfmpegExpression(
			option(cropFilters(overshoot).at(-1) as string, "a").replace(
				"alpha(X,Y)",
				"1"
			)
		);
		const W = 1000;
		for (let i = 0; i <= 40; i++) {
			const T = i * 0.05;
			const edge = Math.min(
				0.9,
				Math.max(0, animatedValue(overshoot, "cropLeft", T))
			);
			// The rightmost 10% always stays visible, as in `cropInsetCss`.
			expect(mask({ H: 100, T, W, X: 950, Y: 50 })).toBe(1);
			const X = Math.round(edge * W);
			if (X > 5) {
				expect(mask({ H: 100, T, W, X: X - 5, Y: 50 })).toBe(0);
			}
			if (X + 5 < W) {
				expect(mask({ H: 100, T, W, X: X + 5, Y: 50 })).toBe(1);
			}
		}
	});

	test("a window that would vanish keeps 2% of each axis", () => {
		const filters = cropFilters(
			clip([
				{ property: "cropLeft", time: 0, value: 0.9 },
				{ property: "cropRight", time: 0, value: 0.9 },
			])
		);
		expect(filters[0]).toBe("crop=w='iw*0.02':h='ih*1':x='iw*0.49':y='ih*0'");
	});
});

describe("keyframed basic color", () => {
	test("static color keeps the historical filters", () => {
		expect(basicColorFilters(clip([]))).toEqual([
			"eq=brightness=0:contrast=1:saturation=1",
		]);
	});

	test("eq evaluates eased brightness, contrast and saturation per frame", () => {
		const segment = clip(
			[
				{
					property: "brightness",
					time: 0,
					value: -0.2,
					interpolation: "ease-in",
				},
				{ property: "brightness", time: 2, value: 0.4 },
				{ property: "exposure", time: 1, value: 1.5, interpolation: "hold" },
				{ property: "exposure", time: 3, value: 0 },
				{ property: "contrast", time: 0, value: 1, interpolation: "ease-out" },
				{ property: "contrast", time: 4, value: 2 },
			],
			{
				colorGrade: { exposure: 0, temperature: 0, tint: 0, vibrance: 0.4 },
				saturation: 1.5,
			}
		);
		const [eq] = basicColorFilters(segment);
		expect(eq).toEndWith(":eval=frame");
		const brightness = compileFfmpegExpression(
			option(eq as string, "brightness")
		);
		const contrast = compileFfmpegExpression(option(eq as string, "contrast"));
		const saturation = compileFfmpegExpression(
			option(eq as string, "saturation")
		);
		for (let i = 0; i <= 50; i++) {
			const t = (i / 50) * 4;
			expect(brightness({ t })).toBeCloseTo(
				animatedValue(segment, "brightness", t) +
					animatedValue(segment, "exposure", t) / 3,
				9
			);
			expect(contrast({ t })).toBeCloseTo(
				animatedValue(segment, "contrast", t),
				9
			);
			expect(saturation({ t })).toBeCloseTo(1.8, 9);
		}
	});

	test("temperature steps colorbalance through sendcmd at fps/2", () => {
		const segment = clip(
			[
				{
					property: "temperature",
					time: 0,
					value: 0,
					interpolation: "ease-in",
				},
				{ property: "temperature", time: 1, value: 0.6 },
			],
			{ colorGrade: { exposure: 0, temperature: 0, tint: 0.1, vibrance: 0 } }
		);
		const filters = basicColorFilters(segment, 30);
		const name = (filters[2] as string).split("=")[0] as string;
		expect(name).toMatch(/^colorbalance@kt[0-9a-f]{8}$/);
		expect(filters[0]).toBe("eq=brightness=0:contrast=1:saturation=1");
		expect(filters[2]).toBe(`${name}=rs=0:gs=0.1:bs=0`);
		const commands = option(filters[1] as string, "c").split(";");
		// One step every two frames until the curve settles at t = 1.
		expect(commands).toHaveLength(16);
		expect(commands[0]).toBe(`0 ${name} rs 0,${name} bs 0`);
		const [time, , , value] = (commands[8] as string).split(" ");
		expect(Number(value?.replace(/,.*/, ""))).toBeCloseTo(
			animatedValue(segment, "temperature", Number(time)),
			4
		);
		expect(commands.at(-1)).toBe(`1 ${name} rs 0.6,${name} bs -0.6`);
	});

	test("the temperature step follows the project fps", () => {
		const segment = clip(
			[
				{ property: "temperature", time: 0, value: -1 },
				{ property: "temperature", time: 4, value: 1 },
			],
			{ colorGrade: { exposure: 0, temperature: 0, tint: 0, vibrance: 0 } }
		);
		for (const fps of [24, 30, 60]) {
			expect(temperatureStep(segment, fps)).toBeCloseTo(2 / fps, 9);
			const commands = option(
				basicColorFilters(segment, fps)[1] as string,
				"c"
			).split(";");
			const second = Number(commands[1]?.split(" ")[0]);
			expect(second).toBeLessThanOrEqual(2 / fps);
			expect(second).toBeGreaterThan(2 / fps - 0.001);
		}
	});
});

/** Linux caps one argv string (the whole `-filter_complex`) at 128 KiB. */
const MAX_ARG_STRLEN = 128 * 1024;

describe("filtergraph size stays under the argv limit", () => {
	test("a long, ever-changing temperature curve coarsens its steps", () => {
		const segment = clip(
			[
				{ property: "temperature", time: 0, value: -1 },
				{ property: "temperature", time: 600, value: 1 },
			],
			{ sourceOut: 600 }
		);
		const filters = basicColorFilters(segment, 60);
		const script = option(filters[1] as string, "c");
		expect(script.length).toBeLessThanOrEqual(TEMPERATURE_COMMAND_BUDGET);
		expect(temperatureStep(segment, 60)).toBeGreaterThan(2 / 60);
		const commands = script.split(";");
		const values = commands.map((command) =>
			Number(command.split(" ")[3]?.replace(/,.*/, ""))
		);
		// Still a smooth ramp: each step moves the balance by under 1%.
		for (let i = 1; i < values.length; i++) {
			expect(
				Math.abs((values[i] as number) - (values[i - 1] as number))
			).toBeLessThan(0.01);
		}
		const [time, , , value] = (commands[100] as string).split(" ");
		expect(Number(value?.replace(/,.*/, ""))).toBeCloseTo(
			animatedValue(segment, "temperature", Number(time)),
			4
		);
	});

	const extreme: Pick<Keyframe, "bezier" | "interpolation"> = {
		bezier: [1, -1, 0, 2],
		interpolation: "bezier",
	};
	/** Spread over ten minutes, so temperature changes for the whole clip. */
	const awkward = (index: number) =>
		Number((index * 2.9 + 0.123_457).toFixed(6));

	test("200 extreme Bezier keyframes on one color channel", () => {
		const segment = clip(
			Array.from({ length: 200 }, (_, index) => ({
				...extreme,
				property: "brightness" as const,
				time: awkward(index),
				value: index % 2 ? 0.9 : -0.9,
			})),
			{ sourceOut: 600 }
		);
		const graph = [...cropFilters(segment), ...basicColorFilters(segment, 60)];
		expect(graph.join(",").length).toBeLessThan(MAX_ARG_STRLEN / 2);
		// Each interval still hits its keyframe values.
		const brightness = compileFfmpegExpression(
			option(graph.at(-1) as string, "brightness")
		);
		for (const index of [0, 57, 198]) {
			const time = awkward(index);
			expect(brightness({ t: time })).toBeCloseTo(
				animatedValue(segment, "brightness", time),
				3
			);
		}
	});

	test("the schema's worst clip across crop and color channels", () => {
		const properties = [
			"cropLeft",
			"cropRight",
			"cropTop",
			"cropBottom",
			"brightness",
			"contrast",
			"saturation",
			"exposure",
			"temperature",
		] as const;
		const segment = clip(
			Array.from({ length: 200 }, (_, index) => ({
				...extreme,
				property: properties[
					index % properties.length
				] as (typeof properties)[number],
				time: awkward(index),
				value: index % 2 ? 0.5 : -0.3,
			})),
			{ sourceOut: 600 }
		);
		const graph = [...cropFilters(segment), ...basicColorFilters(segment, 60)];
		expect(graph.join(",").length).toBeLessThan(MAX_ARG_STRLEN / 2);
	});

	test("a few Bezier curves keep the full-precision fit", () => {
		const segment = clip([
			{ ...extreme, property: "brightness", time: 0, value: 0 },
			{ property: "brightness", time: 2, value: 0.5 },
		]);
		const brightness = compileFfmpegExpression(
			option(basicColorFilters(segment)[0] as string, "brightness")
		);
		for (let i = 0; i <= 40; i++) {
			const t = i * 0.05;
			expect(
				Math.abs(brightness({ t }) - animatedValue(segment, "brightness", t))
			).toBeLessThan(0.5 * 0.002 + 1e-6);
		}
	});
});
