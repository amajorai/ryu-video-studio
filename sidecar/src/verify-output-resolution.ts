/**
 * Real-FFmpeg proof for export resolution tiers. Renders solid-colour
 * fixtures on 16:9, 9:16, 4:5 and an odd custom canvas through
 * `POST /projects/:id/render` with `outputResolution`, then checks with
 * ffprobe that the short side is the tier, the aspect is kept (even sizes)
 * and the frame edges hold picture, not letterbox bars. Also checks a tier
 * replaces a preset size without a letterbox warning, and that a tier with
 * an explicit size is refused. Run: `bun sidecar/src/verify-output-resolution.ts`.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputResolution } from "../../shared/output-resolution.ts";
import { type Asset, newSegment, type Project } from "../../shared/project.ts";
import {
	type ExportJobOutput,
	exportJobOutputSchema,
	type RenderRequest,
} from "../../shared/render-options.ts";
import { probe, runMedia } from "./media.ts";
import { createStudioServer } from "./server.ts";
import { type RenderJob, StudioStore } from "./store.ts";

type ExportJob = RenderJob & { export?: ExportJobOutput };

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

function same(actual: unknown, expected: unknown, label = "value") {
	const left = JSON.stringify(actual);
	const right = JSON.stringify(expected);
	ensure(left === right, `${label}: expected ${right}, received ${left}`);
}

function videoSize(path: string): { height: number; width: number } {
	const result = spawnSync(
		"ffprobe",
		[
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=width,height",
			"-of",
			"json",
			path,
		],
		{ encoding: "utf8" }
	);
	same(result.status, 0, result.stderr);
	const parsed = JSON.parse(result.stdout) as {
		streams?: { height?: number; width?: number }[];
	};
	const stream = parsed.streams?.[0];
	ensure(stream?.width && stream.height, "the export has a video stream");
	return { width: stream.width, height: stream.height };
}

/** Mean luma (0-255) of a `w`×`h` crop at (x, y) of the first frame. */
function lumaAt(
	path: string,
	crop: { h: number; w: number; x: number; y: number }
): number {
	const result = spawnSync(
		"ffmpeg",
		[
			"-v",
			"error",
			"-i",
			path,
			"-frames:v",
			"1",
			"-vf",
			`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},format=gray`,
			"-f",
			"rawvideo",
			"-",
		],
		{ maxBuffer: crop.w * crop.h * 2 }
	);
	same(result.status, 0, String(result.stderr));
	const frame = result.stdout as Buffer;
	same(frame.length, crop.w * crop.h, "one gray crop");
	let total = 0;
	for (const value of frame) {
		total += value;
	}
	return total / frame.length;
}

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-resolution-"));
const store = new StudioStore(directory);
const token = crypto.randomUUID();
const app = createStudioServer({ store, token, port: 0 });
let passed = 0;

async function call(
	path: string,
	body: unknown
): Promise<{ ok: boolean; value: unknown }> {
	const response = await fetch(
		`http://127.0.0.1:${app.server.port}/api/video-studio${path}`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		}
	);
	return { ok: response.ok, value: await response.json() };
}

