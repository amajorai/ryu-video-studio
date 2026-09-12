import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newProject } from "../../shared/project.ts";
import { runMedia } from "./media.ts";
import { buildRender } from "./render.ts";
import { reviewRender } from "./review.ts";

function ensure(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-codecs-"));
try {
	const project = newProject("Codec verification");
	project.width = 640;
	project.height = 360;
	project.fps = 24;
	project.graphics = [
		{
			animation: "none",
			end: 1,
			entryDuration: 0,
			fill: "#2563eb",
			height: 0.5,
			id: crypto.randomUUID(),
			opacity: 1,
			shape: "ellipse",
			start: 0,
			stroke: "#ffffff",
			strokeWidth: 0,
			width: 0.5,
			x: 0.25,
			y: 0.25,
		},
	];
	const expected = {
		h264: "h264",
		h265: "hevc",
		prores: "prores",
	} as const;
	const results: string[] = [];
	for (const codec of ["h264", "h265", "prores"] as const) {
		project.exportCodec = codec;
		const output = join(
			directory,
			`${codec}.${codec === "prores" ? "mov" : "mp4"}`
		);
		await runMedia(
			[...buildRender(project, [], () => "/tmp/missing.mp4"), output],
			{
				cwd: directory,
			}
		);
		const probe = JSON.parse(
			await runMedia(
				[
					"-v",
					"error",
					"-show_entries",
					"stream=codec_name,width,height,r_frame_rate:format=duration",
					"-of",
					"json",
					output,
				],
				{ probe: true }
			)
		) as {
			streams?: Array<{
				codec_name?: string;
				height?: number;
				r_frame_rate?: string;
				width?: number;
			}>;
			format?: { duration?: string };
		};
		const stream = probe.streams?.[0];
		ensure(stream, `${codec} did not produce a video stream.`);
		ensure(
			stream.codec_name === expected[codec],
			`${codec} encoded as ${stream.codec_name ?? "unknown"}.`
		);
		ensure(stream.width === project.width, `${codec} width is incorrect.`);
		ensure(stream.height === project.height, `${codec} height is incorrect.`);
		ensure(stream.r_frame_rate === "24/1", `${codec} frame rate is incorrect.`);
		ensure(
			Math.abs(Number(probe.format?.duration) - 1) < 0.1,
			`${codec} duration is incorrect.`
		);
		const review = await reviewRender(output, {
			duration: 1,
			fps: project.fps,
			hasAudio: false,
			height: project.height,
			width: project.width,
		});
		ensure(review.passed, `${codec} delivery review did not pass.`);
		results.push(
			`${codec}=${stream.codec_name} ${stream.width}x${stream.height}`
		);
	}
	console.log(`PASS: ${results.join(", ")}`);
} finally {
	await rm(directory, { recursive: true, force: true });
}
