/**
 * Real-FFmpeg proof for keying and the static-background cutout (W2-V4).
 *
 * 1. A generated green-screen video (a white subject box on green) is keyed
 *    over a solid red base through `buildRender`: the background must come
 *    out red and the subject white, for the chroma, RGB colour and (when
 *    available) hue keys. Hue keys of other hues (magenta, whose hue sits
 *    next to FFmpeg's grey hue, and pure red, whose hue is 0) must leave the
 *    green screen and the white subject in place.
 * 2. Luma keys remove a black background, and a white one with a band at
 *    the top of the range (limited-range luma).
 * 3. Spill suppression pulls the green cast off a green-tinted subject.
 * 4. The cutout derivative keys a static shot against its clean-plate frame:
 *    the result has alpha, the plate is transparent and the subject opaque,
 *    the derivative keeps the source duration, and composited over the red
 *    base through `buildRender` the plate shows red. VP9 is refused (exports
 *    decode VP9 without its alpha).
 *
 * Run: `bun src/verify-keying.ts`
 */
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Key } from "../../shared/keying.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	segmentSchema,
} from "../../shared/project.ts";
import { cutoutAsset } from "./cutout.ts";
import { ffmpegCapabilities } from "./ffmpeg-capabilities.ts";
import { probe, runMedia } from "./media.ts";
import { buildRender } from "./render.ts";
import { StudioStore } from "./store.ts";

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
/** The subject box: centred, 120x80. */
const BOX = { height: 80, width: 120, x: 100, y: 50 };
const CENTER = { x: WIDTH / 2, y: HEIGHT / 2 };
const CORNER = { x: 20, y: 20 };

type Pixel = readonly [number, number, number];
const near = (pixel: Pixel, expected: Pixel, tolerance: number) =>
	pixel.every(
		(channel, index) => Math.abs(channel - (expected[index] ?? 0)) <= tolerance
	);
const show = (pixel: Pixel) => `rgb(${pixel.join(", ")})`;

