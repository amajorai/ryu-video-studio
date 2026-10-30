/**
 * Real-FFmpeg proof for canvas backgrounds (W2-V8). Single frames and a short
 * export render through `buildRender`; pixels are compared with the gradient
 * math in `shared/background.ts`.
 *
 * - A 9:16 project with a 16:9 clip and a project blur fill has non-black
 *   pixels above and below the clip that take the clip's color.
 * - Project color, gradient (two angles), image and looped video canvases.
 * - Clip-level color and gradient fills draw only while their clip plays.
 * - A blur fill follows the clip's alpha: a base-track crossfade, partial
 *   opacity and a fade-in look the same with and without it inside the clip.
 * - Waveform (audio) clips get no blur fill.
 * - A frame render of a looped video canvas shows the export's frame.
 *
 * Run: `bun src/verify-background.ts`
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CanvasBackground,
	gradientLine,
	gradientPosition,
	hexToRgb,
	loopedMediaTime,
} from "../../shared/background.ts";
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
import { baseSource } from "./render-stages/background.ts";

type Rgb = [number, number, number];

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

/** Allowed per-channel error in 8-bit steps (YUV 4:2:0 round trips). */
const TOLERANCE = 8;

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-background-"));
const results: string[] = [];
try {
	let assetCount = 0;
	const paths = new Map<string, string>();
	async function media(
		name: string,
		source: string,
		options: { kind: "image" | "video"; height: number; width: number }
	): Promise<Asset> {
		const path = join(
			directory,
			`${name}.${options.kind === "image" ? "png" : "mp4"}`
		);
		await runMedia([
			"-y",
			"-f",
			"lavfi",
			"-i",
			`${source}:s=${options.width}x${options.height}${options.kind === "video" ? ":r=10:d=1" : ""}`,
			...(options.kind === "image"
				? ["-frames:v", "1"]
				: ["-pix_fmt", "yuv420p", "-c:v", "libx264"]),
			path,
		]);
		assetCount += 1;
		const asset: Asset = {
			createdAt: "2026-01-01T00:00:00.000Z",
			duration: options.kind === "image" ? 5 : 1,
			hasAudio: false,
			height: options.height,
			id: `00000000-0000-4000-8000-${assetCount.toString(16).padStart(12, "0")}`,
			kind: options.kind,
			name,
			width: options.width,
		};
		paths.set(asset.id, path);
		return asset;
	}

	const red = await media("red-16x9", "color=c=0xd03020", {
		height: 90,
		kind: "image",
		width: 160,
	});
	const green = await media("green", "color=c=0x20c040", {
		height: 180,
		kind: "image",
		width: 320,
	});
	const blue = await media("blue", "color=c=0x2040d0", {
		height: 120,
		kind: "image",
		width: 120,
	});
	const loop = await media("loop", "color=c=0xe0c020", {
		height: 90,
		kind: "video",
		width: 160,
	});
	const tonePath = join(directory, "tone.wav");
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:duration=3",
		tonePath,
	]);
	const tone: Asset = {
		createdAt: "2026-01-01T00:00:00.000Z",
		duration: 3,
		hasAudio: true,
		height: 0,
		id: "00000000-0000-4000-8000-0000000000a1",
		kind: "audio",
		name: "tone",
		width: 0,
	};
	paths.set(tone.id, tonePath);
	const assets = [red, green, blue, loop, tone];

	function project(
		width: number,
		height: number,
		segments: Segment[],
		background?: CanvasBackground
	): Project {
		return {
			...newProject("Background proof"),
			...(background ? { background } : {}),
			height,
			segments,
			styleProfile: "clean-professional",
			width,
		};
	}

	const clip = (asset: Asset, fields: Partial<Segment> = {}): Segment =>
		segmentSchema.parse({ ...newSegment(asset), sourceOut: 2, ...fields });

	async function frame(
		name: string,
		value: Project,
		frameTime: number
	): Promise<(x: number, y: number) => Rgb> {
		const png = join(directory, `${name}.png`);
		await runMedia(
			[
				...buildRender(
					value,
					assets,
					(id) => paths.get(id) ?? "",
					undefined,
					[],
					frameTime
				),
				png,
			],
			{ cwd: directory }
		);
		return sampler(name, png, value.width, value.height);
	}

	async function sampler(
		name: string,
		source: string,
		width: number,
		height: number,
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
			pixels.length === width * height * 3,
			`${name}: frame is not ${width}x${height}`
		);
		return (x, y) => {
			const offset = (y * width + x) * 3;
			return [
				pixels[offset] ?? 0,
				pixels[offset + 1] ?? 0,
				pixels[offset + 2] ?? 0,
			];
		};
	}

	const rgb = (hex: string): Rgb => {
		const { b, g, r } = hexToRgb(hex);
		return [r, g, b];
	};

	function expectPixel(
		name: string,
		actual: Rgb,
		expected: Rgb,
		tolerance = TOLERANCE
	) {
		const off = actual.some(
			(value, index) => Math.abs(value - (expected[index] ?? 0)) > tolerance
		);
		ensure(
			!off,
			`${name}: got rgb(${actual.join(",")}), expected rgb(${expected.map((value) => Math.round(value)).join(",")})`
		);
	}

	// 1. Acceptance: 9:16 canvas, 16:9 clip, project blur fill.
	const blur: CanvasBackground = { amount: 0.4, dim: 0.2, type: "blur" };
	const portrait = project(180, 320, [clip(red)], blur);
	for (const [name, sample] of [
		["blur-frame", await frame("blur-frame", portrait, 1)],
		[
			"blur-export",
			await (async () => {
				const mp4 = join(directory, "blur-export.mp4");
				await runMedia(
					[...buildRender(portrait, assets, (id) => paths.get(id) ?? ""), mp4],
					{ cwd: directory }
				);
				return sampler("blur-export", mp4, 180, 320, 1);
			})(),
		],
	] as const) {
		const center = sample(90, 160);
		expectPixel(`${name} center`, center, rgb("#d03020"));
		for (const [label, y] of [
			["top", 8],
			["bottom", 311],
		] as const) {
			const pixel = sample(90, y);
			ensure(
				pixel.some((value) => value > 40),
				`${name} ${label}: the blur fill is black (rgb(${pixel.join(",")}))`
			);
			// The fill is the clip's red, dimmed by 20 %.
			expectPixel(
				`${name} ${label}`,
				pixel,
				rgb("#d03020").map((value) => value * 0.8) as Rgb,
				20
			);
		}
	}
	results.push("blur fill: non-black dimmed clip color above and below");

	// Without the blur the same project letterboxes on the style color.
	const letterbox = await frame("letterbox", project(180, 320, [clip(red)]), 1);
	expectPixel("letterbox top", letterbox(90, 8), [0, 0, 0]);
	results.push("default canvas: legacy letterbox stays black");

	// A blur fill applies only to base-track clips.
	const upper = await frame(
		"blur-upper",
		project(180, 320, [clip(red, { track: 1 })], blur),
		1
	);
	expectPixel("blur upper track top", upper(90, 8), [0, 0, 0]);
	results.push("blur fill: clips above the base track are not filled");

	// 2. Color canvas.
	const half = { scale: 0.5 };
	const colored = await frame(
		"color",
		project(320, 180, [clip(green, half)], {
			color: "#3060a0",
			type: "color",
		}),
		1
	);
	expectPixel("color corner", colored(4, 4), rgb("#3060a0"));
	expectPixel("color clip", colored(160, 90), rgb("#20c040"));
	results.push("color canvas");

	// 3. Gradients against the CSS gradient math.
	for (const angle of [90, 135]) {
		const background: CanvasBackground = {
			angle,
			color: "#000000",
			color2: "#ffffff",
			type: "gradient",
		};
		const sample = await frame(
			`gradient-${angle}`,
			project(320, 180, [clip(green, { scale: 0.2 })], background),
			1
		);
		const line = gradientLine(angle, 320, 180);
		for (const [x, y] of [
			[4, 4],
			[316, 176],
			[60, 150],
			[280, 30],
		] as const) {
			const level = gradientPosition(line, x + 0.5, y + 0.5) * 255;
			expectPixel(`gradient ${angle}deg at ${x},${y}`, sample(x, y), [
				level,
				level,
				level,
			]);
		}
	}
	results.push(
		"gradient canvas: matches the CSS gradient line at 90 and 135 deg"
	);

	// 4. Image and looped video canvases cover the frame.
	const image = await frame(
		"image",
		project(320, 180, [clip(green, half)], {
			assetId: blue.id,
			type: "image",
		}),
		1
	);
	expectPixel("image corner", image(2, 2), rgb("#2040d0"));
	expectPixel("image far corner", image(317, 177), rgb("#2040d0"));
	const looped = await frame(
		"video-loop",
		project(320, 180, [clip(green, { ...half, sourceOut: 3 })], {
			assetId: loop.id,
			type: "image",
		}),
		2.5
	);
	expectPixel("looped video corner", looped(2, 2), rgb("#e0c020"));
	results.push("image and looped video canvases cover the frame");

	// 5. Clip-level fills draw only during their clip.
	const timed = project(320, 180, [
		clip(green, { sourceOut: 4 }),
		clip(blue, {
			background: { color: "#c02090", type: "color" },
			scale: 0.4,
			sourceOut: 1,
			start: 1,
			track: 1,
		}),
		clip(blue, {
			background: {
				angle: 90,
				color: "#000000",
				color2: "#ffffff",
				type: "gradient",
			},
			scale: 0.4,
			sourceOut: 1,
			start: 3,
			track: 1,
		}),
	]);
	const before = await frame("clip-before", timed, 0.5);
	expectPixel("before the clip", before(4, 4), rgb("#20c040"));
	const during = await frame("clip-during", timed, 1.5);
	expectPixel("clip color fill", during(4, 4), rgb("#c02090"));
	expectPixel("clip over its fill", during(160, 90), rgb("#2040d0"));
	const after = await frame("clip-after", timed, 2.5);
	expectPixel("after the clip", after(4, 4), rgb("#20c040"));
	const gradient = await frame("clip-gradient", timed, 3.5);
	const line = gradientLine(90, 320, 180);
	for (const x of [4, 80, 300]) {
		const level = gradientPosition(line, x + 0.5, 4.5) * 255;
		expectPixel(`clip gradient at ${x}`, gradient(x, 4), [level, level, level]);
	}
	results.push("clip-level color and gradient fills draw only during the clip");

	// 5b. Clip-level images: a library picture (or a video's first frame)
	// covers the frame behind the clip while it plays.
	const pictured = project(320, 180, [
		clip(green, { sourceOut: 4 }),
		clip(blue, {
			background: { assetId: red.id, type: "image" },
			scale: 0.4,
			sourceOut: 1,
			start: 1,
			track: 1,
		}),
		clip(blue, {
			background: { assetId: loop.id, type: "image" },
			scale: 0.4,
			sourceOut: 1,
			start: 3,
			track: 1,
		}),
	]);
	const imageBefore = await frame("clip-image-before", pictured, 0.5);
	expectPixel("before the image clip", imageBefore(4, 4), rgb("#20c040"));
	const imageDuring = await frame("clip-image-during", pictured, 1.5);
	expectPixel("clip image fill corner", imageDuring(4, 4), rgb("#d03020"));
	expectPixel("clip image fill edge", imageDuring(316, 176), rgb("#d03020"));
	expectPixel("clip over its image", imageDuring(160, 90), rgb("#2040d0"));
	const videoFill = await frame("clip-video-fill", pictured, 3.5);
	expectPixel("clip video-frame fill", videoFill(4, 4), rgb("#e0c020"));
	const imageExport = join(directory, "clip-image.mp4");
	await runMedia(
		[
			...buildRender(
				pictured,
				assets,
				(id) => paths.get(id) ?? "",
				undefined,
				[]
			),
			imageExport,
		],
		{ cwd: directory }
	);
	const exportedFill = await sampler(
		"clip-image-export",
		imageExport,
		320,
		180,
		1.5
	);
	expectPixel("exported clip image fill", exportedFill(4, 4), rgb("#d03020"));
	results.push(
		"clip-level images (and a video's first frame) cover the frame behind the clip"
	);

	// 6. The blur fill carries the clip's alpha: inside the clip a crossfade,
	// partial opacity and a fade-in match the render without a blur fill.
	const crossfade = (background?: CanvasBackground) =>
		project(
			320,
			180,
			[
				clip(green, { sourceOut: 3 }),
				clip(red, {
					entryDuration: 1,
					entryTransition: "crossfade",
					sourceOut: 3,
					start: 2,
				}),
			],
			background
		);
	const plainCross = await frame("cross-plain", crossfade(), 2.5);
	const blurCross = await frame("cross-blur", crossfade(blur), 2.5);
	expectPixel("crossfade under blur", blurCross(160, 90), plainCross(160, 90));
	ensure(
		plainCross(160, 90)[1] > 80,
		`crossfade midpoint keeps the outgoing green (rgb(${plainCross(160, 90).join(",")}))`
	);
	results.push("blur fill: a base-track crossfade keeps the outgoing clip");

	const faint = (background?: CanvasBackground) =>
		project(180, 320, [clip(red, { opacity: 0.3 })], background);
	const plainFaint = await frame("faint-plain", faint(), 1);
	const blurFaint = await frame("faint-blur", faint(blur), 1);
	expectPixel(
		"opacity 0.3 under blur",
		blurFaint(90, 160),
		plainFaint(90, 160)
	);
	expectPixel(
		"opacity 0.3 fill",
		blurFaint(90, 8),
		rgb("#d03020").map((value) => value * 0.8 * 0.3) as Rgb,
		12
	);
	const fading = (background?: CanvasBackground) =>
		project(180, 320, [clip(red, { fadeIn: 1 })], background);
	const plainFade = await frame("fade-plain", fading(), 0.1);
	const blurFade = await frame("fade-blur", fading(blur), 0.1);
	expectPixel("fade-in under blur", blurFade(90, 160), plainFade(90, 160));
	ensure(
		blurFade(90, 8).every((value) => value < 30),
		`fade-in fill starts dark (rgb(${blurFade(90, 8).join(",")}))`
	);
	results.push("blur fill: partial opacity and fades apply to the fill");

	// 7. Waveform clips get no blur fill.
	const waveform = await frame(
		"waveform-blur",
		project(
			320,
			180,
			[
				segmentSchema.parse({
					...newSegment(tone),
					sourceOut: 2,
					visualization: "waveform",
					waveformColor: "#ff00ff",
				}),
			],
			blur
		),
		1
	);
	for (const [x, y] of [
		[4, 4],
		[160, 10],
		[300, 170],
	] as const) {
		expectPixel(`waveform canvas ${x},${y}`, waveform(x, y), [0, 0, 0]);
	}
	results.push("blur fill: waveform clips are not filled");

	// 8. A frame render of a looped video canvas matches the export.
	const rampPath = join(directory, "ramp.mp4");
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		"color=c=black:s=64x36:r=10:d=1,format=rgb24,geq=r='N*20':g=0:b=0",
		"-pix_fmt",
		"yuv444p",
		"-c:v",
		"libx264",
		"-qp",
		"0",
		rampPath,
	]);
	const ramp: Asset = {
		...loop,
		height: 36,
		id: "00000000-0000-4000-8000-0000000000a2",
		name: "ramp",
		width: 64,
	};
	paths.set(ramp.id, rampPath);
	const rampProject = project(64, 36, [], {
		assetId: ramp.id,
		type: "image",
	});
	const canvasContext = {
		asset: (id: string) => assets.concat(ramp).find((item) => item.id === id),
		mediaPath: (id: string) => paths.get(id) ?? "",
	};
	async function canvasFrame(name: string, frameTime?: number, seek?: number) {
		const source = baseSource(rampProject, 4, frameTime, canvasContext);
		const out = join(directory, `${name}.mp4`);
		await runMedia([
			"-y",
			...source.args,
			"-filter_complex",
			source.filters.join(";"),
			"-map",
			"[base]",
			"-pix_fmt",
			"yuv444p",
			"-c:v",
			"libx264",
			"-qp",
			"0",
			out,
		]);
		return sampler(name, out, 64, 36, seek);
	}
	const stillTime = 2.55;
	ensure(
		loopedMediaTime(stillTime, ramp.duration) > 0.5,
		"looped canvas time wraps"
	);
	const still = await canvasFrame("canvas-still", stillTime);
	const exported = await canvasFrame("canvas-export", undefined, stillTime);
	expectPixel("looped canvas still", still(32, 18), exported(32, 18), 22);
	ensure(
		still(32, 18)[0] > 60,
		`looped canvas still is not the first frame (rgb(${still(32, 18).join(",")}))`
	);
	results.push("looped video canvas: frame renders show the export's frame");

	for (const line of results) {
		console.log(`ok  ${line}`);
	}
	console.log(`verify-background: ${results.length} checks passed`);
} finally {
	await rm(directory, { force: true, recursive: true });
}
