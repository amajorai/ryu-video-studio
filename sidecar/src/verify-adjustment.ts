/**
 * Real-FFmpeg proof for adjustment layers (W2-V7). A full-frame red card sits
 * on track 0 and a half-size green card on track 1. Adjustment layers grade
 * the composite after their track; frames from full exports and single-frame
 * renders are sampled in a corner (track 0 only) and at the center (track 1).
 *
 * Run: `bun src/verify-adjustment.ts`
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdjustmentLayer } from "../../shared/adjustment.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	segmentSchema,
} from "../../shared/project.ts";
import { defaultMask } from "../../shared/schema/mask.ts";
import { LutStore } from "./lut-store.ts";
import { mediaBinary, runMedia } from "./media.ts";
import { buildRender } from "./render.ts";
import { adjustmentAfterTrack } from "./render-stages/adjustment.ts";

type Rgb = readonly [number, number, number];

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
const TOLERANCE = 8;
const RED: Rgb = [220, 40, 40];
const GREEN: Rgb = [40, 200, 60];
const CORNER = [20, 20] as const;
const CENTER = [WIDTH / 2, HEIGHT / 2] as const;

const hex = ([r, g, b]: Rgb) =>
	`0x${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
const uuid = (n: number) =>
	`00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
/** BT.601 luma, which `eq=saturation=0` keeps. */
const luma = ([r, g, b]: Rgb) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Peak resident memory (VmHWM, MB) of an FFmpeg run, polled from /proc. */
async function peakMemoryMb(args: string[]): Promise<number> {
	const child = Bun.spawn([mediaBinary("ffmpeg"), ...args], {
		stderr: "ignore",
		stdout: "ignore",
	});
	let peak = 0;
	const poll = async () => {
		try {
			const status = await readFile(`/proc/${child.pid}/status`, "utf8");
			const match = /VmHWM:\s+(\d+) kB/.exec(status);
			peak = Math.max(peak, Number(match?.[1] ?? 0) / 1024);
		} catch {
			// The process exited between polls.
		}
	};
	const timer = setInterval(poll, 25);
	const code = await child.exited;
	clearInterval(timer);
	ensure(code === 0, `memory probe: ffmpeg exited with ${code}`);
	return peak;
}

/**
 * The adjustment stage on a 40 s synthetic composite, as `-f null` argv. The
 * graded branch must stay in step with the base, so a layer that starts late
 * may not make the overlay buffer every frame before its start.
 */