async function importFixture(
	name: string,
	size: { height: number; width: number }
): Promise<Asset> {
	const file = join(directory, name);
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=c=0x3080c0:s=${size.width}x${size.height}:r=30:d=1`,
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		file,
	]);
	const asset: Asset = {
		...(await probe(file)),
		id: crypto.randomUUID(),
		name,
		createdAt: new Date().toISOString(),
	};
	await Bun.write(store.mediaPath(asset.id), Bun.file(file));
	store.putAsset(asset);
	return asset;
}

async function render(project: Project, request: RenderRequest) {
	const queued = await call(`/projects/${project.id}/render`, request);
	ensure(queued.ok, `render refused: ${JSON.stringify(queued.value)}`);
	const { id } = queued.value as { id: string };
	for (let attempt = 0; attempt < 2400; attempt++) {
		const job = store.jobs().find((value) => value.id === id) as
			| ExportJob
			| undefined;
		if (job && ["completed", "failed", "canceled"].includes(job.status)) {
			same(job.status, "completed", job.error ?? "export failed");
			return {
				output: exportJobOutputSchema.parse(job.export),
				path: store.renderPath(job.id, job.codec),
			};
		}
		await Bun.sleep(50);
	}
	throw new Error("export timed out");
}

function pass(message: string) {
	passed += 1;
	process.stdout.write(`PASS: ${message}\n`);
}

async function canvasProject(
	title: string,
	size: { height: number; width: number }
): Promise<Project> {
	const source = await importFixture(`${title}.mp4`, size);
	return store.save({
		...store.create(title),
		fps: 30,
		...size,
		segments: [{ ...newSegment(source, 0, 0), sourceOut: 1 }],
	});
}

/** Every edge of the frame holds the fixture colour (luma ~ 100), not a bar. */
function ensureNoBars(path: string, size: { height: number; width: number }) {
	const edges = [
		{ x: 0, y: 0, w: size.width, h: 4 },
		{ x: 0, y: size.height - 4, w: size.width, h: 4 },
		{ x: 0, y: 0, w: 4, h: size.height },
		{ x: size.width - 4, y: 0, w: 4, h: size.height },
	];
	for (const edge of edges) {
		const luma = lumaAt(path, edge);
		ensure(luma > 60, `edge ${JSON.stringify(edge)} is a bar (luma ${luma})`);
	}
}

try {
	const cases: {
		canvas: { height: number; width: number };
		expected: { height: number; width: number };
		tier: OutputResolution;
		title: string;
	}[] = [
		{
			title: "Landscape",
			canvas: { width: 320, height: 180 },
			tier: "720p",
			expected: { width: 1280, height: 720 },
		},
		{
			title: "Landscape 1080",
			canvas: { width: 320, height: 180 },
			tier: "1080p",
			expected: { width: 1920, height: 1080 },
		},
		{
			title: "Vertical",
			canvas: { width: 180, height: 320 },
			tier: "720p",
			expected: { width: 720, height: 1280 },
		},
		{
			title: "Four by five",
			canvas: { width: 256, height: 320 },
			tier: "2k",
			expected: { width: 1440, height: 1800 },
		},
		{
			title: "Odd custom",
			canvas: { width: 250, height: 154 },
			tier: "720p",
			expected: { width: 1168, height: 720 },
		},
	];
	for (const entry of cases) {
		const project = await canvasProject(entry.title, entry.canvas);
		const { output, path } = await render(project, {
			outputResolution: entry.tier,
			overrides: { encoderPreset: "ultrafast" },
		});
		const size = videoSize(path);
		same(size, entry.expected, `${entry.title} ${entry.tier} size`);
		same(
			{ width: output.width, height: output.height },
			entry.expected,
			"job summary size"
		);
		same(output.request?.outputResolution, entry.tier, "recorded tier");
		ensureNoBars(path, size);
		const drift = Math.abs(
			size.width / size.height - entry.canvas.width / entry.canvas.height
		);
		ensure(drift < 0.01, `${entry.title} aspect drift ${drift}`);
		pass(
			`${entry.title} ${entry.canvas.width}x${entry.canvas.height} at ${entry.tier}: ${size.width}x${size.height}, aspect kept, no bars`
		);
	}
	{
		const project = await canvasProject("Preset", { width: 256, height: 320 });
		const { output, path } = await render(project, {
			outputResolution: "720p",
			overrides: { platformPreset: "tiktok", encoderPreset: "ultrafast" },
		});
		same(videoSize(path), { width: 720, height: 900 }, "tier over TikTok");
		ensure(
			!output.warnings.some((warning) => warning.includes("letterboxed")),
			"no letterbox warning when the tier replaces the preset size"
		);
		ensureNoBars(path, { width: 720, height: 900 });
		pass("4:5 canvas with TikTok preset at 720p: 720x900, no letterbox");
		const refused = await call(`/projects/${project.id}/render`, {
			outputResolution: "1080p",
			overrides: { outputWidth: 640, outputHeight: 360 },
		});
		ensure(!refused.ok, "a tier with an explicit size is refused");
		ensure(
			JSON.stringify(refused.value).includes("not both"),
			"refusal names the conflict"
		);
		pass("tier plus explicit output size is refused with 400");
	}
	process.stdout.write(`\n${passed} output resolution checks passed.\n`);
} finally {
	app.stop();
	store.close();
	await rm(directory, { recursive: true, force: true });
}
