/**
 * Real-FFmpeg proof for AI transition gap fill (W4-G2). A red card (A) runs
 * 0–2 s, a blue card (B) starts at 3 s on the same track, and a green bridge
 * still with a white border is placed by `applyGapFill` (default 0.5 s
 * overlaps, so the still runs 1.5–3.5 s). Single frames render through
 * `buildRender` and pixels are checked:
 *
 * - before the bridge: A; mid-dissolve: a red/green blend; in the gap: green;
 * - mid-dissolve into B: a green/blue blend; after the bridge: B;
 * - the Ken Burns push grows the still, so its border leaves the frame edge.
 *
 * Generate motion (G79) is then proven through the real sidecar routes:
 *
 * - two synthetic videos whose every frame has a distinct grey level stand
 *   in for A and B, with trims that start and end mid-file;
 * - `POST /projects/:id/gap-fill-frames` must extract exactly the last frame
 *   A shows and the first frame B shows (checked by grey level, as PNG);
 * - a generated motion clip placed with `POST /projects/:id/gap-fill` must
 *   fill exactly the gap, trimmed to its length, with hard cuts.
 *
 * Run: `bun src/verify-gap-fill.ts`
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyGapFill, planGapFillMotion } from "../../shared/gap-fill.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	segmentSchema,
} from "../../shared/project.ts";
import { runMedia } from "./media.ts";
import { buildRender } from "./render.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

type Rgb = [number, number, number];

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
const BORDER = 12;
/** Allowed per-channel error in 8-bit steps (YUV round trips). */
const TOLERANCE = 14;
const RED: Rgb = [255, 0, 0];
const GREEN: Rgb = [0, 255, 0];
const BLUE: Rgb = [0, 0, 255];
const WHITE: Rgb = [255, 255, 255];

/** Frames per second of the synthetic grey-ramp videos. */
const RAMP_FPS = 24;

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-gap-fill-"));
const results: string[] = [];

const hex = (color: Rgb) =>
	color.map((value) => value.toString(16).padStart(2, "0")).join("");

async function card(
	name: string,
	color: Rgb,
	index: number,
	border = false
): Promise<{ asset: Asset; path: string }> {
	const path = join(directory, `${name}.png`);
	const source = border
		? `color=c=0x${hex(WHITE)}:s=${WIDTH}x${HEIGHT},drawbox=x=${BORDER}:y=${BORDER}:w=${WIDTH - 2 * BORDER}:h=${HEIGHT - 2 * BORDER}:color=0x${hex(color)}:t=fill,format=rgb24`
		: `color=c=0x${hex(color)}:s=${WIDTH}x${HEIGHT},format=rgb24`;
	await runMedia(["-y", "-f", "lavfi", "-i", source, "-frames:v", "1", path]);
	const asset: Asset = {
		createdAt: "2026-01-01T00:00:00.000Z",
		duration: 5,
		hasAudio: false,
		height: HEIGHT,
		id: `00000000-0000-4000-8000-00000000000${index}`,
		kind: "image",
		name: `${name}.png`,
		width: WIDTH,
	};
	return { asset, path };
}

