/**
 * Real-FFmpeg proof for clip masks (W2-V3). A solid red image fills a black
 * 320x180 canvas; single frames render through `buildRender` with masks, and
 * the red channel (the clip's alpha over black) is compared with the pure
 * reference `maskAlphaAt` from `shared/masks.ts`. Mask strokes are drawn in
 * pure green, so the green channel is the stroke alpha and is compared with
 * `maskStrokeAlphaAt`.
 *
 * Run: `bun src/verify-masks.ts`
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defaultMask,
	type Mask,
	maskAlphaAt,
	maskStrokeAlphaAt,
	maskStrokeSvg,
	maskSvgPad,
	maskToSvg,
} from "../../shared/masks.ts";
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
import { maskMatteFilters, staticMaskValue } from "./render-stages/mask.ts";

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
const maskId = (index: number) => `00000000-0000-4000-8000-00000000000${index}`;

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-masks-"));
const results: string[] = [];
try {
	const card = join(directory, "red.png");
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=red:s=${WIDTH}x${HEIGHT}`,
		"-frames:v",
		"1",
		card,
	]);
	const asset: Asset = {
		createdAt: "2026-01-01T00:00:00.000Z",
		duration: 5,
		hasAudio: false,
		height: HEIGHT,
		id: "00000000-0000-4000-8000-0000000000a1",
		kind: "image",
		name: "red.png",
		width: WIDTH,
	};

	/**
	 * Alpha (0..1) of the clip per pixel: its red channel over black. Pass
	 * `channel` 1 to read green (a green mask stroke's alpha).
	 */
	async function alphaFrame(
		patch: Partial<Segment>,
		name: string,
		frameTime = 1
	): Promise<(x: number, y: number, channel?: number) => number> {
		const project: Project = {
			...newProject(`Masks ${name}`),
			height: HEIGHT,
			styleProfile: "clean-professional",
			width: WIDTH,
		};
		project.segments = [
			segmentSchema.parse({ ...newSegment(asset), ...patch }),
		];
		const png = join(directory, `${name}.png`);
		await runMedia(
			[
				...buildRender(project, [asset], () => card, undefined, [], frameTime),
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
			pixels.length === WIDTH * HEIGHT * 3,
			`${name}: frame is not ${WIDTH}x${HEIGHT}`
		);
		return (x, y, channel = 0) =>
			(pixels[(y * WIDTH + x) * 3 + channel] ?? 0) / 255;
	}

	/**
	 * Share of pixels whose rendered alpha differs from the reference by more
	 * than `tolerance`, ignoring pixels the reference puts on an edge.
	 */
	async function compareWithReference(
		masks: Mask[],
		name: string,
		limit = 0.01
	) {
		const alpha = await alphaFrame({ masks }, name);
		let compared = 0;
		let wrong = 0;
		for (let y = 0; y < HEIGHT; y++) {
			for (let x = 0; x < WIDTH; x++) {
				const neighbours = [
					[x, y],
					[x - 1, y],
					[x + 1, y],
					[x, y - 1],
					[x, y + 1],
				].map(([px = 0, py = 0]) =>
					masks.reduce(
						(product, mask) =>
							product * maskAlphaAt(mask, px, py, WIDTH, HEIGHT),
						1
					)
				);
				const expected = neighbours[0] ?? 0;
				const edge = neighbours.some(
					(value) => Math.abs(value - expected) > 0.02
				);
				if (edge) {
					continue;
				}
				compared++;
				if (Math.abs(alpha(x, y) - expected) > 0.06) {
					wrong++;
				}
			}
		}
		const share = wrong / compared;
		ensure(
			share <= limit,
			`${name}: ${(share * 100).toFixed(2)}% of ${compared} pixels differ from the reference`
		);
		results.push(
			`${name}: ${(100 - share * 100).toFixed(2)}% of ${compared} interior pixels match the reference`
		);
	}

	// Acceptance: an inverted ellipse hides the center and keeps the corners.
	const inverted = await alphaFrame(
		{
			masks: [
				{
					...defaultMask("ellipse", maskId(1)),
					height: 0.6,
					invert: true,
					width: 0.4,
				},
			],
		},
		"ellipse-invert"
	);
	ensure(
		inverted(WIDTH / 2, HEIGHT / 2) < 0.05,
		"ellipse-invert: the center should show the black canvas"
	);
	ensure(
		inverted(4, 4) > 0.95,
		"ellipse-invert: the corner should show the red clip"
	);
	results.push("ellipse-invert: center is the canvas, corner is the clip");

	await compareWithReference(
		[
			{
				...defaultMask("rectangle", maskId(1)),
				cornerRadius: 0.25,
				height: 0.7,
				rotation: 30,
				width: 0.5,
				x: 0.1,
			},
		],
		"rectangle-rounded-rotated"
	);
	await compareWithReference(
		[{ ...defaultMask("ellipse", maskId(1)), width: 0.6, x: -0.2, y: 0.1 }],
		"ellipse"
	);
	await compareWithReference(
		[{ ...defaultMask("polygon", maskId(1)), rotation: 15, sides: 5 }],
		"polygon"
	);
	await compareWithReference(
		[{ ...defaultMask("star", maskId(1)), height: 0.9, width: 0.5 }],
		"star"
	);
	await compareWithReference(
		[{ ...defaultMask("heart", maskId(1)), height: 0.8, width: 0.45 }],
		"heart"
	);
	await compareWithReference(
		[
			{
				...defaultMask("freeform", maskId(1)),
				path: [
					{ outX: 0.6, outY: -0.9, x: 0, y: -0.8 },
					{ x: 0.8, y: 0.7 },
					{ inX: -0.9, inY: 0.9, x: -0.7, y: 0.5 },
				],
			},
		],
		"freeform-bezier"
	);
	await compareWithReference(
		[{ ...defaultMask("linear", maskId(1)), feather: 0.3, rotation: 20 }],
		"linear-ramp"
	);
	await compareWithReference(
		[
			{
				...defaultMask("mirror", maskId(1)),
				feather: 0.1,
				height: 0.4,
				rotation: -45,
			},
		],
		"mirror-band"
	);
	await compareWithReference(
		[
			{ ...defaultMask("rectangle", maskId(1)), width: 1, x: -0.5 },
			{ ...defaultMask("ellipse", maskId(2)), opacity: 0.5, width: 0.7 },
		],
		"two-masks-multiply"
	);

	/**
	 * Share of interior pixels whose green channel (the stroke) differs from
	 * `maskStrokeAlphaAt` by more than 0.1. Pixels within two of a stroke
	 * edge, or of a mask edge outside the stroke, are skipped: 4:2:0 chroma
	 * blurs them.
	 */
	async function compareStrokeWithReference(
		mask: Mask,
		name: string,
		limit = 0.01
	) {
		const frame = await alphaFrame({ masks: [mask] }, name);
		let compared = 0;
		let wrong = 0;
		let stroked = 0;
		for (let y = 0; y < HEIGHT; y++) {
			for (let x = 0; x < WIDTH; x++) {
				const around = [-2, -1, 0, 1, 2].flatMap((dy) =>
					[-2, -1, 0, 1, 2].map((dx) => [x + dx, y + dy] as const)
				);
				const expected = maskStrokeAlphaAt(mask, x, y, WIDTH, HEIGHT);
				const edge = around.some(
					([px, py]) =>
						Math.abs(
							maskStrokeAlphaAt(mask, px, py, WIDTH, HEIGHT) - expected
						) > 0.02 ||
						(expected < 0.98 &&
							Math.abs(
								maskAlphaAt(mask, px, py, WIDTH, HEIGHT) -
									maskAlphaAt(mask, x, y, WIDTH, HEIGHT)
							) > 0.02)
				);
				if (edge) {
					continue;
				}
				compared++;
				stroked += expected > 0.5 ? 1 : 0;
				if (Math.abs(frame(x, y, 1) - expected) > 0.1) {
					wrong++;
				}
			}
		}
		const share = wrong / compared;
		ensure(stroked > 50, `${name}: the reference stroke covers too few pixels`);
		ensure(
			share <= limit,
			`${name}: ${(share * 100).toFixed(2)}% of ${compared} pixels differ from the stroke reference`
		);
		results.push(
			`${name}: ${(100 - share * 100).toFixed(2)}% of ${compared} pixels (${stroked} stroked) match the stroke reference`
		);
	}

	const green = "#00ff00";
	await compareStrokeWithReference(
		{
			...defaultMask("rectangle", maskId(1)),
			cornerRadius: 0.2,
			height: 0.6,
			rotation: 20,
			strokeColor: green,
			strokeWidth: 0.05,
			width: 0.5,
		},
		"stroke-rectangle-center"
	);
	await compareStrokeWithReference(
		{
			...defaultMask("ellipse", maskId(1)),
			height: 0.6,
			strokeAlign: "outside",
			strokeColor: green,
			strokeWidth: 0.06,
			width: 0.4,
		},
		"stroke-ellipse-outside"
	);
	await compareStrokeWithReference(
		{
			...defaultMask("star", maskId(1)),
			height: 0.8,
			strokeAlign: "inside",
			strokeColor: green,
			strokeWidth: 0.05,
			width: 0.5,
		},
		"stroke-star-inside"
	);
	await compareStrokeWithReference(
		{
			...defaultMask("heart", maskId(1)),
			height: 0.7,
			invert: true,
			strokeColor: green,
			strokeWidth: 0.04,
			width: 0.4,
		},
		"stroke-heart-inverted"
	);
	await compareStrokeWithReference(
		{
			...defaultMask("mirror", maskId(1)),
			height: 0.4,
			rotation: 30,
			strokeAlign: "outside",
			strokeColor: green,
			strokeWidth: 0.04,
		},
		"stroke-mirror-outside"
	);

	// A stroke follows keyframed geometry: the outline moves with the mask.
	{
		const strokeMoving: Partial<Segment> = {
			keyframes: [
				{
					id: maskId(5),
					property: "maskX",
					target: maskId(1),
					time: 0,
					value: -0.5,
				},
				{
					id: maskId(6),
					property: "maskX",
					target: maskId(1),
					time: 2,
					value: 0.5,
				},
			],
			masks: [
				{
					...defaultMask("rectangle", maskId(1)),
					height: 0.4,
					strokeAlign: "outside",
					strokeColor: green,
					strokeWidth: 0.05,
					width: 0.2,
				},
			],
		};
		const first = await alphaFrame(strokeMoving, "stroke-keyframe-start", 0);
		const last = await alphaFrame(strokeMoving, "stroke-keyframe-end", 2);
		// The left edge of the box sits at x = (1 + maskX - width/2)/2 · W; the
		// outside stroke is just left of it.
		const edgeAt = (maskX: number) =>
			Math.round(((1 + maskX - 0.2) / 2) * WIDTH) - 4;
		ensure(
			first(edgeAt(-0.5), HEIGHT / 2, 1) > 0.8 &&
				last(edgeAt(-0.5), HEIGHT / 2, 1) < 0.1 &&
				last(edgeAt(0.5), HEIGHT / 2, 1) > 0.8,
			"stroke-keyframe: the stroke should follow the moving mask"
		);
		results.push(
			"stroke-keyframe: the outline follows keyframed maskX from 0 s to 2 s"
		);
	}

	// Feather: a soft ellipse edge, full inside, empty far outside.
	const feathered = await alphaFrame(
		{
			masks: [
				{
					...defaultMask("ellipse", maskId(1)),
					feather: 0.4,
					height: 0.5,
					width: 0.3,
				},
			],
		},
		"ellipse-feather"
	);
	const edgeX = Math.round(WIDTH / 2 + WIDTH * 0.15);
	const edge = feathered(edgeX, HEIGHT / 2);
	ensure(
		feathered(WIDTH / 2, HEIGHT / 2) > 0.9 &&
			feathered(2, HEIGHT / 2) < 0.05 &&
			edge > 0.25 &&
			edge < 0.75,
		`ellipse-feather: expected a soft edge, got ${edge.toFixed(2)} at the boundary`
	);
	results.push(
		`ellipse-feather: center ${feathered(WIDTH / 2, HEIGHT / 2).toFixed(2)}, boundary ${edge.toFixed(2)}, outside ${feathered(2, HEIGHT / 2).toFixed(2)}`
	);

	// Keyframed position: a small rectangle moves from left to right.
	const moving: Partial<Segment> = {
		keyframes: [
			{
				id: maskId(5),
				property: "maskX",
				target: maskId(1),
				time: 0,
				value: -0.6,
			},
			{
				id: maskId(6),
				property: "maskX",
				target: maskId(1),
				time: 2,
				value: 0.6,
			},
		],
		masks: [
			{ ...defaultMask("rectangle", maskId(1)), height: 0.4, width: 0.2 },
		],
	};
	const start = await alphaFrame(moving, "keyframe-start", 0);
	const end = await alphaFrame(moving, "keyframe-end", 2);
	const leftX = Math.round(WIDTH * 0.2);
	const rightX = Math.round(WIDTH * 0.8);
	ensure(
		start(leftX, HEIGHT / 2) > 0.9 && start(rightX, HEIGHT / 2) < 0.1,
		"keyframe-start: the mask should start on the left"
	);
	ensure(
		end(rightX, HEIGHT / 2) > 0.9 && end(leftX, HEIGHT / 2) < 0.1,
		"keyframe-end: the mask should end on the right"
	);
	results.push("keyframed maskX: left at 0 s, right at 2 s");

	// Keyframed feather crossfades from sharp to soft.
	const softening: Partial<Segment> = {
		keyframes: [
			{
				id: maskId(5),
				property: "maskFeather",
				target: maskId(1),
				time: 0,
				value: 0,
			},
			{
				id: maskId(6),
				property: "maskFeather",
				target: maskId(1),
				time: 2,
				value: 0.5,
			},
		],
		masks: [{ ...defaultMask("ellipse", maskId(1)), height: 0.5, width: 0.3 }],
	};
	const sharp = await alphaFrame(softening, "feather-start", 0);
	const soft = await alphaFrame(softening, "feather-end", 2);
	const justOutside = Math.round(WIDTH / 2 + WIDTH * 0.15 + 6);
	ensure(
		sharp(justOutside, HEIGHT / 2) < 0.05 &&
			soft(justOutside, HEIGHT / 2) > 0.1,
		"keyframed feather: the edge should soften over time"
	);
	results.push(
		`keyframed maskFeather: just outside the edge ${sharp(justOutside, HEIGHT / 2).toFixed(2)} → ${soft(justOutside, HEIGHT / 2).toFixed(2)}`
	);

	// Text: white glyphs on black keep the clip only inside the letters.
	const text = await alphaFrame(
		{
			masks: [
				{
					...defaultMask("text", maskId(1)),
					height: 0.5,
					text: "IIII",
					width: 1,
				},
			],
		},
		"text"
	);
	let inside = 0;
	for (let x = 0; x < WIDTH; x++) {
		inside += text(x, HEIGHT / 2) > 0.5 ? 1 : 0;
	}
	ensure(
		inside > 4 && inside < WIDTH / 2 && text(2, 2) < 0.05,
		`text: expected glyph columns across the middle row, got ${inside}`
	);
	results.push(
		`text: ${inside} glyph pixels across the middle row, corners hidden`
	);

	// Moved and rotated text stays in the right half.
	const movedText = await alphaFrame(
		{
			masks: [
				{
					...defaultMask("text", maskId(1)),
					height: 0.3,
					rotation: 90,
					text: "MASK",
					width: 1,
					x: 0.5,
				},
			],
		},
		"text-moved"
	);
	let leftHalf = 0;
	let rightHalf = 0;
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			if (movedText(x, y) > 0.5) {
				if (x < WIDTH / 2) {
					leftHalf++;
				} else {
					rightHalf++;
				}
			}
		}
	}
	ensure(
		leftHalf === 0 && rightHalf > 50,
		`text-moved: expected glyphs only in the right half, got ${leftHalf} left and ${rightHalf} right`
	);
	results.push(`text-moved: ${rightHalf} glyph pixels, all in the right half`);

	// No masks: the clip is untouched.
	const plain = await alphaFrame({}, "plain");
	ensure(
		plain(2, 2) > 0.95 && plain(WIDTH / 2, HEIGHT / 2) > 0.95,
		"plain: an unmasked clip should cover the canvas"
	);
	results.push("plain: unmasked clip covers the canvas");

	// A static matte is drawn once and held for every later frame: export a
	// 2 s clip and read a frame near its end.
	{
		const project: Project = {
			...newProject("Masks held"),
			height: HEIGHT,
			styleProfile: "clean-professional",
			width: WIDTH,
		};
		project.segments = [
			segmentSchema.parse({
				...newSegment(asset),
				masks: [
					{ ...defaultMask("ellipse", maskId(1)), height: 0.5, width: 0.3 },
				],
				sourceOut: 2,
			}),
		];
		const movie = join(directory, "held.mp4");
		await runMedia(
			[...buildRender(project, [asset], () => card), "-y", movie],
			{ cwd: directory }
		);
		const raw = join(directory, "held.rgb");
		await runMedia([
			"-y",
			"-ss",
			"1.8",
			"-i",
			movie,
			"-frames:v",
			"1",
			"-pix_fmt",
			"rgb24",
			"-f",
			"rawvideo",
			raw,
		]);
		const pixels = await readFile(raw);
		const red = (x: number, y: number) =>
			(pixels[(y * WIDTH + x) * 3] ?? 0) / 255;
		ensure(
			red(WIDTH / 2, HEIGHT / 2) > 0.85 && red(4, 4) < 0.15,
			`held: frame at 1.8 s should still be masked (center ${red(WIDTH / 2, HEIGHT / 2).toFixed(2)}, corner ${red(4, 4).toFixed(2)})`
		);
		results.push(
			"held: a static matte still masks the clip 1.8 s into a 2 s export"
		);
	}

	// Preview parity at the frame border: the preview SVG (rasterized by
	// librsvg) and the render agree where a feathered shape meets the edge.
	const decoders = await runMedia(["-hide_banner", "-decoders"]);
	if (decoders.includes("librsvg")) {
		const borderCases: [string, Mask][] = [
			[
				"full-frame-rectangle",
				{ ...defaultMask("rectangle", maskId(1)), feather: 0.5 },
			],
			[
				"ellipse-past-edge",
				{
					...defaultMask("ellipse", maskId(1)),
					feather: 0.4,
					width: 0.6,
					x: 0.8,
				},
			],
		];
		for (const [name, mask] of borderCases) {
			const rendered = await alphaFrame({ masks: [mask] }, `parity-${name}`);
			const pad = maskSvgPad(mask, WIDTH, HEIGHT);
			const svgPath = join(directory, `${name}.svg`);
			await Bun.write(svgPath, maskToSvg(mask, WIDTH, HEIGHT));
			const raw = join(directory, `${name}-svg.rgba`);
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
			const outer = WIDTH + 2 * pad;
			const preview = (x: number, y: number) =>
				(svg[((y + pad) * outer + x + pad) * 4 + 3] ?? 0) / 255;
			let total = 0;
			let worst = 0;
			const border: [number, number][] = [];
			for (let x = 0; x < WIDTH; x++) {
				border.push([x, 0], [x, HEIGHT - 1]);
			}
			for (let y = 0; y < HEIGHT; y++) {
				border.push([0, y], [WIDTH - 1, y]);
			}
			for (const [x, y] of border) {
				const difference = Math.abs(preview(x, y) - rendered(x, y));
				total += difference;
				worst = Math.max(worst, difference);
			}
			const mean = total / border.length;
			ensure(
				mean < 0.03 && worst < 0.12,
				`parity-${name}: preview and render differ at the frame border (mean ${mean.toFixed(3)}, worst ${worst.toFixed(3)})`
			);
			results.push(
				`parity-${name}: preview vs render at the frame border, mean ${mean.toFixed(3)}, worst ${worst.toFixed(3)}; corner ${preview(0, 0).toFixed(2)} vs ${rendered(0, 0).toFixed(2)}`
			);
		}
		// Stroke parity: the preview's stroke SVG and the rendered stroke
		// cover the same pixels.
		const strokeCases: [string, Mask][] = [
			[
				"stroke-polygon-center",
				{
					...defaultMask("polygon", maskId(1)),
					height: 0.7,
					rotation: 10,
					sides: 5,
					strokeColor: "#00ff00",
					strokeWidth: 0.05,
					width: 0.45,
				},
			],
			[
				"stroke-ellipse-outside",
				{
					...defaultMask("ellipse", maskId(1)),
					height: 0.5,
					strokeAlign: "outside",
					strokeColor: "#00ff00",
					strokeWidth: 0.05,
					width: 0.5,
				},
			],
			[
				"stroke-rectangle-inside",
				{
					...defaultMask("rectangle", maskId(1)),
					cornerRadius: 0.3,
					height: 0.6,
					strokeAlign: "inside",
					strokeColor: "#00ff00",
					strokeWidth: 0.06,
					width: 0.6,
				},
			],
		];
		for (const [name, mask] of strokeCases) {
			const rendered = await alphaFrame({ masks: [mask] }, `parity-${name}`);
			const svgPath = join(directory, `${name}.svg`);
			await Bun.write(svgPath, maskStrokeSvg(mask, WIDTH, HEIGHT) ?? "");
			const raw = join(directory, `${name}-svg.rgba`);
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
			let both = 0;
			let either = 0;
			for (let y = 0; y < HEIGHT; y++) {
				for (let x = 0; x < WIDTH; x++) {
					const inPreview = (svg[(y * WIDTH + x) * 4 + 3] ?? 0) > 127;
					const inRender = rendered(x, y, 1) > 0.5;
					both += inPreview && inRender ? 1 : 0;
					either += inPreview || inRender ? 1 : 0;
				}
			}
			const overlap = both / Math.max(1, either);
			ensure(
				overlap > 0.85,
				`parity-${name}: preview and render strokes overlap ${(overlap * 100).toFixed(1)}%`
			);
			results.push(
				`parity-${name}: preview and render strokes overlap ${(overlap * 100).toFixed(1)}% of ${either} pixels`
			);
		}
	} else {
		results.push("parity: skipped, this FFmpeg has no librsvg decoder");
	}

	// Speed at 1080p30: static mattes are computed once per clip.
	const freeformPath = Array.from({ length: 64 }, (_, index) => {
		const angle = (index / 64) * 2 * Math.PI;
		return {
			outX: -0.05 * Math.sin(angle),
			outY: 0.05 * Math.cos(angle),
			x: 0.9 * Math.cos(angle),
			y: 0.9 * Math.sin(angle),
		};
	});
	const timingCases: [string, Mask, number][] = [
		[
			"feathered star",
			{ ...defaultMask("star", maskId(1)), feather: 0.2 },
			10_000,
		],
		[
			"freeform, 64 curved points",
			{
				...defaultMask("freeform", maskId(1)),
				feather: 0.2,
				path: freeformPath,
			},
			30_000,
		],
	];
	timingCases.push([
		"stroked freeform, 64 curved points",
		{
			...defaultMask("freeform", maskId(1)),
			path: freeformPath,
			strokeWidth: 0.02,
		},
		30_000,
	]);
	for (const [name, mask, limit] of timingCases) {
		const { filters, label } = maskMatteFilters({
			input: "0:v",
			masks: [mask],
			prefix: "t",
			value: staticMaskValue,
		});
		const script = join(directory, "timing.txt");
		await Bun.write(script, `${filters.join(";\n")};[${label}]null[out]`);
		const started = performance.now();
		await runMedia([
			"-f",
			"lavfi",
			"-i",
			"testsrc2=s=1920x1080:r=30:d=2",
			"-filter_complex_script",
			script,
			"-map",
			"[out]",
			"-f",
			"null",
			"-",
		]);
		const elapsed = performance.now() - started;
		ensure(
			elapsed < limit,
			`timing: ${name} took ${Math.round(elapsed)} ms for 60 frames at 1080p (limit ${limit} ms)`
		);
		results.push(
			`timing: ${name}, 60 frames at 1080p in ${Math.round(elapsed)} ms`
		);
	}
} finally {
	await rm(directory, { force: true, recursive: true });
}
for (const line of results) {
	process.stdout.write(`ok  ${line}\n`);
}
