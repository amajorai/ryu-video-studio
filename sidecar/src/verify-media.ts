import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Asset, newSegment } from "../../shared/project.ts";
import { probe, runMedia } from "./media.ts";
import { createStudioServer } from "./server.ts";
import { type RenderJob, StudioStore } from "./store.ts";

const cleanup: (() => Promise<void>)[] = [];
async function setup() {
	const directory = await mkdtemp(
		join(tmpdir(), "ryu-video-studio-integration-")
	);
	const store = new StudioStore(directory);
	cleanup.push(async () => {
		store.close();
		await rm(directory, { recursive: true, force: true });
	});
	return store;
}
async function test(_name: string, run: () => Promise<void>) {
	await run();
}

try {
	await test("authenticated upload, render, review and download", async () => {
		const store = await setup();
		const token = crypto.randomUUID();
		const app = createStudioServer({ store, token, port: 0 });
		cleanup.unshift(async () => {
			app.stop();
		});
		const base = `http://127.0.0.1:${app.server.port}`;
		const filterList = await runMedia(["-hide_banner", "-filters"]);
		const captionBurnInAvailable = filterList
			.split("\n")
			.some((line) => /\bsubtitles\b/.test(line));
		if (!captionBurnInAvailable) {
			process.stdout.write(
				"SKIP: caption burn-in proof requires an FFmpeg build with the subtitles (libass) filter.\n"
			);
		}
		const call = async (path: string, method = "GET", body?: unknown) => {
			const response = await fetch(`${base}/api/video-studio${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			const result = await response.json();
			if (!response.ok) {
				throw new Error(JSON.stringify(result));
			}
			return result;
		};
		assert.equal(
			(await fetch(`${base}/api/video-studio/projects`)).status,
			401
		);
		const fixture = join(store.directory, "fixture.mp4");
		await runMedia([
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"color=red:size=320x180:rate=24:duration=1",
			"-f",
			"lavfi",
			"-i",
			"color=blue:size=320x180:rate=24:duration=1",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=2",
			"-filter_complex",
			"[0:v][1:v]concat=n=2:v=1:a=0[v]",
			"-map",
			"[v]",
			"-map",
			"2:a",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			"-shortest",
			fixture,
		]);
		const bytes = await Bun.file(fixture).arrayBuffer();
		const upload = await call("/uploads", "POST", {
			name: "Test footage.mp4",
			size: bytes.byteLength,
		});
		await call(`/uploads/${upload.id}`, "PUT", {
			offset: 0,
			data: Buffer.from(bytes).toString("base64"),
		});
		assert.equal((await probe(fixture)).width, 320);
		const a: Asset = await call(`/uploads/${upload.id}/finish`, "POST");
		assert.equal(a.width, 320);
		assert.equal(a.hasAudio, true);
		const audioWindow = await call(`/assets/${a.id}/audio-window`, "POST", {
			start: 0.25,
		});
		const wav = Buffer.from(audioWindow.dataUrl.split(",")[1], "base64");
		assert.equal(wav.subarray(0, 4).toString(), "RIFF");
		assert.equal(wav.readUInt16LE(22), 1);
		assert.equal(wav.readUInt32LE(24), 16_000);
		assert.ok(wav.length > 16_000 && wav.length < 1_000_000);

		await call(`/assets/${a.id}/analyze`, "POST");
		let analysis = (await call(`/assets/${a.id}/analysis`)).analysis;
		for (
			let attempt = 0;
			attempt < 200 && analysis?.status === "running";
			attempt++
		) {
			await Bun.sleep(100);
			analysis = (await call(`/assets/${a.id}/analysis`)).analysis;
		}
		assert.equal(analysis?.status, "completed", analysis?.error);
		assert.ok(
			analysis.sceneCuts.some((time: number) => Math.abs(time - 1) < 0.1),
			"Detect the actual red-to-blue scene cut"
		);
		assert.ok(
			analysis.waveform.some((level: number) => level > 0.01),
			"Measure the source audio rather than using placeholder waveforms"
		);

		const p = await call("/projects", "POST", { title: "Verified film" });
		p.width = 320;
		p.height = 180;
		p.fps = 24;
		p.segments = [{ ...newSegment(a), sourceIn: 0.25, sourceOut: 1.25 }];
		p.segments[0].keyframes = [
			{ id: crypto.randomUUID(), time: 0, property: "scale", value: 0.4 },
			{ id: crypto.randomUUID(), time: 1, property: "scale", value: 0.9 },
			{ id: crypto.randomUUID(), time: 0, property: "x", value: -0.3 },
			{ id: crypto.randomUUID(), time: 1, property: "x", value: 0.3 },
		];
		if (captionBurnInAvailable) {
			p.captions = [
				{
					id: crypto.randomUUID(),
					start: 0,
					end: 1,
					text: "Ryu Video Studio",
				},
			];
			p.titles = [
				{
					id: crypto.randomUUID(),
					start: 0.2,
					end: 0.8,
					text: "TITLE",
					x: 0.5,
					y: 0.2,
					fontSize: 0.12,
					color: "#ffffff",
					fadeIn: 0,
					fadeOut: 0,
				},
			];
		}
		const saved = await call(`/projects/${p.id}`, "PUT", p);
		assert.equal(saved.revision, 1);
		const job = await call(`/projects/${p.id}/render`, "POST");
		let current: RenderJob = job;
		for (let i = 0; i < 200; i++) {
			current = await call(`/renders/${job.id}`);
			if (["completed", "failed", "canceled"].includes(current.status)) {
				break;
			}
			await Bun.sleep(100);
		}
		assert.equal(current.error, undefined);
		assert.equal(current.status, "completed");
		assert.equal(current.review?.width, 320);
		assert.ok(Math.abs((current.review?.duration ?? 0) - 1) < 0.1);
		assert.equal(current.review?.hasAudio, true);
		if (captionBurnInAvailable) {
			const titleFrame = join(store.directory, "title.rgb");
			await runMedia([
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-ss",
				"0.5",
				"-i",
				store.renderPath(job.id),
				"-frames:v",
				"1",
				"-pix_fmt",
				"rgb24",
				"-f",
				"rawvideo",
				titleFrame,
			]);
			const titlePixels = new Uint8Array(
				await Bun.file(titleFrame).arrayBuffer()
			);
			let whitePixels = 0;
			for (let y = 15; y < 60; y++) {
				for (let x = 80; x < 240; x++) {
					const offset = (y * 320 + x) * 3;
					if (
						(titlePixels[offset] ?? 0) > 220 &&
						(titlePixels[offset + 1] ?? 0) > 220 &&
						(titlePixels[offset + 2] ?? 0) > 220
					) {
						whitePixels++;
					}
				}
			}
			assert.ok(
				whitePixels > 30,
				"Title text must appear at its configured position in encoded frames"
			);
		}
		const occupied: number[] = [];
		for (const [index, time] of [0.05, 0.9].entries()) {
			const path = join(store.directory, `frame-${index}.rgb`);
			await runMedia([
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-ss",
				String(time),
				"-i",
				store.renderPath(job.id),
				"-frames:v",
				"1",
				"-pix_fmt",
				"rgb24",
				"-f",
				"rawvideo",
				path,
			]);
			const pixels = new Uint8Array(await Bun.file(path).arrayBuffer());
			let count = 0;
			for (let i = 0; i < pixels.length; i += 3) {
				if (
					(pixels[i] ?? 0) + (pixels[i + 1] ?? 0) + (pixels[i + 2] ?? 0) >
					80
				) {
					count++;
				}
			}
			occupied.push(count);
		}
		assert.ok(
			(occupied[1] ?? 0) > (occupied[0] ?? 0) * 2,
			`Scale keyframes must change the actual rendered image area: ${occupied.join(",")}`
		);
		const data = await call(`/renders/${job.id}/data`);
		assert.ok(Buffer.from(data.data, "base64").byteLength > 1000);
		if (captionBurnInAvailable) {
			const card = await call("/projects", "POST", {
				title: "Title-only film",
			});
			card.width = 320;
			card.height = 180;
			card.fps = 24;
			card.titles = [
				{
					id: crypto.randomUUID(),
					start: 0,
					end: 1,
					text: "A title-only film",
					x: 0.5,
					y: 0.5,
					fontSize: 0.1,
					color: "#ffffff",
					fadeIn: 0,
					fadeOut: 0,
				},
			];
			await call(`/projects/${card.id}`, "PUT", card);
			let cardJob = await call(`/projects/${card.id}/render`, "POST");
			for (
				let attempt = 0;
				attempt < 100 && ["pending", "running"].includes(cardJob.status);
				attempt++
			) {
				await Bun.sleep(100);
				cardJob = await call(`/renders/${cardJob.id}`);
			}
			assert.equal(cardJob.status, "completed", cardJob.error);
			assert.equal(cardJob.review.hasAudio, false);
			assert.ok(Math.abs(cardJob.review.duration - 1) < 0.1);
		}
		const waveUpload = await call("/uploads", "POST", {
			name: "Waveform audio.wav",
			size: wav.length,
		});
		await call(`/uploads/${waveUpload.id}`, "PUT", {
			offset: 0,
			data: wav.toString("base64"),
		});
		const waveAsset = await call(`/uploads/${waveUpload.id}/finish`, "POST");
		const waveProject = await call("/projects", "POST", {
			title: "Audio waveform film",
		});
		waveProject.width = 320;
		waveProject.height = 180;
		waveProject.fps = 24;
		waveProject.segments = [
			{ ...newSegment(a), sourceOut: waveAsset.duration, volume: 0 },
			{
				...newSegment(waveAsset),
				track: 1,
				visualization: "waveform",
				waveformColor: "#ffffff",
			},
		];
		await call(`/projects/${waveProject.id}`, "PUT", waveProject);
		let waveJob = await call(`/projects/${waveProject.id}/render`, "POST");
		for (
			let attempt = 0;
			attempt < 100 && ["pending", "running"].includes(waveJob.status);
			attempt++
		) {
			await Bun.sleep(100);
			waveJob = await call(`/renders/${waveJob.id}`);
		}
		assert.equal(waveJob.status, "completed", waveJob.error);
		assert.equal(waveJob.review.hasAudio, true);
		const frames: Buffer[] = [];
		for (const time of [0.2, 0.5]) {
			const path = join(store.directory, `wave-${time}.rgb`);
			await runMedia([
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-ss",
				String(time),
				"-i",
				store.renderPath(waveJob.id),
				"-frames:v",
				"1",
				"-pix_fmt",
				"rgb24",
				"-f",
				"rawvideo",
				path,
			]);
			frames.push(Buffer.from(await Bun.file(path).arrayBuffer()));
		}
		let white = 0;
		const pixels = frames[0]!;
		for (let index = 0; index < pixels.length; index += 3) {
			if (
				pixels[index]! > 200 &&
				pixels[index + 1]! > 200 &&
				pixels[index + 2]! > 200
			) {
				white++;
			}
		}
		assert.ok(white > 100, "Source audio produces visible waveform pixels");
		assert.ok(
			pixels[0]! > 200 && pixels[1]! < 30 && pixels[2]! < 30,
			"Waveform background must preserve the video layer underneath"
		);

		assert.notDeepEqual(
			frames[0],
			frames[1],
			"The waveform changes with source samples over time"
		);
		const fastProject = await call(`/projects/${waveProject.id}`);
		fastProject.fps = 60;
		await call(`/projects/${fastProject.id}`, "PUT", fastProject);
		let fastJob = await call(`/projects/${fastProject.id}/render`, "POST");
		for (
			let attempt = 0;
			attempt < 100 && ["pending", "running"].includes(fastJob.status);
			attempt++
		) {
			await Bun.sleep(100);
			fastJob = await call(`/renders/${fastJob.id}`);
		}
		assert.equal(fastJob.status, "completed", fastJob.error);
		const rate = await runMedia(
			[
				"-v",
				"error",
				"-select_streams",
				"v:0",
				"-show_entries",
				"stream=avg_frame_rate",
				"-of",
				"csv=p=0",
				store.renderPath(fastJob.id),
			],
			{ probe: true }
		);
		assert.equal(
			rate.trim(),
			"60/1",
			"Waveform export honors the selected 60 fps preset"
		);
		const fullProject = await call("/projects", "POST", {
			title: "Full-resolution audio waveform",
		});
		fullProject.width = 1920;
		fullProject.height = 1080;
		fullProject.fps = 30;
		fullProject.segments = [
			{
				...newSegment(waveAsset),
				sourceOut: waveAsset.duration - 1 / 16_000,
				visualization: "waveform",
				y: 0.35,
			},
		];
		await call(`/projects/${fullProject.id}`, "PUT", fullProject);
		let fullJob = await call(`/projects/${fullProject.id}/render`, "POST");
		for (
			let attempt = 0;
			attempt < 150 && ["pending", "running"].includes(fullJob.status);
			attempt++
		) {
			await Bun.sleep(100);
			fullJob = await call(`/renders/${fullJob.id}`);
		}
		assert.equal(fullJob.status, "completed", fullJob.error);
		assert.equal(fullJob.review.width, 1920);
		assert.equal(fullJob.review.hasAudio, true);
		const fullFrame = join(store.directory, "full-wave.rgb");
		await runMedia([
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-ss",
			"0.5",
			"-i",
			store.renderPath(fullJob.id),
			"-frames:v",
			"1",
			"-pix_fmt",
			"rgb24",
			"-f",
			"rawvideo",
			fullFrame,
		]);
		const fullPixels = new Uint8Array(await Bun.file(fullFrame).arrayBuffer());
		let rightEdge = 0;
		for (let y = 0; y < 1080; y++) {
			for (let x = 1600; x < 1920; x++) {
				const offset = (y * 1920 + x) * 3;
				if (
					fullPixels[offset]! > 180 &&
					fullPixels[offset + 1]! > 180 &&
					fullPixels[offset + 2]! > 180
				) {
					rightEdge++;
				}
			}
		}
		assert.ok(
			rightEdge > 50,
			"A full-resolution waveform fills the right side rather than ending mid-frame"
		);
	});
	process.stdout.write(
		"PASS: authenticated media import, render, review, and download\n"
	);
} finally {
	for (const clean of cleanup) {
		await clean();
	}
}
