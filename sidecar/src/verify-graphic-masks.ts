/**
 * Real-FFmpeg proof for masks on shape graphics. A red graphic with a
 * 180x180 px box sits in the middle of a black 640x360 frame; single frames
 * and a short export render through `buildRender`, and pixels are compared
 * with the shared mask reference (`maskAlphaAtPoint`, `maskStrokeAlphaAtPoint`)
 * in the graphic's own box: the red channel carries the masked fill, the
 * green channel a green mask stroke. Rotation (static and keyframed) and a
 * keyframed scale must carry the masks with the graphic, and the preview's
 * mask SVG (rasterized by librsvg when FFmpeg has it) must agree.
 *
 * Run: `bun src/verify-graphic-masks.ts`
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defaultMask,
	type Mask,
	maskAlphaAtPoint,
	maskStrokeAlphaAtPoint,
	maskToSvg,
} from "../../shared/masks.ts";
import {
	type Graphic,
	graphicSchema,
	newProject,
	type Project,
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

const WIDTH = 640;
const HEIGHT = 360;
/**
 * A 180 px box at (230, 90): its normalized position is exact, and the
 * raster's top-left lands on even pixels, so 4:2:0 overlay snapping does not
 * shift it.
 */
const BOX = 180;
const LEFT = (WIDTH - BOX) / 2;
const TOP = (HEIGHT - BOX) / 2;
const maskId = (index: number) => `00000000-0000-4000-8000-00000000000${index}`;

function graphic(fields: Partial<Graphic>): Graphic {
	return graphicSchema.parse({
		animation: "none",
		end: 4,
		entryDuration: 0,
		fill: "#ff0000",
		height: BOX / HEIGHT,
		id: crypto.randomUUID(),
		opacity: 1,
		shape: "rectangle",
		start: 0,
		strokeAlign: "inside",
		strokeWidth: 0,
		width: BOX / WIDTH,
		x: LEFT / WIDTH,
		y: TOP / HEIGHT,
		...fields,
	});
}

function project(graphics: Graphic[]): Project {
	return {
		...newProject("Graphic masks proof"),
		graphics,
		height: HEIGHT,
		styleProfile: "clean-professional",
		width: WIDTH,
	};
}

