/**
 * Real-FFmpeg proof for title text-style keyframes and graphic shape
 * keyframes.
 *
 * 1. Titles: a title whose color (red to blue) and font size (0.06 to 0.14)
 *    are keyframed, and a boxed title whose background color (green to
 *    yellow) and padding grow, are burned through the ASS renderer. Early
 *    and late frames must show the keyframed colors, and the text and box
 *    must grow by the keyframed amount.
 * 2. Graphics: a rectangle whose fill (red to blue), scale (0.6 to 1.4
 *    about its center) and corner radius are keyframed, and a hexagon whose
 *    outside stroke width and stroke color are keyframed, are exported
 *    through `buildRender` (the animated raster sequence). Pixels inside
 *    and outside the predicted silhouettes are compared at early and late
 *    times, and a single-frame render agrees with the export.
 *
 * Run: `bun src/verify-overlay-keyframes.ts`
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Graphic,
	graphicSchema,
	newProject,
	type Project,
	type Title,
} from "../../shared/project.ts";
import { graphicShapeAt, type Rgb } from "../../shared/shape-geometry.ts";
import { titleAt } from "../../shared/text-animation.ts";
import { subtitlesFontsOption } from "./fonts.ts";
import { runMedia } from "./media.ts";
import { buildRender } from "./render.ts";
import { assCaptions } from "./render-ass.ts";
import { prepareShapeSequences, shapeSamples } from "./render-graphics.ts";

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const WIDTH = 640;
const HEIGHT = 360;
const FPS = 10;
/** Allowed per-channel error in 8-bit steps (YUV 4:2:0 round trips). */
const TOLERANCE = 40;
const RED: Rgb = [255, 0, 0];
const BLUE: Rgb = [0, 0, 255];
const GREEN: Rgb = [0, 255, 0];
const YELLOW: Rgb = [255, 255, 0];

const near = (actual: Rgb, expected: Rgb, tolerance = TOLERANCE) =>
	actual.every(
		(value, index) => Math.abs(value - (expected[index] ?? 0)) <= tolerance
	);

interface Box {
	x0: number;
	x1: number;
	y0: number;
	y1: number;
}

function pixelAt(pixels: Uint8Array, x: number, y: number): Rgb {
	const offset = (Math.round(y) * WIDTH + Math.round(x)) * 3;
	return [
		pixels[offset] ?? 0,
		pixels[offset + 1] ?? 0,
		pixels[offset + 2] ?? 0,
	];
}

function countNear(pixels: Uint8Array, target: Rgb, box: Box): number {
	let count = 0;
	for (let y = box.y0; y < box.y1; y++) {
		for (let x = box.x0; x < box.x1; x++) {
			if (near(pixelAt(pixels, x, y), target)) {
				count++;
			}
		}
	}
	return count;
}

/** Horizontal extent of pixels near `target` inside `box`. */
function extentOf(pixels: Uint8Array, target: Rgb, box: Box): number {
	let low = Number.POSITIVE_INFINITY;
	let high = Number.NEGATIVE_INFINITY;
	for (let y = box.y0; y < box.y1; y++) {
		for (let x = box.x0; x < box.x1; x++) {
			if (near(pixelAt(pixels, x, y), target)) {
				low = Math.min(low, x);
				high = Math.max(high, x);
			}
		}
	}
	return high >= low ? high - low + 1 : 0;
}

const title = (patch: Partial<Title>): Title => ({
	animation: "fade",
	color: "#ffffff",
	end: 2,
	fadeIn: 0,
	fadeOut: 0,
	fontSize: 0.08,
	id: crypto.randomUUID(),
	start: 0,
	text: "Keyed",
	x: 0.5,
	y: 0.5,
	...patch,
});

