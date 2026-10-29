import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probe, runMedia } from "./media.ts";

test("a timed-out real encode can retry and produce independently probed media", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-timeout-"));
	const output = join(directory, "retry.mp4");
	try {
		await expect(
			runMedia(
				[
					"-v",
					"error",
					"-re",
					"-f",
					"lavfi",
					"-i",
					"color=c=blue:s=160x90:r=24:d=30",
					"-c:v",
					"libx264",
					"-y",
					output,
				],
				{ timeoutMs: 250 }
			)
		).rejects.toThrow("Media operation timed out.");
		await runMedia([
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=c=blue:s=160x90:r=24:d=1",
			"-c:v",
			"libx264",
			"-y",
			output,
		]);
		expect(await probe(output)).toMatchObject({
			kind: "video",
			duration: 1,
			width: 160,
			height: 90,
			hasAudio: false,
		});
		await runMedia(["-v", "error", "-i", output, "-f", "null", "-"]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("canceling a running real media process reports cancellation rather than timeout", async () => {
	const controller = new AbortController();
	const cancel = setTimeout(() => controller.abort(), 250);
	try {
		await expect(
			runMedia(
				[
					"-v",
					"error",
					"-re",
					"-f",
					"lavfi",
					"-i",
					"color=s=160x90:r=24:d=30",
					"-f",
					"null",
					"-",
				],
				{ signal: controller.signal, timeoutMs: 5000 }
			)
		).rejects.toThrow("Operation canceled.");
	} finally {
		clearTimeout(cancel);
	}
});