const capabilities = await ffmpegCapabilities();
const directory = await mkdtemp(join(tmpdir(), "ryu-verify-keying-"));
const results: string[] = [];
let store: StudioStore | undefined;
try {
	/** A lossless-ish 2 s H.264 clip: `background` with a `subject` box. */
	async function screenClip(
		name: string,
		background: string,
		subject: string
	): Promise<string> {
		const path = join(directory, `${name}.mov`);
		await runMedia([
			"-y",
			"-f",
			"lavfi",
			"-i",
			`color=${background}:s=${WIDTH}x${HEIGHT}:r=25:d=2`,
			"-vf",
			`drawbox=x=${BOX.x}:y=${BOX.y}:w=${BOX.width}:h=${BOX.height}:color=${subject}:t=fill`,
			"-c:v",
			"libx264",
			"-qp",
			"0",
			"-pix_fmt",
			"yuv444p",
			path,
		]);
		return path;
	}

	const redPath = join(directory, "red.png");
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=red:s=${WIDTH}x${HEIGHT}`,
		"-frames:v",
		"1",
		redPath,
	]);
	const red: Asset = {
		createdAt: "2026-01-01T00:00:00.000Z",
		duration: 5,
		hasAudio: false,
		height: HEIGHT,
		id: "00000000-0000-4000-8000-0000000000b1",
		kind: "image",
		name: "red.png",
		width: WIDTH,
	};

	/**
	 * Render one frame of `clip` (keyed by `key`, when given) over the red
	 * base, at one second.
	 */
	async function keyedFrame(
		name: string,
		clipPath: string,
		key: Key | undefined,
		asset?: Asset
	): Promise<(x: number, y: number) => Pixel> {
		const clip: Asset = asset ?? {
			createdAt: "2026-01-01T00:00:00.000Z",
			duration: 2,
			hasAudio: false,
			height: HEIGHT,
			id: "00000000-0000-4000-8000-0000000000b2",
			kind: "video",
			name: `${name}.mov`,
			width: WIDTH,
		};
		const project: Project = {
			...newProject(`Keying ${name}`),
			height: HEIGHT,
			styleProfile: "clean-professional",
			width: WIDTH,
		};
		project.segments = [
			segmentSchema.parse({ ...newSegment(red), sourceOut: 2, track: 0 }),
			segmentSchema.parse({
				...newSegment(clip),
				...(key ? { key } : {}),
				track: 1,
			}),
		];
		const png = join(directory, `${name}.png`);
		await runMedia(
			[
				...buildRender(
					project,
					[red, clip],
					(id) => (id === red.id ? redPath : clipPath),
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

	async function expectKeyed(
		name: string,
		clipPath: string,
		key: Key,
		subject: Pixel
	) {
		const frame = await keyedFrame(name, clipPath, key);
		const background = frame(CORNER.x, CORNER.y);
		const centre = frame(CENTER.x, CENTER.y);
		ensure(
			near(background, [255, 0, 0], 12),
			`${name}: the keyed background shows ${show(background)}, not the red base`
		);
		ensure(
			near(centre, subject, 12),
			`${name}: the subject shows ${show(centre)}, expected ${show(subject)}`
		);
		results.push(
			`${name}: background ${show(background)} (red base), subject ${show(centre)}`
		);
		return frame;
	}

	const greenScreen = await screenClip("green-screen", "0x00FF00", "white");
	await expectKeyed(
		"chroma key",
		greenScreen,
		{ color: "#00ff00", type: "chroma" },
		[255, 255, 255]
	);
	await expectKeyed(
		"color key",
		greenScreen,
		{ color: "#00ff00", type: "color" },
		[255, 255, 255]
	);
	if (capabilities.filters.hsvkey) {
		await expectKeyed(
			"hue key",
			greenScreen,
			{ color: "#00ff00", type: "hsv" },
			[255, 255, 255]
		);
		// Other hues must leave the green screen and the white subject in
		// place: magenta sits next to the hue FFmpeg gives grey pixels, so
		// only the grey gate keeps white; red has hue 0, which FFmpeg's
		// hsvkey would read as "every hue".
		for (const [name, color] of [
			["hue key (magenta)", "#ff00ff"],
			["hue key (red)", "#ff0000"],
		] as const) {
			const other = await keyedFrame(name, greenScreen, {
				color,
				similarity: 0.25,
				type: "hsv",
			});
			const kept = other(CORNER.x, CORNER.y);
			const subject = other(CENTER.x, CENTER.y);
			ensure(
				near(kept, [0, 255, 0], 12),
				`${name}: the green screen shows ${show(kept)}, expected it unkeyed`
			);
			ensure(
				near(subject, [255, 255, 255], 12),
				`${name}: the white subject shows ${show(subject)}, expected it unkeyed`
			);
			results.push(
				`${name}: green screen kept ${show(kept)}, white subject kept ${show(subject)}`
			);
		}
	} else {
		results.push("hue key: SKIP (no hsvkey filter; renders as a chroma key)");
	}

	const blackScreen = await screenClip("black-screen", "black", "white");
	await expectKeyed(
		"luma key",
		blackScreen,
		{ lumaHigh: 0.1, lumaLow: 0, type: "luma" },
		[255, 255, 255]
	);

	// The top of the luma range: FFmpeg compares limited-range luma, where
	// white is 235, so a 0.95..1 band must still remove pure white.
	const whiteScreen = await screenClip("white-screen", "white", "black");
	await expectKeyed(
		"luma key (white band)",
		whiteScreen,
		{ blend: 0, lumaHigh: 1, lumaLow: 0.95, type: "luma" },
		[0, 0, 0]
	);

	if (capabilities.filters.despill) {
		// A grey subject with a green cast (#80C080) on a green screen.
		const spilled = await screenClip("spill", "0x00FF00", "0x80C080");
		const plain = await keyedFrame("spill off", spilled, {
			color: "#00ff00",
			type: "chroma",
		});
		const despilled = await keyedFrame("spill on", spilled, {
			color: "#00ff00",
			spill: 1,
			type: "chroma",
		});
		const before = plain(CENTER.x, CENTER.y);
		const after = despilled(CENTER.x, CENTER.y);
		ensure(
			before[1] - before[0] > 40,
			`spill: the unsuppressed subject ${show(before)} has no green cast`
		);
		ensure(
			Math.abs(after[1] - after[0]) <= 16 &&
				Math.abs(after[0] - before[0]) <= 8,
			`spill: the suppressed subject ${show(after)} keeps its green cast`
		);
		results.push(
			`spill: subject ${show(before)} → ${show(after)} with spill 1`
		);
	} else {
		results.push("spill: SKIP (no despill filter)");
	}

	if (capabilities.filters.backgroundkey) {
		// A static textured shot: the first second is the empty plate, then a
		// white subject appears in the centre.
		const shot = join(directory, "static-shot.mov");
		await runMedia([
			"-y",
			"-f",
			"lavfi",
			"-i",
			`testsrc2=s=${WIDTH}x${HEIGHT}:r=25:d=3`,
			"-vf",
			`select=eq(n\\,0),loop=loop=74:size=1:start=0,setpts=N/25/TB,drawbox=x=${BOX.x}:y=${BOX.y}:w=${BOX.width}:h=${BOX.height}:color=white:t=fill:enable='gte(t,1)'`,
			"-c:v",
			"libx264",
			"-qp",
			"0",
			"-pix_fmt",
			"yuv444p",
			shot,
		]);
		store = new StudioStore(directory);
		const info = await probe(shot);
		ensure(info.kind === "video", "cutout: the fixture is not a video");
		const source: Asset = {
			...info,
			createdAt: new Date().toISOString(),
			id: crypto.randomUUID(),
			name: "static-shot.mov",
		};
		await copyFile(shot, store.mediaPath(source.id));
		store.putAsset(source);
		const cutout = await cutoutAsset(store, source, {
			cleanPlateTime: 0.2,
			threshold: 0.9,
		});
		ensure(
			cutout.derivation === "cutout" && cutout.derivedFromAssetId === source.id,
			"cutout: the derivative is not linked to its source"
		);
		ensure(
			Math.abs(cutout.duration - source.duration) <= 0.25,
			`cutout: duration ${cutout.duration}s differs from ${source.duration}s`
		);
		const alphaRaw = join(directory, "cutout-alpha.gray");
		await runMedia([
			"-y",
			"-ss",
			"2",
			"-i",
			store.mediaPath(cutout.id),
			"-frames:v",
			"1",
			"-vf",
			"format=yuva444p,alphaextract",
			"-pix_fmt",
			"gray",
			"-f",
			"rawvideo",
			alphaRaw,
		]);
		const alpha = await readFile(alphaRaw);
		ensure(
			alpha.length === WIDTH * HEIGHT,
			"cutout: the alpha frame has the wrong size"
		);
		const alphaAt = (x: number, y: number) => alpha[y * WIDTH + x] ?? 0;
		const plateAlpha = alphaAt(CORNER.x, CORNER.y);
		const subjectAlpha = alphaAt(CENTER.x, CENTER.y);
		ensure(
			plateAlpha <= 16,
			`cutout: the clean-plate background has alpha ${plateAlpha}`
		);
		ensure(
			subjectAlpha >= 240,
			`cutout: the subject has alpha ${subjectAlpha}`
		);
		results.push(
			`cutout (${cutout.name}): plate alpha ${plateAlpha}, subject alpha ${subjectAlpha}, ${cutout.duration.toFixed(2)}s`
		);
		// The renderer must decode the derivative's alpha: over the red base
		// the plate shows red and the subject stays white.
		const composited = await keyedFrame(
			"cutout over red",
			store.mediaPath(cutout.id),
			undefined,
			cutout
		);
		const behind = composited(CORNER.x, CORNER.y);
		const front = composited(CENTER.x, CENTER.y);
		ensure(
			near(behind, [255, 0, 0], 12),
			`cutout over red: the plate shows ${show(behind)}, not the red base`
		);
		ensure(
			near(front, [255, 255, 255], 12),
			`cutout over red: the subject shows ${show(front)}, expected white`
		);
		results.push(
			`cutout over red (buildRender): plate ${show(behind)}, subject ${show(front)}`
		);
		// VP9 is refused up front: FFmpeg's default VP9 decoder drops alpha,
		// so a VP9 cutout would export opaque.
		const refused = await cutoutAsset(store, source, {
			cleanPlateTime: 0.2,
			// @ts-expect-error VP9 is deliberately not an accepted codec.
			codec: "vp9",
		}).then(
			() => false,
			() => true
		);
		ensure(refused, "cutout: a VP9 request was accepted");
		results.push("cutout VP9: refused");
	} else {
		results.push("cutout: SKIP (no backgroundkey filter)");
	}

	process.stdout.write(`PASS keying\n${results.join("\n")}\n`);
} finally {
	store?.close();
	await rm(directory, { force: true, recursive: true });
}
