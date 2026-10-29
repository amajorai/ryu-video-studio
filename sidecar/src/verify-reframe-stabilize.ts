/**
 * Real-FFmpeg proof for auto reframe with image stabilization.
 *
 * A 3 s, 640x360 clip is a crop of a still (a dimmed, blurred grey test
 * pattern with a magenta square in the middle) whose window jumps by up to
 * ±16 px horizontally and ±13 px vertically every frame, so the square
 * jitters like handheld footage of a static subject. The clip is reframed to 9:16 through
 * `POST /projects/:id/reframe` twice, with `mode: "track"`: once with
 * `stabilize: "high"` and once without, and both are exported through the
 * render queue.
 *
 * Checks: the stabilized run swaps the clip onto a `stabilize` derivative of
 * its media (and a second run reuses it), and the square's frame-to-frame
 * movement in the stabilized export is less than half of the unstabilized
 * export's.
 *
 * Run: `bun sidecar/src/verify-reframe-stabilize.ts`
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	type Asset,
	newSegment,
	type Project,
	projectSchema,
} from "../../shared/project.ts";
import { probe, runMedia } from "./media.ts";
import { createStudioServer } from "./server.ts";
import { type RenderJob, StudioStore } from "./store.ts";

function verifyThat(condition: boolean, message: string): void {
	if (!condition) {
		throw new Error(`FAIL: ${message}`);
	}
}

const WIDTH = 640;
const HEIGHT = 360;
const FPS = 30;
const directory = await mkdtemp(join(tmpdir(), "ryu-verify-reframe-stab-"));
const store = new StudioStore(directory);
const token = crypto.randomUUID();
const app = createStudioServer({ port: 0, store, token });

const reframeResponseSchema = z.object({
	clips: z.array(z.object({ keyframes: z.number(), mode: z.string() })),
	height: z.number(),
	project: z.unknown(),
	stabilized: z
		.array(
			z.object({
				assetId: z.string().optional(),
				clipId: z.string(),
				skipped: z.string().optional(),
			})
		)
		.optional(),
	width: z.number(),
});

async function call(path: string, body?: unknown): Promise<unknown> {
	const response = await fetch(
		`http://127.0.0.1:${app.server.port}/api/video-studio${path}`,
		{
			body: body === undefined ? undefined : JSON.stringify(body),
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			method: body === undefined ? "GET" : "POST",
		}
	);
	const value: unknown = await response.json();
	if (!response.ok) {
		throw new Error(`${path} ${response.status}: ${JSON.stringify(value)}`);
	}
	return value;
}

async function waitForRender(project: Project): Promise<string> {
	const queued = z
		.object({ id: z.string() })
		.parse(await call(`/projects/${project.id}/render`, {}));
	for (let attempt = 0; attempt < 600; attempt += 1) {
		const job: RenderJob | undefined = store
			.jobs()
			.find((candidate) => candidate.id === queued.id);
		if (job?.status === "completed") {
			return store.renderPath(job.id);
		}
		if (job?.status === "failed") {
			throw new Error(`Render failed: ${job.error ?? "unknown error"}`);
		}
		await Bun.sleep(100);
	}
	throw new Error("Render timed out.");
}

/** Centroid x/y of the magenta square in every frame of `file`. */
async function squarePath(
	file: string,
	width: number,
	height: number
): Promise<{ x: number; y: number }[]> {
	const raw = join(directory, `frames-${crypto.randomUUID()}.rgb`);
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-i",
		file,
		"-pix_fmt",
		"rgb24",
		"-f",
		"rawvideo",
		raw,
	]);
	const pixels = await readFile(raw);
	const frameBytes = width * height * 3;
	const path: { x: number; y: number }[] = [];
	for (let offset = 0; offset + frameBytes <= pixels.length; ) {
		let sumX = 0;
		let sumY = 0;
		let count = 0;
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const index = offset + (y * width + x) * 3;
				const r = pixels[index] ?? 0;
				const g = pixels[index + 1] ?? 0;
				const b = pixels[index + 2] ?? 0;
				if (r > 170 && b > 170 && g < 90) {
					sumX += x;
					sumY += y;
					count += 1;
				}
			}
		}
		if (count > 20) {
			path.push({ x: sumX / count, y: sumY / count });
		}
		offset += frameBytes;
	}
	return path;
}

/** Mean frame-to-frame movement of a path, in pixels. */
function meanStep(path: readonly { x: number; y: number }[]): number {
	let total = 0;
	for (let index = 1; index < path.length; index += 1) {
		const previous = path[index - 1];
		const current = path[index];
		if (previous && current) {
			total += Math.hypot(current.x - previous.x, current.y - previous.y);
		}
	}
	return path.length > 1 ? total / (path.length - 1) : 0;
}

