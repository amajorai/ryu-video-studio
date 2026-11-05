/**
 * Real-FFmpeg proof for reveal transitions, exit transitions and clip
 * animations (W2-V10). A red card (A) runs 0–2 s and a blue card (B) starts at
 * 1 s on the same track, overlapping A by the 1 s transition. Single frames
 * render through `buildRender` and pixels are compared with the shared
 * reference math the preview evaluates (`shared/reveal-transitions.ts`,
 * `shared/transitions.ts`).
 *
 * Plan acceptance: the wipe-left midpoint frame has left = B and right = A.
 *
 * Run: `bun src/verify-reveal-transitions.ts`
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
	segmentSchema,
} from "../../shared/project.ts";
import {
	type RevealTransition,
	revealCoverage,
	revealProgress,
	revealTransitions,
} from "../../shared/reveal-transitions.ts";
import type { ClipAnimation } from "../../shared/schema/transition.ts";
import {
	applyRevealTransition,
	clipMotionAt,
} from "../../shared/transitions.ts";
import { runMedia } from "./media.ts";
import { buildRender } from "./render.ts";

type Rgb = [number, number, number];

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
/**
 * Frame renders quantize timestamps to each input's time base (1/25 s for the
 * still cards, 1/30 s for the canvas), so sampled times sit on both grids
 * (multiples of 0.2 s). The wipe midpoint at 1.5 s draws the 1.48 s frame.
 */
/** Allowed per-channel error in 8-bit steps (YUV round trips, soft edges). */
const TOLERANCE = 14;
const RED: Rgb = [255, 0, 0];
const BLUE: Rgb = [0, 0, 255];

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-reveal-"));
const results: string[] = [];

