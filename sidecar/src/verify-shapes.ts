/**
 * Real-FFmpeg proof for shape graphics (W2-V11). Graphics-only projects
 * render through `buildRender` (single frames and short exports) and pixels
 * at star tips, star notches, rounded corners, aligned strokes, rotated and
 * keyframed positions are compared with the shared geometry.
 *
 * Run: `bun src/verify-shapes.ts`
 */
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Graphic,
	graphicSchema,
	newProject,
	type Project,
} from "../../shared/project.ts";
import type { Rgb } from "../../shared/shape-geometry.ts";
import { runMedia } from "./media.ts";
import { buildRender } from "./render.ts";
import { graphicsFilters } from "./render-graphics.ts";

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
/** Allowed per-channel error in 8-bit steps (YUV 4:2:0 round trips). */
const TOLERANCE = 24;
const RED: Rgb = [255, 0, 0];
const YELLOW: Rgb = [255, 255, 0];

/** A graphic whose 200x200 px box is centred on the frame. */
function centredGraphic(fields: Partial<Graphic>): Graphic {
	return graphicSchema.parse({
		animation: "none",
		end: 4,
		entryDuration: 0,
		fill: "#ff0000",
		height: 200 / HEIGHT,
		id: crypto.randomUUID(),
		opacity: 1,
		shape: "star",
		start: 0,
		stroke: "#ffff00",
		strokeWidth: 0,
		width: 200 / WIDTH,
		x: 220 / WIDTH,
		y: 80 / HEIGHT,
		...fields,
	});
}

