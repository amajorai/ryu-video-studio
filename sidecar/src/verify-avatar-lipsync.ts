/**
 * Real-FFmpeg proof for avatar lip-sync (W3-G3).
 *
 * 1. `POST /projects/:id/avatars/lip-sync` on a speech-like fixture with known
 *    pauses writes at most 100 mouth keyframes that open during speech and
 *    close during the pauses.
 * 2. FFmpeg's own expression evaluator (`aevalsrc`, which evaluates `t` per
 *    sample) computes the rig's 100-keyframe mouth expression identically to
 *    the preview's `avatarPoseAtTime`. Before the balanced expression tree,
 *    FFmpeg refused this expression ("Missing ')' or too many args").
 * 3. The real avatar render stage (`avatarFilters`, per-frame `overlay` layers) accepts
 *    the expression and renders a frame.
 * 4. The `analysis` envelope (cached waveform) gives the same open/closed
 *    pattern without a new extraction.
 *
 * Run: `bun src/verify-avatar-lipsync.ts`
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { avatarPoseAtTime, avatarRigExpression } from "../../shared/avatar.ts";
import { type Avatar, newSegment, type Project } from "../../shared/project.ts";
import { runMedia } from "./media.ts";
import { avatarFilters } from "./render-avatars.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";
import {
	speechFixtureAsset,
	VAD_FIXTURE_DURATION,
	VAD_FIXTURE_PAUSES,
	VAD_FIXTURE_SPEECH,
} from "./vad-fixture.ts";

const WIDTH = 640;
const HEIGHT = 360;

const midpoints = (spans: readonly (readonly [number, number])[]) =>
	spans.map(([start, end]) => (start + end) / 2);

/** The mouth expression evaluated by FFmpeg at `rate` samples per second. */
async function ffmpegMouthCurve(
	expression: string,
	rate: number,
	directory: string
): Promise<Float32Array> {
	const output = join(directory, "mouth.f32");
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		`aevalsrc=exprs='${expression}':s=${rate}:d=${VAD_FIXTURE_DURATION}`,
		"-c:a",
		"pcm_f32le",
		"-f",
		"f32le",
		output,
	]);
	return new Float32Array(await Bun.file(output).arrayBuffer());
}