async function card(name: string, color: Rgb, index: number) {
	const path = join(directory, `${name}.png`);
	const hex = color
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=c=0x${hex}:s=${WIDTH}x${HEIGHT},format=rgb24`,
		"-frames:v",
		"1",
		path,
	]);
	const asset: Asset = {
		createdAt: "2026-01-01T00:00:00.000Z",
		duration: 5,
		hasAudio: false,
		height: HEIGHT,
		id: `00000000-0000-4000-8000-00000000000${index}`,
		kind: "image",
		name: `${name}.png`,
		width: WIDTH,
	};
	return { asset, path };
}

try {
	const red = await card("red", RED, 1);
	const blue = await card("blue", BLUE, 2);
	const assets = [red.asset, blue.asset];
	const paths = new Map([
		[red.asset.id, red.path],
		[blue.asset.id, blue.path],
	]);

	/** A cut at 2 s turned into a 1 s transition through `applyRevealTransition`. */
	function scene(
		type: RevealTransition | undefined,
		patch: Partial<Segment> = {}
	): Project {
		const project: Project = {
			...newProject("Reveal proof"),
			height: HEIGHT,
			styleProfile: "clean-professional",
			width: WIDTH,
			segments: [
				segmentSchema.parse({ ...newSegment(red.asset), sourceOut: 2 }),
				segmentSchema.parse({
					...newSegment(blue.asset, 2),
					sourceOut: 2,
					...patch,
				}),
			],
		};
		const incoming = project.segments[1];
		ensure(incoming, "scene has no incoming clip");
		if (!type) {
			return project;
		}
		return applyRevealTransition(project, assets, incoming.id, {
			duration: 1,
			softness: 0,
			type,
		});
	}

	async function frame(
		name: string,
		project: Project,
		at: number
	): Promise<(x: number, y: number) => Rgb> {
		const png = join(directory, `${name}.png`);
		const raw = join(directory, `${name}.rgb`);
		const args = buildRender(
			project,
			assets,
			(id) => paths.get(id) ?? "",
			undefined,
			[],
			at
		);
		await runMedia([...args, png], { cwd: directory });
		await runMedia([
			"-y",
			"-i",
			png,
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
		return (x, y) => {
			const offset = (y * WIDTH + x) * 3;
			return [
				pixels[offset] ?? 0,
				pixels[offset + 1] ?? 0,
				pixels[offset + 2] ?? 0,
			];
		};
	}

	const mix = (a: Rgb, b: Rgb, amount: number): Rgb => [
		a[0] + (b[0] - a[0]) * amount,
		a[1] + (b[1] - a[1]) * amount,
		a[2] + (b[2] - a[2]) * amount,
	];

	function expectPixel(name: string, actual: Rgb, expected: Rgb) {
		const off = actual.some(
			(value, index) => Math.abs(value - (expected[index] ?? 0)) > TOLERANCE
		);
		ensure(
			!off,
			`${name}: got rgb(${actual.join(",")}), expected rgb(${expected.map((value) => Math.round(value)).join(",")})`
		);
	}

	// Plan acceptance: wipe-left midpoint, left = B (blue), right = A (red).
	{
		const project = scene("wipe-left");
		const incoming = project.segments[1];
		ensure(incoming?.start === 1, "the transition did not roll the cut to 1 s");
		ensure(
			Math.abs(
				revealProgress({ duration: 1, softness: 0, type: "wipe-left" }, 0.5) -
					0.5
			) < 1e-9,
			"wipe-left midpoint progress is not 0.5"
		);
		const sample = await frame("wipe-left-mid", project, 1.5);
		expectPixel(
			"wipe-left mid, left quarter",
			sample(WIDTH / 4, HEIGHT / 2),
			BLUE
		);
		expectPixel(
			"wipe-left mid, right quarter",
			sample((3 * WIDTH) / 4, HEIGHT / 2),
			RED
		);
		results.push("wipe-left midpoint: left = B, right = A");
	}

	// Every per-pixel reveal against the shared coverage the preview uses.
	const points: [number, number][] = [
		[16, 16],
		[WIDTH / 2, HEIGHT / 2],
		[WIDTH - 20, 24],
		[40, HEIGHT - 30],
		[WIDTH - 50, HEIGHT - 20],
		[WIDTH / 2 + 30, HEIGHT / 2 - 40],
	];
	for (const type of revealTransitions) {
		if (
			[
				"dissolve",
				"slide-left",
				"slide-right",
				"slide-up",
				"slide-down",
				"push-left",
				"push-right",
				"zoom",
				"blur",
				"fade-black",
				"fade-white",
			].includes(type)
		) {
			continue;
		}
		const project = scene(type);
		const transition = project.segments[1]?.transitionIn;
		ensure(transition, `${type}: transition missing`);
		for (const at of [1.2, 1.6]) {
			const sample = await frame(`${type}-${at}`, project, at);
			for (const [x, y] of points) {
				const coverage = revealCoverage(transition, at - 1, {
					h: HEIGHT,
					w: WIDTH,
					x,
					y,
				});
				// Skip pixels within 3 px of the hard edge: 4:2:0 chroma blends 2x2 blocks.
				const near = [-3, 3].flatMap((ox) =>
					[-3, 3].map((oy) =>
						revealCoverage(transition, at - 1, {
							h: HEIGHT,
							w: WIDTH,
							x: x + ox,
							y: y + oy,
						})
					)
				);
				if (near.some((value) => Math.abs(value - coverage) > 0.02)) {
					continue;
				}
				expectPixel(
					`${type} at ${at}s (${x},${y})`,
					sample(x, y),
					mix(RED, BLUE, coverage)
				);
			}
		}
		results.push(`${type}: pixels match the shared coverage`);
	}

	// Fades through a color: the 25% frame is A darkened/lightened, 75% is B tinted.
	for (const [type, color] of [
		["fade-black", [0, 0, 0]],
		["fade-white", [255, 255, 255]],
	] as const) {
		const project = scene(type);
		const quarter = await frame(`${type}-quarter`, project, 1.2);
		const p1 = revealProgress({ duration: 1, softness: 0, type }, 0.2);
		expectPixel(
			`${type} 25%`,
			quarter(WIDTH / 2, HEIGHT / 2),
			mix(RED, [...color], Math.min(1, 2 * p1))
		);
		const late = await frame(`${type}-late`, project, 1.8);
		const p2 = revealProgress({ duration: 1, softness: 0, type }, 0.8);
		expectPixel(
			`${type} 75%`,
			late(WIDTH / 2, HEIGHT / 2),
			mix([...color], BLUE, 2 * p2 - 1)
		);
		results.push(
			`${type}: passes through ${type === "fade-black" ? "black" : "white"}`
		);
	}

	// Dissolve-type alpha (whole frame) against `clipMotionAt`.
	{
		const project = scene("dissolve");
		const sample = await frame("dissolve-mid", project, 1.4);
		const incoming = project.segments[1];
		ensure(incoming, "dissolve: incoming missing");
		const alpha = clipMotionAt(incoming, 0.4).opacity;
		expectPixel(
			"dissolve 40%",
			sample(WIDTH / 2, HEIGHT / 2),
			mix(RED, BLUE, alpha)
		);
		results.push("dissolve: whole-frame alpha matches the preview opacity");
	}

	// Slides and pushes: the incoming card's edge sits where the shared offset puts it.
	for (const type of ["slide-left", "push-left", "push-right"] as const) {
		const project = scene(type);
		const incoming = project.segments[1];
		ensure(incoming, `${type}: incoming missing`);
		const shift = clipMotionAt(incoming, 0.4).shiftX;
		const edge = Math.round(shift * WIDTH);
		const sample = await frame(`${type}-mid`, project, 1.4);
		const insideB = shift > 0 ? edge + 20 : WIDTH + edge - 20;
		const outsideB = shift > 0 ? edge - 20 : WIDTH + edge + 20;
		expectPixel(`${type} inside B`, sample(insideB, HEIGHT / 2), BLUE);
		const outgoing = project.segments[0];
		ensure(outgoing, `${type}: outgoing missing`);
		if (type === "slide-left") {
			expectPixel(`${type} A stays`, sample(outsideB, HEIGHT / 2), RED);
		} else {
			ensure(outgoing.exitTransition, `${type}: push did not pair an exit`);
			const outgoingShift = clipMotionAt(outgoing, 1.4).shiftX;
			ensure(
				Math.abs(outgoingShift - (shift > 0 ? shift - 1 : shift + 1)) < 1e-6,
				`${type}: outgoing and incoming are not butted (${outgoingShift} vs ${shift})`
			);
			expectPixel(`${type} A pushed`, sample(outsideB, HEIGHT / 2), RED);
		}
		results.push(`${type}: offsets match the shared curve`);
	}

	// Zoom and blur reveal render (zoom never grows above the pad).
	for (const type of ["zoom", "blur"] as const) {
		const project = scene(type);
		const sample = await frame(`${type}-mid`, project, 1.5);
		const incoming = project.segments[1];
		ensure(incoming, `${type}: incoming missing`);
		const alpha = clipMotionAt(incoming, 0.5).opacity;
		expectPixel(
			`${type} centre`,
			sample(WIDTH / 2, HEIGHT / 2),
			mix(RED, BLUE, alpha)
		);
		if (type === "zoom") {
			// At 80% scale the blue card leaves a red margin at the corners.
			expectPixel("zoom corner", sample(4, 4), RED);
		}
		results.push(`${type}: renders with the shared alpha`);
	}

	// Animations on a lone blue card over black.
	async function animated(name: string, animation: ClipAnimation, at: number) {
		const project: Project = {
			...newProject("Animation proof"),
			height: HEIGHT,
			styleProfile: "clean-professional",
			width: WIDTH,
			segments: [
				segmentSchema.parse({
					...newSegment(blue.asset),
					animation,
					sourceOut: 3,
				}),
			],
		};
		const segment = project.segments[0];
		ensure(segment, "animation clip missing");
		return {
			motion: clipMotionAt(segment, at),
			sample: await frame(name, project, at),
		};
	}
	{
		const { motion, sample } = await animated(
			"anim-fade",
			{ in: "fade", inDuration: 1 },
			0.4
		);
		expectPixel(
			"fade in at 0.4 s",
			sample(WIDTH / 2, HEIGHT / 2),
			mix([0, 0, 0], BLUE, motion.opacity)
		);
		results.push("animation fade-in: opacity matches the preview");
	}
	{
		const { motion, sample } = await animated(
			"anim-out",
			{ out: "slide-left", outDuration: 1 },
			2.6
		);
		const edge = Math.round(WIDTH + motion.shiftX * WIDTH);
		expectPixel(
			"slide-left out keeps B left of its edge",
			sample(edge - 20, HEIGHT / 2),
			mix([0, 0, 0], BLUE, motion.opacity)
		);
		expectPixel(
			"slide-left out uncovers the right",
			sample(Math.min(WIDTH - 1, edge + 20), HEIGHT / 2),
			[0, 0, 0]
		);
		results.push("animation slide-left out: travel matches the preview");
	}
	{
		const { motion, sample } = await animated(
			"anim-pop",
			{ in: "pop", inDuration: 1 },
			0.2
		);
		ensure(motion.scale < 1, "pop starts small");
		expectPixel("pop corner is empty", sample(4, 4), [0, 0, 0]);
		const centre = sample(WIDTH / 2, HEIGHT / 2);
		ensure(centre[2] > 100, `pop centre shows B (${centre.join(",")})`);
		results.push("animation pop: scales up from the centre");
	}
	for (const [name, animation] of [
		["spin", { in: "spin", loop: "wobble" }],
		["bounce", { in: "bounce", out: "blur", loop: "shake" }],
		["loops", { loop: "pulse", loopPeriod: 0.5 }],
		["float", { loop: "float" }],
		["spin-loop", { loop: "spin" }],
	] as const) {
		await animated(`anim-${name}`, animation, 0.25);
		await animated(`anim-${name}-late`, animation, 2.8);
		results.push(`animation ${name}: renders`);
	}

	// Exit transitions mirror the entry set.
	{
		const project: Project = {
			...newProject("Exit proof"),
			height: HEIGHT,
			styleProfile: "clean-professional",
			width: WIDTH,
			segments: [
				segmentSchema.parse({
					...newSegment(blue.asset),
					exitDuration: 1,
					exitTransition: "crossfade",
					sourceOut: 3,
				}),
			],
		};
		const sample = await frame("exit-crossfade", project, 2.6);
		expectPixel(
			"exit crossfade at 40%",
			sample(WIDTH / 2, HEIGHT / 2),
			mix([0, 0, 0], BLUE, 0.4)
		);
		results.push("exit crossfade: fades out over the exit window");
	}

	// An unset exit duration on a clip shorter than the 0.5 s default encodes.
	{
		const project: Project = {
			...newProject("Short exit proof"),
			height: HEIGHT,
			styleProfile: "clean-professional",
			width: WIDTH,
			segments: [
				segmentSchema.parse({
					...newSegment(blue.asset),
					exitTransition: "crossfade",
					sourceOut: 0.3,
				}),
			],
		};
		const output = join(directory, "short-exit.mp4");
		const args = buildRender(project, assets, (id) => paths.get(id) ?? "");
		await runMedia([...args, output], { cwd: directory });
		results.push("short clip with default exit duration: encodes");
	}

	// A full export with transitions and animations encodes end to end.
	{
		const project = scene("circle-open", {
			animation: { in: "spin", loop: "wobble", out: "blur" },
		});
		const output = join(directory, "export.mp4");
		const args = buildRender(project, assets, (id) => paths.get(id) ?? "");
		await runMedia([...args, output], { cwd: directory });
		results.push("export: circle-open + spin/wobble/blur encodes");
	}

	for (const line of results) {
		process.stdout.write(`PASS: ${line}\n`);
	}
} finally {
	await rm(directory, { force: true, recursive: true });
}
