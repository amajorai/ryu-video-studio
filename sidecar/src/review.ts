import { stat } from "node:fs/promises";
import type { Project } from "../../shared/project.ts";
import {
	type RenderReview,
	summarizeRenderReview,
} from "../../shared/render-review.ts";
import { probe, runMedia } from "./media.ts";

async function sampleLuma(path: string, time: number): Promise<number | null> {
	let output: string;
	try {
		output = await runMedia([
			"-hide_banner",
			"-loglevel",
			"error",
			"-nostdin",
			"-ss",
			String(Math.max(0, time)),
			"-i",
			path,
			"-frames:v",
			"1",
			"-vf",
			"scale=32:18,format=yuv420p,signalstats,metadata=print:file=-",
			"-f",
			"null",
			"-",
		]);
	} catch {
		return null;
	}
	const values = [
		...output.matchAll(/lavfi\.signalstats\.YMAX=([0-9]+(?:\.[0-9]+)?)/g),
	]
		.map((match) => Number(match[1]))
		.filter(Number.isFinite);
	return values.at(-1) ?? null;
}

async function frameRate(path: string): Promise<number> {
	let rateText: string;
	try {
		rateText = await runMedia(
			[
				"-v",
				"error",
				"-select_streams",
				"v:0",
				"-show_entries",
				"stream=avg_frame_rate",
				"-of",
				"csv=p=0",
				path,
			],
			{ probe: true }
		);
	} catch {
		return 0;
	}
	const [numerator, denominator] = rateText.trim().split("/").map(Number);
	return (numerator ?? 0) / (denominator ?? 0);
}

export async function reviewRender(
	path: string,
	project: Pick<Project, "width" | "height" | "fps"> & {
		duration: number;
		hasAudio: boolean;
	}
): Promise<RenderReview> {
	const info = await probe(path);
	const file = await stat(path);
	const duration = Math.max(0, project.duration);
	const sampleTimes = [
		0,
		duration / 3,
		(duration * 2) / 3,
		Math.max(0, duration - 1 / project.fps),
	];
	const samples: Array<number | null> = [];
	for (const time of sampleTimes) {
		samples.push(await sampleLuma(path, time));
	}
	return summarizeRenderReview({
		actual: {
			bytes: file.size,
			duration: info.duration,
			frameRate: await frameRate(path),
			hasAudio: info.hasAudio,
			height: info.height,
			width: info.width,
		},
		expected: {
			duration: project.duration,
			fps: project.fps,
			hasAudio: project.hasAudio,
			height: project.height,
			width: project.width,
		},
		samples,
	});
}
