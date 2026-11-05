import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Asset, newSegment } from "../../shared/project.ts";
import { inspectMediaAsset, renderTimelineFrame } from "./capture.ts";
import { ffmpegLacksFilter } from "./ffmpeg-build-fixture.ts";
import { runMedia } from "./media.ts";
import { assCaptions, buildRender } from "./render.ts";
import { StudioStore } from "./store.ts";

// The timed captions burn in through the `subtitles` filter (libass), which
// some package builds (Homebrew) leave out.
test.skipIf(ffmpegLacksFilter("subtitles"))(
	"direct frame retains overlapping layers, source trim/speed, fades, keyframes and timed captions",
	async () => {
		const store = new StudioStore(
			await mkdtemp(join(tmpdir(), "ryu-frame-pixels-"))
		);
		try {
			const source: Asset = {
				id: crypto.randomUUID(),
				name: "Test pattern",
				kind: "video",
				duration: 2,
				width: 320,
				height: 180,
				hasAudio: false,
				createdAt: new Date().toISOString(),
			};
			const backing: Asset = {
				...source,
				id: crypto.randomUUID(),
				name: "Red backing",
				kind: "image",
				duration: 5,
			};
			await runMedia([
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-f",
				"lavfi",
				"-i",
				"testsrc2=s=320x180:r=30:d=2",
				"-c:v",
				"libx264",
				"-f",
				"mp4",
				store.mediaPath(source.id),
			]);
			await runMedia([
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-f",
				"lavfi",
				"-i",
				"color=red:s=320x180",
				"-frames:v",
				"1",
				"-c:v",
				"png",
				"-f",
				"image2",
				store.mediaPath(backing.id),
			]);
			store.putAsset(source);
			store.putAsset(backing);
			const inspected = await inspectMediaAsset(store, source, 2, false);
			expect(inspected.frames.map((frame) => frame.time)).toEqual([0, 1.966]);
			for (const frame of inspected.frames) {
				expect(Buffer.from(frame.data, "base64").subarray(0, 2)).toEqual(
					Buffer.from([0xff, 0xd8])
				);
			}
			const project = store.save({
				...store.create("Pixel comparison"),
				width: 320,
				height: 180,
				fps: 30,
				segments: [
					{ ...newSegment(backing), sourceOut: 2.3 },
					{
						...newSegment(source, 0.3, 1),
						sourceIn: 0.2,
						sourceOut: 1.2,
						speed: 0.5,
						fadeIn: 1,
						fadeOut: 0.6,
						scale: 0.7,
						keyframes: [
							{ id: crypto.randomUUID(), property: "x", time: 0, value: -0.2 },
							{ id: crypto.randomUUID(), property: "x", time: 1, value: 0.2 },
						],
					},
				],
				titles: [
					{
						id: crypto.randomUUID(),
						text: "Sample",
						start: 0.2,
						end: 1.8,
						x: 0.5,
						y: 0.5,
						fontSize: 0.08,
						color: "#ffffff",
						fadeIn: 0.1,
						fadeOut: 0.1,
					},
				],
				graphics: [
					{
						id: crypto.randomUUID(),
						shape: "rectangle",
						start: 0.2,
						end: 1.8,
						x: 0.1,
						y: 0.1,
						width: 0.2,
						height: 0.2,
						fill: "#00ff00",
						opacity: 0.8,
					},
				],
			});
			const ass = join(store.directory, "captions.ass");
			await Bun.write(ass, assCaptions(project));
			const full = join(store.directory, "baseline.mp4");
			await runMedia(
				[
					...buildRender(
						project,
						store.assets(),
						(id) => store.mediaPath(id),
						"captions.ass"
					),
					full,
				],
				{ cwd: store.directory }
			);
			for (const time of [0, 1, 2.3]) {
				const actual = join(store.directory, `direct-${time}.png`);
				await Bun.write(
					actual,
					await renderTimelineFrame(store, project, time)
				);
				const baseline = join(store.directory, `baseline-${time}.png`);
				await runMedia([
					"-hide_banner",
					"-loglevel",
					"error",
					"-y",
					"-ss",
					String(Math.min(time, 2.3 - 1 / 30)),
					"-i",
					full,
					"-frames:v",
					"1",
					baseline,
				]);
				const pixels = [];
				for (const path of [actual, baseline]) {
					const raw = `${path}.rgb`;
					await runMedia([
						"-hide_banner",
						"-loglevel",
						"error",
						"-y",
						"-i",
						path,
						"-frames:v",
						"1",
						"-f",
						"rawvideo",
						"-pix_fmt",
						"rgb24",
						raw,
					]);
					pixels.push(new Uint8Array(await Bun.file(raw).arrayBuffer()));
				}
				expect(pixels[0]?.length).toBe(320 * 180 * 3);
				let total = 0;
				for (let n = 0; n < pixels[0]!.length; n++) {
					total += Math.abs(pixels[0]![n]! - pixels[1]![n]!);
				}
				expect(
					total / pixels[0]!.length,
					`time=${time}, direct=${pixels[0]!.slice(0, 3)}, baseline=${pixels[1]!.slice(0, 3)}`
				).toBeLessThan(8);
			}
		} finally {
			store.close();
			await rm(store.directory, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 100,
			});
		}
	}
);
