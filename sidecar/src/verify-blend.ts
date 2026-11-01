/**
 * Real-FFmpeg proof for blend modes (W2-V1). A full-frame base card sits on
 * track 1 and a half-size layer card on track 2; single frames render through
 * `buildRender` and pixels inside and outside the layer are compared with the
 * reference math in `shared/blend.ts`.
 *
 * Run: `bun src/verify-blend.ts`
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BlendMode,
	blendModes,
	compositePixel,
	type Rgb,
} from "../../shared/blend.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	segmentSchema,
} from "../../shared/project.ts";
import { runMedia } from "./media.ts";
import { buildRender } from "./render.ts";

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const WIDTH = 320;
const HEIGHT = 180;
/** Allowed per-channel error in 8-bit steps (YUV 4:2:0 round trips). */
const TOLERANCE = 6;

const hex = ([r, g, b]: Rgb) =>
	`0x${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-blend-"));
const results: string[] = [];
try {
	const cards = new Map<string, { asset: Asset; path: string }>();
	async function card(color: Rgb): Promise<{ asset: Asset; path: string }> {
		const key = hex(color);
		const existing = cards.get(key);
		if (existing) {
			return existing;
		}
		const path = join(directory, `card-${key}.png`);
		await runMedia([
			"-y",
			"-f",
			"lavfi",
			"-i",
			`color=c=${key}:s=${WIDTH}x${HEIGHT},format=rgb24`,
			"-frames:v",
			"1",
			path,
		]);
		const asset: Asset = {
			createdAt: "2026-01-01T00:00:00.000Z",
			duration: 5,
			hasAudio: false,
			height: HEIGHT,
			id: `00000000-0000-4000-8000-${(cards.size + 1).toString(16).padStart(12, "0")}`,
			kind: "image",
			name: `card-${key}.png`,
			width: WIDTH,
		};
		const entry = { asset, path };
		cards.set(key, entry);
		return entry;
	}

	interface Scene {
		base: Rgb;
		layer: Rgb;
		/** Where the layer clip starts on the timeline (it lasts 2 s). */
		layerStart?: number;
		mode: BlendMode;
		opacity?: number;
	}

	async function sceneRender(
		scene: Scene,
		frameTime: number | undefined
	): Promise<string[]> {
		const below = await card(scene.base);
		const above = await card(scene.layer);
		const project: Project = {
			...newProject("Blend proof"),
			height: HEIGHT,
			styleProfile: "clean-professional",
			width: WIDTH,
		};
		project.segments = [
			segmentSchema.parse({ ...newSegment(below.asset), sourceOut: 4 }),
			segmentSchema.parse({
				...newSegment(above.asset),
				...(scene.mode === "normal" ? {} : { blendMode: scene.mode }),
				opacity: scene.opacity ?? 1,
				scale: 0.5,
				sourceOut: 2,
				start: scene.layerStart ?? 0,
				track: 1,
			}),
		];
		const paths = new Map([
			[below.asset.id, below.path],
			[above.asset.id, above.path],
		]);
		return buildRender(
			project,
			[below.asset, above.asset],
			(id) => paths.get(id) ?? "",
			undefined,
			[],
			frameTime
		);
	}

	/** Decode one frame of an image or video file into a pixel sampler. */
	async function sampler(
		name: string,
		source: string,
		seek?: number
	): Promise<(x: number, y: number) => Rgb> {
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
			const offset = (y * WIDTH + x) * 3;
			return [
				pixels[offset] ?? 0,
				pixels[offset + 1] ?? 0,
				pixels[offset + 2] ?? 0,
			];
		};
	}

	async function renderFrame(
		name: string,
		scene: Scene,
		frameTime = 1
	): Promise<(x: number, y: number) => Rgb> {
		const png = join(directory, `${name}.png`);
		await runMedia([...(await sceneRender(scene, frameTime)), png], {
			cwd: directory,
		});
		return sampler(name, png);
	}

	const toUnit = (color: Rgb): Rgb => [
		color[0] / 255,
		color[1] / 255,
		color[2] / 255,
	];

	function expectPixel(name: string, actual: Rgb, expected: Rgb) {
		const off = actual.some(
			(value, index) => Math.abs(value - (expected[index] ?? 0)) > TOLERANCE
		);
		ensure(
			!off,
			`${name}: got rgb(${actual.join(",")}), expected rgb(${expected.map((value) => Math.round(value)).join(",")})`
		);
	}

	async function check(
		name: string,
		base: Rgb,
		layer: Rgb,
		mode: BlendMode,
		opacity = 1
	) {
		const sample = await renderFrame(name, { base, layer, mode, opacity });
		const inside = compositePixel(
			mode,
			toUnit(base),
			toUnit(layer),
			opacity
		).map((value) => value * 255) as unknown as Rgb;
		// The layer is centred at half size: (80..240, 45..135).
		expectPixel(`${name} inside`, sample(WIDTH / 2, HEIGHT / 2), inside);
		expectPixel(`${name} outside`, sample(20, 20), base);
		results.push(name);
	}

	const gray: Rgb = [128, 128, 128];
	// Plan acceptance: multiply by white and screen with black leave the base.
	await check(
		"multiply white over 50% gray",
		gray,
		[255, 255, 255],
		"multiply"
	);
	await check("screen black over 50% gray", gray, [0, 0, 0], "screen");
	// Normal still places the layer opaquely.
	await check("normal red", gray, [255, 0, 0], "normal");
	// Half opacity proves straight (not premultiplied) layer colour.
	await check(
		"multiply red at 50% opacity",
		gray,
		[255, 0, 0],
		"multiply",
		0.5
	);
	// Every mode against the reference math, including the operand order.
	const base: Rgb = [64, 128, 200];
	const layer: Rgb = [200, 96, 40];
	for (const mode of blendModes) {
		await check(`${mode} reference`, base, layer, mode);
	}
	// Component modes (hue, saturation, color, luminosity) mix whole pixels.
	async function checkExact(
		name: string,
		scene: { base: Rgb; layer: Rgb; mode: BlendMode; opacity?: number },
		expected: Rgb
	) {
		const sample = await renderFrame(name, scene);
		expectPixel(`${name} inside`, sample(WIDTH / 2, HEIGHT / 2), expected);
		results.push(name);
	}
	// A grey layer has no saturation: saturation mode leaves the base's luma.
	const blueLuma = Math.round(0.299 * 64 + 0.587 * 128 + 0.114 * 200);
	await checkExact(
		"saturation of a grey layer desaturates the base to its luma",
		{ base, layer: gray, mode: "saturation" },
		[blueLuma, blueLuma, blueLuma]
	);
	// A grey layer has no hue either, so hue mode also gives grey.
	await checkExact(
		"hue of a grey layer leaves grey at the base luma",
		{ base, layer: gray, mode: "hue" },
		[blueLuma, blueLuma, blueLuma]
	);
	// Luminosity of a grey layer over grey changes only the brightness.
	await checkExact(
		"luminosity of light grey over 50% gray",
		{ base: gray, layer: [200, 200, 200], mode: "luminosity" },
		[200, 200, 200]
	);
	// Color keeps the base luma and takes the layer's chroma; colour over a
	// grey base and luminosity of that grey over the colour agree.
	const colored = compositePixel(
		"color",
		toUnit(gray),
		toUnit([255, 0, 0]),
		1
	).map((value) => value * 255) as unknown as Rgb;
	ensure(
		colored[0] > colored[1] + 40 && Math.abs(colored[1] - colored[2]) < 2,
		"color reference keeps red chroma"
	);
	await checkExact(
		"color of red over 50% gray",
		{ base: gray, layer: [255, 0, 0], mode: "color" },
		colored
	);
	await checkExact(
		"luminosity of gray over red is color of red over gray",
		{ base: [255, 0, 0], layer: gray, mode: "luminosity" },
		colored
	);
	// Half opacity mixes the component result with the base in RGB.
	await check("hue at 50% opacity", base, layer, "hue", 0.5);
	// A full export: the blend graph must end with the timeline, and the
	// layer must only blend while its clip is on screen.
	const exported = await sceneRender(
		{ base: gray, layer: [255, 0, 0], layerStart: 1, mode: "multiply" },
		undefined
	);
	const exportedPath = join(directory, "export.mp4");
	await runMedia([...exported, exportedPath], { cwd: directory });
	const before = await sampler("export before", exportedPath, 0.5);
	expectPixel("export before the layer", before(WIDTH / 2, HEIGHT / 2), gray);
	const during = await sampler("export during", exportedPath, 2);
	expectPixel(
		"export during the layer",
		during(WIDTH / 2, HEIGHT / 2),
		[128, 0, 0]
	);
	const after = await sampler("export after", exportedPath, 3.5);
	expectPixel("export after the layer", after(WIDTH / 2, HEIGHT / 2), gray);
	results.push("export blends only while the clip is on screen");
	for (const result of results) {
		console.log(`ok  ${result}`);
	}
	console.log(`verify-blend: ${results.length} checks passed`);
} finally {
	await rm(directory, { force: true, recursive: true });
}
