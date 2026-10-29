/**
 * Real-FFmpeg proof for AI subject matting (G46). No model is called: the
 * mattes are synthetic, standing in for what a segmentation model returns.
 *
 * - a still with a luma matte (left half white): the derivative keeps the
 *   left half opaque with its colour and makes the right half transparent;
 * - the same still with a cutout matte that carries alpha (a PNG whose RGB
 *   is noise): the alpha channel decides coverage, not the noisy RGB;
 * - `invert` keeps the background instead;
 * - a 2 s clip with a 1 s matte video that moves its white square: the
 *   derivative is ProRes 4444 with alpha, 1 s long from `start`, and its
 *   alpha follows the matte frame by frame;
 * - the matted clip's browser preview copy is VP9 that keeps the alpha;
 * - mismatched pairs (a still matte for a clip) are refused.
 *
 * Run: `bun src/verify-ai-matte.ts`
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Asset } from "../../shared/project.ts";
import { aiMatteAsset } from "./ai-matte.ts";
import { runMedia } from "./media.ts";
import { StudioStore } from "./store.ts";

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const WIDTH = 160;
const HEIGHT = 90;
const directory = await mkdtemp(join(tmpdir(), "ryu-verify-ai-matte-"));
const store = new StudioStore(join(directory, "store"));
const results: string[] = [];

let nextId = 1;
async function addAsset(
	kind: Asset["kind"],
	name: string,
	args: string[],
	duration: number
): Promise<Asset> {
	const asset: Asset = {
		createdAt: "2026-01-01T00:00:00.000Z",
		duration,
		...(kind === "video" ? { frameRate: 25 } : {}),
		hasAudio: false,
		height: HEIGHT,
		id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
		kind,
		name,
		width: WIDTH,
	};
	await runMedia(["-y", ...args, store.mediaPath(asset.id)]);
	store.putAsset(asset);
	return asset;
}

/** RGBA pixels of frame `index` (0 for stills) of a stored asset. */
async function rgba(asset: Asset, index = 0): Promise<Uint8Array> {
	const raw = join(directory, `${asset.id}-${index}.rgba`);
	await runMedia([
		"-y",
		"-i",
		store.mediaPath(asset.id),
		"-vf",
		`select=eq(n\\,${index})`,
		"-frames:v",
		"1",
		"-pix_fmt",
		"rgba",
		"-f",
		"rawvideo",
		raw,
	]);
	const pixels = new Uint8Array(await readFile(raw));
	ensure(
		pixels.length === WIDTH * HEIGHT * 4,
		`${asset.name}: unexpected size`
	);
	return pixels;
}

const at = (pixels: Uint8Array, x: number, y: number) => {
	const offset = (y * WIDTH + x) * 4;
	return [
		pixels[offset] ?? 0,
		pixels[offset + 1] ?? 0,
		pixels[offset + 2] ?? 0,
		pixels[offset + 3] ?? 0,
	];
};

const png = (filter: string) => [
	"-f",
	"lavfi",
	"-i",
	filter,
	"-frames:v",
	"1",
	"-c:v",
	"png",
	"-f",
	"image2",
];

