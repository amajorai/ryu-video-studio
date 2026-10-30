import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	mediaFailureMessage,
	parseProbeOutput,
	readProbeFile,
	runMedia,
} from "./media.ts";

test("media runner stops oversized file output while the producer is running", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-probe-producer-"));
	const file = join(directory, "probe.json");
	const previous = process.env.RYU_VIDEO_STUDIO_FFPROBE;
	process.env.RYU_VIDEO_STUDIO_FFPROBE = process.execPath;
	try {
		const script = `await Bun.write(${JSON.stringify(file)}, new Uint8Array(8000001)); await Bun.sleep(10000);`;
		await expect(
			runMedia(["-e", script], {
				probe: true,
				outputPath: file,
				timeoutMs: 3000,
			})
		).rejects.toThrow("output limit");
	} finally {
		if (previous === undefined) {
			delete process.env.RYU_VIDEO_STUDIO_FFPROBE;
		} else {
			process.env.RYU_VIDEO_STUDIO_FFPROBE = previous;
		}
		await rm(directory, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("file-backed probe output obeys the same byte budget as stdout", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-probe-budget-"));
	const file = join(directory, "probe.json");
	try {
		await writeFile(file, "{}");
		expect(await readProbeFile(file)).toBe("{}");
		await writeFile(file, Buffer.alloc(8_000_001, 32));
		await expect(readProbeFile(file)).rejects.toThrow("output limit");
		expect(() => parseProbeOutput("é".repeat(4_000_001))).toThrow(
			"output limit"
		);
	} finally {
		await rm(directory, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("probe parsing retains embedded source timecode and frame rate", () => {
	const parsed = parseProbeOutput(
		JSON.stringify({
			format: { duration: "1", tags: {} },
			streams: [
				{
					avg_frame_rate: "30/1",
					codec_name: "h264",
					codec_type: "video",
					duration: "1",
					height: 180,
					tags: { timecode: "01:02:03:04" },
					width: 320,
				},
			],
		})
	);
	expect(parsed).toMatchObject({
		timecodeFrameRate: 30,
		timecodeStart: "01:02:03:04",
	});
});

test("missing subtitles filter names the host capability needed for titles and captions", () => {
	expect(mediaFailureMessage("No such filter: 'subtitles'")).toBe(
		"FFmpeg is missing the subtitles filter (libass), required to render titles and captions. Install a full build."
	);
	expect(mediaFailureMessage("No such filter: 'xfade'")).toBe(
		"This FFmpeg installation lacks a required video filter. Install the full build."
	);
});
