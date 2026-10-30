/**
 * Real-FFmpeg proof for the raster toolkit (W1-R1): rasterized shapes encode
 * as PNG stills that FFmpeg probes and decodes byte for byte, a grayscale
 * matte drives `alphamerge` the way masks will, and an RGBA star overlays a
 * background the way shape layers will.
 *
 * Run: `bun src/verify-raster.ts`
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	alphaToRgba,
	hexColor,
	invertAlpha,
	rasterizeShape,
} from "../../shared/raster.ts";
import { runMedia } from "./media.ts";
import { alphaRasterToPng, rgbaRasterToPng } from "./png.ts";

const WIDTH = 320;
const HEIGHT = 180;

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

/** Renders one frame of `filter` over `inputs` and returns its RGB bytes. */
async function renderRgb(
	directory: string,
	name: string,
	inputs: string[],
	filter: string
): Promise<Uint8Array> {
	const output = join(directory, `${name}.rgb`);
	await runMedia([
		"-v",
		"error",
		"-y",
		...inputs,
		"-filter_complex",
		filter,
		"-map",
		"[out]",
		"-frames:v",
		"1",
		"-f",
		"rawvideo",
		"-pix_fmt",
		"rgb24",
		output,
	]);
	const bytes = new Uint8Array(await Bun.file(output).arrayBuffer());
	ensure(bytes.length === WIDTH * HEIGHT * 3, `${name}: unexpected frame size`);
	return bytes;
}

function rgbAt(
	frame: Uint8Array,
	x: number,
	y: number
): [number, number, number] {
	const offset = (y * WIDTH + x) * 3;
	return [frame[offset] ?? 0, frame[offset + 1] ?? 0, frame[offset + 2] ?? 0];
}

function near(
	actual: [number, number, number],
	expected: [number, number, number],
	label: string
): void {
	const close = actual.every(
		(value, index) => Math.abs(value - (expected[index] ?? 0)) <= 6
	);
	ensure(
		close,
		`${label}: expected rgb(${expected.join(",")}), got rgb(${actual.join(",")})`
	);
}

const directory = await mkdtemp(join(tmpdir(), "ryu-video-raster-verify-"));
try {
	// 1. Byte-exact decode of a grayscale matte.
	const ellipse = rasterizeShape(
		{ cx: WIDTH / 2, cy: HEIGHT / 2, kind: "ellipse", rx: 100, ry: 60 },
		WIDTH,
		HEIGHT
	);
	const mattePath = join(directory, "matte.png");
	await Bun.write(mattePath, alphaRasterToPng(invertAlpha(ellipse)));
	const decodedPath = join(directory, "matte.gray");
	await runMedia([
		"-v",
		"error",
		"-y",
		"-i",
		mattePath,
		"-f",
		"rawvideo",
		"-pix_fmt",
		"gray",
		decodedPath,
	]);
	const decoded = new Uint8Array(await Bun.file(decodedPath).arrayBuffer());
	const expected = invertAlpha(ellipse).data;
	ensure(
		Buffer.from(decoded).equals(Buffer.from(expected)),
		"matte: FFmpeg decoded different bytes than were encoded"
	);

	// 2. The inverted ellipse matte cuts a blue clip over a green base: the
	// center shows the base, a corner shows the clip.
	const masked = await renderRgb(
		directory,
		"masked",
		[
			"-f",
			"lavfi",
			"-i",
			`color=c=0x00ff00:s=${WIDTH}x${HEIGHT}:d=1`,
			"-f",
			"lavfi",
			"-i",
			`color=c=0x0000ff:s=${WIDTH}x${HEIGHT}:d=1`,
			"-i",
			mattePath,
		],
		"[2:v]format=gray[matte];[1:v]format=rgba[clip];[clip][matte]alphamerge[cut];[0:v][cut]overlay=format=auto[out]"
	);
	near(rgbAt(masked, WIDTH / 2, HEIGHT / 2), [0, 255, 0], "mask center");
	near(rgbAt(masked, 4, 4), [0, 0, 255], "mask corner");

	// 3. An RGBA star overlays a dark background: a tip is painted, the notch
	// between two tips is not.
	const star = rasterizeShape(
		{
			cx: WIDTH / 2,
			cy: HEIGHT / 2,
			innerRadius: 0.45,
			kind: "star",
			points: 5,
			rx: 80,
			ry: 80,
		},
		WIDTH,
		HEIGHT
	);
	const starPath = join(directory, "star.png");
	await Bun.write(
		starPath,
		rgbaRasterToPng(alphaToRgba(star, hexColor("#ff0000")))
	);
	const shaped = await renderRgb(
		directory,
		"shaped",
		[
			"-f",
			"lavfi",
			"-i",
			`color=c=0x101010:s=${WIDTH}x${HEIGHT}:d=1`,
			"-i",
			starPath,
		],
		"[0:v][1:v]overlay=format=auto[out]"
	);
	near(rgbAt(shaped, WIDTH / 2, HEIGHT / 2 - 75), [255, 0, 0], "star tip");
	near(rgbAt(shaped, WIDTH / 2, HEIGHT / 2 + 60), [16, 16, 16], "star notch");

	// 4. A UHD mask rasterizes and encodes in reasonable time.
	const started = performance.now();
	const uhd = rasterizeShape(
		{
			cx: 1920,
			cy: 1080,
			height: 1800,
			kind: "heart",
			rotation: 8,
			width: 2000,
		},
		3840,
		2160
	);
	const uhdPng = alphaRasterToPng(uhd);
	const elapsed = performance.now() - started;
	ensure(uhdPng.length > 0, "uhd: empty PNG");

	process.stdout.write(
		`verify-raster: ok (matte byte-exact, alphamerge and overlay pixels match; UHD heart ${Math.round(elapsed)} ms, ${uhdPng.length} bytes)\n`
	);
} finally {
	await rm(directory, { force: true, recursive: true });
}
