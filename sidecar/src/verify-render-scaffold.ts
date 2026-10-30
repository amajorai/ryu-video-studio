/**
 * Real-FFmpeg proof for the render scaffold (W0-B): every golden fixture in
 * `__fixtures__/render` encodes through the split orchestrator, and each of its
 * frame times renders a PNG of the canvas size. Synthetic media stand in for
 * the fixture assets.
 *
 * Run: `bun src/verify-render-scaffold.ts`
 */
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	type Asset,
	assetSchema,
	projectSchema,
} from "../../shared/project.ts";
import { runMedia } from "./media.ts";
import { assCaptions, buildRender } from "./render.ts";
import { segmentAudible } from "./render-stages/visibility.ts";

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const fixtureSchema = z.object({
	assets: z.array(assetSchema),
	assFile: z.string().optional(),
	frameTimes: z.array(z.number()),
	meshInputs: z
		.array(
			z.object({
				end: z.number(),
				path: z.string(),
				sequence: z.boolean().optional(),
				start: z.number(),
			})
		)
		.optional(),
	project: projectSchema,
});

const probeSchema = z.object({
	format: z.object({ duration: z.string().optional() }).optional(),
	streams: z
		.array(
			z.object({
				codec_type: z.string().optional(),
				height: z.number().optional(),
				width: z.number().optional(),
			})
		)
		.optional(),
});

async function probe(path: string) {
	return probeSchema.parse(
		JSON.parse(
			await runMedia(
				[
					"-v",
					"error",
					"-show_entries",
					"stream=codec_type,width,height:format=duration",
					"-of",
					"json",
					path,
				],
				{ probe: true }
			)
		)
	);
}

async function synthesize(asset: Asset, directory: string): Promise<string> {
	const seconds = String(asset.duration + 1);
	if (asset.kind === "image") {
		const path = join(directory, `${asset.id}.png`);
		await runMedia([
			"-y",
			"-f",
			"lavfi",
			"-i",
			`testsrc2=s=${asset.width}x${asset.height}`,
			"-frames:v",
			"1",
			path,
		]);
		return path;
	}
	if (asset.kind === "audio") {
		const path = join(directory, `${asset.id}.wav`);
		await runMedia([
			"-y",
			"-f",
			"lavfi",
			"-i",
			`sine=frequency=440:sample_rate=48000:duration=${seconds}`,
			"-ac",
			"2",
			path,
		]);
		return path;
	}
	const path = join(directory, `${asset.id}.mov`);
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		`testsrc2=s=${asset.width}x${asset.height}:r=30:d=${seconds}`,
		...(asset.hasAudio
			? [
					"-f",
					"lavfi",
					"-i",
					`sine=frequency=330:sample_rate=48000:duration=${seconds}`,
					"-c:a",
					"aac",
				]
			: []),
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-pix_fmt",
		"yuv420p",
		path,
	]);
	return path;
}

async function meshFrame(path: string, width: number, height: number) {
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=c=0x22aa88@0.6:s=${width}x${height},format=rgba`,
		"-frames:v",
		"1",
		path,
	]);
}

const fixtureDirectory = join(import.meta.dir, "__fixtures__", "render");
const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-scaffold-"));
const results: string[] = [];
try {
	for (const file of (await readdir(fixtureDirectory)).sort()) {
		if (!file.endsWith(".json")) {
			continue;
		}
		const name = file.replace(/\.json$/, "");
		const fixture = fixtureSchema.parse(
			JSON.parse(await readFile(join(fixtureDirectory, file), "utf8"))
		);
		const project = fixture.project;
		const work = join(directory, name);
		await mkdir(work);
		const paths = new Map<string, string>();
		for (const asset of fixture.assets) {
			paths.set(asset.id, await synthesize(asset, work));
		}
		const meshInputs = [];
		for (const [index, mesh] of (fixture.meshInputs ?? []).entries()) {
			if (mesh.sequence) {
				const sequence = join(work, `mesh-${index}`);
				await mkdir(sequence);
				const frames = Math.ceil((mesh.end - mesh.start) * project.fps) + 1;
				for (let frame = 0; frame < frames; frame++) {
					await meshFrame(
						join(sequence, `frame-${String(frame).padStart(6, "0")}.png`),
						project.width,
						project.height
					);
				}
				meshInputs.push({ ...mesh, path: sequence });
			} else {
				const path = join(work, `mesh-${index}.png`);
				await meshFrame(path, project.width, project.height);
				meshInputs.push({ ...mesh, path });
			}
		}
		if (fixture.assFile) {
			await Bun.write(join(work, fixture.assFile), assCaptions(project));
		}
		const mediaPath = (id: string) => {
			const path = paths.get(id);
			ensure(path, `${name}: missing synthetic media for ${id}`);
			return path;
		};
		const output = join(
			work,
			`export.${project.exportCodec === "prores" ? "mov" : "mp4"}`
		);
		await runMedia(
			[
				...buildRender(
					project,
					fixture.assets,
					mediaPath,
					fixture.assFile,
					meshInputs
				),
				output,
			],
			{ cwd: work }
		);
		const exported = await probe(output);
		const video = exported.streams?.find(
			(stream) => stream.codec_type === "video"
		);
		ensure(
			video?.width === project.width && video.height === project.height,
			`${name}: export is not ${project.width}x${project.height}`
		);
		const expectsAudio = project.segments.some((segment) =>
			segmentAudible(
				project,
				segment,
				fixture.assets.find((asset) => asset.id === segment.assetId)
			)
		);
		const hasAudio = Boolean(
			exported.streams?.some((stream) => stream.codec_type === "audio")
		);
		ensure(
			hasAudio === expectsAudio,
			`${name}: audio stream presence is ${hasAudio}, expected ${expectsAudio}`
		);
		const duration = Number(exported.format?.duration ?? 0);
		const expected = Math.max(
			...project.segments.map(
				(segment) =>
					segment.start + (segment.sourceOut - segment.sourceIn) / segment.speed
			),
			...project.titles.map((title) => title.end),
			...project.graphics.map((graphic) => graphic.end),
			...project.avatars.map((avatar) => avatar.end),
			...project.spatialObjects.map((object) => object.end)
		);
		ensure(
			Math.abs(duration - expected) < 0.15,
			`${name}: export lasts ${duration}s, expected ${expected}s`
		);
		for (const time of fixture.frameTimes) {
			const png = join(work, `frame-${time}.png`);
			await runMedia(
				[
					...buildRender(
						project,
						fixture.assets,
						mediaPath,
						fixture.assFile,
						meshInputs,
						time
					),
					png,
				],
				{ cwd: work }
			);
			const frame = (await probe(png)).streams?.[0];
			ensure(
				frame?.width === project.width && frame.height === project.height,
				`${name}: frame at ${time}s is not ${project.width}x${project.height}`
			);
		}
		results.push(
			`${name}: ${duration.toFixed(2)}s ${video.width}x${video.height}${hasAudio ? " +audio" : ""}, ${fixture.frameTimes.length} frame(s)`
		);
	}
	ensure(
		results.length === 8,
		`expected 8 fixtures, rendered ${results.length}`
	);
	for (const line of results) {
		console.info(`PASS: ${line}`);
	}
} finally {
	await rm(directory, { recursive: true, force: true });
}