try {
	const orange = await addAsset(
		"image",
		"Orange.png",
		png(`color=c=0xff8000:s=${WIDTH}x${HEIGHT},format=rgb24`),
		5
	);
	const lumaMatte = await addAsset(
		"image",
		"Luma matte.png",
		png(
			`color=c=black:s=${WIDTH}x${HEIGHT},drawbox=x=0:y=0:w=${WIDTH / 2}:h=${HEIGHT}:color=white:t=fill,format=gray`
		),
		5
	);
	// A cutout with alpha: opaque on the left, transparent on the right, and
	// RGB noise everywhere, so a luma reading would be wrong.
	const alphaMatte = await addAsset(
		"image",
		"Cutout matte.png",
		png(
			`nullsrc=s=${WIDTH}x${HEIGHT},format=rgba,geq=r='random(1)*255':g='random(2)*255':b='random(3)*255':a='if(lt(X,W/2),255,0)',format=rgba`
		),
		5
	);

	const luma = await aiMatteAsset(store, orange, {
		matteAssetId: lumaMatte.id,
	});
	ensure(luma.derivation === "ai-matte", "derivation is ai-matte");
	ensure(luma.derivedFromAssetId === orange.id, "derived from the source");
	ensure(luma.kind === "image", "still stays a still");
	let pixels = await rgba(luma);
	const [r, g, b, a] = at(pixels, 20, 45);
	ensure(
		a === 255 && r > 245 && g > 115 && g < 140 && b < 10,
		`left keeps orange, got ${[r, g, b, a]}`
	);
	ensure(
		at(pixels, 140, 45)[3] === 0,
		`right is transparent, got ${at(pixels, 140, 45)}`
	);
	results.push(
		"still + luma matte: subject opaque in its colour, background transparent"
	);

	const alpha = await aiMatteAsset(store, orange, {
		matteAssetId: alphaMatte.id,
	});
	pixels = await rgba(alpha);
	ensure(
		at(pixels, 20, 45)[3] === 255 && at(pixels, 140, 45)[3] === 0,
		"alpha matte read from its alpha channel"
	);
	ensure(
		at(pixels, 20, 45)[0] > 245,
		"colour comes from the source, not the matte's RGB"
	);
	results.push(
		"still + cutout matte with alpha: coverage comes from the alpha channel"
	);

	const inverted = await aiMatteAsset(store, orange, {
		invert: true,
		matteAssetId: lumaMatte.id,
	});
	pixels = await rgba(inverted);
	ensure(
		at(pixels, 20, 45)[3] === 0 && at(pixels, 140, 45)[3] === 255,
		"invert keeps the background"
	);
	results.push("invert keeps the background instead");

	const clip = await addAsset(
		"video",
		"Blue clip.mp4",
		[
			"-f",
			"lavfi",
			"-i",
			`color=c=0x2040ff:s=${WIDTH}x${HEIGHT}:r=25:d=2`,
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-f",
			"mp4",
		],
		2
	);
	// The matte's white square moves right by 4 px per frame.
	const matteVideo = await addAsset(
		"video",
		"Matte video.mp4",
		[
			"-f",
			"lavfi",
			"-i",
			`color=c=black:s=${WIDTH}x${HEIGHT}:r=25:d=1,geq=lum='if(between(X,10+N*4,50+N*4)*between(Y,20,70),235,16)':cb=128:cr=128`,
			"-c:v",
			"libx264",
			"-qp",
			"0",
			"-pix_fmt",
			"yuv444p",
			"-f",
			"mp4",
		],
		1
	);
	const matted = await aiMatteAsset(store, clip, {
		matteAssetId: matteVideo.id,
		start: 0.5,
	});
	ensure(matted.kind === "video", "clip stays video");
	ensure(
		Math.abs(matted.duration - 1) < 0.1,
		`derivative covers the matte's 1 s, got ${matted.duration}`
	);
	const codec = join(directory, "codec.txt");
	await runMedia(
		[
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=codec_name,pix_fmt",
			"-of",
			"csv=p=0",
			"-o",
			codec,
			store.mediaPath(matted.id),
		],
		{ probe: true }
	);
	const codecText = (await Bun.file(codec).text()).trim();
	ensure(
		codecText === "prores,yuva444p12le" ||
			codecText.startsWith("prores,yuva444p"),
		`codec ${codecText}`
	);
	for (const frame of [0, 10, 20]) {
		pixels = await rgba(matted, frame);
		const inside = 30 + frame * 4;
		ensure(
			at(pixels, inside, 45)[3] > 240,
			`frame ${frame}: inside the square is opaque (${at(pixels, inside, 45)})`
		);
		ensure(
			at(pixels, inside - 25, 45)[3] < 15,
			`frame ${frame}: left of the square is transparent`
		);
		ensure(
			at(pixels, inside, 45)[2] > 200,
			`frame ${frame}: keeps the clip's blue`
		);
	}
	results.push(
		"clip + matte video: ProRes 4444 with alpha that follows the matte frame by frame"
	);

	// Browsers cannot decode ProRes: the preview plays a VP9 copy, which must
	// keep the alpha when decoded the way Chromium does (libvpx-vp9).
	const preview = store
		.assets()
		.find(
			(item) =>
				item.derivation === "proxy" && item.derivedFromAssetId === matted.id
		);
	ensure(preview, "the matted clip has a browser preview copy");
	const previewAlpha = join(directory, "preview-alpha.gray");
	await runMedia([
		"-y",
		"-c:v",
		"libvpx-vp9",
		"-i",
		store.mediaPath(preview.id),
		"-vf",
		"alphaextract,format=gray",
		"-frames:v",
		"1",
		"-f",
		"rawvideo",
		previewAlpha,
	]);
	const previewPlane = new Uint8Array(await readFile(previewAlpha));
	const previewAt = (x: number, y: number) => previewPlane[y * WIDTH + x] ?? -1;
	ensure(
		previewAt(30, 45) > 200 && previewAt(5, 45) < 40,
		`the VP9 preview keeps the matte's alpha (${previewAt(30, 45)}, ${previewAt(5, 45)})`
	);
	results.push("the matted clip's VP9 preview copy keeps its alpha");

	let refused = "";
	try {
		await aiMatteAsset(store, clip, { matteAssetId: lumaMatte.id });
	} catch (error) {
		refused = error instanceof Error ? error.message : String(error);
	}
	ensure(
		refused.includes("matte video"),
		`a still matte for a clip is refused (${refused})`
	);
	results.push("a still matte for a video clip is refused with a reason");

	for (const line of results) {
		console.info(`ok  ${line}`);
	}
	console.info(`verify-ai-matte: ${results.length} checks passed`);
} finally {
	store.close();
	await rm(directory, { force: true, recursive: true });
}
