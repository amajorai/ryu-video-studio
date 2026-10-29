/**
 * Real-FFmpeg proof for the projects dashboard (W1-WS5).
 *
 * 1. A timeline that opens on a one-second gap before a solid red clip gets a
 *    poster taken at the clip's start, so the decoded poster is red, not the
 *    black canvas; the second request is served from the per-revision cache.
 * 2. A real export completes, and deleting the project removes the export
 *    file, its delivery thumbnail, its job record, history, and poster cache,
 *    while the media asset stays in the library.
 *
 * Run: `bun src/verify-projects-dashboard.ts`
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Asset, newSegment } from "../../shared/project.ts";
import { projectSummariesResponseSchema } from "../../shared/project-summary.ts";
import { probe, runMedia } from "./media.ts";
import { RenderQueue } from "./render.ts";
import { routes } from "./routes/projects-ext.ts";
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

const posterSchema = z.object({
	cached: z.boolean(),
	data: z.string(),
	height: z.number(),
	revision: z.number(),
	time: z.number(),
	width: z.number(),
});

async function centerRgb(png: Uint8Array, directory: string) {
	const input = join(directory, "poster.png");
	const output = join(directory, "poster.rgb");
	await writeFile(input, png);
	await runMedia([
		"-v",
		"error",
		"-y",
		"-i",
		input,
		"-f",
		"rawvideo",
		"-pix_fmt",
		"rgb24",
		output,
	]);
	return new Uint8Array(await readFile(output));
}

async function main() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-verify-projects-"));
	const store = new StudioStore(directory);
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, routes, store, token });
	const call = (method: "GET" | "DELETE", path: string) =>
		fetch(`http://127.0.0.1:${app.server.port}/api/video-studio${path}`, {
			headers: { authorization: `Bearer ${token}` },
			method,
		});
	try {
		const source = join(directory, "red.mp4");
		await runMedia([
			"-v",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"color=c=red:s=320x180:r=30:d=3",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			source,
		]);
		const asset: Asset = {
			...(await probe(source)),
			createdAt: new Date().toISOString(),
			id: crypto.randomUUID(),
			name: "Red",
		};
		await Bun.write(store.mediaPath(asset.id), Bun.file(source));
		store.putAsset(asset);
		const project = store.save({
			...store.create("Poster proof"),
			width: 320,
			height: 180,
			segments: [{ ...newSegment(asset, 1), sourceOut: 2 }],
		});

		const first = posterSchema.parse(
			await (await call("GET", `/projects/${project.id}/poster`)).json()
		);
		ensure(!first.cached, "The first poster request should render.");
		ensure(first.time === 1, `Poster time ${first.time}, expected 1.`);
		const rgb = await centerRgb(Buffer.from(first.data, "base64"), directory);
		ensure(
			rgb.length === 320 * 180 * 3,
			`Decoded poster has ${rgb.length} bytes, expected ${320 * 180 * 3}.`
		);
		const center = (90 * 320 + 160) * 3;
		const [red, green, blue] = [rgb[center], rgb[center + 1], rgb[center + 2]];
		ensure(
			red !== undefined &&
				green !== undefined &&
				blue !== undefined &&
				red > 200 &&
				green < 60 &&
				blue < 60,
			`Poster centre is rgb(${red}, ${green}, ${blue}); expected red.`
		);
		const second = posterSchema.parse(
			await (await call("GET", `/projects/${project.id}/poster`)).json()
		);
		ensure(second.cached, "The second poster request should hit the cache.");
		ensure(second.data === first.data, "The cached poster changed.");

		const summaries = projectSummariesResponseSchema.parse(
			await (await call("GET", "/project-summaries")).json()
		);
		const summary = summaries.projects.find((item) => item.id === project.id);
		ensure(summary?.duration === 3, "Summary duration should be 3 s.");
		ensure(summary.segmentCount === 1, "Summary should count one clip.");

		const queued = new RenderQueue(store).start(project);
		// The export was just queued and cannot have finished encoding yet.
		const refused = await call(
			"DELETE",
			`/projects/${project.id}/delete?revision=${project.revision}`
		);
		ensure(
			refused.status === 409,
			`Delete during an export answered ${refused.status}, expected 409.`
		);
		let job = queued;
		for (let attempt = 0; attempt < 600; attempt++) {
			job = store.jobs().find((item) => item.id === queued.id) ?? job;
			if (["completed", "failed"].includes(job.status)) {
				break;
			}
			await Bun.sleep(100);
		}
		ensure(job.status === "completed", `Export failed: ${job.error}`);
		const output = store.renderPath(job.id, job.codec);
		const thumbnail = join(directory, "renders", `${job.id}.jpg`);
		const poster = store.posterPath(project.id, project.revision);
		ensure(existsSync(output), "The export file is missing.");
		ensure(existsSync(thumbnail), "The export thumbnail is missing.");
		ensure(existsSync(poster), "The poster cache is missing.");

		const deleted = await call(
			"DELETE",
			`/projects/${project.id}/delete?revision=${project.revision}`
		);
		ensure(deleted.status === 200, `Delete answered ${deleted.status}.`);
		ensure(!existsSync(output), "The export file survived the delete.");
		ensure(!existsSync(thumbnail), "The export thumbnail survived.");
		ensure(!existsSync(poster), "The poster cache survived.");
		ensure(
			!store.jobs().some((item) => item.projectId === project.id),
			"The export record survived."
		);
		ensure(store.history(project.id).length === 0, "History survived.");
		ensure(
			store.assets().some((item) => item.id === asset.id) &&
				existsSync(store.mediaPath(asset.id)),
			"The media asset should stay in the library."
		);
		process.stdout.write(
			"verify-projects-dashboard: poster, cache, and delete passed\n"
		);
	} finally {
		app.server.stop(true);
		store.close();
		await rm(directory, { force: true, recursive: true });
	}
}

await main();