const results: string[] = [];
try {
	const still = join(directory, "scene.png");
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		"testsrc=s=704x416:r=1:d=1",
		"-f",
		"lavfi",
		"-i",
		"color=c=0xff00ff:s=64x64",
		"-filter_complex",
		"[0]format=gray,boxblur=3,eq=contrast=0.35:brightness=-0.25,format=rgb24[bg];[bg][1]overlay=x=320:y=176",
		"-frames:v",
		"1",
		still,
	]);
	const shaky = join(directory, "shaky.mp4");
	// The crop window shakes; the square (scene centre 200,120) jitters.
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-loop",
		"1",
		"-framerate",
		String(FPS),
		"-t",
		"3",
		"-i",
		still,
		"-vf",
		`crop=w=${WIDTH}:h=${HEIGHT}:x='32+10*sin(n*1.7)+6*sin(n*0.9)':y='28+8*cos(n*2.3)+5*sin(n*1.1)'`,
		"-c:v",
		"libx264",
		"-crf",
		"16",
		"-pix_fmt",
		"yuv420p",
		"-r",
		String(FPS),
		shaky,
	]);
	const id = crypto.randomUUID();
	await Bun.write(store.mediaPath(id), Bun.file(shaky));
	const asset: Asset = {
		...(await probe(shaky)),
		createdAt: new Date().toISOString(),
		id,
		name: "shaky.mp4",
	};
	store.putAsset(asset);

	const reframe = async (title: string, stabilize?: "high") => {
		const clip = newSegment(asset);
		const created = store.save({
			...store.create(title),
			height: HEIGHT,
			segments: [clip],
			width: WIDTH,
		});
		const response = reframeResponseSchema.parse(
			await call(`/projects/${created.id}/reframe`, {
				aspect: "9:16",
				mode: "track",
				revision: created.revision,
				smoothing: 0.5,
				stabilize,
			})
		);
		return { clip, response, project: projectSchema.parse(response.project) };
	};

	const steady = await reframe("Stabilized reframe", "high");
	const derivative = store
		.assets()
		.find((item) => item.derivedFromAssetId === asset.id);
	verifyThat(
		derivative?.derivation === "stabilize",
		"a stabilized derivative of the clip media exists"
	);
	verifyThat(
		steady.response.stabilized?.[0]?.assetId === derivative?.id &&
			steady.project.segments[0]?.assetId === derivative?.id,
		`the reframed clip plays the stabilized media, got ${JSON.stringify(steady.response.stabilized)}`
	);
	verifyThat(
		steady.response.clips[0]?.mode === "track",
		"the stabilized clip is still tracked"
	);
	results.push(
		`stabilized derivative ${derivative?.id ?? ""} swapped in; ${steady.response.clips[0]?.keyframes ?? 0} pan keyframes`
	);
	const shakyRun = await reframe("Unstabilized reframe");
	verifyThat(
		shakyRun.response.stabilized === undefined &&
			shakyRun.project.segments[0]?.assetId === asset.id,
		"without stabilize the clip keeps its media"
	);
	const reuse = await reframe("Reused stabilization", "high");
	verifyThat(
		reuse.project.segments[0]?.assetId === derivative?.id &&
			store.assets().filter((item) => item.derivation === "stabilize")
				.length === 1,
		"a second stabilized reframe reuses the derivative"
	);
	results.push("a second stabilized reframe reuses the same derivative");

	const steadyRender = await waitForRender(steady.project);
	const shakyRender = await waitForRender(shakyRun.project);
	const media = await probe(steadyRender);
	verifyThat(
		media.width === steady.response.width &&
			media.height === steady.response.height,
		`the export is ${steady.response.width}x${steady.response.height}, got ${media.width}x${media.height}`
	);
	const steadyPath = await squarePath(
		steadyRender,
		steady.response.width,
		steady.response.height
	);
	const shakyPath = await squarePath(
		shakyRender,
		shakyRun.response.width,
		shakyRun.response.height
	);
	verifyThat(
		steadyPath.length > 50 && shakyPath.length > 50,
		`the square is in frame in both exports (${steadyPath.length} and ${shakyPath.length} frames)`
	);
	const steadyStep = meanStep(steadyPath);
	const shakyStep = meanStep(shakyPath);
	verifyThat(
		steadyStep < shakyStep * 0.5,
		`stabilization steadies the subject (${steadyStep.toFixed(2)} px/frame vs ${shakyStep.toFixed(2)} px/frame)`
	);
	results.push(
		`subject movement: ${steadyStep.toFixed(2)} px/frame stabilized vs ${shakyStep.toFixed(2)} px/frame without`
	);
	for (const line of results) {
		process.stdout.write(`ok  ${line}\n`);
	}
	process.stdout.write("verify-reframe-stabilize: PASS\n");
} finally {
	app.stop();
	store.close();
	await rm(directory, { force: true, recursive: true });
}
