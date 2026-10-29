/**
 * Real-FFmpeg proof for offline media and relink (W2-L2).
 *
 * 1. A clip imported into a temp store renders.
 * 2. Deleting its stored media file makes the asset offline: the offline
 *    report lists it with its project, and a render is refused naming it.
 * 3. A replacement whose duration is off by more than 0.5 s is refused.
 * 4. Relinking to a replacement (a red clip 0.3 s longer) restores the
 *    render, and a decoded frame of the export is red, so the export reads
 *    the relinked media.
 * 5. Overwriting that media with garbage bytes is caught only by the FFprobe
 *    scan (reason "undecodable"); a folder-style batch relink given the
 *    probed report relinks it to a green clip, and the export is green.
 *
 * Run: `bun src/verify-relink.ts`
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { newSegment } from "../../shared/project.ts";
import { importMediaAsset } from "./import-media.ts";
import { runMedia } from "./media.ts";
import { offlineAssetReports, relinkAsset, relinkBatch } from "./relink.ts";
import { RenderQueue } from "./render.ts";
import { OfflineMediaError, StudioStore } from "./store.ts";

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

async function clip(path: string, source: string, seconds: number) {
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		`${source}${source.includes("=") ? ":" : "="}s=320x180:r=30:d=${seconds}`,
		"-f",
		"lavfi",
		"-i",
		`sine=frequency=440:duration=${seconds}`,
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-shortest",
		path,
	]);
}

async function render(store: StudioStore, projectId: string) {
	const queue = new RenderQueue(store);
	const job = queue.start(store.project(projectId));
	for (let attempt = 0; attempt < 600; attempt++) {
		const current = store.jobs().find((candidate) => candidate.id === job.id);
		if (current?.status === "completed") {
			return store.renderPath(job.id, current.codec);
		}
		if (current?.status === "failed" || current?.status === "canceled") {
			throw new Error(`Render ${current.status}: ${current.error ?? ""}`);
		}
		await Bun.sleep(100);
	}
	throw new Error("Render timed out.");
}

const durationSchema = z.object({
	format: z.object({ duration: z.coerce.number() }),
});

async function exportDuration(path: string): Promise<number> {
	return durationSchema.parse(
		JSON.parse(
			await runMedia(
				[
					"-v",
					"error",
					"-show_entries",
					"format=duration",
					"-of",
					"json",
					path,
				],
				{ probe: true }
			)
		)
	).format.duration;
}

/** Average RGB of the frame at `seconds`, scaled to one pixel. */
async function frameColor(path: string, seconds: number, work: string) {
	const output = join(work, `pixel-${crypto.randomUUID()}.rgb`);
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-ss",
		String(seconds),
		"-i",
		path,
		"-frames:v",
		"1",
		"-vf",
		"scale=1:1:flags=area",
		"-f",
		"rawvideo",
		"-pix_fmt",
		"rgb24",
		output,
	]);
	const [red = 0, green = 0, blue = 0] = new Uint8Array(
		await Bun.file(output).arrayBuffer()
	);
	return { blue, green, red };
}

