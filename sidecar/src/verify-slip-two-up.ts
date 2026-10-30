/**
 * Real-FFmpeg proof for the slip/roll/ripple two-up viewer (W1-T12).
 *
 * A source whose luma encodes its frame number is placed on a timeline. For
 * slip, roll, and ripple proposals the UI's `trimFeedbackFrames` picks the
 * source times to show and `trimFramePlan` turns each into a filmstrip
 * request whose last tile is the frame; the sidecar's `assetFilmstrip`
 * renders it. Each picture must be exactly the frame the committed edit
 * would show at that edge. Media faster than the project (60 fps media in a
 * 30 or 60 fps project) proves the frames in the route's final-50 ms seek
 * guard, including the media's very last frame.
 *
 * Run: `bun src/verify-slip-two-up.ts`
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type ProjectFps,
	type Segment,
} from "../../shared/project.ts";
import { assetFilmstrip } from "./filmstrip.ts";
import { probe, runMedia } from "./media.ts";
import { StudioStore } from "./store.ts";

const SECONDS = 4;

/** The slice of `ui/src/timeline/trim-feedback.ts` this proof drives. */
interface TrimFeedbackModule {
	trimFeedbackFrames: (
		project: Project,
		assets: readonly Asset[],
		proposal: Record<string, unknown>
	) => {
		frames: { assetId: string; role: string; time: number }[];
		mode: string;
	} | null;
	trimFramePlan: (
		frame: { assetId: string; time: number },
		asset: Asset
	) => {
		count: number;
		end: number;
		height: number;
		start: number;
	} | null;
}

// Loaded by path so the sidecar typecheck does not pull in the UI (React) graph.
const uiModule = "../../ui/src/timeline/trim-feedback.ts";
const { trimFeedbackFrames, trimFramePlan } = (await import(
	uiModule
)) as TrimFeedbackModule;

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

async function centreLuma(png: Uint8Array, directory: string) {
	const input = join(directory, "frame.png");
	const output = join(directory, "frame.gray");
	await writeFile(input, png);
	await runMedia([
		"-v",
		"error",
		"-y",
		"-i",
		input,
		"-f",
		"rawvideo",
		"-pix_fmt",
		"gray",
		output,
	]);
	const pixels = new Uint8Array(await readFile(output));
	return { pixels };
}

interface Scenario {
	/** Exact frame numbers for each case, when pinned by hand. */
	expected?: Record<string, number[]>;
	/** Frame number the slip-to-end case's last frame must show. */
	lastMediaFrame: number;
	mediaFps: number;
	projectFps: ProjectFps;
}

const SCENARIOS: Scenario[] = [
	{
		expected: {
			// Source moves 0.5 s later: frames 45 and 74.
			slip: [45, 74],
			// Handles clamp the slip at the end of the media: frames 90 and 119.
			"slip to the media end": [90, 119],
			// Edit point rolls 0.2 s later: outgoing 65, incoming 81.
			roll: [65, 81],
			// The first clip loses 0.3 s: outgoing 50, incoming stays 75.
			"ripple end": [50, 75],
			// The second clip's head moves 0.4 s in: outgoing 59, incoming 87.
			"ripple start": [59, 87],
		},
		lastMediaFrame: 119,
		mediaFps: 30,
		projectFps: 30,
	},
	// Regression: the last project frame (media frame 238) sits inside the
	// route's end seek guard and used to show frame 237.
	{ lastMediaFrame: 238, mediaFps: 60, projectFps: 30 },
	// The media's very last frame, 16.7 ms before its end.
	{ lastMediaFrame: 239, mediaFps: 60, projectFps: 60 },
];

/**
 * Luma codes the frame number modulo `LUMA_FRAMES`, two levels per frame so
 * the limited-range round trip through yuv420p cannot blur neighbours.
 */
const LUMA_PER_FRAME = 2;
const LUMA_FRAMES = 128;

