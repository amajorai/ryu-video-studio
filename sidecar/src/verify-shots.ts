/**
 * Real-FFmpeg proof for visual media search.
 *
 * 1. A four-shot H.264 fixture (dark navy, moving test pattern, warm orange
 *    pan, near-white) runs through the real scene analysis (`scdet`), so the
 *    shot boundaries come from detected cuts, not hand-written ones. `scdet`
 *    fires repeatedly inside the moving orange shot; those flicker cuts must
 *    merge back into one shot.
 * 2. `POST /assets/:id/shots` decodes 32x18 frames and labels each shot; the
 *    labels match what the fixture shows.
 * 3. `GET /shot-search` answers "dark blue static", "vivid moving" and
 *    "bright white" with the right source range each.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Asset } from "../../shared/project.ts";
import { shotIndexSchema } from "../../shared/shot-index.ts";
import { AnalysisQueue } from "./analysis.ts";
import { probe, runMedia } from "./media.ts";
import { routes } from "./routes/shots.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

async function test(_name: string, run: () => Promise<void>) {
	await run();
}

await test("visual shot search on real scene cuts", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-verify-shots-"));
	const store = new StudioStore(directory);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0, routes });
	const call = async (path: string, method = "GET") => {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio${path}`,
			{ method, headers: { authorization: `Bearer ${token}` } }
		);
		const body: unknown = await response.json();
		assert.equal(response.status, 200, JSON.stringify(body));
		return body;
	};

	try {
		const file = join(directory, "fixture.mp4");
		await runMedia([
			"-hide_banner",
			"-loglevel",
			"error",
			"-nostdin",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"color=c=0x0a1450:s=640x360:d=3:r=30",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=s=640x360:d=3:r=30",
			"-f",
			"lavfi",
			// Orange with a dark brown bar sweeping across it: warm and moving.
			"-i",
			"color=c=0xff7a00:s=640x360:d=3:r=30[bg];color=c=0x3a1600:s=160x360:d=3:r=30[bar];[bg][bar]overlay=x='t*180':y=0[out0]",
			"-f",
			"lavfi",
			"-i",
			"color=c=0xf5f5f5:s=640x360:d=3:r=30",
			"-filter_complex",
			"[0][1][2][3]concat=n=4:v=1:a=0",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			file,
		]);
		const asset: Asset = {
			...(await probe(file)),
			createdAt: new Date().toISOString(),
			id: crypto.randomUUID(),
			name: "Four shots",
		};
		await Bun.write(store.mediaPath(asset.id), Bun.file(file));
		store.putAsset(asset);

		const analyses = new AnalysisQueue(store);
		analyses.start(asset);
		const deadline = Date.now() + 60_000;
		while (store.analysis(asset.id)?.status === "running") {
			assert.ok(Date.now() < deadline, "scene analysis timed out");
			await Bun.sleep(50);
		}
		const analysis = store.analysis(asset.id);
		assert.equal(analysis?.status, "completed", analysis?.error);
		console.log("scene cuts", analysis?.sceneCuts);

		const index = shotIndexSchema.parse(
			await call(`/assets/${asset.id}/shots`, "POST")
		);
		for (const shot of index.shots) {
			console.log(
				`${shot.start.toFixed(2)}-${shot.end.toFixed(2)}s`,
				shot.labels.join(","),
				shot.colors.map((color) => `${color.name}:${color.weight}`).join(" "),
				`motion=${shot.motion} edges=${shot.edgeDensity}`
			);
		}
		assert.equal(index.shots.length, 4, "four shots from detected cuts");
		const [navy, pattern, orange, white] = index.shots;
		for (const [shot, expected] of [
			[navy, ["dark", "static", "blue"]],
			[pattern, ["vivid", "wide"]],
			[orange, ["vivid", "motion", "orange"]],
			[white, ["bright", "static", "white"]],
		] as const) {
			for (const label of expected) {
				assert.ok(
					shot?.labels.includes(label),
					`shot ${shot?.start}s should be ${label}: ${shot?.labels}`
				);
			}
		}

		const search = async (query: string) =>
			(
				(await call(`/shot-search?q=${encodeURIComponent(query)}`)) as {
					results: { start: number; end: number }[];
				}
			).results;
		const near = (value: number | undefined, target: number) =>
			value !== undefined && Math.abs(value - target) < 0.15;
		const dark = await search("dark blue static");
		assert.ok(dark.length === 1 && near(dark[0]?.start, 0), "dark blue static");
		const moving = await search("orange moving");
		assert.ok(near(moving[0]?.start, 6), "orange moving starts at 6 s");
		const bright = await search("bright white");
		assert.ok(near(bright[0]?.start, 9), "bright white starts at 9 s");
		console.log("verify-shots: ok");
	} finally {
		app.stop();
		store.close();
		await rm(directory, { force: true, recursive: true });
	}
});