async function main() {
	const work = await mkdtemp(join(tmpdir(), "ryu-verify-relink-"));
	const store = new StudioStore(join(work, "store"));
	try {
		const imports = join(work, "imports");
		await Bun.write(join(imports, ".keep"), "");
		await clip(join(imports, "Interview.mp4"), "testsrc2", 2);
		await clip(join(imports, "Interview (1).mp4"), "color=c=red", 2.3);
		await clip(join(imports, "Interview long.mp4"), "color=c=blue", 3.5);
		await clip(join(imports, "interview copy.mp4"), "color=c=green", 2.1);
		const original = await importMediaAsset(
			store,
			{ source: { path: join(imports, "Interview.mp4") } },
			{ localImportRoot: imports }
		);
		const project = store.create("Relink proof");
		store.save({ ...project, segments: [newSegment(original, 0)] });
		const first = await render(store, project.id);
		const firstDuration = await exportDuration(first);
		ensure(
			Math.abs(firstDuration - 2) < 0.2,
			`Initial render lasts ${firstDuration} s.`
		);
		console.log(`ok online: render lasts ${firstDuration.toFixed(2)} s`);

		await rm(store.mediaPath(original.id));
		const offline = await offlineAssetReports(store);
		ensure(
			offline.length === 1 &&
				offline[0]?.assetId === original.id &&
				offline[0].reason === "missing" &&
				offline[0].projects[0]?.projectId === project.id,
			`Offline report is wrong: ${JSON.stringify(offline)}`
		);
		let refused: unknown;
		try {
			await render(store, project.id);
		} catch (error) {
			refused = error;
		}
		ensure(
			refused instanceof OfflineMediaError &&
				refused.message.includes(original.name),
			`Render was not refused for offline media: ${String(refused)}`
		);
		console.log(`ok offline: ${refused.message}`);

		const tooLong = await importMediaAsset(
			store,
			{ source: { path: join(imports, "Interview long.mp4") } },
			{ localImportRoot: imports }
		);
		let mismatch: unknown;
		try {
			await relinkAsset(store, original.id, { sourceAssetId: tooLong.id });
		} catch (error) {
			mismatch = error;
		}
		ensure(
			mismatch instanceof Error && mismatch.message.includes("allowed"),
			`A 3.5 s replacement was not refused: ${String(mismatch)}`
		);
		console.log(`ok validation: ${mismatch.message}`);

		const replacement = await importMediaAsset(
			store,
			{ source: { path: join(imports, "Interview (1).mp4") } },
			{ localImportRoot: imports }
		);
		const result = await relinkAsset(store, original.id, {
			sourceAssetId: replacement.id,
		});
		ensure(
			result.asset.id === original.id &&
				result.removedAssetId === replacement.id &&
				!store.assets().some((asset) => asset.id === replacement.id),
			"The relink did not keep the original id or drop the upload."
		);
		ensure(
			(await offlineAssetReports(store, { probe: true })).length === 0,
			"Media is still offline after relink."
		);
		const restored = await render(store, project.id);
		const restoredDuration = await exportDuration(restored);
		const color = await frameColor(restored, 1, work);
		ensure(
			Math.abs(restoredDuration - 2) < 0.2,
			`Restored render lasts ${restoredDuration} s.`
		);
		ensure(
			color.red > 200 && color.green < 60 && color.blue < 60,
			`Restored render is not the red replacement: ${JSON.stringify(color)}`
		);
		console.log(
			`ok relinked: render lasts ${restoredDuration.toFixed(2)} s, frame rgb(${color.red},${color.green},${color.blue})`
		);

		await writeFile(store.mediaPath(original.id), "garbage-not-media");
		ensure(
			(await offlineAssetReports(store)).length === 0,
			"A present file was reported offline without probing."
		);
		const probed = await offlineAssetReports(store, { probe: true });
		ensure(
			probed.length === 1 &&
				probed[0]?.assetId === original.id &&
				probed[0].reason === "undecodable",
			`Damaged media was not found by the probe: ${JSON.stringify(probed)}`
		);
		const green = await importMediaAsset(
			store,
			{ source: { path: join(imports, "interview copy.mp4") } },
			{ localImportRoot: imports }
		);
		const batch = await relinkBatch(store, {
			sourceAssetIds: [green.id],
			targetAssetIds: probed.map((report) => report.assetId),
		});
		ensure(
			batch.relinked.length === 1 && batch.failures.length === 0,
			`Damaged media was not batch relinked: ${JSON.stringify(batch)}`
		);
		ensure(
			(await offlineAssetReports(store, { probe: true })).length === 0,
			"Media is still damaged after the batch relink."
		);
		const repaired = await render(store, project.id);
		const repairedColor = await frameColor(repaired, 1, work);
		ensure(
			repairedColor.green > 100 &&
				repairedColor.red < 60 &&
				repairedColor.blue < 60,
			`Repaired render is not the green replacement: ${JSON.stringify(repairedColor)}`
		);
		console.log(
			`ok damaged: probe found it undecodable, batch relink restored rgb(${repairedColor.red},${repairedColor.green},${repairedColor.blue})`
		);
	} finally {
		store.close();
		await rm(work, { force: true, recursive: true });
	}
}

await main();