function project(graphics: Graphic[]): Project {
	return {
		...newProject("Shapes proof"),
		graphics,
		height: HEIGHT,
		styleProfile: "clean-professional",
		width: WIDTH,
	};
}

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-shapes-"));
const results: string[] = [];
try {
	type Sampler = (x: number, y: number) => Rgb;

	async function sampler(
		name: string,
		source: string,
		seek?: number
	): Promise<Sampler> {
		const raw = join(directory, `${name}.rgb`);
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
			raw,
		]);
		const pixels = await readFile(raw);
		ensure(
			pixels.length === WIDTH * HEIGHT * 3,
			`${name}: frame is not ${WIDTH}x${HEIGHT}`
		);
		return (x, y) => {
			const offset = (Math.round(y) * WIDTH + Math.round(x)) * 3;
			return [
				pixels[offset] ?? 0,
				pixels[offset + 1] ?? 0,
				pixels[offset + 2] ?? 0,
			];
		};
	}

	async function renderFrame(
		name: string,
		graphics: Graphic[],
		frameTime = 1
	): Promise<Sampler> {
		const png = join(directory, `${name}.png`);
		const args = buildRender(
			project(graphics),
			[],
			() => "",
			undefined,
			[],
			frameTime
		);
		await runMedia([...args, png], { cwd: directory });
		return sampler(name, png);
	}

	async function renderExport(
		name: string,
		graphics: Graphic[]
	): Promise<(time: number) => Promise<Sampler>> {
		const path = join(directory, `${name}.mp4`);
		const args = buildRender(project(graphics), [], () => "");
		await runMedia([...args, path], { cwd: directory });
		return (time) => sampler(`${name}-${time}`, path, time);
	}

	const near = (actual: Rgb, expected: Rgb) =>
		actual.every(
			(value, index) => Math.abs(value - (expected[index] ?? 0)) <= TOLERANCE
		);

	function expectPixel(name: string, actual: Rgb, expected: Rgb) {
		ensure(
			near(actual, expected),
			`${name}: got rgb(${actual.join(",")}), expected rgb(${expected.join(",")})`
		);
	}

	function expectNot(name: string, actual: Rgb, unexpected: Rgb) {
		ensure(
			!near(actual, unexpected),
			`${name}: got rgb(${actual.join(",")}), expected anything else`
		);
	}

	const blank = await renderFrame("blank", [
		centredGraphic({ end: 0.5, start: 0 }),
	]);
	const canvas = blank(320, 180);
	expectNot("canvas is not red", canvas, RED);

	// Plan acceptance: a red star has a pixel at a tip and none at a notch.
	const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
	const polar = (degrees: number, radius: number) => ({
		x: 320 + radius * Math.cos(toRadians(degrees)),
		y: 180 + radius * Math.sin(toRadians(degrees)),
	});
	const star = await renderFrame("star", [centredGraphic({})]);
	const tip = polar(-90, 92);
	const notch = polar(-54, 70);
	expectPixel("star top tip", star(tip.x, tip.y), RED);
	expectPixel("star centre", star(320, 180), RED);
	expectPixel("star outside the notch", star(notch.x, notch.y), canvas);
	results.push("red star: pixel at a tip, none at the inner notch");

	// Static rotation is baked into the raster: rotating a five-point star by
	// 36 degrees swaps tips and notches.
	const rotated = await renderFrame("star-rotated", [
		centredGraphic({ rotation: 36 }),
	]);
	expectPixel("rotated star old tip", rotated(tip.x, tip.y), canvas);
	const rotatedTip = polar(-54, 92);
	expectPixel("rotated star new tip", rotated(rotatedTip.x, rotatedTip.y), RED);
	results.push("static rotation turns the star clockwise");

	// Polygon sides and hearts.
	const hexagon = await renderFrame("hexagon", [
		centredGraphic({ shape: "polygon", sides: 6 }),
	]);
	expectPixel("hexagon top vertex", hexagon(320, 84), RED);
	expectPixel("hexagon right side", hexagon(400, 180), RED);
	expectPixel("hexagon beyond the right vertices", hexagon(412, 180), canvas);
	expectPixel("hexagon corner of the box", hexagon(228, 88), canvas);
	const heart = await renderFrame("heart", [
		centredGraphic({ shape: "heart" }),
	]);
	expectPixel("heart lobe", heart(270, 120), RED);
	expectPixel("heart cleft", heart(320, 86), canvas);
	expectPixel("heart point", heart(320, 250), RED);
	results.push("polygon and heart silhouettes");

	// Rounded rectangle: the corner pixel is cut away, the edge midpoint stays.
	const rounded = await renderFrame("rounded", [
		centredGraphic({ cornerRadius: 0.5, shape: "rectangle" }),
	]);
	expectPixel("pill corner", rounded(224, 84), canvas);
	expectPixel("pill edge midpoint", rounded(320, 84), RED);
	results.push("corner radius rounds the rectangle");

	// Stroke alignment: a 20 px stroke (strokeWidth is a fraction of height).
	const strokeWidth = 20 / HEIGHT;
	const outside = await renderFrame("stroke-outside", [
		centredGraphic({ shape: "rectangle", strokeAlign: "outside", strokeWidth }),
	]);
	expectPixel("outside stroke beyond the box", outside(320, 70), YELLOW);
	expectPixel("outside stroke leaves the fill", outside(320, 90), RED);
	const inside = await renderFrame("stroke-inside", [
		centredGraphic({ shape: "rectangle", strokeAlign: "inside", strokeWidth }),
	]);
	expectPixel("inside stroke stays in the box", inside(320, 90), YELLOW);
	expectPixel("inside stroke leaves outside clear", inside(320, 70), canvas);
	expectPixel("inside stroke fill", inside(320, 180), RED);
	const centred = await renderFrame("stroke-center", [
		centredGraphic({ shape: "rectangle", strokeAlign: "center", strokeWidth }),
	]);
	expectPixel("centre stroke outer half", centred(320, 74), YELLOW);
	expectPixel("centre stroke inner half", centred(320, 86), YELLOW);
	expectPixel("centre stroke fill", centred(320, 96), RED);
	results.push("stroke alignment: inside, centre and outside");

	// Keyframed x in a frame render: the box moves 100 px right by t=2.
	const moving = centredGraphic({
		keyframes: [
			{
				id: crypto.randomUUID(),
				property: "x",
				time: 2,
				value: 320 / WIDTH,
			},
		],
		shape: "rectangle",
		cornerRadius: 0.1,
	});
	const start = await renderFrame("moving-0", [moving], 0);
	expectPixel("keyframed x at start, left side", start(240, 180), RED);
	const end = await renderFrame("moving-2", [moving], 3);
	expectPixel("keyframed x at end, old left side", end(240, 180), canvas);
	expectPixel("keyframed x at end, new right side", end(500, 180), RED);
	results.push("keyframed position in frame renders");

	// Keyframed rotation and opacity in an export.
	const spin = centredGraphic({
		end: 3,
		keyframes: [
			{
				id: crypto.randomUUID(),
				property: "rotation",
				time: 2,
				value: 36,
			},
			{ id: crypto.randomUUID(), property: "opacity", time: 0, value: 1 },
			{ id: crypto.randomUUID(), property: "opacity", time: 2.2, value: 1 },
			{ id: crypto.randomUUID(), property: "opacity", time: 2.5, value: 0 },
		],
	});
	const spinning = await renderExport("spin", [spin]);
	const first = await spinning(0);
	expectPixel("spin start tip", first(polar(-90, 75).x, polar(-90, 75).y), RED);
	const turned = await spinning(2.1);
	expectPixel("spin end old tip", turned(tip.x, tip.y), canvas);
	const spunTip = polar(-54, 75);
	expectPixel("spin end new tip", turned(spunTip.x, spunTip.y), RED);
	const faded = await spinning(2.7);
	expectPixel("faded out", faded(320, 180), canvas);
	results.push("keyframed rotation and opacity in an export");

	// Blend mode: a white heart in multiply leaves the canvas unchanged where
	// it covers, and normal draws it white.
	const multiplied = await renderFrame("multiply", [
		centredGraphic({ blendMode: "multiply", fill: "#ffffff" }),
	]);
	expectPixel("multiply white star", multiplied(320, 180), canvas);
	const keyframedBlend = await renderFrame(
		"multiply-keyframed",
		[
			centredGraphic({
				blendMode: "multiply",
				fill: "#ffffff",
				keyframes: [
					{ id: crypto.randomUUID(), property: "rotation", time: 2, value: 30 },
				],
			}),
			centredGraphic({
				blendMode: "multiply",
				fill: "#000000",
				keyframes: [
					{ id: crypto.randomUUID(), property: "opacity", time: 2, value: 0 },
				],
				shape: "rectangle",
				x: 0,
				y: 0,
			}),
		],
		1
	);
	expectPixel(
		"keyframed multiply white star",
		keyframedBlend(320, 180),
		canvas
	);
	const halfBlack: Rgb = [
		Math.round(canvas[0] / 2),
		Math.round(canvas[1] / 2),
		Math.round(canvas[2] / 2),
	];
	expectPixel(
		"half-faded multiply black rectangle",
		keyframedBlend(100, 100),
		halfBlack
	);
	results.push("blend modes composite shapes");

	// Legacy rectangles still use drawbox.
	const legacy = buildRender(
		project([centredGraphic({ shape: "rectangle" })]),
		[],
		() => ""
	).join(" ");
	ensure(legacy.includes("drawbox"), "legacy rectangle keeps drawbox");
	ensure(!legacy.includes("movie="), "legacy rectangle has no raster");
	results.push("plain rectangles keep drawbox");

	// Raster paths survive filtergraph escaping, even with special characters.
	const odd = join(directory, "odd dir, it's [x];y:z");
	await mkdir(odd);
	const chain = graphicsFilters(project([centredGraphic({})]), "base", {
		rasterDirectory: odd,
	});
	const oddPng = join(directory, "odd.png");
	await runMedia(
		[
			"-y",
			"-f",
			"lavfi",
			"-i",
			`color=c=black:s=${WIDTH}x${HEIGHT}:r=30:d=1`,
			"-filter_complex",
			["[0:v]null[base]", ...chain.filters].join(";"),
			"-map",
			`[${chain.last}]`,
			"-ss",
			"0.5",
			"-frames:v",
			"1",
			oddPng,
		],
		{ cwd: directory }
	);
	const oddFrame = await sampler("odd", oddPng);
	expectPixel("escaped raster path", oddFrame(320, 180), RED);
	results.push("raster paths with special characters");

	// Border parity (review fix): a stroked rectangle keeps its legacy
	// drawbox border widths when it moves to the raster path. 0.05 of a
	// 640x360 frame is 32 px left/right and 18 px top/bottom.
	const bordered = { shape: "rectangle" as const, strokeWidth: 0.05 };
	const legacyBorder = await renderFrame("border-legacy", [
		centredGraphic(bordered),
	]);
	const rasterBorder = await renderFrame("border-raster", [
		centredGraphic({ ...bordered, strokeAlign: "inside" }),
	]);
	for (const [name, frame] of [
		["legacy", legacyBorder],
		["raster", rasterBorder],
	] as const) {
		expectPixel(`${name} left border at 28 px`, frame(248, 180), YELLOW);
		expectPixel(`${name} fill at 36 px from the left`, frame(256, 180), RED);
		expectPixel(`${name} top border at 15 px`, frame(320, 95), YELLOW);
		expectPixel(`${name} fill at 22 px from the top`, frame(320, 102), RED);
	}
	results.push("rectangle borders match between drawbox and raster");

	// Keyframed opacity in a frame render: half way through a fade.
	const fading = centredGraphic({
		cornerRadius: 0.1,
		keyframes: [
			{ id: crypto.randomUUID(), property: "opacity", time: 1, value: 1 },
			{ id: crypto.randomUUID(), property: "opacity", time: 2, value: 0 },
		],
		shape: "rectangle",
	});
	const halfFaded = await renderFrame("fade-half", [fading], 1.5);
	const mixed: Rgb = [
		Math.round((RED[0] + canvas[0]) / 2),
		Math.round((RED[1] + canvas[1]) / 2),
		Math.round((RED[2] + canvas[2]) / 2),
	];
	expectPixel("half-faded rectangle", halfFaded(320, 180), mixed);
	const opaque = await renderFrame("fade-before", [fading], 0.5);
	expectPixel("opaque before the fade", opaque(320, 180), RED);
	const gone = await renderFrame("fade-after", [fading], 3);
	expectPixel("faded out after the fade", gone(320, 180), canvas);
	results.push("keyframed opacity in frame renders");

	// Cost outside the window (review fix): a large rotated rectangle shown
	// for one second of a 20 s 1080p timeline costs about what a drawbox
	// rectangle does, and a keyframed fade on it stays cheap.
	async function timedRun(name: string, graphics: Graphic[], seconds: number) {
		const big = {
			...project(graphics),
			height: 1080,
			width: 1920,
		};
		const chain = graphicsFilters(big, "base", { rasterDirectory: directory });
		const started = performance.now();
		await runMedia(
			[
				"-y",
				"-f",
				"lavfi",
				"-i",
				`color=c=black:s=1920x1080:r=30:d=${seconds}`,
				"-filter_complex",
				["[0:v]null[base]", ...chain.filters].join(";"),
				"-map",
				`[${chain.last}]`,
				"-f",
				"null",
				"-",
			],
			{ cwd: directory }
		);
		const elapsed = (performance.now() - started) / 1000;
		console.log(`    ${name}: ${elapsed.toFixed(2)} s`);
		return elapsed;
	}
	const large = {
		end: 1,
		height: 0.9,
		shape: "rectangle" as const,
		start: 0,
		width: 0.9,
		x: 0.05,
		y: 0.05,
	};
	const drawboxTime = await timedRun(
		"drawbox rectangle, 20 s",
		[centredGraphic(large)],
		20
	);
	const rasterTime = await timedRun(
		"rotated raster rectangle, 20 s",
		[centredGraphic({ ...large, rotation: 5 })],
		20
	);
	ensure(
		rasterTime < drawboxTime * 2 + 1,
		`rotated rectangle outside its window took ${rasterTime.toFixed(2)} s against ${drawboxTime.toFixed(2)} s`
	);
	const fadeTime = await timedRun(
		"keyframed fade on a large shape, 2 s",
		[
			centredGraphic({
				...large,
				end: 2,
				keyframes: [
					{ id: crypto.randomUUID(), property: "opacity", time: 1, value: 0.5 },
				],
				rotation: 5,
			}),
		],
		2
	);
	ensure(fadeTime < 5, `keyframed fade took ${fadeTime.toFixed(2)} s`);
	const keyframedTime = await timedRun(
		"keyframed rectangle shown for 1 s of 20 s",
		[
			centredGraphic({
				...large,
				keyframes: [
					{ id: crypto.randomUUID(), property: "opacity", time: 1, value: 0.5 },
				],
			}),
		],
		20
	);
	ensure(
		keyframedTime < drawboxTime * 4 + 2,
		`keyframed rectangle outside its window took ${keyframedTime.toFixed(2)} s against ${drawboxTime.toFixed(2)} s`
	);
	results.push("no per-frame raster work outside the window; cheap fades");

	// 4K: a full-frame star is rasterized at the capped side and scaled up
	// once by FFmpeg; the tip and the notch still land in place.
	{
		const uhd = {
			...project([
				centredGraphic({
					height: 1,
					width: 1,
					x: 0,
					y: 0,
				}),
			]),
			height: 2160,
			width: 3840,
		};
		const chain = graphicsFilters(uhd, "base", { rasterDirectory: directory });
		ensure(
			chain.filters.some((filter) => filter.includes(",scale=")),
			"4K raster is scaled up in FFmpeg"
		);
		const uhdPng = join(directory, "uhd.png");
		await runMedia(
			[
				"-y",
				"-f",
				"lavfi",
				"-i",
				"color=c=black:s=3840x2160:r=30:d=1",
				"-filter_complex",
				["[0:v]null[base]", ...chain.filters].join(";"),
				"-map",
				`[${chain.last}]`,
				"-frames:v",
				"1",
				uhdPng,
			],
			{ cwd: directory }
		);
		const pixel = async (x: number, y: number): Promise<Rgb> => {
			const raw = join(directory, "uhd-pixel.rgb");
			await runMedia([
				"-y",
				"-i",
				uhdPng,
				"-vf",
				`crop=1:1:${x}:${y}`,
				"-pix_fmt",
				"rgb24",
				"-f",
				"rawvideo",
				raw,
			]);
			const bytes = await readFile(raw);
			return [bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0];
		};
		// Tips lie on the frame-filling ellipse; the top tip is at (1920, 0).
		expectPixel("4K star near the top tip", await pixel(1920, 40), RED);
		expectPixel("4K star centre", await pixel(1920, 1080), RED);
		const notchAngle = toRadians(-54);
		const notch4k = {
			x: Math.round(1920 + 1920 * 0.62 * Math.cos(notchAngle)),
			y: Math.round(1080 + 1080 * 0.62 * Math.sin(notchAngle)),
		};
		expectPixel(
			"4K star outside the notch",
			await pixel(notch4k.x, notch4k.y),
			[0, 0, 0]
		);
	}
	results.push("4K rasters are capped and scaled up in FFmpeg");

	// The default raster directory is removed when the process exits.
	{
		const script = join(directory, "raster-dir-child.ts");
		const module = new URL("./render-graphics.ts", import.meta.url).pathname;
		const shared = new URL("../../shared/project.ts", import.meta.url).pathname;
		await Bun.write(
			script,
			[
				`import { graphicSchema, newProject } from ${JSON.stringify(shared)};`,
				`import { graphicsFilters } from ${JSON.stringify(module)};`,
				"const graphic = graphicSchema.parse({ end: 1, fill: '#ff0000', height: 0.2, id: crypto.randomUUID(), opacity: 1, shape: 'star', start: 0, width: 0.2, x: 0, y: 0 });",
				"graphicsFilters({ ...newProject('child'), graphics: [graphic] }, 'base');",
				"console.log(process.pid);",
			].join("\n")
		);
		const child = Bun.spawnSync(["bun", script]);
		ensure(child.exitCode === 0, `child failed: ${child.stderr.toString()}`);
		const pid = child.stdout.toString().trim();
		const leftover = readdirSync(tmpdir()).filter((name) =>
			name.startsWith(`ryu-video-studio-shapes-${pid}-`)
		);
		ensure(
			leftover.length === 0,
			`raster directory left behind: ${leftover.join(", ")}`
		);
	}
	results.push("default raster directory is removed at exit");

	for (const result of results) {
		console.log(`ok  ${result}`);
	}
	console.log(`verify-shapes: ${results.length} checks passed`);
} finally {
	await rm(directory, { force: true, recursive: true });
}
