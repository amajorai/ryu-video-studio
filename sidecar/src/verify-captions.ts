/**
 * Real-FFmpeg proof for W3-X2: a malformed SRT imports leniently with two
 * skipped cues, and the render burns the styled caption (a solid box) at the
 * configured position instead of the legacy bottom placement.
 *
 *   bun sidecar/src/verify-captions.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importCaptions } from "../../shared/caption-edits.ts";
import { applyCaptionStyle } from "../../shared/caption-style.ts";
import type { Project } from "../../shared/project.ts";
import { runMedia } from "./media.ts";
import { RenderQueue } from "./render.ts";
import { StudioStore } from "./store.ts";

const WIDTH = 640;
const HEIGHT = 360;
const MALFORMED_SRT = `1
00:00:00,000 --> 00:00:02,000
Styled caption

2
00:00:02,500 --> 00:00:01,000
Ends before it starts

3
00:00:xx,000 --> 00:00:03,000
Broken timestamp
`;

/** Rows and columns of pixels close to the box color in one RGB frame. */
function boxPixels(pixels: Uint8Array) {
	let count = 0;
	let sumY = 0;
	let bottom = 0;
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			const offset = (y * WIDTH + x) * 3;
			const r = pixels[offset] ?? 0;
			const g = pixels[offset + 1] ?? 0;
			const b = pixels[offset + 2] ?? 0;
			if (b > 180 && r < 70 && g > 50 && g < 120) {
				count++;
				sumY += y;
				if (y > HEIGHT * 0.75) {
					bottom++;
				}
			}
		}
	}
	return { bottom, count, meanY: count ? sumY / count : -1 };
}

/** Pixels close to the pop highlight green. */
function greenPixels(pixels: Uint8Array) {
	let count = 0;
	let sumX = 0;
	let sumY = 0;
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			const offset = (y * WIDTH + x) * 3;
			const r = pixels[offset] ?? 0;
			const g = pixels[offset + 1] ?? 0;
			const b = pixels[offset + 2] ?? 0;
			if (g > 170 && r < 100 && b < 120) {
				count++;
				sumX += x;
				sumY += y;
			}
		}
	}
	return {
		count,
		meanX: count ? sumX / count : -1,
		meanY: count ? sumY / count : -1,
	};
}

/** Render `project` and return one RGB frame. */
async function renderFrame(
	store: StudioStore,
	directory: string,
	project: Project,
	frameIndex: number
): Promise<Uint8Array> {
	const saved = store.save({
		...project,
		revision: store.project(project.id).revision,
	});
	const queued = new RenderQueue(store).start(saved);
	let job = queued;
	for (let attempt = 0; attempt < 600; attempt++) {
		job = store.jobs().find((item) => item.id === queued.id) ?? job;
		if (["completed", "failed"].includes(job.status)) {
			break;
		}
		await Bun.sleep(100);
	}
	if (job.status !== "completed") {
		throw new Error(`Render ${job.status}: ${job.error ?? "timed out"}`);
	}
	const frame = join(directory, `frame-${job.id}-${frameIndex}.rgb`);
	await runMedia([
		"-y",
		"-i",
		store.renderPath(job.id),
		"-vf",
		`select=eq(n\\,${frameIndex})`,
		"-frames:v",
		"1",
		"-pix_fmt",
		"rgb24",
		"-f",
		"rawvideo",
		frame,
	]);
	return new Uint8Array(await Bun.file(frame).arrayBuffer());
}

async function test(_name: string, run: () => Promise<void>) {
	await run();
}

await test("captions import leniently and render styled", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-verify-captions-"));
	const store = new StudioStore(directory);
	try {
		const base = store.save({
			...store.create("Caption style proof"),
			height: HEIGHT,
			// A small red title gives the render a visual layer (captions alone
			// do not start an export); it never matches the blue box test.
			titles: [
				{
					color: "#ff0000",
					end: 2,
					fadeIn: 0,
					fadeOut: 0,
					fontSize: 0.04,
					id: crypto.randomUUID(),
					start: 0,
					text: "proof",
					x: 0.1,
					y: 0.9,
				},
			],
			width: WIDTH,
		});
		const imported = importCaptions(base, [], {
			format: "srt",
			lenient: true,
			revision: base.revision,
			text: MALFORMED_SRT,
		});
		assert.equal(imported.skipped.length, 2, "two malformed cues are skipped");
		assert.equal(imported.imported, 1, "the valid cue is imported");
		const styled = applyCaptionStyle(imported.project, [], {
			revision: base.revision,
			style: {
				backgroundColor: "#2050e0",
				backgroundOpacity: 1,
				color: "#ffffff",
				fontSize: 0.08,
				positionY: 0.35,
				wordAnimation: "none",
			},
		});
		const box = boxPixels(await renderFrame(store, directory, styled, 15));
		assert.ok(box.count > 500, `the caption box renders (${box.count} px)`);
		assert.equal(
			box.bottom,
			0,
			"nothing is drawn at the legacy bottom position"
		);
		assert.ok(
			box.meanY > HEIGHT * 0.2 && box.meanY < HEIGHT * 0.36,
			`the box sits just above positionY (mean row ${box.meanY.toFixed(1)})`
		);
		const words = store.project(base.id);
		const popped = applyCaptionStyle(
			{
				...words,
				captions: [
					{
						end: 2,
						id: crypto.randomUUID(),
						start: 0,
						text: "Pop words",
						words: [
							{ end: 0.9, id: crypto.randomUUID(), start: 0, text: "Pop" },
							{ end: 2, id: crypto.randomUUID(), start: 1, text: "words" },
						],
					},
				],
			},
			[],
			{
				mode: "replace",
				revision: words.revision,
				style: {
					fontSize: 0.1,
					highlightColor: "#22dd44",
					positionY: 0.6,
					uppercase: true,
					wordAnimation: "pop",
				},
			}
		);
		const centers: number[] = [];
		for (const frameIndex of [15, 45]) {
			const green = greenPixels(
				await renderFrame(store, directory, popped, frameIndex)
			);
			assert.ok(
				green.count > 50,
				`the spoken word is highlighted (${green.count} px)`
			);
			assert.ok(
				green.meanY > HEIGHT * 0.4 && green.meanY < HEIGHT * 0.61,
				`the highlighted word sits at positionY (row ${green.meanY.toFixed(1)})`
			);
			centers.push(green.meanX);
		}
		assert.ok(
			(centers[1] ?? 0) - (centers[0] ?? 0) > 40,
			"the highlight moves from the first word to the second"
		);
		process.stdout.write(
			`PASS: lenient import skipped:${imported.skipped.length}; styled caption box (${box.count} px) centred on row ${box.meanY.toFixed(1)} of ${HEIGHT}; pop highlight moved ${((centers[1] ?? 0) - (centers[0] ?? 0)).toFixed(0)} px between words.\n`
		);
	} finally {
		store.close();
		await rm(directory, { force: true, recursive: true });
	}
});