function canvasProject(patch: Partial<Project>): Project {
	return {
		...newProject("Overlay keyframes proof"),
		height: HEIGHT,
		styleProfile: "clean-professional",
		width: WIDTH,
		...patch,
	};
}

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-overlay-keys-"));
const results: string[] = [];
try {
	// -----------------------------------------------------------------------
	// 1. Title text-style keyframes through the ASS renderer.
	const colorTitle = title({
		fontFamily: "anton",
		keyframes: [
			{
				color: "#ff0000",
				id: crypto.randomUUID(),
				property: "color",
				time: 0,
				value: 0,
			},
			{
				color: "#0000ff",
				id: crypto.randomUUID(),
				property: "color",
				time: 2,
				value: 0,
			},
			{ id: crypto.randomUUID(), property: "fontSize", time: 0, value: 0.06 },
			{ id: crypto.randomUUID(), property: "fontSize", time: 2, value: 0.14 },
		],
		text: "GROW",
		y: 0.27,
	});
	const boxTitle = title({
		backgroundColor: "#00ff00",
		backgroundPadding: 0.005,
		color: "#000000",
		fontFamily: "anton",
		fontSize: 0.06,
		keyframes: [
			{
				color: "#00ff00",
				id: crypto.randomUUID(),
				property: "backgroundColor",
				time: 0,
				value: 0,
			},
			{
				color: "#ffff00",
				id: crypto.randomUUID(),
				property: "backgroundColor",
				time: 2,
				value: 0,
			},
			{
				id: crypto.randomUUID(),
				property: "backgroundPadding",
				time: 2,
				value: 0.04,
			},
		],
		text: "BOX",
		y: 0.74,
	});
	const titlesProject = canvasProject({ titles: [colorTitle, boxTitle] });
	const script = join(directory, "titles.ass");
	await Bun.write(script, assCaptions(titlesProject));
	const raw = join(directory, "titles.rgb");
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=black:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=2`,
		"-vf",
		`subtitles=filename=${script}${subtitlesFontsOption()}`,
		"-pix_fmt",
		"rgb24",
		"-f",
		"rawvideo",
		raw,
	]);
	const all = new Uint8Array(await readFile(raw));
	const frameSize = WIDTH * HEIGHT * 3;
	const frame = (index: number) =>
		all.slice(index * frameSize, (index + 1) * frameSize);
	const early = frame(2);
	const late = frame(18);
	const topHalf: Box = { x0: 0, x1: WIDTH, y0: 0, y1: HEIGHT / 2 };
	const bottomHalf: Box = { x0: 0, x1: WIDTH, y0: HEIGHT / 2, y1: HEIGHT };

	const earlyRed = countNear(early, RED, topHalf);
	const earlyBlue = countNear(early, BLUE, topHalf);
	const lateRed = countNear(late, RED, topHalf);
	const lateBlue = countNear(late, BLUE, topHalf);
	ensure(
		earlyRed > 40 && earlyBlue < earlyRed / 10,
		`early title text is red (red ${earlyRed}, blue ${earlyBlue})`
	);
	ensure(
		lateBlue > 100 && lateRed < lateBlue / 10,
		`late title text is blue (red ${lateRed}, blue ${lateBlue})`
	);
	results.push("title color keyframes: red at 0.2 s, blue at 1.8 s");

	const earlyWidth = Math.max(
		extentOf(early, RED, topHalf),
		extentOf(early, [235, 0, 20], topHalf)
	);
	const lateWidth = extentOf(late, BLUE, topHalf);
	const expectedGrowth =
		(titleAt(colorTitle, 1.8).fontSize as number) /
		(titleAt(colorTitle, 0.2).fontSize as number);
	const growth = lateWidth / Math.max(1, earlyWidth);
	ensure(
		Math.abs(growth - expectedGrowth) < 0.35,
		`title width grows with its font size keyframes (${earlyWidth}px to ${lateWidth}px, ${growth.toFixed(2)}x, expected ${expectedGrowth.toFixed(2)}x)`
	);
	results.push(
		`title font size keyframes: text ${earlyWidth}px to ${lateWidth}px wide (${growth.toFixed(2)}x, shared curve ${expectedGrowth.toFixed(2)}x)`
	);

	const earlyGreen = countNear(early, GREEN, bottomHalf);
	const lateYellow = countNear(late, YELLOW, bottomHalf);
	const lateGreen = countNear(late, GREEN, bottomHalf);
	ensure(earlyGreen > 200, `early box is green (${earlyGreen} px)`);
	ensure(
		lateYellow > earlyGreen * 1.5 && lateGreen < lateYellow / 10,
		`late box is yellow and larger (green early ${earlyGreen}, yellow late ${lateYellow}, green late ${lateGreen})`
	);
	results.push(
		`title background color and padding keyframes: green box ${earlyGreen} px at 0.2 s, yellow box ${lateYellow} px at 1.8 s`
	);

	// -----------------------------------------------------------------------
	// 1b. Every frame of eased title style keyframes. libass interpolates the
	// `\t` targets per frame, so each frame's text and box color must sit
	// within one 8-bit unit of the shared curve, and its glyph and box size
	// within one pixel of a static title drawn at the curve's value for that
	// frame (libass hints glyph outlines, so sizes are compared rendered to
	// rendered).
	const easedText = title({
		color: "#ff0000",
		fontFamily: "anton",
		keyframes: [
			{
				color: "#ff2000",
				id: crypto.randomUUID(),
				interpolation: "ease-in-out",
				property: "color",
				time: 0,
				value: 0,
			},
			{
				color: "#2040ff",
				id: crypto.randomUUID(),
				property: "color",
				time: 2,
				value: 0,
			},
			{
				id: crypto.randomUUID(),
				interpolation: "ease-in",
				property: "fontSize",
				time: 0,
				value: 0.08,
			},
			{ id: crypto.randomUUID(), property: "fontSize", time: 2, value: 0.2 },
		],
		outlineWidth: 0,
		shadowDepth: 0,
		text: "HI",
		y: 0.27,
	});
	const easedBox = title({
		backgroundColor: "#103080",
		backgroundPadding: 0.01,
		color: "#000000",
		fontFamily: "anton",
		fontSize: 0.06,
		keyframes: [
			{
				color: "#103080",
				id: crypto.randomUUID(),
				property: "backgroundColor",
				time: 0,
				value: 0,
			},
			{
				color: "#f0c020",
				id: crypto.randomUUID(),
				property: "backgroundColor",
				time: 2,
				value: 0,
			},
			{
				id: crypto.randomUUID(),
				interpolation: "ease-out",
				property: "backgroundPadding",
				time: 0,
				value: 0.01,
			},
			{
				id: crypto.randomUUID(),
				property: "backgroundPadding",
				time: 2,
				value: 0.06,
			},
		],
		outlineWidth: 0,
		shadowDepth: 0,
		text: "BOX",
		y: 0.74,
	});
	const STYLE_FPS = 30;
	const renderTitles = async (name: string, titles: Title[]) => {
		const script = join(directory, `${name}.ass`);
		await Bun.write(script, assCaptions(canvasProject({ titles })));
		const out = join(directory, `${name}.rgb`);
		await runMedia([
			"-y",
			"-f",
			"lavfi",
			"-i",
			`color=black:s=${WIDTH}x${HEIGHT}:r=${STYLE_FPS}:d=2,format=rgb24`,
			"-vf",
			`subtitles=filename=${script}${subtitlesFontsOption()}`,
			"-pix_fmt",
			"rgb24",
			"-f",
			"rawvideo",
			out,
		]);
		const bytes = new Uint8Array(await readFile(out));
		return Array.from(
			{ length: Math.floor(bytes.length / frameSize) },
			(_, index) => bytes.slice(index * frameSize, (index + 1) * frameSize)
		);
	};
	const animated = await renderTitles("eased", [easedText, easedBox]);
	ensure(
		animated.length >= STYLE_FPS * 2 - 1,
		`eased titles: ${animated.length} frames`
	);
	// The reference: one static title per frame holding the curve's value at
	// that frame (start and end floored to the centiseconds ASS keeps).
	const centiseconds = (frame: number) =>
		Math.floor((frame * 100) / STYLE_FPS) / 100;
	const staticAt = (keyed: Title, frame: number): Title => {
		const resolved = titleAt(keyed, frame / STYLE_FPS);
		return {
			...resolved,
			end: centiseconds(frame + 1),
			id: crypto.randomUUID(),
			// One constant font-size key keeps the size unrounded, as in the
			// animated title (static titles draw at whole pixels).
			keyframes: (keyed.keyframes ?? []).some(
				(key) => key.property === "fontSize"
			)
				? [
						{
							id: crypto.randomUUID(),
							property: "fontSize",
							time: 0,
							value: resolved.fontSize,
						},
					]
				: [],
			start: centiseconds(frame),
		};
	};
	const reference = await renderTitles(
		"eased-reference",
		animated.flatMap((_, frame) => [
			staticAt(easedText, frame),
			staticAt(easedBox, frame),
		])
	);
	const hexRgb = (hex: string): Rgb => {
		const value = Number.parseInt(hex.slice(1, 7), 16);
		return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
	};
	/** The most common non-black color in `box` and the extent of non-black pixels. */
	const dominant = (pixels: Uint8Array, box: Box) => {
		const counts = new Map<number, number>();
		let x0 = Number.POSITIVE_INFINITY;
		let x1 = Number.NEGATIVE_INFINITY;
		let y0 = Number.POSITIVE_INFINITY;
		let y1 = Number.NEGATIVE_INFINITY;
		for (let y = box.y0; y < box.y1; y++) {
			for (let x = box.x0; x < box.x1; x++) {
				const [r, g, b] = pixelAt(pixels, x, y);
				if (r + g + b > 24) {
					const key = (r << 16) | (g << 8) | b;
					counts.set(key, (counts.get(key) ?? 0) + 1);
					x0 = Math.min(x0, x);
					x1 = Math.max(x1, x);
					y0 = Math.min(y0, y);
					y1 = Math.max(y1, y);
				}
			}
		}
		let best = 0;
		let bestCount = 0;
		for (const [key, count] of counts) {
			if (count > bestCount) {
				best = key;
				bestCount = count;
			}
		}
		const color: Rgb = [(best >> 16) & 255, (best >> 8) & 255, best & 255];
		return { color, height: y1 - y0 + 1, width: x1 - x0 + 1 };
	};
	const channelError = (actual: Rgb, expected: Rgb) =>
		Math.max(
			...actual.map((value, index) => Math.abs(value - (expected[index] ?? 0)))
		);
	let worstColor = 0;
	let worstBoxColor = 0;
	let worstSize = 0;
	for (const [frame, pixels] of animated.entries()) {
		const time = frame / STYLE_FPS;
		const want = reference[frame];
		ensure(want, `no reference frame ${frame}`);
		const text = dominant(pixels, topHalf);
		const box = dominant(pixels, bottomHalf);
		const refText = dominant(want, topHalf);
		const refBox = dominant(want, bottomHalf);
		const textColor = hexRgb(titleAt(easedText, time).color);
		const boxColor = hexRgb(titleAt(easedBox, time).backgroundColor as string);
		const colorError = channelError(text.color, textColor);
		const boxError = channelError(box.color, boxColor);
		const sizeError = Math.max(
			Math.abs(text.height - refText.height),
			Math.abs(text.width - refText.width),
			Math.abs(box.width - refBox.width),
			Math.abs(box.height - refBox.height)
		);
		ensure(
			colorError <= 1 && boxError <= 1,
			`at ${time.toFixed(3)} s the text is rgb(${text.color.join(",")}) (curve rgb(${textColor.join(",")})) and the box rgb(${box.color.join(",")}) (curve rgb(${boxColor.join(",")}))`
		);
		ensure(
			sizeError <= 1,
			`at ${time.toFixed(3)} s the glyphs are ${text.width}x${text.height} px (static ${refText.width}x${refText.height}) and the box ${box.width}x${box.height} px (static ${refBox.width}x${refBox.height})`
		);
		worstColor = Math.max(worstColor, colorError);
		worstBoxColor = Math.max(worstBoxColor, boxError);
		worstSize = Math.max(worstSize, sizeError);
	}
	results.push(
		`eased title style keyframes, every one of ${animated.length} frames: text color within ${worstColor} and box color within ${worstBoxColor} of the curve, glyphs and box within ${worstSize} px of a static title at the curve's value`
	);

	// -----------------------------------------------------------------------
	// 2. Graphic shape keyframes through the animated raster sequence.
	const centre = { x: WIDTH / 2, y: HEIGHT / 2 };
	const rectangle: Graphic = graphicSchema.parse({
		animation: "none",
		end: 2,
		entryDuration: 0,
		fill: "#ff0000",
		height: 100 / HEIGHT,
		id: crypto.randomUUID(),
		keyframes: [
			{
				color: "#ff0000",
				id: crypto.randomUUID(),
				property: "fill",
				time: 0,
				value: 0,
			},
			{
				color: "#0000ff",
				id: crypto.randomUUID(),
				property: "fill",
				time: 2,
				value: 0,
			},
			{ id: crypto.randomUUID(), property: "scale", time: 0, value: 0.5 },
			{ id: crypto.randomUUID(), property: "scale", time: 2, value: 1.5 },
			{ id: crypto.randomUUID(), property: "cornerRadius", time: 0, value: 0 },
			{
				id: crypto.randomUUID(),
				property: "cornerRadius",
				time: 2,
				value: 0.5,
			},
		],
		opacity: 1,
		shape: "rectangle",
		start: 0,
		width: 100 / WIDTH,
		x: (centre.x - 50) / WIDTH,
		y: (centre.y - 50) / HEIGHT,
	});
	const hexagon: Graphic = graphicSchema.parse({
		animation: "none",
		end: 2,
		entryDuration: 0,
		fill: "#000000",
		height: 60 / HEIGHT,
		id: crypto.randomUUID(),
		keyframes: [
			{
				color: "#ffff00",
				id: crypto.randomUUID(),
				property: "stroke",
				time: 0,
				value: 0,
			},
			{
				color: "#00ff00",
				id: crypto.randomUUID(),
				property: "stroke",
				time: 2,
				value: 0,
			},
			{ id: crypto.randomUUID(), property: "strokeWidth", time: 0, value: 0 },
			{
				id: crypto.randomUUID(),
				property: "strokeWidth",
				time: 2,
				value: 0.05,
			},
		],
		opacity: 1,
		shape: "polygon",
		sides: 6,
		start: 0,
		stroke: "#ffff00",
		strokeAlign: "outside",
		width: 60 / WIDTH,
		x: 60 / WIDTH,
		y: 60 / HEIGHT,
	});
	const graphicsProject = canvasProject({ graphics: [rectangle, hexagon] });
	const samples = shapeSamples(rectangle, FPS);
	ensure(
		samples.length > 10,
		`the rectangle has one raster per changing frame (${samples.length})`
	);
	const exportPath = join(directory, "graphics.mp4");
	// Exports draw animated shapes ahead of the graph, as the queue does.
	const shapes = await prepareShapeSequences(graphicsProject, {
		rasterDirectory: join(directory, "graphics"),
	});
	await runMedia(
		[
			...buildRender(graphicsProject, [], () => "", undefined, [], undefined, {
				shapeSequences: shapes.sequences,
			}),
			exportPath,
		],
		{ cwd: directory }
	);
	const grab = async (name: string, source: string, seek?: number) => {
		const out = join(directory, `${name}.rgb`);
		await runMedia([
			"-y",
			...(seek === undefined ? [] : ["-ss", `${seek}`]),
			"-i",
			source,
			"-frames:v",
			"1",
			"-pix_fmt",
			"rgb24",
			"-f",
			"rawvideo",
			out,
		]);
		const pixels = new Uint8Array(await readFile(out));
		ensure(pixels.length === frameSize, `${name}: frame is ${WIDTH}x${HEIGHT}`);
		return pixels;
	};
	const graphicEarly = await grab("graphic-early", exportPath, 0.2);
	const graphicLate = await grab("graphic-late", exportPath, 1.8);
	const canvas = pixelAt(graphicEarly, WIDTH - 4, HEIGHT - 4);

	const expectPixel = (name: string, actual: Rgb, expected: Rgb) =>
		ensure(
			near(actual, expected),
			`${name}: got rgb(${actual.join(",")}), expected rgb(${expected.join(",")})`
		);

	expectPixel(
		"rectangle centre early",
		pixelAt(graphicEarly, centre.x, centre.y),
		RED
	);
	expectPixel(
		"rectangle centre late",
		pixelAt(graphicLate, centre.x, centre.y),
		BLUE
	);
	results.push("graphic fill keyframes: red at 0.2 s, blue at 1.8 s");

	const earlyHalf = (graphicShapeAt(rectangle, 0.2).width * WIDTH) / 2;
	const lateHalf = (graphicShapeAt(rectangle, 1.8).width * WIDTH) / 2;
	expectPixel(
		"inside the early (small) box",
		pixelAt(graphicEarly, centre.x + earlyHalf - 4, centre.y),
		RED
	);
	expectPixel(
		"outside the early box, inside the late one",
		pixelAt(graphicEarly, centre.x + earlyHalf + 8, centre.y),
		canvas
	);
	expectPixel(
		"inside the late (large) box",
		pixelAt(graphicLate, centre.x + lateHalf - 4, centre.y),
		BLUE
	);
	expectPixel(
		"outside the late box",
		pixelAt(graphicLate, centre.x + lateHalf + 6, centre.y),
		canvas
	);
	results.push(
		`graphic scale keyframes about the centre: half width ${earlyHalf.toFixed(0)} px at 0.2 s, ${lateHalf.toFixed(0)} px at 1.8 s`
	);

	// The late corner radius (~0.45 of the short side) cuts the box corner.
	const corner = lateHalf - 3;
	expectPixel(
		"late rounded corner is cut",
		pixelAt(graphicLate, centre.x + corner, centre.y - corner),
		canvas
	);
	expectPixel(
		"early square corner is filled",
		pixelAt(graphicEarly, centre.x + earlyHalf - 6, centre.y - earlyHalf + 6),
		RED
	);
	results.push("graphic corner radius keyframes: square early, rounded late");

	// Outside stroke: none at the start, a green band late.
	const hexTop = { x: 90, y: 60 };
	const strokeLate = graphicShapeAt(hexagon, 1.8).strokeWidth * HEIGHT;
	expectPixel(
		"no stroke above the hexagon early",
		pixelAt(graphicEarly, hexTop.x, hexTop.y - strokeLate / 2),
		canvas
	);
	const lateStroke = pixelAt(graphicLate, hexTop.x, hexTop.y - strokeLate / 2);
	ensure(
		near(lateStroke, [25, 255, 0], 60),
		`late stroke band is (nearly) green: rgb(${lateStroke.join(",")})`
	);
	results.push(
		`graphic stroke width and color keyframes: no band at 0.2 s, ${strokeLate.toFixed(0)} px green band at 1.8 s`
	);

	// A single-frame render (as the preview frame endpoint uses) agrees.
	const framePath = join(directory, "graphic-frame.png");
	await runMedia(
		[
			...buildRender(graphicsProject, [], () => "", undefined, [], 1.8),
			framePath,
		],
		{ cwd: directory }
	);
	const single = await grab("graphic-frame", framePath);
	expectPixel("frame render centre", pixelAt(single, centre.x, centre.y), BLUE);
	expectPixel(
		"frame render inside the late box",
		pixelAt(single, centre.x + lateHalf - 4, centre.y),
		BLUE
	);
	results.push("single-frame render matches the export at 1.8 s");

	for (const result of results) {
		console.log(`ok  ${result}`);
	}
	console.log(`verify-overlay-keyframes: ${results.length} checks passed`);
} finally {
	await rm(directory, { force: true, recursive: true });
}
