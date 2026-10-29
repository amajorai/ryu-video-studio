/**
 * Real-FFmpeg proof for the advanced grade (W2-V5). Single color cards (and a
 * gradient) render through `buildRender` with each grade control, and pixels
 * are compared with the CPU reference in `shared/color-advanced.ts`.
 *
 * LUTs are imported through `LutStore` into a directory whose name contains
 * a colon, a space, a comma and brackets, so the `lut3d` path escaping is
 * exercised too.
 *
 * Run: `bun src/verify-color-advanced.ts`
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileGrade, type Rgb } from "../../shared/color-advanced.ts";
import { lookGrade } from "../../shared/color-looks.ts";
import {
	identityCubeLut,
	parseCubeLut,
	serializeCubeLut,
} from "../../shared/cube-lut.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	segmentSchema,
} from "../../shared/project.ts";
import type { ColorGrade } from "../../shared/schema/color.ts";
import { LutStore } from "./lut-store.ts";
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

const WIDTH = 256;
const HEIGHT = 144;

const root = await mkdtemp(join(tmpdir(), "ryu-verify-color-"));
const results: string[] = [];
try {
	const lutDirectory = join(root, "store: a,b [1]");
	await mkdir(lutDirectory, { recursive: true });
	const luts = new LutStore(lutDirectory);
	const identity = await luts.add(
		"Identity",
		serializeCubeLut(identityCubeLut(17))
	);
	const invertText =
		"LUT_3D_SIZE 2\n1 1 1\n0 1 1\n1 0 1\n0 0 1\n1 1 0\n0 1 0\n1 0 0\n0 0 0\n";
	const invert = await luts.add("Invert", invertText);
	const invertLut = parseCubeLut(invertText);
	const lutPath = (id: string) => luts.path(id);

	let assetCount = 0;
	async function card(
		name: string,
		source: string
	): Promise<{ asset: Asset; path: string }> {
		assetCount += 1;
		const path = join(root, `${name}.png`);
		await runMedia([
			"-y",
			"-f",
			"lavfi",
			"-i",
			`${source}:s=${WIDTH}x${HEIGHT},format=rgb24`,
			"-frames:v",
			"1",
			path,
		]);
		return {
			asset: {
				createdAt: "2026-01-01T00:00:00.000Z",
				duration: 5,
				hasAudio: false,
				height: HEIGHT,
				id: `00000000-0000-4000-8000-${assetCount.toString(16).padStart(12, "0")}`,
				kind: "image",
				name: `${name}.png`,
				width: WIDTH,
			},
			path,
		};
	}

	function project(
		input: { asset: Asset },
		grade: Partial<ColorGrade>
	): Project {
		const segment = newSegment(input.asset);
		return {
			...newProject("Color proof"),
			height: HEIGHT,
			segments: [
				segmentSchema.parse({
					...segment,
					colorGrade: { ...segment.colorGrade, ...grade },
					sourceOut: 2,
				}),
			],
			styleProfile: "clean-professional",
			width: WIDTH,
		};
	}

	async function decode(
		name: string,
		source: string,
		seek?: number
	): Promise<(x: number, y: number) => Rgb> {
		const raw = join(root, `${name}.rgb`);
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

	async function frame(
		name: string,
		input: { asset: Asset; path: string },
		grade: Partial<ColorGrade>
	) {
		const png = join(root, `${name}-out.png`);
		const args = buildRender(
			project(input, grade),
			[input.asset],
			() => input.path,
			undefined,
			[],
			1,
			{ lutPath }
		);
		await runMedia([...args, png], { cwd: root });
		return decode(name, png);
	}

	function expectPixel(
		name: string,
		actual: Rgb,
		expected: Rgb,
		tolerance: number
	) {
		const off = actual.some(
			(value, index) => Math.abs(value - (expected[index] ?? 0)) > tolerance
		);
		ensure(
			!off,
			`${name}: got rgb(${actual.join(",")}), expected rgb(${expected.map((value) => Math.round(value)).join(",")})`
		);
	}

	const toUnit = (rgb: Rgb): Rgb => [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
	const toByte = (rgb: Rgb): Rgb => [rgb[0] * 255, rgb[1] * 255, rgb[2] * 255];

	// Plan acceptance 1: an identity LUT keeps every pixel within 2.
	const gradient = await card("gradient", "testsrc2=d=1");
	const plain = await frame("gradient-plain", gradient, {});
	const viaIdentity = await frame("gradient-identity", gradient, {
		lut: { intensity: 1, lutId: identity.id },
	});
	let worst = 0;
	for (let y = 2; y < HEIGHT; y += 7) {
		for (let x = 2; x < WIDTH; x += 7) {
			const a = plain(x, y);
			const b = viaIdentity(x, y);
			for (let channel = 0; channel < 3; channel++) {
				worst = Math.max(
					worst,
					Math.abs((a[channel] ?? 0) - (b[channel] ?? 0))
				);
			}
		}
	}
	ensure(worst <= 2, `identity LUT moved a pixel by ${worst}`);
	results.push(`identity LUT keeps pixels (max difference ${worst})`);

	// Plan acceptance 2: an invert master curve flips gray 0.2 to 0.8.
	const gray = await card("gray", "color=c=0x333333");
	const inverted = await frame("gray-invert-curve", gray, {
		curves: {
			master: [
				{ x: 0, y: 1 },
				{ x: 1, y: 0 },
			],
		},
	});
	expectPixel("invert curve", inverted(128, 72), [204, 204, 204], 3);
	results.push("invert curve flips gray 0.2 to 0.8");

	async function againstReference(
		name: string,
		input: { asset: Asset; path: string },
		color: Rgb,
		grade: Partial<ColorGrade>,
		tolerance: number,
		lut?: ReturnType<typeof parseCubeLut>
	) {
		const sample = await frame(name, input, grade);
		const reference = compileGrade(
			{ exposure: 0, temperature: 0, tint: 0, vibrance: 0, ...grade },
			lut
		)(toUnit(color));
		expectPixel(name, sample(128, 72), toByte(reference), tolerance);
		results.push(`${name} matches the reference`);
	}

	// LUTs: full strength and the split/blend intensity mix.
	await againstReference(
		"invert LUT",
		gray,
		[51, 51, 51],
		{ lut: { intensity: 1, lutId: invert.id } },
		3,
		invertLut
	);
	await againstReference(
		"invert LUT at 25%",
		gray,
		[51, 51, 51],
		{ lut: { intensity: 0.25, lutId: invert.id } },
		3,
		invertLut
	);
	// Levels and the tone curve.
	await againstReference(
		"crushed blacks",
		gray,
		[51, 51, 51],
		{ blacks: 0.4 },
		3
	);
	await againstReference(
		"lifted blacks",
		gray,
		[51, 51, 51],
		{ blacks: -0.8 },
		3
	);
	await againstReference(
		"dimmed whites",
		gray,
		[51, 51, 51],
		{ whites: -1 },
		3
	);
	await againstReference(
		"lifted shadows",
		gray,
		[51, 51, 51],
		{ shadows: 0.8 },
		3
	);
	// Wheels (colorbalance) on a dark and a bright card.
	const dark = await card("dark", "color=c=0x202020");
	await againstReference(
		"blue lift",
		dark,
		[32, 32, 32],
		{ lift: { b: 0.6, g: 0, master: 0, r: -0.4 } },
		4
	);
	const bright = await card("bright", "color=c=0xd0d0d0");
	await againstReference(
		"warm gain",
		bright,
		[208, 208, 208],
		{ gain: { b: -0.4, g: 0, master: 0, r: 0.4 } },
		4
	);
	// Per-channel curves.
	await againstReference(
		"red channel curve",
		gray,
		[51, 51, 51],
		{
			curves: {
				red: [
					{ x: 0, y: 0.5 },
					{ x: 1, y: 1 },
				],
			},
		},
		3
	);

	// HSL: full desaturation of every band leaves a neutral pixel.
	const orange = await card("orange", "color=c=0xd2691e");
	const mono = await frame("orange-mono", orange, lookGrade("mono-contrast"));
	const [mr, mg, mb] = mono(128, 72);
	ensure(
		Math.max(mr, mg, mb) - Math.min(mr, mg, mb) <= 6,
		`mono look left colour: rgb(${mr},${mg},${mb})`
	);
	results.push("mono look removes colour");
	// An orange saturation boost raises orange saturation.
	const boosted = await frame("orange-boost", orange, {
		hsl: [{ band: "orange", hue: 0, lightness: 0, saturation: 1 }],
	});
	const before = (await decode("orange-source", orange.path))(128, 72);
	const after = boosted(128, 72);
	const chroma = (rgb: Rgb) => Math.max(...rgb) - Math.min(...rgb);
	ensure(
		chroma(after) > chroma(before),
		`orange boost did not add saturation: ${before} → ${after}`
	);
	results.push("orange band saturation boost adds chroma");

	await againstReference(
		"red band desaturation",
		orange,
		[210, 105, 30],
		{ hsl: [{ band: "red", hue: 0, lightness: 0, saturation: -1 }] },
		8
	);
	await againstReference(
		"red band boost",
		orange,
		[210, 105, 30],
		{ hsl: [{ band: "red", hue: 0, lightness: 0, saturation: 1 }] },
		8
	);
	// Near-identical hue-vs-sat grades render alike: a flat curve and one
	// tilted by 0.01 must not jump between a global and a selective filter.
	const pinkish = await card("pinkish", "color=c=0x996666");
	const flat = (
		await frame("hue-vs-sat-flat", pinkish, {
			hueVsSat: [
				{ x: 0, y: 0.25 },
				{ x: 1, y: 0.25 },
			],
		})
	)(128, 72);
	const tilted = (
		await frame("hue-vs-sat-tilted", pinkish, {
			hueVsSat: [
				{ x: 0, y: 0.25 },
				{ x: 1, y: 0.26 },
			],
		})
	)(128, 72);
	expectPixel("tilted hue-vs-sat stays near the flat one", tilted, flat, 4);
	results.push(
		`close hue-vs-sat grades render alike (rgb(${flat.join(",")}) vs rgb(${tilted.join(",")}))`
	);
	await againstReference(
		"tilted hue-vs-sat",
		pinkish,
		[153, 102, 102],
		{
			hueVsSat: [
				{ x: 0, y: 0.25 },
				{ x: 1, y: 0.26 },
			],
		},
		8
	);
	// Every look renders.
	for (const id of [
		"warm-film",
		"teal-orange",
		"cross-process",
		"matte",
	] as const) {
		await frame(`look-${id}`, orange, lookGrade(id));
	}
	results.push("looks render through FFmpeg");

	// A full export with a partial LUT (the forked chain must close cleanly).
	const exportPath = join(root, "export.mp4");
	await runMedia(
		[
			...buildRender(
				project(gray, { lut: { intensity: 0.5, lutId: invert.id } }),
				[gray.asset],
				() => gray.path,
				undefined,
				[],
				undefined,
				{ lutPath }
			),
			exportPath,
		],
		{ cwd: root }
	);
	const exported = await decode("export", exportPath, 1);
	expectPixel("export with a 50% LUT", exported(128, 72), [128, 128, 128], 4);
	results.push("export with a 50% LUT mixes the LUT");

	for (const result of results) {
		console.log(`ok  ${result}`);
	}
	console.log(`verify-color-advanced: ${results.length} checks passed`);
} finally {
	await rm(root, { force: true, recursive: true });
}
