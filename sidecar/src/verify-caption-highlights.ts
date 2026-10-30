import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMedia } from "./media.ts";
import { RenderQueue } from "./render.ts";
import { StudioStore } from "./store.ts";

async function test(_name: string, run: () => Promise<void>) {
	await run();
}
await test("encoded captions move the highlight between measured words", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-caption-highlight-"));
	const store = new StudioStore(directory);
	try {
		const project = store.save({
			...store.create("Highlight proof"),
			width: 640,
			height: 360,
			titles: [
				{
					id: crypto.randomUUID(),
					start: 0,
					end: 2,
					text: "Measured captions",
					x: 0.5,
					y: 0.2,
					fontSize: 0.05,
					color: "#ffffff",
					fadeIn: 0,
					fadeOut: 0,
				},
			],
			captions: [
				{
					id: crypto.randomUUID(),
					start: 0,
					end: 2,
					text: "Hello world",
					highlightColor: "#33dd66",
					words: [
						{ id: crypto.randomUUID(), start: 0, end: 0.9, text: "Hello" },
						{ id: crypto.randomUUID(), start: 1, end: 2, text: "world" },
					],
				},
			],
		});
		const queued = new RenderQueue(store).start(project);
		let job = queued;
		for (let attempt = 0; attempt < 600; attempt++) {
			job = store.jobs().find((item) => item.id === queued.id)!;
			if (["completed", "failed"].includes(job.status)) {
				break;
			}
			await Bun.sleep(100);
		}
		assert.equal(job.status, "completed", job.error);
		const centers: number[] = [];
		for (const frameIndex of [15, 45]) {
			const frame = join(directory, `frame-${frameIndex}.rgb`);
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
			const pixels = new Uint8Array(await Bun.file(frame).arrayBuffer());
			let count = 0;
			let sum = 0;
			let white = 0;
			for (let y = 250; y < 360; y++) {
				for (let x = 0; x < 640; x++) {
					const offset = (y * 640 + x) * 3;
					const r = pixels[offset]!;
					const g = pixels[offset + 1]!;
					const b = pixels[offset + 2]!;
					if (g > 150 && r < 110 && b < 160) {
						count++;
						sum += x;
					}
					if (r > 190 && g > 190 && b > 190) {
						white++;
					}
				}
			}
			assert.ok(
				count > 20,
				"The active word renders in the chosen highlight color"
			);
			assert.ok(white > 20, "The other word remains readable in white");
			centers.push(sum / count);
		}
		assert.ok(
			centers[1]! - centers[0]! > 30,
			"The highlight moves from the first word to the second"
		);
		process.stdout.write(
			"PASS: measured word highlights rendered at both timestamps.\n"
		);
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});