type Sampler = (x: number, y: number) => [number, number, number];

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-graphic-masks-"));
const results: string[] = [];
try {
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
				(pixels[offset] ?? 0) / 255,
				(pixels[offset + 1] ?? 0) / 255,
				(pixels[offset + 2] ?? 0) / 255,
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

	/** Reference [masked fill, stroke] at a frame pixel of the unrotated box. */
	function reference(masks: readonly Mask[], x: number, y: number) {
		const bx = x + 0.5 - LEFT;
		const by = y + 0.5 - TOP;
		if (bx < 0 || by < 0 || bx > BOX || by > BOX) {
			return [0, 0] as const;
		}
		let fill = 1;
		let stroke = 0;
		for (const mask of masks) {
			fill *= maskAlphaAtPoint(mask, bx, by, BOX, BOX);
		}
		for (const mask of masks) {
			const band = maskStrokeAlphaAtPoint(mask, bx, by, BOX, BOX);
			fill *= 1 - band;
			stroke = band + stroke * (1 - band);
		}
		return [fill, stroke] as const;
	}

	async function compareWithReference(name: string, masks: Mask[]) {
		const frame = await renderFrame(name, [graphic({ masks })]);
		let compared = 0;
		let wrong = 0;
		for (let y = TOP - 4; y < TOP + BOX + 4; y++) {
			for (let x = LEFT - 4; x < LEFT + BOX + 4; x++) {
				const [fill, stroke] = reference(masks, x, y);
				const edge = [-2, -1, 1, 2].some((offset) =>
					[
						reference(masks, x + offset, y),
						reference(masks, x, y + offset),
					].some(
						([otherFill, otherStroke]) =>
							Math.abs(otherFill - fill) > 0.02 ||
							Math.abs(otherStroke - stroke) > 0.02
					)
				);
				if (edge) {
					continue;
				}
				compared++;
				const [red, green] = frame(x, y);
				if (Math.abs(red - fill) > 0.1 || Math.abs(green - stroke) > 0.1) {
					wrong++;
				}
			}
		}
		const share = wrong / compared;
		ensure(
			share <= 0.01,
			`${name}: ${(share * 100).toFixed(2)}% of ${compared} pixels differ from the reference`
		);
		results.push(
			`${name}: ${(100 - share * 100).toFixed(2)}% of ${compared} pixels match the mask reference`
		);
		return frame;
	}

	const ellipse: Mask = { ...defaultMask("ellipse", maskId(1)), width: 0.8 };
	await compareWithReference("ellipse", [ellipse]);
	await compareWithReference("star-inverted", [
		{
			...defaultMask("star", maskId(1)),
			height: 0.7,
			invert: true,
			width: 0.7,
		},
	]);
	await compareWithReference("polygon-stroke-center", [
		{
			...defaultMask("polygon", maskId(1)),
			height: 0.8,
			rotation: 15,
			sides: 5,
			strokeColor: "#00ff00",
			strokeWidth: 0.05,
			width: 0.8,
		},
	]);
	await compareWithReference("two-masks-stroke-inside", [
		{ ...defaultMask("rectangle", maskId(1)), width: 0.5, x: -0.5 },
		{
			...defaultMask("ellipse", maskId(2)),
			strokeAlign: "inside",
			strokeColor: "#00ff00",
			strokeWidth: 0.04,
		},
	]);

	// Static rotation: a mask over the box's left half turns with the box.
	const leftHalf: Mask = {
		...defaultMask("rectangle", maskId(1)),
		width: 0.5,
		x: -0.5,
	};
	const rotated = await renderFrame("rotated", [
		graphic({ masks: [leftHalf], rotation: 90 }),
	]);
	const centerX = LEFT + BOX / 2;
	const centerY = TOP + BOX / 2;
	ensure(
		rotated(centerX, centerY - 50)[0] > 0.9 &&
			rotated(centerX, centerY + 50)[0] < 0.1,
		"rotated: the left-half mask should cover the top half after a 90° turn"
	);
	results.push("rotated: a left-half mask covers the top half at 90°");

	// Keyframed rotation: the masked half follows the turning graphic.
	const turning = graphic({
		keyframes: [
			{ id: maskId(5), property: "rotation", time: 0, value: 0 },
			{ id: maskId(6), property: "rotation", time: 2, value: 180 },
		],
		masks: [leftHalf],
	});
	const atStart = await renderFrame("turning-0", [turning], 0);
	const atEnd = await renderFrame("turning-2", [turning], 2);
	ensure(
		atStart(centerX - 50, centerY)[0] > 0.9 &&
			atStart(centerX + 50, centerY)[0] < 0.1 &&
			atEnd(centerX + 50, centerY)[0] > 0.9 &&
			atEnd(centerX - 50, centerY)[0] < 0.1,
		"keyframed rotation: the masked half should turn with the graphic"
	);
	results.push(
		"keyframed rotation: the kept half moves from left (0 s) to right (2 s)"
	);

	// Keyframed scale (a shape-keyframed raster): the mask scales with the box.
	const growing = graphic({
		keyframes: [
			{ id: maskId(5), property: "scale", time: 0, value: 0.5 },
			{ id: maskId(6), property: "scale", time: 2, value: 1 },
		],
		masks: [leftHalf],
	});
	const small = await renderFrame("scale-0", [growing], 0);
	const large = await renderFrame("scale-2", [growing], 2);
	ensure(
		small(centerX - 25, centerY)[0] > 0.9 &&
			small(centerX - 75, centerY)[0] < 0.1 &&
			small(centerX + 25, centerY)[0] < 0.1 &&
			large(centerX - 75, centerY)[0] > 0.9,
		"keyframed scale: the mask should scale with the graphic box"
	);
	results.push(
		"keyframed scale: the mask follows the box from half to full size"
	);

	// Export: the masked raster holds through a short video.
	{
		const path = join(directory, "export.mp4");
		const args = buildRender(
			project([graphic({ end: 2, masks: [ellipse] })]),
			[],
			() => ""
		);
		await runMedia([...args, path], { cwd: directory });
		const late = await sampler("export-late", path, 1.5);
		ensure(
			late(centerX, centerY)[0] > 0.9 && late(LEFT + 5, TOP + 5)[0] < 0.1,
			"export: the ellipse mask should hold 1.5 s into the export"
		);
		results.push("export: the masked graphic holds 1.5 s into a 2 s export");
	}

	// Preview parity: the preview's mask SVG agrees with the render.
	const decoders = await runMedia(["-hide_banner", "-decoders"]);
	if (decoders.includes("librsvg")) {
		const soft: Mask = {
			...defaultMask("heart", maskId(1)),
			feather: 0.2,
			height: 0.8,
			width: 0.8,
		};
		const rendered = await renderFrame("parity", [graphic({ masks: [soft] })]);
		const svgPath = join(directory, "parity.svg");
		await Bun.write(svgPath, maskToSvg({ ...soft, feather: 0 }, BOX, BOX));
		// White has no chroma, so 4:2:0 cannot bleed it past the mask edge.
		const hard = await renderFrame("parity-hard", [
			graphic({ fill: "#ffffff", masks: [{ ...soft, feather: 0 }] }),
		]);
		const raw = join(directory, "parity-svg.rgba");
		await runMedia([
			"-y",
			"-i",
			svgPath,
			"-frames:v",
			"1",
			"-pix_fmt",
			"rgba",
			"-f",
			"rawvideo",
			raw,
		]);
		const svg = await readFile(raw);
		let total = 0;
		let worst = 0;
		for (let y = 0; y < BOX; y++) {
			for (let x = 0; x < BOX; x++) {
				const preview = (svg[(y * BOX + x) * 4 + 3] ?? 0) / 255;
				const difference = Math.abs(preview - hard(LEFT + x, TOP + y)[0]);
				total += difference;
				worst = Math.max(worst, difference);
			}
		}
		const mean = total / (BOX * BOX);
		ensure(
			mean < 0.01 && worst < 0.6,
			`parity: preview mask and render differ (mean ${mean.toFixed(3)}, worst ${worst.toFixed(3)})`
		);
		const middle = rendered(centerX, centerY)[0];
		ensure(middle > 0.9, "parity: the feathered heart keeps its middle");
		results.push(
			`parity: preview mask SVG vs render, mean ${mean.toFixed(3)}, worst ${worst.toFixed(3)}; feathered middle ${middle.toFixed(2)}`
		);
	} else {
		results.push("parity: skipped, this FFmpeg has no librsvg decoder");
	}
} finally {
	await rm(directory, { force: true, recursive: true });
}
for (const line of results) {
	process.stdout.write(`ok  ${line}\n`);
}
