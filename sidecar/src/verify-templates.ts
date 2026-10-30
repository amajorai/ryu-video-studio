/**
 * Real-FFmpeg proof for project templates (W4-N2).
 *
 * - A built-in template (Vlog intro) is instantiated through
 *   `POST /template-instances` with three user clips: a long red video, a
 *   blue still and a 1 s green video that must be slowed to fill its slot.
 *   The fourth slot keeps the gray placeholder matte, and the music bed is
 *   synthesized locally.
 * - The project renders; the export lasts the template length, carries
 *   audio, and sampled frames inside each slot show that slot's media.
 * - A project saved as a template and filled again renders the new media in
 *   the old clip's place.
 *
 * Run: `bun src/verify-templates.ts`
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Asset, Project } from "../../shared/project.ts";
import { soundtrackBarSeconds } from "../../shared/soundtrack.ts";
import {
	BUILT_IN_TEMPLATES,
	builtInTemplateDuration,
} from "../../shared/template-library.ts";
import { probe, runMedia } from "./media.ts";
import { createStudioServer } from "./server.ts";
import { type RenderJob, StudioStore } from "./store.ts";

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
const TOLERANCE = 12;

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-templates-"));
const store = new StudioStore(directory);
const token = crypto.randomUUID();
const app = createStudioServer({ port: 0, store, token });

async function call<Result>(path: string, body?: unknown): Promise<Result> {
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
	const value = (await response.json()) as Result;
	if (!response.ok) {
		throw new Error(`${path} ${response.status}: ${JSON.stringify(value)}`);
	}
	return value;
}

async function register(file: string): Promise<Asset> {
	const id = crypto.randomUUID();
	const media = await probe(file);
	await Bun.write(store.mediaPath(id), Bun.file(file));
	const asset: Asset = {
		...media,
		createdAt: new Date().toISOString(),
		id,
		name: file.split("/").at(-1) ?? "media",
	};
	store.putAsset(asset);
	return asset;
}

async function colorVideo(name: string, color: string, seconds: number) {
	const file = join(directory, name);
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=${color}:s=640x360:r=30:d=${seconds}`,
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		file,
	]);
	return await register(file);
}

async function colorStill(name: string, color: string) {
	const file = join(directory, name);
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=${color}:s=640x360`,
		"-frames:v",
		"1",
		file,
	]);
	return await register(file);
}

async function render(project: Project): Promise<string> {
	const queued = await call<RenderJob>(`/projects/${project.id}/render`, {});
	for (let attempt = 0; attempt < 1200; attempt++) {
		const job = store.jobs().find((value) => value.id === queued.id);
		if (job?.status === "completed") {
			return store.renderPath(job.id);
		}
		if (job?.status === "failed") {
			throw new Error(`Render failed: ${job.error ?? "unknown"}`);
		}
		await Bun.sleep(100);
	}
	throw new Error("Render timed out.");
}

/** The RGB pixel at (x, y) of the frame at `time`. */
async function pixel(file: string, time: number, x: number, y: number) {
	const output = join(directory, `pixel-${crypto.randomUUID()}.rgb`);
	await runMedia([
		"-y",
		"-ss",
		time.toFixed(3),
		"-i",
		file,
		"-frames:v",
		"1",
		"-vf",
		`crop=2:2:${x}:${y},format=rgb24`,
		"-f",
		"rawvideo",
		"-pix_fmt",
		"rgb24",
		output,
	]);
	const bytes = await readFile(output);
	return [bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0] as Rgb;
}

function near(actual: Rgb, expected: Rgb, label: string) {
	const off = actual.some(
		(channel, index) => Math.abs(channel - (expected[index] ?? 0)) > TOLERANCE
	);
	ensure(
		!off,
		`${label}: expected rgb(${expected.join(",")}), got rgb(${actual.join(",")})`
	);
}

interface Instance {
	adjustments: { change: string; segmentId: string }[];
	createdAssets: Asset[];
	project: Project;
	unfilledSlotIds: string[];
}

const RED: Rgb = [255, 0, 0];
const BLUE: Rgb = [0, 0, 255];
const GREEN: Rgb = [0, 128, 0];
const PLACEHOLDER: Rgb = [0x2e, 0x34, 0x40];

try {
	const red = await colorVideo("red.mp4", "red", 8);
	const blue = await colorStill("blue.png", "blue");
	const green = await colorVideo("green.mp4", "green", 1);

	const template = BUILT_IN_TEMPLATES.find(
		(item) => item.title === "Vlog intro"
	);
	ensure(template, "Vlog intro template is missing.");
	const instance = await call<Instance>("/template-instances", {
		templateId: template.id,
		assetIds: [red.id, blue.id, green.id],
		title: "Template proof",
	});
	ensure(
		instance.createdAssets.length === 2,
		"Expected a placeholder matte and a music bed to be created."
	);
	ensure(
		instance.unfilledSlotIds.length === 2,
		"Expected the last visual slot and the music slot to keep their placeholders."
	);
	ensure(
		instance.adjustments.some((item) => item.change === "retimed"),
		"Expected the 1 s clip to be retimed to fill its slot."
	);
	const output = await render(instance.project);
	const rendered = await probe(output);
	const duration = builtInTemplateDuration(template);
	ensure(
		Math.abs(rendered.duration - duration) < 0.2,
		`Export lasts ${rendered.duration}s, expected ${duration}s.`
	);
	ensure(rendered.hasAudio, "Export has no music bed.");
	process.stdout.write(
		`PASS: Vlog intro rendered ${rendered.duration.toFixed(2)}s with audio.\n`
	);

	// Slots: 2 bars red, 1 bar blue, 1 bar green (slowed), 2 bars placeholder.
	const bar = soundtrackBarSeconds(template.music.bpm);
	const samples: [number, Rgb, string][] = [
		[1, RED, "slot 1 (video)"],
		[2.5, BLUE, "slot 2 (still)"],
		[3.5, GREEN, "slot 3 (retimed video)"],
		[4.9, PLACEHOLDER, "slot 4 (placeholder)"],
	];
	for (const [bars, expected, label] of samples) {
		near(await pixel(output, bars * bar, 60, 60), expected, label);
		process.stdout.write(`PASS: ${label} shows its media.\n`);
	}

	// Save the filled project as a template and fill its first clip again.
	const filled = store.project(instance.project.id);
	const firstClip = filled.segments.find(
		(segment) => segment.assetId === red.id
	);
	ensure(firstClip, "The red clip is missing.");
	const saved = await call<{ project: Project }>(
		`/projects/${filled.id}/save-template`,
		{ slots: [{ segmentId: firstClip.id }], revision: filled.revision }
	);
	const second = await call<Instance>("/template-instances", {
		templateId: saved.project.id,
		assetIds: [blue.id],
	});
	const secondOutput = await render(second.project);
	near(await pixel(secondOutput, 1, 60, 60), BLUE, "refilled slot");
	near(await pixel(secondOutput, 2.5, 60, 60), BLUE, "kept still");
	process.stdout.write("PASS: a saved template refills its slot.\n");
} finally {
	app.stop();
	store.close();
	await rm(directory, { force: true, recursive: true });
}
