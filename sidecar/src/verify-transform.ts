/**
 * Real-FFmpeg proof for flip, scale X/Y and fit (W2-V2). A test card whose
 * left half is red and right half is blue renders single frames through
 * `buildRender`, and pixels are sampled from the PNG.
 *
 * Run: `bun src/verify-transform.ts`
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
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

type Rgb = [number, number, number];
type Color = "background" | "blue" | "green" | "red";

function classify([r, g, b]: Rgb): Color | "other" {
	if (r > 180 && g < 70 && b < 70) {
		return "red";
	}
	if (b > 180 && r < 70 && g < 70) {
		return "blue";
	}
	if (g > 100 && r < 70 && b < 70) {
		return "green";
	}
	if (r < 30 && g < 30 && b < 30) {
		return "background";
	}
	return "other";
}

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-transform-"));
const results: string[] = [];
try {
	// 320x180: left half red, right half blue, bottom quarter green.
	const card = join(directory, "card.png");
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		"color=red:s=160x135[a];color=blue:s=160x135[b];color=0x00a000:s=320x45[c];[a][b]hstack[top];[top][c]vstack",
		"-frames:v",
		"1",
		card,
	]);
	const asset: Asset = {
		createdAt: "2026-01-01T00:00:00.000Z",
		duration: 5,
		hasAudio: false,
		height: 180,
		id: "00000000-0000-4000-8000-0000000000a1",
		kind: "image",
		name: "card.png",
		width: 320,
	};

	async function rawFrame(
		patch: Partial<Segment>,
		size: { height: number; width: number },
		name: string,
		source = { asset, path: card }
	): Promise<Buffer> {
		const project: Project = {
			...newProject(`Transform ${name}`),
			height: size.height,
			styleProfile: "clean-professional",
			width: size.width,
		};
		project.segments = [
			segmentSchema.parse({ ...newSegment(source.asset), ...patch }),
		];
		const png = join(directory, `${name}.png`);
		await runMedia(
			[
				...buildRender(
					project,
					[source.asset],
					() => source.path,
					undefined,
					[],
					1
				),
				png,
			],
			{ cwd: directory }
		);
		const raw = join(directory, `${name}.rgb`);
		await runMedia([
			"-y",
			"-i",
			png,
			"-pix_fmt",
			"rgb24",
			"-f",
			"rawvideo",
			raw,
		]);
		const pixels = await readFile(raw);
		ensure(
			pixels.length === size.width * size.height * 3,
			`${name}: frame is not ${size.width}x${size.height}`
		);
		return pixels;
	}

	async function frame(
		patch: Partial<Segment>,
		size: { height: number; width: number },
		name: string
	): Promise<(x: number, y: number) => Color | "other"> {
		const pixels = await rawFrame(patch, size, name);
		return (x, y) => {
			const offset = (y * size.width + x) * 3;
			return classify([
				pixels[offset] ?? 0,
				pixels[offset + 1] ?? 0,
				pixels[offset + 2] ?? 0,
			]);
		};
	}

	/**
	 * Angle in degrees at the topmost corner of the bright shape: the corner
	 * between the vectors to its leftmost and rightmost pixels.
	 */
	function topCornerAngle(
		pixels: Buffer,
		size: { height: number; width: number }
	): number {
		const points: [number, number][] = [];
		for (let y = 0; y < size.height; y += 1) {
			for (let x = 0; x < size.width; x += 1) {
				const offset = (y * size.width + x) * 3;
				if (
					(pixels[offset] ?? 0) > 200 &&
					(pixels[offset + 1] ?? 0) > 200 &&
					(pixels[offset + 2] ?? 0) > 200
				) {
					points.push([x, y]);
				}
			}
		}
		ensure(points.length > 0, "no bright shape in the frame");
		const pick = (score: (point: [number, number]) => number) =>
			points.reduce((best, point) =>
				score(point) < score(best) ? point : best
			);
		const top = pick(([, y]) => y);
		const left = pick(([x]) => x);
		const right = pick(([x]) => -x);
		const toLeft = [left[0] - top[0], left[1] - top[1]];
		const toRight = [right[0] - top[0], right[1] - top[1]];
		const cosine =
			((toLeft[0] ?? 0) * (toRight[0] ?? 0) +
				(toLeft[1] ?? 0) * (toRight[1] ?? 0)) /
			(Math.hypot(toLeft[0] ?? 0, toLeft[1] ?? 0) *
				Math.hypot(toRight[0] ?? 0, toRight[1] ?? 0));
		return (Math.acos(cosine) * 180) / Math.PI;
	}

	function expectColors(
		name: string,
		sample: (x: number, y: number) => Color | "other",
		points: [number, number, Color][]
	) {
		for (const [x, y, color] of points) {
			const actual = sample(x, y);
			ensure(
				actual === color,
				`${name}: pixel (${x},${y}) is ${actual}, expected ${color}`
			);
		}
		results.push(name);
	}

	const landscape = { height: 180, width: 320 };
	const portrait = { height: 320, width: 180 };

	expectColors("plain card", await frame({}, landscape, "plain"), [
		[40, 60, "red"],
		[280, 60, "blue"],
		[160, 170, "green"],
	]);
	expectColors(
		"flipH puts red on the right",
		await frame({ flipH: true }, landscape, "flip-h"),
		[
			[40, 60, "blue"],
			[280, 60, "red"],
		]
	);
	expectColors(
		"flipV puts green on top",
		await frame({ flipV: true }, landscape, "flip-v"),
		[
			[160, 10, "green"],
			[40, 120, "red"],
		]
	);
	expectColors(
		"fit letterboxes 16:9 in 9:16",
		await frame({}, portrait, "fit-portrait"),
		[
			[90, 20, "background"],
			[40, 140, "red"],
			[140, 140, "blue"],
		]
	);
	expectColors(
		"fill covers 9:16 with a centre crop",
		await frame({ fit: "fill" }, portrait, "fill-portrait"),
		[
			[40, 20, "red"],
			[140, 20, "blue"],
			[90, 310, "green"],
		]
	);
	expectColors(
		"stretch with scale X 0.5 squeezes the width",
		await frame({ fit: "stretch", scaleX: 0.5 }, landscape, "stretch-x"),
		[
			[40, 60, "background"],
			[100, 60, "red"],
			[220, 60, "blue"],
			[280, 60, "background"],
		]
	);
	expectColors(
		"fit with scale X 0.5 keeps the aspect",
		await frame({ scaleX: 0.5 }, landscape, "fit-x"),
		[
			[100, 30, "background"],
			[100, 80, "red"],
			[220, 80, "blue"],
		]
	);
	expectColors(
		"keyframed scale X grows past the canvas inside the pad",
		await frame(
			{
				fit: "stretch",
				keyframes: [
					{
						id: "00000000-0000-4000-8000-0000000000b1",
						property: "scaleX",
						time: 0,
						value: 0.5,
					},
					{
						id: "00000000-0000-4000-8000-0000000000b2",
						property: "scaleX",
						time: 2,
						value: 2,
					},
				],
			},
			landscape,
			"keyframed-x"
		),
		[
			[5, 60, "red"],
			[315, 60, "blue"],
		]
	);
	// 160x90 dark frame with a centred white 80x46 rectangle.
	const box = join(directory, "box.png");
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		"color=0x202020:s=160x90,drawbox=x=40:y=22:w=80:h=46:color=white:t=fill",
		"-frames:v",
		"1",
		box,
	]);
	const boxAsset: Asset = {
		...asset,
		height: 90,
		id: "00000000-0000-4000-8000-0000000000a2",
		name: "box.png",
		width: 160,
	};
	const square = { height: 400, width: 400 };
	for (const [name, patch] of [
		["rotated stretch keeps right angles", { fit: "stretch", scaleX: 0.5 }],
		["rotated fill keeps right angles", { fit: "fill", scaleX: 0.5 }],
		["rotated non-uniform fit keeps right angles", { scaleX: 0.5 }],
	] as const) {
		const pixels = await rawFrame(
			{ ...patch, rotation: 30 },
			square,
			name.replaceAll(" ", "-"),
			{ asset: boxAsset, path: box }
		);
		const angle = topCornerAngle(pixels, square);
		ensure(
			Math.abs(angle - 90) < 4,
			`${name}: top corner is ${angle.toFixed(1)} degrees, expected 90`
		);
		results.push(`${name} (${angle.toFixed(1)} degrees)`);
	}
	expectColors(
		"keyframed stretch with rotation renders inside the pad",
		await frame(
			{
				fit: "stretch",
				keyframes: [
					{
						id: "00000000-0000-4000-8000-0000000000b3",
						property: "scaleX",
						time: 0,
						value: 0.5,
					},
					{
						id: "00000000-0000-4000-8000-0000000000b4",
						property: "scaleX",
						time: 2,
						value: 2,
					},
				],
				rotation: 5,
			},
			landscape,
			"keyframed-rotated"
		),
		[
			[40, 90, "red"],
			[280, 90, "blue"],
		]
	);
	expectColors(
		"fill with a keyframed box covers without stretching",
		await frame(
			{
				fit: "fill",
				keyframes: [
					{
						id: "00000000-0000-4000-8000-0000000000b5",
						property: "scaleX",
						time: 0,
						value: 0.5,
					},
					{
						id: "00000000-0000-4000-8000-0000000000b6",
						property: "scaleX",
						time: 2,
						value: 2,
					},
				],
			},
			landscape,
			"fill-keyframed"
		),
		[
			// At 1 s the box is 400x180. The first-frame crop (a centred 8:9
			// column) covers it at 400x450, which pushes the green bottom
			// quarter off the canvas; stretching it to the box would show green.
			[10, 90, "red"],
			[310, 90, "blue"],
			[10, 170, "red"],
			[310, 170, "blue"],
		]
	);
	for (const line of results) {
		console.info(`PASS: ${line}`);
	}
} finally {
	await rm(directory, { force: true, recursive: true });
}
