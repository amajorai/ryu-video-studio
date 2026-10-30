/**
 * Real-FFmpeg proof for the effects library (W2-V6). A short noisy
 * `testsrc2` clip (with a skin-tone patch) is exported through `buildRender`
 * once without effects and once per effect type at full amount; every
 * effect must render and change the frame by more than a small mean
 * difference. Amount 0 must leave the export identical, a keyframed amount
 * must follow its curve, and two clips sharing a branching effect must keep
 * their graph labels apart.
 *
 * Run: `bun src/verify-effects.ts`
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Effect,
	type EffectType,
	effectTypeSchema,
} from "../../shared/effects.ts";
import {
	type Asset,
	type Keyframe,
	newProject,
	newSegment,
	type Project,
	type Segment,
	segmentSchema,
} from "../../shared/project.ts";
import { runMedia } from "./media.ts";
import { buildRender } from "./render.ts";

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const WIDTH = 320;
const HEIGHT = 180;
const CLIP = 0.6;
/** Smallest mean absolute 8-bit difference that counts as a visible change. */
const EPSILON = 0.5;
/** Frame sampled from each export (inside the glitch burst window). */
const SAMPLE_AT = 0.12;

const effectId = (index: number) =>
	`00000000-0000-4000-9000-${index.toString(16).padStart(12, "0")}`;

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-effects-"));
const results: string[] = [];
try {
	const sourcePath = join(directory, "source.mp4");
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		`testsrc2=s=${WIDTH}x${HEIGHT}:r=25:d=1,drawbox=x=24:y=24:w=120:h=90:color=0xD2A07A:t=fill,noise=alls=24:allf=t`,
		"-pix_fmt",
		"yuv420p",
		"-c:v",
		"libx264",
		"-crf",
		"10",
		sourcePath,
	]);
	const asset: Asset = {
		createdAt: "2026-01-01T00:00:00.000Z",
		duration: 1,
		hasAudio: false,
		height: HEIGHT,
		id: "00000000-0000-4000-8000-000000000001",
		kind: "video",
		name: "source.mp4",
		width: WIDTH,
	};

	function project(segments: Partial<Segment>[]): Project {
		return {
			...newProject("Effects proof"),
			height: HEIGHT,
			segments: segments.map((patch) =>
				segmentSchema.parse({
					...newSegment(asset),
					sourceOut: CLIP,
					...patch,
				})
			),
			styleProfile: "clean-professional",
			width: WIDTH,
		};
	}

	async function exportFrames(
		name: string,
		p: Project,
		times: readonly number[]
	): Promise<Buffer[]> {
		const output = join(directory, `${name}.mp4`);
		await runMedia(
			[
				...buildRender(p, [asset], () => sourcePath, undefined, [], undefined),
				output,
			],
			{ cwd: directory, timeoutMs: 120_000 }
		);
		const frames: Buffer[] = [];
		for (const [index, time] of times.entries()) {
			const raw = join(directory, `${name}-${index}.rgb`);
			await runMedia([
				"-y",
				"-ss",
				`${time}`,
				"-i",
				output,
				"-frames:v",
				"1",
				"-pix_fmt",
				"rgb24",
				"-f",
				"rawvideo",
				raw,
			]);
			const pixels = await readFile(raw);
			ensure(
				pixels.length === WIDTH * HEIGHT * 3,
				`${name}: frame is not ${WIDTH}x${HEIGHT}`
			);
			frames.push(pixels);
		}
		return frames;
	}

	/** One frame through the single-frame (preview) render path. */
	async function stillFrame(
		name: string,
		p: Project,
		time: number
	): Promise<Buffer> {
		const png = join(directory, `${name}.png`);
		const raw = join(directory, `${name}.rgb`);
		await runMedia(
			[...buildRender(p, [asset], () => sourcePath, undefined, [], time), png],
			{ cwd: directory }
		);
		await runMedia([
			"-y",
			"-i",
			png,
			"-pix_fmt",
			"rgb24",
			"-f",
			"rawvideo",
			raw,
		]);
		const pixels = await readFile(raw);
		ensure(
			pixels.length === WIDTH * HEIGHT * 3,
			`${name}: frame is not ${WIDTH}x${HEIGHT}`
		);
		return pixels;
	}

	function meanDifference(a: Buffer, b: Buffer): number {
		let total = 0;
		for (let index = 0; index < a.length; index++) {
			total += Math.abs((a[index] ?? 0) - (b[index] ?? 0));
		}
		return total / a.length;
	}

	function regionDifference(
		a: Buffer,
		b: Buffer,
		left: number,
		top: number,
		right: number,
		bottom: number
	): number {
		let total = 0;
		let count = 0;
		for (let y = top; y < bottom; y++) {
			for (let x = left * 3; x < right * 3; x++) {
				const index = y * WIDTH * 3 + x;
				total += Math.abs((a[index] ?? 0) - (b[index] ?? 0));
				count++;
			}
		}
		return total / count;
	}

	const [baseline] = await exportFrames("baseline", project([{}]), [SAMPLE_AT]);
	ensure(baseline, "baseline frame missing");

	const effect = (type: EffectType, patch: Partial<Effect> = {}): Effect => ({
		amount: 1,
		enabled: true,
		type,
		...patch,
	});

	for (const type of effectTypeSchema.options) {
		const started = performance.now();
		const [frame] = await exportFrames(
			type,
			project([{ effects: [effect(type, { seed: 7 })] }]),
			[SAMPLE_AT]
		);
		ensure(frame, `${type}: frame missing`);
		const difference = meanDifference(frame, baseline);
		ensure(
			difference > EPSILON,
			`${type}: mean difference ${difference.toFixed(3)} is not above ${EPSILON}`
		);
		results.push(
			`${type} changes the frame (mean ${difference.toFixed(2)}, ${Math.round(performance.now() - started)} ms)`
		);
	}

	// Skin smoothing is confined to the skin-tone patch (24..144, 24..114).
	const [smoothed] = await exportFrames(
		"skin-local",
		project([{ effects: [effect("skin-smooth")] }]),
		[SAMPLE_AT]
	);
	ensure(smoothed, "skin-smooth frame missing");
	const inside = regionDifference(smoothed, baseline, 40, 40, 120, 100);
	const outside = regionDifference(smoothed, baseline, 200, 120, 300, 170);
	ensure(
		inside > outside * 2 && inside > EPSILON,
		`skin-smooth: patch ${inside.toFixed(2)} vs elsewhere ${outside.toFixed(2)}`
	);
	results.push(
		`skin-smooth targets skin tones (patch ${inside.toFixed(2)}, elsewhere ${outside.toFixed(2)})`
	);

	// Relight presets move the light: a left rim light brightens the left
	// edge more than the right, a right rim light the reverse, and a colored
	// preset tints the frame (sunset warms: red rises more than blue).
	function regionMean(
		pixels: Buffer,
		left: number,
		right: number,
		channel?: 0 | 1 | 2
	): number {
		let total = 0;
		let count = 0;
		for (let y = 0; y < HEIGHT; y++) {
			for (let x = left; x < right; x++) {
				for (const c of channel === undefined ? [0, 1, 2] : [channel]) {
					total += pixels[(y * WIDTH + x) * 3 + c] ?? 0;
					count++;
				}
			}
		}
		return total / count;
	}
	const edge = Math.round(WIDTH / 5);
	const lift = async (preset: "rim-left" | "rim-right") => {
		const [lit] = await exportFrames(
			`relight-${preset}`,
			project([{ effects: [effect("relight", { light: { preset } })] }]),
			[SAMPLE_AT]
		);
		ensure(lit, `relight ${preset}: frame missing`);
		return {
			left: regionMean(lit, 0, edge) - regionMean(baseline, 0, edge),
			right:
				regionMean(lit, WIDTH - edge, WIDTH) -
				regionMean(baseline, WIDTH - edge, WIDTH),
		};
	};
	const rimLeft = await lift("rim-left");
	const rimRight = await lift("rim-right");
	ensure(
		rimLeft.left > rimLeft.right + 1 && rimRight.right > rimRight.left + 1,
		`relight rims do not follow their side (left rim ${rimLeft.left.toFixed(2)}/${rimLeft.right.toFixed(2)}, right rim ${rimRight.left.toFixed(2)}/${rimRight.right.toFixed(2)})`
	);
	results.push(
		`relight rim presets light their own side (left rim +${rimLeft.left.toFixed(1)} vs +${rimLeft.right.toFixed(1)}, right rim +${rimRight.right.toFixed(1)} vs +${rimRight.left.toFixed(1)})`
	);
	const [sunset] = await exportFrames(
		"relight-sunset",
		project([
			{ effects: [effect("relight", { light: { preset: "sunset" } })] },
		]),
		[SAMPLE_AT]
	);
	ensure(sunset, "relight sunset: frame missing");
	const warmth =
		regionMean(sunset, 0, WIDTH, 0) -
		regionMean(baseline, 0, WIDTH, 0) -
		(regionMean(sunset, 0, WIDTH, 2) - regionMean(baseline, 0, WIDTH, 2));
	ensure(
		warmth > 1,
		`relight sunset does not warm the frame (${warmth.toFixed(2)})`
	);
	results.push(
		`relight sunset warms the frame (red over blue +${warmth.toFixed(1)})`
	);

	// Amount 0 and disabled effects are skipped, so the frame is identical.
	const [silent] = await exportFrames(
		"silent",
		project([
			{
				effects: [
					effect("glow", { amount: 0 }),
					effect("grain", { enabled: false }),
				],
			},
		]),
		[SAMPLE_AT]
	);
	ensure(silent, "silent frame missing");
	ensure(
		meanDifference(silent, baseline) === 0,
		"amount 0 or disabled effects changed the frame"
	);
	results.push("amount 0 and disabled effects leave the frame identical");

	// Keyframed amounts: 0 until 0.2 s, rising to 1 at 0.45 s, for each
	// strategy (expression, timeline steps, the cross-fade mix, and the
	// per-amount shake branches, whose zoom must vanish at amount 0).
	const keyframed = (id: string): Keyframe[] => [
		{
			id: effectId(100),
			property: "effectAmount",
			target: id,
			time: 0,
			value: 0,
		},
		{
			id: effectId(101),
			property: "effectAmount",
			target: id,
			time: 0.2,
			value: 0,
		},
		{
			id: effectId(102),
			property: "effectAmount",
			target: id,
			time: 0.45,
			value: 1,
		},
	];
	const early = 0.08;
	const late = 0.5;
	const earlyBaseline = await stillFrame(
		"early-baseline",
		project([{}]),
		early
	);
	const lateBaseline = await stillFrame("late-baseline", project([{}]), late);
	for (const type of ["hue-cycle", "mosaic", "invert", "shake"] as const) {
		const id = effectId(1);
		const animated = project([
			{ effects: [effect(type, { id })], keyframes: keyframed(id) },
		]);
		const atStart = meanDifference(
			await stillFrame(`keyframed-${type}-early`, animated, early),
			earlyBaseline
		);
		const atEnd = meanDifference(
			await stillFrame(`keyframed-${type}-late`, animated, late),
			lateBaseline
		);
		ensure(
			atStart === 0,
			`${type}: keyframed amount 0 changed the frame (${atStart.toFixed(3)})`
		);
		ensure(
			atEnd > EPSILON,
			`${type}: keyframed amount 1 left the frame unchanged (${atEnd.toFixed(3)})`
		);
		results.push(
			`keyframed ${type} follows its curve (0 at ${early} s, mean ${atEnd.toFixed(2)} at ${late} s)`
		);
	}

	// Two clips with the same branching effects keep unique link labels.
	const [stacked] = await exportFrames(
		"two-clips",
		project([
			{ effects: [effect("glow"), effect("mirror")] },
			{
				effects: [effect("glow"), effect("mirror")],
				id: effectId(2),
				scale: 0.5,
				track: 1,
			},
		]),
		[SAMPLE_AT]
	);
	ensure(stacked, "two-clip frame missing");
	results.push("two clips with the same branching effects render together");

	for (const result of results) {
		console.log(`ok  ${result}`);
	}
	console.log(`verify-effects: ${results.length} checks passed`);
} finally {
	await rm(directory, { force: true, recursive: true });
}