try {
	const red = await card("red", RED, 1);
	const blue = await card("blue", BLUE, 2);
	const bridge = await card("bridge", GREEN, 3, true);
	const still: Asset = {
		...bridge.asset,
		generation: { kind: "image", prompt: "bridge" },
	};
	const assets = [red.asset, blue.asset, still];
	const paths = new Map([
		[red.asset.id, red.path],
		[blue.asset.id, blue.path],
		[still.id, bridge.path],
	]);
	const base: Project = {
		...newProject("Gap fill proof"),
		height: HEIGHT,
		styleProfile: "clean-professional",
		width: WIDTH,
		segments: [
			segmentSchema.parse({ ...newSegment(red.asset), sourceOut: 2 }),
			segmentSchema.parse({ ...newSegment(blue.asset, 3), sourceOut: 2 }),
		],
	};
	const outgoing = base.segments[0];
	ensure(outgoing, "scene has no outgoing clip");
	const filled = applyGapFill(base, assets, {
		afterClipId: outgoing.id,
		assetId: still.id,
		revision: base.revision,
	});
	ensure(
		filled.plan.start === 1.5 && filled.plan.end === 3.5,
		`unexpected bridge placement ${filled.plan.start}–${filled.plan.end}`
	);
	const project = filled.project;

	async function frame(
		name: string,
		at: number
	): Promise<(x: number, y: number) => Rgb> {
		const png = join(directory, `${name}.png`);
		const raw = join(directory, `${name}.rgb`);
		const args = buildRender(
			project,
			assets,
			(id) => paths.get(id) ?? "",
			undefined,
			[],
			at
		);
		await runMedia([...args, png], { cwd: directory });
		await runMedia([
			"-y",
			"-i",
			png,
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

	function expectPixel(name: string, actual: Rgb, expected: Rgb) {
		const off = actual.some(
			(value, index) => Math.abs(value - (expected[index] ?? 0)) > TOLERANCE
		);
		ensure(
			!off,
			`${name}: got rgb(${actual.join(",")}), expected rgb(${expected.join(",")})`
		);
	}

	/** Both channels clearly partway: the frame is a blend, not a hard cut. */
	function expectBlend(
		name: string,
		actual: Rgb,
		from: 0 | 1 | 2,
		to: 0 | 1 | 2
	) {
		const between = (value: number) => value > 30 && value < 225;
		ensure(
			between(actual[from]) && between(actual[to]),
			`${name}: rgb(${actual.join(",")}) is not a blend`
		);
	}

	const center = (sample: (x: number, y: number) => Rgb) =>
		sample(WIDTH / 2, HEIGHT / 2);

	expectPixel("A before the bridge", center(await frame("a", 1)), RED);
	results.push("1.0 s: outgoing clip only");
	expectBlend("dissolve into the bridge", center(await frame("in", 1.8)), 0, 1);
	results.push("1.8 s: outgoing clip dissolving into the bridge");
	const gap = await frame("gap", 2.4);
	expectPixel("bridge in the gap", center(gap), GREEN);
	results.push("2.4 s: bridge still fills the gap");
	expectBlend("dissolve into B", center(await frame("out", 3.2)), 1, 2);
	results.push("3.2 s: incoming clip dissolving in over the bridge");
	expectPixel("B after the bridge", center(await frame("b", 4)), BLUE);
	results.push("4.0 s: incoming clip only");

	// Ken Burns: the bordered still grows from scale 1 to 1.1 over 2 s, so
	// the border (12 px) covers x = 6 early and has left it by 2.8 s.
	const early = await frame("push-early", 2);
	expectPixel("border near the start of the push", early(6, HEIGHT / 2), WHITE);
	const late = await frame("push-late", 2.8);
	expectPixel("border pushed out late in the push", late(6, HEIGHT / 2), GREEN);
	results.push("Ken Burns push: the still's border leaves the frame edge");

	await verifyMotionBridge(directory, results);

	for (const line of results) {
		console.info(`ok  ${line}`);
	}
	console.info(`verify-gap-fill: ${results.length} checks passed`);
} finally {
	await rm(directory, { force: true, recursive: true });
}

/** A lossless video whose frame n is a flat grey of 16 + 7n (luma). */
async function rampVideo(path: string, frames: number) {
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=c=black:s=64x36:r=${RAMP_FPS}:d=${frames / RAMP_FPS},geq=lum='16+N*7':cb=128:cr=128`,
		"-frames:v",
		String(frames),
		"-c:v",
		"libx264",
		"-qp",
		"0",
		"-pix_fmt",
		"yuv444p",
		"-f",
		"mp4",
		path,
	]);
}

/** Grey level of frame `index` of `path`, decoded by frame number (no seek). */
async function greyOfFrame(path: string, index: number, directory: string) {
	const png = join(directory, `select-${crypto.randomUUID()}.png`);
	await runMedia([
		"-y",
		"-i",
		path,
		"-vf",
		`select=eq(n\\,${index})`,
		"-frames:v",
		"1",
		png,
	]);
	return await greyOfPng(new Uint8Array(await readFile(png)), directory);
}

async function greyOfPng(png: Uint8Array, directory: string): Promise<number> {
	const input = join(directory, `grey-${crypto.randomUUID()}.png`);
	const raw = join(directory, `grey-${crypto.randomUUID()}.gray`);
	await Bun.write(input, png);
	await runMedia([
		"-y",
		"-i",
		input,
		"-pix_fmt",
		"gray",
		"-f",
		"rawvideo",
		raw,
	]);
	const pixels = await readFile(raw);
	return pixels[Math.floor(pixels.length / 2)] ?? -1;
}

async function verifyMotionBridge(directory: string, results: string[]) {
	const storeDirectory = join(directory, "store");
	const store = new StudioStore(storeDirectory);
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, store, token });
	const base = `http://127.0.0.1:${app.server.port}/api/video-studio`;
	const headers = {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	};
	const post = async (path: string, body: unknown) => {
		const response = await fetch(`${base}${path}`, {
			body: JSON.stringify(body),
			headers,
			method: "POST",
		});
		const json = (await response.json()) as Record<string, unknown>;
		ensure(response.ok, `${path}: ${response.status} ${String(json.message)}`);
		return json;
	};
	const readInput = async (id: string) => {
		const parts: Uint8Array[] = [];
		let offset = 0;
		for (;;) {
			const response = await fetch(
				`${base}/generation-inputs/${id}/data?offset=${offset}`,
				{ headers }
			);
			const chunk = (await response.json()) as {
				data: string;
				done: boolean;
			};
			ensure(response.ok, `read input: ${JSON.stringify(chunk)}`);
			const bytes = Buffer.from(chunk.data, "base64");
			parts.push(bytes);
			offset += bytes.length;
			if (chunk.done) {
				break;
			}
		}
		return new Uint8Array(Buffer.concat(parts));
	};
	try {
		const ramp = async (index: number, name: string): Promise<Asset> => {
			const asset: Asset = {
				createdAt: "2026-01-01T00:00:00.000Z",
				duration: 30 / RAMP_FPS,
				frameRate: RAMP_FPS,
				hasAudio: false,
				height: 36,
				id: `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
				kind: "video",
				name,
				width: 64,
			};
			await rampVideo(store.mediaPath(asset.id), 30);
			store.putAsset(asset);
			return asset;
		};
		const a = await ramp(1, "A ramp.mp4");
		const b = await ramp(2, "B ramp.mp4");
		// A shows source 0.25–0.75 s (frames 6–17); B starts at source 0.5 s
		// (frame 12). A ends at 0.5 s on the timeline; B starts at 1.5 s.
		const project = store.save({
			...store.create("Motion proof"),
			fps: RAMP_FPS,
			height: 360,
			segments: [
				segmentSchema.parse({
					...newSegment(a, 0),
					sourceIn: 0.25,
					sourceOut: 0.75,
				}),
				segmentSchema.parse({
					...newSegment(b, 1.5),
					sourceIn: 0.5,
					sourceOut: 1.25,
				}),
			],
			width: 640,
		});
		const outgoing = project.segments[0];
		ensure(outgoing, "motion proof has no outgoing clip");
		const frames = (await post(`/projects/${project.id}/gap-fill-frames`, {
			afterClipId: outgoing.id,
			revision: project.revision,
		})) as {
			gap: number;
			motionSeconds: number;
			next: { frame: number; input: { id: string; mediaType: string } };
			previous: { frame: number; input: { id: string; mediaType: string } };
		};
		ensure(
			frames.previous.frame === 17,
			`last frame of A is ${frames.previous.frame}, expected 17`
		);
		ensure(
			frames.next.frame === 12,
			`first frame of B is ${frames.next.frame}, expected 12`
		);
		ensure(
			frames.previous.input.mediaType === "image/png" &&
				frames.next.input.mediaType === "image/png",
			"boundary frames are PNG"
		);
		const previousGrey = await greyOfPng(
			await readInput(frames.previous.input.id),
			directory
		);
		const nextGrey = await greyOfPng(
			await readInput(frames.next.input.id),
			directory
		);
		const aPath = store.mediaPath(a.id);
		const bPath = store.mediaPath(b.id);
		const expectFrame = async (
			name: string,
			path: string,
			grey: number,
			index: number
		) => {
			const [before, exact, after] = await Promise.all([
				greyOfFrame(path, index - 1, directory),
				greyOfFrame(path, index, directory),
				greyOfFrame(path, index + 1, directory),
			]);
			ensure(
				before !== exact && after !== exact,
				`${name}: neighbouring ramp frames are not distinct`
			);
			ensure(
				grey === exact,
				`${name}: boundary PNG is grey ${grey}; frame ${index - 1}/${index}/${index + 1} are ${before}/${exact}/${after}`
			);
		};
		await expectFrame("A's last frame", aPath, previousGrey, 17);
		await expectFrame("B's first frame", bPath, nextGrey, 12);
		ensure(
			frames.gap === 1 && frames.motionSeconds === 1,
			"gap and motion length"
		);
		results.push(
			`Generate motion: exact boundary frames extracted (A frame 17 grey ${previousGrey}, B frame 12 grey ${nextGrey})`
		);

		// A "generated" 2 s motion clip is trimmed to the 1 s gap.
		const motion: Asset = {
			createdAt: "2026-01-01T00:00:00.000Z",
			duration: 2,
			frameRate: RAMP_FPS,
			generation: { kind: "video", prompt: "motion", task: "flf" },
			hasAudio: false,
			height: 36,
			id: "00000000-0000-4000-8000-000000000199",
			kind: "video",
			name: "Motion bridge.mp4",
			width: 64,
		};
		await rampVideo(store.mediaPath(motion.id), 48);
		store.putAsset(motion);
		const placed = (await post(`/projects/${project.id}/gap-fill`, {
			afterClipId: outgoing.id,
			assetId: motion.id,
			revision: project.revision,
		})) as { clipId: string; project: Project };
		const bridge = placed.project.segments.find(
			(segment) => segment.id === placed.clipId
		);
		ensure(bridge, "motion bridge placed");
		ensure(
			bridge.start === 0.5 &&
				bridge.sourceIn === 0 &&
				bridge.sourceOut === 1 &&
				bridge.speed === 1,
			`motion bridge ${bridge.start} ${bridge.sourceIn}-${bridge.sourceOut} x${bridge.speed}`
		);
		ensure(
			bridge.transitionIn === undefined &&
				placed.project.segments.every(
					(segment) => segment.transitionIn === undefined
				),
			"motion bridges use hard cuts"
		);
		ensure(
			store.assets().find((asset) => asset.id === motion.id)?.derivation ===
				"gap-fill",
			"motion bridge tagged gap-fill"
		);
		const shorter = planGapFillMotion(
			project,
			store.assets(),
			outgoing.id,
			0.5
		);
		ensure(
			shorter.speed === 0.5 && shorter.sourceOut === 0.5,
			"a short clip is slowed to fill the gap"
		);
		results.push(
			"Generate motion: the clip fills the 1 s gap exactly with hard cuts"
		);
	} finally {
		app.stop();
		store.close();
	}
}