async function runScenario(directory: string, scenario: Scenario) {
	const { mediaFps, projectFps } = scenario;
	const store = new StudioStore(join(directory, `${mediaFps}-${projectFps}`));
	try {
		const source = join(directory, `frames-${mediaFps}.mp4`);
		await runMedia([
			"-v",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			`color=c=black:s=160x90:r=${mediaFps}:d=${SECONDS},format=gray,geq=lum='mod(N\\,${LUMA_FRAMES})*${LUMA_PER_FRAME}'`,
			"-c:v",
			"libx264",
			"-qp",
			"0",
			"-pix_fmt",
			"yuv420p",
			source,
		]);
		const asset: Asset = {
			...(await probe(source)),
			createdAt: new Date().toISOString(),
			id: crypto.randomUUID(),
			name: "Frame counter",
		};
		await Bun.write(store.mediaPath(asset.id), Bun.file(source));
		store.putAsset(asset);

		const first: Segment = {
			...newSegment(asset, 0),
			sourceIn: 1,
			sourceOut: 2,
		};
		const second: Segment = {
			...newSegment(asset, 1),
			sourceIn: 2.5,
			sourceOut: 3.5,
		};
		const project: Project = {
			...newProject("Two-up proof"),
			fps: projectFps,
			segments: [first, second],
		};
		const cases: { name: string; proposal: Record<string, unknown> }[] = [
			{
				name: "slip",
				proposal: { clipId: first.id, delta: 0.5, mode: "slip" },
			},
			{
				name: "slip to the media end",
				proposal: { clipId: first.id, delta: 5, mode: "slip" },
			},
			{
				name: "roll",
				proposal: {
					delta: 0.2,
					inClipId: second.id,
					mode: "roll",
					outClipId: first.id,
				},
			},
			{
				name: "ripple end",
				proposal: {
					clipId: first.id,
					delta: -0.3,
					edge: "end",
					mode: "ripple",
				},
			},
			{
				name: "ripple start",
				proposal: {
					clipId: second.id,
					delta: 0.4,
					edge: "start",
					mode: "ripple",
				},
			},
		];
		const label = `${mediaFps} fps media, ${projectFps} fps project`;
		for (const { name, proposal } of cases) {
			const feedback = trimFeedbackFrames(project, [asset], proposal);
			ensure(feedback, `${label} ${name}: no feedback`);
			const expected =
				scenario.expected?.[name] ??
				feedback.frames.map((frame) => Math.round(frame.time * mediaFps));
			ensure(
				feedback.frames.length === expected.length,
				`${label} ${name}: ${feedback.frames.length} frames`
			);
			if (name === "slip to the media end") {
				ensure(
					expected.at(-1) === scenario.lastMediaFrame,
					`${label} ${name}: last frame ${expected.at(-1)}, expected ${scenario.lastMediaFrame}`
				);
			}
			const seen: string[] = [];
			for (const [index, frame] of feedback.frames.entries()) {
				const want = expected[index] ?? -1;
				ensure(
					Math.round(frame.time * mediaFps) === want,
					`${label} ${name} ${frame.role}: time ${frame.time} is not frame ${want}`
				);
				const plan = trimFramePlan(frame, asset);
				ensure(plan, `${label} ${name} ${frame.role}: no request`);
				const sprite = await assetFilmstrip(store, asset, plan);
				const { pixels } = await centreLuma(
					Uint8Array.from(Buffer.from(sprite.data, "base64")),
					directory
				);
				// The frame is the sprite's last tile.
				const tile = Math.max(0, plan.count - 1);
				const y = Math.floor(sprite.frameHeight / 2);
				const x = tile * sprite.frameWidth + Math.floor(sprite.frameWidth / 2);
				const luma = pixels[y * sprite.width + x] ?? 0;
				const shown = Math.round(luma / LUMA_PER_FRAME);
				ensure(
					shown === want % LUMA_FRAMES,
					`${label} ${name} ${frame.role}: picture shows frame ${shown} (luma ${luma}), expected ${want}`
				);
				seen.push(
					plan.count > 1
						? `${want} (tile ${tile + 1}/${plan.count})`
						: `${want}`
				);
			}
			console.log(
				`${label} ${name}: ${feedback.mode} frames ${seen.join(" | ")}`
			);
		}
	} finally {
		store.close();
	}
}

async function main() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-verify-slip-two-up-"));
	try {
		for (const scenario of SCENARIOS) {
			await runScenario(directory, scenario);
		}
		console.log("verify-slip-two-up: ok");
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

await main();