function lateLayerArgs(start: number): string[] {
	const layer: AdjustmentLayer = {
		end: start + 5,
		id: uuid(60),
		label: "Late",
		opacity: 1,
		saturation: 0,
		start,
		track: 0,
	};
	const project: Project = {
		...newProject("Late adjustment"),
		adjustmentLayers: [layer],
	};
	const { filters, last } = adjustmentAfterTrack(project, 0, "base", 0);
	return [
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=s=640x360:d=40:r=30",
		"-filter_complex",
		["[0:v]format=yuv420p[base]", ...filters].join(";"),
		"-map",
		`[${last}]`,
		"-f",
		"null",
		"-",
	];
}

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-adjustment-"));
const results: string[] = [];
try {
	async function card(color: Rgb, n: number): Promise<Asset> {
		await runMedia([
			"-y",
			"-f",
			"lavfi",
			"-i",
			`color=c=${hex(color)}:s=${WIDTH}x${HEIGHT},format=rgb24`,
			"-frames:v",
			"1",
			join(directory, `${uuid(n)}.png`),
		]);
		return {
			createdAt: "2026-01-01T00:00:00.000Z",
			duration: 5,
			hasAudio: false,
			height: HEIGHT,
			id: uuid(n),
			kind: "image",
			name: `card-${n}.png`,
			width: WIDTH,
		};
	}
	const red = await card(RED, 1);
	const green = await card(GREEN, 2);

	function sceneRender(
		layers: AdjustmentLayer[],
		frameTime: number | undefined,
		lutPath?: (lutId: string) => string
	): string[] {
		const project: Project = {
			...newProject("Adjustment proof"),
			adjustmentLayers: layers,
			height: HEIGHT,
			styleProfile: "clean-professional",
			width: WIDTH,
		};
		project.segments = [
			segmentSchema.parse({ ...newSegment(red), sourceOut: 3 }),
			segmentSchema.parse({
				...newSegment(green),
				scale: 0.5,
				sourceOut: 3,
				track: 1,
			}),
		];
		return buildRender(
			project,
			[red, green],
			(id) => join(directory, `${id}.png`),
			undefined,
			[],
			frameTime,
			lutPath ? { lutPath } : {}
		);
	}

	async function sampler(
		name: string,
		source: string,
		seek?: number
	): Promise<(point: readonly [number, number]) => Rgb> {
		const raw = join(directory, `${name.replaceAll(/\W+/g, "-")}.rgb`);
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
		return ([x, y]) => {
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
		layers: AdjustmentLayer[],
		frameTime: number
	) {
		const png = join(directory, `${name.replaceAll(/\W+/g, "-")}.png`);
		await runMedia([...sceneRender(layers, frameTime), png], {
			cwd: directory,
		});
		return sampler(name, png);
	}

	function expectPixel(name: string, actual: Rgb, expected: Rgb) {
		const off = actual.some(
			(value, index) => Math.abs(value - (expected[index] ?? 0)) > TOLERANCE
		);
		ensure(
			!off,
			`${name}: got rgb(${actual.join(",")}), expected rgb(${expected.map((value) => Math.round(value)).join(",")})`
		);
	}
	function expectGray(name: string, actual: Rgb, source: Rgb) {
		const level = luma(source);
		expectPixel(name, actual, [level, level, level]);
	}

	const grayscale: AdjustmentLayer = {
		end: 2,
		id: uuid(50),
		label: "Black and white",
		opacity: 1,
		saturation: 0,
		start: 1,
		track: 0,
	};

	// Plan acceptance: a grayscale layer over track 0 only, between 1 and 2 s.
	const exported = join(directory, "export.mp4");
	await runMedia([...sceneRender([grayscale], undefined), exported], {
		cwd: directory,
	});
	for (const [label, time, inside] of [
		["before", 0.5, false],
		["during", 1.5, true],
		["after", 2.5, false],
	] as const) {
		const sample = await sampler(`export ${label}`, exported, time);
		if (inside) {
			expectGray(`export ${label}: track 0 corner`, sample(CORNER), RED);
		} else {
			expectPixel(`export ${label}: track 0 corner`, sample(CORNER), RED);
		}
		expectPixel(`export ${label}: track 1 center`, sample(CENTER), GREEN);
	}
	results.push("export grades track 0 only, only between 1 and 2 s");

	// Single-frame renders (the preview's server frame) inside and outside.
	const inside = await renderFrame("frame inside", [grayscale], 1.5);
	expectGray("frame inside: corner", inside(CORNER), RED);
	expectPixel("frame inside: center", inside(CENTER), GREEN);
	const outside = await renderFrame("frame outside", [grayscale], 0.5);
	expectPixel("frame outside: corner", outside(CORNER), RED);
	results.push("single frames honour the layer window");

	// A layer on track 1 grades both tracks; an ellipse mask limits it.
	const masked = await renderFrame(
		"masked",
		[
			{
				...grayscale,
				masks: [
					{ ...defaultMask("ellipse", uuid(70)), height: 0.3, width: 0.3 },
				],
				track: 1,
			},
		],
		1.5
	);
	expectGray("masked: center", masked(CENTER), GREEN);
	expectPixel("masked: corner", masked(CORNER), RED);
	results.push("masks limit the graded area");

	// Half opacity mixes the graded and original composite.
	const half = await renderFrame(
		"half opacity",
		[{ ...grayscale, opacity: 0.5 }],
		1.5
	);
	const gray = luma(RED);
	expectPixel(
		"half opacity: corner",
		half(CORNER),
		RED.map((value) => (value + gray) / 2) as unknown as Rgb
	);
	results.push("opacity mixes the grade");

	// The effect stack: invert on track 0.
	const inverted = await renderFrame(
		"invert effect",
		[
			{
				...grayscale,
				effects: [{ amount: 1, enabled: true, type: "invert" }],
				saturation: undefined,
			},
		],
		1.5
	);
	expectPixel(
		"invert effect: corner",
		inverted(CORNER),
		RED.map((value) => 255 - value) as unknown as Rgb
	);
	expectPixel("invert effect: center", inverted(CENTER), GREEN);
	results.push("effects reuse the clip effect stack");

	// Blend mode: multiply the composite by its own grayscale.
	const multiplied = await renderFrame(
		"multiply blend",
		[{ ...grayscale, blendMode: "multiply" }],
		1.5
	);
	expectPixel(
		"multiply blend: corner",
		multiplied(CORNER),
		RED.map((value) => (value * gray) / 255) as unknown as Rgb
	);
	results.push("blend modes composite through compositeLayer");

	// Keyframed opacity: 0 at the layer start, 1 a second later.
	const ramp: AdjustmentLayer = {
		...grayscale,
		end: 3,
		keyframes: [
			{ id: uuid(80), property: "opacity", time: 0, value: 0 },
			{ id: uuid(81), property: "opacity", time: 1, value: 1 },
		],
	};
	const ramped = await renderFrame("opacity ramp", [ramp], 2.5);
	expectGray("opacity ramp at 2.5 s", ramped(CORNER), RED);
	const rampStart = await renderFrame("opacity ramp start", [ramp], 1);
	expectPixel("opacity ramp at 1 s", rampStart(CORNER), RED);
	results.push("keyframed opacity follows the project clock");

	// Keyframed brightness animates `eq` per frame.
	const darken: AdjustmentLayer = {
		...grayscale,
		end: 3,
		keyframes: [{ id: uuid(82), property: "brightness", time: 1, value: -1 }],
		saturation: undefined,
	};
	const dark = await renderFrame("brightness ramp end", [darken], 2.5);
	const reference = await renderFrame(
		"static brightness",
		[{ ...darken, brightness: -1, keyframes: undefined }],
		2.5
	);
	expectPixel("brightness ramp at 2.5 s", dark(CORNER), reference(CORNER));
	ensure(
		luma(reference(CORNER)) < luma(RED) - 40,
		"static brightness: the reference frame is not darker"
	);
	const light = await renderFrame("brightness ramp start", [darken], 1);
	expectPixel("brightness ramp at 1 s", light(CORNER), RED);
	results.push("keyframed brightness animates per frame");

	// The window is inclusive at its end, like the preview's
	// `adjustmentLayerActiveAt`: the frame at exactly t = end is graded.
	const atEnd = await renderFrame("frame at end", [grayscale], 2);
	expectGray("frame at end: corner", atEnd(CORNER), RED);
	results.push("the end frame is graded, matching the preview");

	// Memory stays flat however late a layer starts (no trimmed branch
	// stalling the overlay). With a trim, 30 s at 640x360 buffers ~300 MB.
	const early = await peakMemoryMb(lateLayerArgs(0));
	const late = await peakMemoryMb(lateLayerArgs(30));
	ensure(
		late < early + 60,
		`late layer memory: ${Math.round(late)} MB vs ${Math.round(early)} MB at start 0`
	);
	results.push(
		`a layer starting at 30 s peaks at ${Math.round(late)} MB (start 0: ${Math.round(early)} MB)`
	);

	// A LUT on an adjustment layer: an inverting .cube grades track 0 between
	// 1 and 2 s through the same LUT stage clips use; track 1 stays as it is.
	const luts = new LutStore(join(directory, "luts"));
	const invert = await luts.add(
		"Invert",
		"LUT_3D_SIZE 2\n1 1 1\n0 1 1\n1 0 1\n0 0 1\n1 1 0\n0 1 0\n1 0 0\n0 0 0\n"
	);
	const lutLayer: AdjustmentLayer = {
		colorGrade: {
			exposure: 0,
			lut: { intensity: 1, lutId: invert.id },
			temperature: 0,
			tint: 0,
			vibrance: 0,
		},
		end: 2,
		id: uuid(70),
		label: "Invert LUT",
		opacity: 1,
		start: 1,
		track: 0,
	};
	const lutExport = join(directory, "lut-export.mp4");
	await runMedia(
		[...sceneRender([lutLayer], undefined, (id) => luts.path(id)), lutExport],
		{ cwd: directory }
	);
	const lutInverted: Rgb = [255 - RED[0], 255 - RED[1], 255 - RED[2]];
	for (const [label, time, inside] of [
		["before", 0.5, false],
		["during", 1.5, true],
		["after", 2.5, false],
	] as const) {
		const sample = await sampler(`lut ${label}`, lutExport, time);
		expectPixel(
			`lut ${label}: track 0 corner`,
			sample(CORNER),
			inside ? lutInverted : RED
		);
		expectPixel(`lut ${label}: track 1 center`, sample(CENTER), GREEN);
	}
	results.push(
		"a LUT on an adjustment layer grades track 0 only, only inside its window"
	);

	for (const result of results) {
		console.log(`ok  ${result}`);
	}
	console.log(`verify-adjustment: ${results.length} checks passed`);
} finally {
	await rm(directory, { force: true, recursive: true });
}
