/**
 * Real-FFmpeg proof for agent-placed stickers. An agent searches the bundled
 * catalog through `GET /stickers`, then places the circle sticker with
 * `POST /projects/:id/stickers`; the sidecar rasterizes the embedded SVG with
 * FFmpeg's librsvg decoder, imports it with its bundled provenance and adds
 * the clip. The project is then rendered to MP4 through `buildRender`:
 *
 * - the search finds the circle, and the stored PNG is 1024 x 1024 RGBA with
 *   a transparent corner and the artwork's colour at its centre;
 * - the placed clip starts at 1 s for 2 s on track 1 with the `fade` preset;
 * - the render shows plain footage before the sticker, the sticker's colour
 *   at the canvas centre while it is on screen (with the footage still
 *   visible at the corner, so its transparency survives), and plain footage
 *   again after it ends; the fade-in frame is dimmer than the held frame.
 *
 * Run: `bun src/verify-stickers.ts`
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Asset, newSegment, projectSchema } from "../../shared/project.ts";
import { runMedia } from "./media.ts";
import { buildRender } from "./render.ts";
import { routes } from "./routes/stickers.ts";
import { createStudioServer } from "./server.ts";
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
/** `shapes/circle.svg` fill: #ff4d6d. */
const CIRCLE = [255, 77, 109] as const;
/** Allowed per-channel error after yuv420p encoding. */
const COLOUR_TOLERANCE = 40;

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-stickers-"));
const results: string[] = [];

/** RGBA of one pixel of an image or a video frame at `time`. */
async function pixel(
	path: string,
	x: number,
	y: number,
	time?: number
): Promise<number[]> {
	const output = join(directory, `pixel-${crypto.randomUUID()}.rgba`);
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		...(time === undefined ? [] : ["-ss", time.toFixed(3)]),
		"-i",
		path,
		"-frames:v",
		"1",
		"-vf",
		`format=rgba,crop=1:1:${x}:${y}`,
		"-pix_fmt",
		"rgba",
		"-f",
		"rawvideo",
		output,
	]);
	return [...new Uint8Array(await Bun.file(output).arrayBuffer())];
}

const near = (actual: readonly number[], expected: readonly number[]) =>
	expected.every(
		(value, index) =>
			Math.abs((actual[index] ?? -999) - value) <= COLOUR_TOLERANCE
	);
const brightness = (rgba: readonly number[]) =>
	(rgba[0] ?? 0) + (rgba[1] ?? 0) + (rgba[2] ?? 0);

const store = new StudioStore(join(directory, "store"));
const token = crypto.randomUUID();
const app = createStudioServer({ port: 0, routes, store, token });
const base = `http://127.0.0.1:${app.server.port}/api/video-studio`;
const headers = {
	authorization: `Bearer ${token}`,
	"content-type": "application/json",
};
try {
	const search = (await (
		await fetch(`${base}/stickers?query=circle&category=shapes`, { headers })
	).json()) as { stickers: { id: string; licenseName: string }[] };
	const circle = search.stickers[0];
	ensure(circle?.id === "shape-circle", `search found ${circle?.id}`);
	results.push(
		`GET /stickers?query=circle found ${circle.id} (${circle.licenseName})`
	);

	const card = join(directory, "card.mp4");
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=c=0x204060:s=${WIDTH}x${HEIGHT}:d=5:r=30`,
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		card,
	]);
	const footage: Asset = {
		createdAt: "2026-01-01T00:00:00.000Z",
		duration: 5,
		hasAudio: false,
		height: HEIGHT,
		id: "00000000-0000-4000-8000-0000000000d1",
		kind: "video",
		name: "card.mp4",
		width: WIDTH,
	};
	store.putAsset(footage);
	const created = store.create("Sticker proof");
	const project = store.save({
		...created,
		height: HEIGHT,
		segments: [newSegment(footage, 0, 0)],
		width: WIDTH,
	});

	const response = await fetch(`${base}/projects/${project.id}/stickers`, {
		body: JSON.stringify({
			duration: 2,
			preset: "fade",
			revision: project.revision,
			stickerId: circle.id,
			time: 1,
		}),
		headers,
		method: "POST",
	});
	ensure(
		response.status === 201,
		`stickers answered ${response.status}: ${await response.clone().text()}`
	);
	const body = (await response.json()) as {
		asset: Asset;
		project: unknown;
		segmentId: string;
		track: number;
	};
	const placed = projectSchema.parse(body.project);
	const sticker = body.asset;
	ensure(
		sticker.width === 1024 &&
			sticker.height === 1024 &&
			sticker.derivation === "sticker" &&
			sticker.origin?.identifier === "shape-circle",
		`sticker asset is ${JSON.stringify(sticker)}`
	);
	const png = store.mediaPath(sticker.id);
	const corner = await pixel(png, 2, 2);
	const centre = await pixel(png, 512, 512);
	ensure(corner[3] === 0, `PNG corner alpha is ${corner[3]}`);
	ensure(near(centre, [...CIRCLE, 255]), `PNG centre is ${centre.join(",")}`);
	results.push(
		"librsvg drew a 1024 x 1024 RGBA PNG: transparent corner, #ff4d6d centre"
	);
	const clip = placed.segments.find((segment) => segment.id === body.segmentId);
	ensure(
		clip?.start === 1 &&
			clip.sourceOut === 2 &&
			clip.track === 1 &&
			clip.animation?.in === "fade",
		`clip is ${JSON.stringify(clip)}`
	);
	results.push("route placed the sticker at 1 s for 2 s on track 1 with fade");

	const paths = new Map([
		[footage.id, card],
		[sticker.id, png],
	]);
	const output = join(directory, "stickered.mp4");
	await runMedia(
		[
			...buildRender(placed, store.assets(), (id) => paths.get(id) ?? ""),
			output,
		],
		{ cwd: directory }
	);
	const cx = WIDTH / 2;
	const cy = HEIGHT / 2;
	const before = await pixel(output, cx, cy, 0.5);
	const fading = await pixel(output, cx, cy, 1.1);
	const held = await pixel(output, cx, cy, 2);
	const heldCorner = await pixel(output, 4, 4, 2);
	const after = await pixel(output, cx, cy, 3.8);
	const background = [0x20, 0x40, 0x60];
	ensure(near(before, background), `before: ${before.join(",")}`);
	ensure(near(held, CIRCLE), `held: ${held.join(",")}`);
	ensure(near(heldCorner, background), `corner: ${heldCorner.join(",")}`);
	ensure(near(after, background), `after: ${after.join(",")}`);
	ensure(
		brightness(fading) < brightness(held) - 20 &&
			brightness(fading) > brightness(before) - 20,
		`fade frame ${fading.join(",")} is not between footage and sticker`
	);
	results.push(
		`render: footage ${before.slice(0, 3).join(",")} at 0.5 s, fading ${fading.slice(0, 3).join(",")} at 1.1 s, sticker ${held.slice(0, 3).join(",")} at 2 s (corner ${heldCorner.slice(0, 3).join(",")}), footage again at 3.8 s`
	);
	process.stdout.write(
		`PASS: agent-placed stickers\n${results.map((line) => `  - ${line}`).join("\n")}\n`
	);
} finally {
	app.server.stop(true);
	store.close();
	await rm(directory, { force: true, recursive: true });
}
