/**
 * Real-FFmpeg proof that the widened clip speed range (0.1x..100x) produces
 * runnable `atempo` chains whose output duration matches the requested speed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audioTempoFilters } from "../../shared/audio.ts";

async function run(command: string[]): Promise<string> {
	const child = Bun.spawn(command, { stderr: "pipe", stdout: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) {
		throw new Error(`${command[0]} exited with ${code}: ${stderr.slice(-800)}`);
	}
	return stdout;
}

const directory = await mkdtemp(join(tmpdir(), "ryu-tempo-chain-"));
try {
	const cases = [
		{ seconds: 1, speed: 0.1 },
		{ seconds: 1, speed: 0.13 },
		{ seconds: 20, speed: 7.5 },
		{ seconds: 100, speed: 100 },
	];
	for (const { seconds, speed } of cases) {
		const output = join(directory, `tempo-${speed}.wav`);
		await run([
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			`sine=frequency=440:sample_rate=48000:duration=${seconds}`,
			"-af",
			audioTempoFilters(speed).join(","),
			"-y",
			output,
		]);
		const duration = Number(
			(
				await run([
					"ffprobe",
					"-v",
					"error",
					"-show_entries",
					"format=duration",
					"-of",
					"default=noprint_wrappers=1:nokey=1",
					output,
				])
			).trim()
		);
		const expected = seconds / speed;
		if (Math.abs(duration - expected) > Math.max(0.05, expected * 0.02)) {
			throw new Error(
				`speed ${speed}: expected ~${expected}s, got ${duration}s`
			);
		}
		process.stdout.write(
			`speed ${speed}x: ${audioTempoFilters(speed).length} atempo stages, ${duration.toFixed(3)}s (expected ${expected.toFixed(3)}s)\n`
		);
	}
} finally {
	await rm(directory, { force: true, recursive: true });
}
