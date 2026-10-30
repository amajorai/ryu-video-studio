/**
 * Real-FFmpeg proof for sync drift correction.
 *
 * A camera file carries irregular gated noise. A recorder copy runs its clock
 * 0.2% slow (`asetrate`), starts 1.5 s late (`adelay`) and has its own room
 * noise. Measured analysis plus `POST /projects/:id/sync` must correct the
 * drift through clip speed and keep the clips within one frame at the end
 * of the overlap. A 0.8% copy must warn and keep its speed; a dry run must
 * measure without saving.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Asset, newSegment, type Project } from "../../shared/project.ts";
import type { SyncMatch } from "../../shared/sync.ts";
import { AnalysisQueue } from "./analysis.ts";
import { probe, runMedia } from "./media.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

const SECONDS = 90;
const OFFSET = 1.5;
/** Irregular gated noise bursts: a shared sound both clocks record. */
const GATED_NOISE = `aevalsrc=0.8*gt(sin(2*PI*0.93*t)*sin(2*PI*2.31*t+1)*sin(2*PI*0.137*t+2)\\,0.2)*(random(0)-0.5)+0.01*(random(1)-0.5):s=48000:d=${SECONDS}`;

async function fixture(
	store: StudioStore,
	name: string,
	args: string[],
	extension: string
): Promise<Asset> {
	const file = join(store.directory, `${crypto.randomUUID()}.${extension}`);
	await runMedia(["-hide_banner", "-loglevel", "error", "-y", ...args, file]);
	const asset: Asset = {
		...(await probe(file)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name,
	};
	await Bun.write(store.mediaPath(asset.id), Bun.file(file));
	store.putAsset(asset);
	return asset;
}

/** A recorder whose clock maps camera second `r` to `r * (1 + drift) + OFFSET`. */
function driftedRecorder(store: StudioStore, name: string, drift: number) {
	return fixture(
		store,
		name,
		[
			"-f",
			"lavfi",
			"-i",
			GATED_NOISE,
			"-f",
			"lavfi",
			"-i",
			`anoisesrc=a=0.004:c=pink:r=48000:d=${SECONDS + 4}`,
			"-filter_complex",
			`[0:a]asetrate=${(48_000 / (1 + drift)).toFixed(6)},aresample=48000,volume=0.7,adelay=${OFFSET * 1000}[voice];[voice][1:a]amix=inputs=2:duration=longest:normalize=0`,
			"-c:a",
			"pcm_s16le",
		],
		"wav"
	);
}

async function analyze(store: StudioStore, queue: AnalysisQueue, asset: Asset) {
	queue.start(asset);
	for (let attempt = 0; attempt < 600; attempt += 1) {
		const analysis = store.analysis(asset.id);
		if (analysis?.status === "completed") {
			return;
		}
		if (analysis?.status === "failed") {
			throw new Error(`Analysis failed for ${asset.name}.`);
		}
		await Bun.sleep(50);
	}
	throw new Error("Analysis did not finish.");
}

interface SyncBody {
	dryRun?: boolean;
	matches: SyncMatch[];
	project?: Project;
	warnings?: string[];
}

async function test(_name: string, run: () => Promise<void>) {
	await run();
}

await test("sync drift correction on real decoded audio", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-verify-sync-drift-"));
	const store = new StudioStore(directory);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	const queue = new AnalysisQueue(store);
	try {
		const camera = await fixture(
			store,
			"Camera",
			[
				"-f",
				"lavfi",
				"-i",
				`testsrc2=s=160x90:r=30:d=${SECONDS}`,
				"-f",
				"lavfi",
				"-i",
				GATED_NOISE,
				"-c:v",
				"libx264",
				"-pix_fmt",
				"yuv420p",
				"-c:a",
				"aac",
				"-b:a",
				"192k",
				"-shortest",
			],
			"mp4"
		);
		const slow = await driftedRecorder(store, "Recorder 0.2%", 0.002);
		const wild = await driftedRecorder(store, "Recorder 0.8%", 0.008);
		for (const asset of [camera, slow, wild]) {
			await analyze(store, queue, asset);
		}
		const sync = async (
			recorder: Asset,
			body: Record<string, unknown> = {}
		) => {
			const referenceClip = newSegment(camera, 0, 0);
			const targetClip = newSegment(recorder, 4, 1);
			const project = store.save({
				...store.create(`Verify ${recorder.name}`),
				segments: [referenceClip, targetClip],
			});
			const response = await fetch(
				`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/sync`,
				{
					body: JSON.stringify({
						mode: "audio",
						referenceClipId: referenceClip.id,
						revision: project.revision,
						searchWindowSeconds: 5,
						targetClipIds: [targetClip.id],
						...body,
					}),
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					method: "POST",
				}
			);
			const text = await response.text();
			assert.equal(response.status, 200, text);
			return {
				body: JSON.parse(text) as SyncBody,
				project,
				referenceClip,
				targetClip,
			};
		};

		const corrected = await sync(slow);
		const match = corrected.body.matches[0];
		assert.equal(match?.drift?.status, "corrected", JSON.stringify(match));
		assert.ok(
			Math.abs((match.drift.driftPercent ?? 0) - 0.2) < 0.02,
			`drift ${match.drift.driftPercent}% is 0.2% ±0.02`
		);
		const saved = corrected.body.project;
		assert.ok(saved, "the corrected project is saved");
		const reference = saved.segments.find(
			(segment) => segment.id === corrected.referenceClip.id
		)!;
		const target = saved.segments.find(
			(segment) => segment.id === corrected.targetClip.id
		)!;
		const frame = 1 / saved.fps;
		const errors = [2, 45, SECONDS - 3].map((second) => {
			const referenceTime =
				reference.start + (second - reference.sourceIn) / reference.speed;
			const targetTime =
				target.start +
				(second * 1.002 + OFFSET - target.sourceIn) / target.speed;
			return Math.abs(referenceTime - targetTime);
		});
		for (const error of errors) {
			assert.ok(error < frame, `misalignment ${error}s is under one frame`);
		}
		process.stdout.write(
			`PASS: 0.2% drift measured ${match.drift.driftPercent}% → speed ${target.speed}; misalignment at 2 s / 45 s / ${SECONDS - 3} s = ${errors.map((error) => `${(error * 1000).toFixed(1)} ms`).join(" / ")} (frame ${(frame * 1000).toFixed(1)} ms).\n`
		);

		// Whole-clip envelope matching smears under large drift, so this
		// coarse pass needs a lower confidence floor before the fine windows.
		const warned = await sync(wild, { minConfidence: 0.2 });
		const wildMatch = warned.body.matches[0];
		assert.equal(
			wildMatch?.drift?.status,
			"too-large",
			JSON.stringify(wildMatch)
		);
		assert.ok(warned.body.warnings?.[0]?.includes("exceeds"));
		assert.equal(
			warned.body.project?.segments.find(
				(segment) => segment.id === warned.targetClip.id
			)?.speed,
			1
		);
		process.stdout.write(
			`PASS: 0.8% drift measured ${wildMatch.drift?.driftPercent}% → warning, speed unchanged.\n`
		);

		const dry = await sync(slow, { dryRun: true });
		assert.equal(dry.body.dryRun, true);
		assert.equal(dry.body.project, undefined);
		assert.equal(dry.body.matches[0]?.drift?.status, "corrected");
		assert.equal(store.project(dry.project.id).revision, dry.project.revision);
		process.stdout.write(
			"PASS: dry run reports drift without saving the project.\n"
		);
	} finally {
		app.stop();
		store.close();
		await rm(directory, { force: true, recursive: true });
	}
});