/** Render one frame of the avatar stage over a white canvas; returns gray pixels. */
async function renderAvatarFrame(
	project: Project,
	time: number,
	directory: string
): Promise<Uint8Array> {
	const chain = avatarFilters(project, "base", {
		height: HEIGHT,
		width: WIDTH,
	});
	const output = join(directory, "frame.gray");
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=c=white:s=${WIDTH}x${HEIGHT}:r=25:d=${VAD_FIXTURE_DURATION}`,
		"-filter_complex",
		`[0:v]null[base];${chain.filters.join(";")};[${chain.last}]format=gray[out]`,
		"-map",
		"[out]",
		"-ss",
		String(time),
		"-frames:v",
		"1",
		"-f",
		"rawvideo",
		output,
	]);
	return new Uint8Array(await Bun.file(output).arrayBuffer());
}

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-lipsync-"));
const store = new StudioStore(directory);
const token = crypto.randomUUID();
const app = createStudioServer({ port: 0, store, token });
const base = `http://127.0.0.1:${app.server.port}/api/video-studio`;
const headers = {
	authorization: `Bearer ${token}`,
	"content-type": "application/json",
};

interface LipSyncResponse {
	keyframes: number;
	message?: string;
	project: Project;
	voicedRatio: number;
}

async function lipSync(project: Project, body: Record<string, unknown>) {
	const response = await fetch(
		`${base}/projects/${project.id}/avatars/lip-sync`,
		{
			body: JSON.stringify({ ...body, revision: project.revision }),
			headers,
			method: "POST",
		}
	);
	return {
		body: (await response.json()) as LipSyncResponse,
		status: response.status,
	};
}

async function test(_name: string, run: () => Promise<void>) {
	await run();
}

const speechTimes = midpoints(VAD_FIXTURE_SPEECH);
const pauseTimes = midpoints(VAD_FIXTURE_PAUSES);

try {
	const audio = await speechFixtureAsset(store, { name: "Voice" });
	const clip = newSegment(audio, 0);
	const character: Avatar = {
		accent: "#f97316",
		animation: "none",
		depth: 0,
		end: VAD_FIXTURE_DURATION,
		entryDuration: 0,
		height: 0.8,
		id: crypto.randomUUID(),
		outfit: "#4f46e5",
		pose: "neutral",
		skin: "#f4c7a1",
		start: 0,
		width: 0.3,
		x: 0.35,
		y: 0.1,
	};
	let latest = store.save({
		...store.create("Lip-sync proof"),
		avatars: [character],
		segments: [clip],
	});
	let synced = character;

	await test("the route writes a bounded mouth curve that follows speech", async () => {
		const response = await lipSync(latest, {
			avatarId: character.id,
			segmentId: clip.id,
			smoothing: 0.25,
		});
		assert.equal(response.status, 200, response.body.message);
		latest = response.body.project;
		const updated = latest.avatars[0];
		assert.ok(updated, "avatar kept");
		synced = updated;
		const mouth = (synced.rigKeyframes ?? []).filter(
			(keyframe) => keyframe.property === "mouth"
		);
		console.log(
			`audio envelope: ${response.body.keyframes} mouth keyframes, voiced ${response.body.voicedRatio}`
		);
		assert.equal(mouth.length, response.body.keyframes);
		assert.ok(mouth.length > 4 && mouth.length <= 100, "keyframe budget");
		for (const time of pauseTimes) {
			const open = avatarPoseAtTime(synced, time).mouth;
			assert.ok(open < 0.05, `pause at ${time}s is closed (${open})`);
		}
	});

	await test("FFmpeg evaluates the 100-keyframe rig like the preview", async () => {
		const expression = avatarRigExpression(synced, "mouth");
		const rate = 100;
		const curve = await ffmpegMouthCurve(expression, rate, directory);
		assert.ok(curve.length >= VAD_FIXTURE_DURATION * rate - 1, "curve length");
		let worst = 0;
		for (const [index, value] of curve.entries()) {
			const preview = avatarPoseAtTime(synced, index / rate).mouth;
			worst = Math.max(worst, Math.abs(value - preview));
		}
		console.log(
			`ffmpeg-evaluated mouth expression (${expression.length} chars): max deviation from preview ${worst.toExponential(2)}`
		);
		assert.ok(worst < 1e-4, "FFmpeg evaluates the rig like the preview");
		for (const time of speechTimes) {
			const peak = Math.max(
				...[-0.08, 0, 0.08].map(
					(offset) => curve[Math.round((time + offset) * rate)] ?? 0
				)
			);
			assert.ok(peak > 0.3, `speech at ${time}s opens the mouth (${peak})`);
		}
	});

	await test("the avatar render stage accepts the lip-synced rig", async () => {
		const frame = await renderAvatarFrame(latest, 2, directory);
		assert.equal(frame.length, WIDTH * HEIGHT, "the avatar stage renders");
		assert.ok(
			frame.some((pixel) => pixel < 60),
			"the avatar is drawn"
		);
	});

	await test("the analysis waveform gives the same open/closed pattern", async () => {
		const analyses = await fetch(`${base}/assets/${audio.id}/analyze`, {
			headers,
			method: "POST",
		});
		assert.ok(analyses.ok, "analysis starts");
		for (let attempt = 0; attempt < 300; attempt += 1) {
			if (store.analysis(audio.id)?.status !== "running") {
				break;
			}
			await Bun.sleep(100);
		}
		assert.equal(store.analysis(audio.id)?.status, "completed");
		const response = await lipSync(latest, {
			avatarId: character.id,
			envelope: "analysis",
			segmentId: clip.id,
			smoothing: 0.25,
		});
		assert.equal(response.status, 200, response.body.message);
		const fromAnalysis = response.body.project.avatars[0];
		assert.ok(fromAnalysis);
		for (const time of pauseTimes) {
			assert.ok(avatarPoseAtTime(fromAnalysis, time).mouth < 0.05);
		}
		for (const time of speechTimes) {
			assert.ok(avatarPoseAtTime(fromAnalysis, time).mouth > 0.2);
		}
		console.log(
			`analysis envelope: ${response.body.keyframes} mouth keyframes`
		);
	});
	console.log("verify-avatar-lipsync: ok");
} finally {
	app.stop();
	store.close();
	await rm(directory, { force: true, recursive: true });
}
