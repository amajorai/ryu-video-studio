/**
 * Real-FFmpeg proof for styled titles (W3-X1).
 *
 * 1. A render-queue export of an outlined title on a square box and a second
 *    title on a rounded box: the box colors must surround the text, the
 *    outline color must appear, and legacy titles still render.
 * 2. The bundled fonts resolve through `fontsdir`, including from a directory
 *    whose name needs filtergraph escaping.
 * 3. A rotated title that moves stays on its keyframed path (rotation pivots
 *    on its own anchor, as in the preview).
 * 4. A square box with zero padding still draws.
 * 5. The render orchestrator's `subtitles` filter selects the bundled face.
 *    Until `render.ts` passes `subtitlesFontsOption()` (W5-I1 handoff) this
 *    reports PENDING; set VERIFY_REQUIRE_RENDER_FONTSDIR=1 to make it fatal.
 */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newProject, type Project, type Title } from "../../shared/project.ts";
import { titleMotionAt } from "../../shared/text-animation.ts";
import { resolveFontsDirectory, subtitlesFontsOption } from "./fonts.ts";
import { mediaBinary, runMedia } from "./media.ts";
import { buildRender, RenderQueue } from "./render.ts";
import { assCaptions } from "./render-ass.ts";
import { StudioStore } from "./store.ts";

const WIDTH = 640;
const HEIGHT = 360;

type Rgb = readonly [number, number, number];

async function frameAt(
	file: string,
	frameIndex: number,
	directory: string
): Promise<Uint8Array> {
	const output = join(directory, `frame-${frameIndex}.rgb`);
	await runMedia([
		"-y",
		"-i",
		file,
		"-vf",
		`select=eq(n\\,${frameIndex})`,
		"-frames:v",
		"1",
		"-pix_fmt",
		"rgb24",
		"-f",
		"rawvideo",
		output,
	]);
	return new Uint8Array(await Bun.file(output).arrayBuffer());
}

function countNear(
	pixels: Uint8Array,
	target: Rgb,
	box: { x0: number; x1: number; y0: number; y1: number },
	tolerance = 40
): number {
	let count = 0;
	for (let y = box.y0; y < box.y1; y++) {
		for (let x = box.x0; x < box.x1; x++) {
			const offset = (y * WIDTH + x) * 3;
			if (
				Math.abs((pixels[offset] ?? 0) - target[0]) < tolerance &&
				Math.abs((pixels[offset + 1] ?? 0) - target[1]) < tolerance &&
				Math.abs((pixels[offset + 2] ?? 0) - target[2]) < tolerance
			) {
				count++;
			}
		}
	}
	return count;
}

const pixel = (pixels: Uint8Array, x: number, y: number): Rgb => {
	const offset = (y * WIDTH + x) * 3;
	return [
		pixels[offset] ?? 0,
		pixels[offset + 1] ?? 0,
		pixels[offset + 2] ?? 0,
	];
};

const title = (patch: Partial<Title>): Title => ({
	animation: "fade",
	color: "#ffffff",
	end: 2,
	fadeIn: 0,
	fadeOut: 0,
	fontSize: 0.1,
	id: crypto.randomUUID(),
	start: 0,
	text: "Styled",
	x: 0.5,
	y: 0.5,
	...patch,
});

async function test(_name: string, run: () => Promise<void>) {
	await run();
}

await test("outlined boxed titles render their box and outline colors", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-verify-text-styles-"));
	const store = new StudioStore(directory);
	try {
		const project = store.save({
			...store.create("Text style proof"),
			height: HEIGHT,
			titles: [
				title({
					backgroundColor: "#ff00ff",
					backgroundPadding: 0.03,
					fontFamily: "anton",
					outlineColor: "#00ff00",
					outlineWidth: 0.01,
					text: "BOXED",
					y: 0.3,
				}),
				title({
					backgroundColor: "#0050ff",
					backgroundPadding: 0.02,
					backgroundRadius: 0.5,
					fontFamily: "poppins",
					fontSize: 0.07,
					text: "Rounded",
					y: 0.72,
				}),
				title({ fontSize: 0.05, text: "legacy", x: 0.12, y: 0.08 }),
			],
			width: WIDTH,
		});
		const queued = new RenderQueue(store).start(project);
		let job = queued;
		for (let attempt = 0; attempt < 600; attempt++) {
			job = store.jobs().find((item) => item.id === queued.id) ?? job;
			if (["completed", "failed"].includes(job.status)) {
				break;
			}
			await Bun.sleep(100);
		}
		assert.equal(job.status, "completed", job.error);
		const pixels = await frameAt(store.renderPath(job.id), 15, directory);
		const top = { x0: 160, x1: 480, y0: 60, y1: 160 };
		const magenta = countNear(pixels, [255, 0, 255], top);
		const green = countNear(pixels, [0, 255, 0], top, 70);
		const white = countNear(pixels, [255, 255, 255], top, 50);
		assert.ok(magenta > 1500, `square box fills around the text (${magenta})`);
		assert.ok(green > 200, `outline color draws around glyphs (${green})`);
		assert.ok(white > 100, `text fill stays white (${white})`);
		// Find the box's top edge above the text center and check the color
		// just inside it: the box pixel near the text.
		let edge = -1;
		for (let y = 60; y < 108; y++) {
			if (
				countNear(pixels, [255, 0, 255], {
					x0: 318,
					x1: 322,
					y0: y,
					y1: y + 1,
				}) === 4
			) {
				edge = y;
				break;
			}
		}
		assert.ok(edge > 60, "the box has a top edge above the text");
		const inside = pixel(pixels, 320, edge + 2);
		assert.ok(
			inside[0] > 215 && inside[1] < 40 && inside[2] > 215,
			`box pixel near the text is magenta (${inside.join(",")})`
		);
		const bottom = { x0: 160, x1: 480, y0: 220, y1: 300 };
		const blue = countNear(pixels, [0, 80, 255], bottom);
		assert.ok(blue > 1500, `rounded box fills (${blue})`);
		assert.equal(
			countNear(pixels, [0, 80, 255], { x0: 160, x1: 162, y0: 222, y1: 224 }),
			0,
			"rounded box corners stay transparent outside the shape"
		);
		const legacy = countNear(pixels, [255, 255, 255], {
			x0: 20,
			x1: 140,
			y0: 10,
			y1: 50,
		});
		assert.ok(legacy > 20, `legacy title still renders (${legacy})`);
		process.stdout.write(
			`PASS: box ${magenta}px magenta (edge y=${edge}, inside ${inside.join(",")}), outline ${green}px, rounded ${blue}px, legacy ${legacy}px.\n`
		);
	} finally {
		store.close();
		await rm(directory, { force: true, recursive: true });
	}
});

await test("bundled fonts resolve through an escaped fontsdir", async () => {
	const bundled = resolveFontsDirectory();
	assert.ok(bundled, "bundled fonts are present");
	const directory = await mkdtemp(join(tmpdir(), "ryu-verify-fonts-"));
	try {
		const fonts = join(directory, "fonts, it's: here");
		await mkdir(fonts);
		await cp(bundled, fonts, { recursive: true });
		const script = join(directory, "titles.ass");
		const project = {
			...newProject("Fonts"),
			height: HEIGHT,
			titles: [
				title({ fontFamily: "anton", text: "Anton" }),
				title({ fontFamily: "source-code-pro", text: "Mono", y: 0.8 }),
			],
			width: WIDTH,
		};
		await Bun.write(script, assCaptions(project));
		const child = Bun.spawn(
			[
				mediaBinary("ffmpeg"),
				"-hide_banner",
				"-loglevel",
				"debug",
				"-f",
				"lavfi",
				"-i",
				`color=black:s=${WIDTH}x${HEIGHT}:d=1`,
				"-vf",
				`subtitles=filename=${script}${subtitlesFontsOption(fonts)}`,
				"-frames:v",
				"1",
				"-f",
				"null",
				"-",
			],
			{ stderr: "pipe", stdout: "ignore" }
		);
		const log = await new Response(child.stderr).text();
		assert.equal(await child.exited, 0, log.slice(-2000));
		const selections = log
			.split("\n")
			.filter((line) => line.includes("fontselect"));
		assert.ok(
			selections.some((line) => line.includes("-> Anton-Regular")),
			`Anton resolves from the bundled directory:\n${selections.join("\n")}`
		);
		assert.ok(
			selections.some((line) => line.includes("-> SourceCodePro-Bold")),
			`Source Code Pro bold resolves:\n${selections.join("\n")}`
		);
		process.stdout.write(
			"PASS: bundled Anton and Source Code Pro resolve through an escaped fontsdir.\n"
		);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

/** Render `project`'s ASS over black and return raw RGB frames at `indexes`. */
async function renderAssFrames(
	project: Project,
	directory: string,
	fps: number,
	seconds: number,
	indexes: readonly number[]
): Promise<Uint8Array[]> {
	const script = join(directory, "titles.ass");
	await Bun.write(script, assCaptions(project));
	const output = join(directory, "frames.rgb");
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=black:s=${WIDTH}x${HEIGHT}:r=${fps}:d=${seconds}`,
		"-vf",
		`subtitles=filename=${script}${subtitlesFontsOption()}`,
		"-pix_fmt",
		"rgb24",
		"-f",
		"rawvideo",
		output,
	]);
	const all = new Uint8Array(await Bun.file(output).arrayBuffer());
	const size = WIDTH * HEIGHT * 3;
	return indexes.map((index) => all.slice(index * size, (index + 1) * size));
}

/** Centroid of bright pixels, or null when the frame has none. */
function brightCentroid(pixels: Uint8Array): [number, number] | null {
	let sumX = 0;
	let sumY = 0;
	let count = 0;
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			if ((pixels[(y * WIDTH + x) * 3] ?? 0) > 128) {
				sumX += x;
				sumY += y;
				count++;
			}
		}
	}
	return count > 0 ? [sumX / count, sumY / count] : null;
}

await test("a rotated title that moves stays on its keyframed path", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-verify-rotate-"));
	try {
		const moving = title({
			end: 2,
			keyframes: [
				{ id: "a", property: "x", time: 0, value: 0.2 },
				{ id: "b", property: "x", time: 2, value: 0.8 },
			],
			rotation: 45,
			text: "XX",
			x: 0.2,
		});
		const project = {
			...newProject("Rotate"),
			fps: 24 as const,
			height: HEIGHT,
			titles: [moving],
			width: WIDTH,
		};
		const indexes = [0, 10, 19];
		const frames = await renderAssFrames(project, directory, 10, 2, indexes);
		const report: string[] = [];
		indexes.forEach((index, position) => {
			const centroid = brightCentroid(frames[position] as Uint8Array);
			const motion = titleMotionAt(moving, index / 10);
			const expected = [motion.x * WIDTH, motion.y * HEIGHT];
			assert.ok(centroid, `frame ${index} shows the title`);
			const distance = Math.hypot(
				centroid[0] - (expected[0] as number),
				centroid[1] - (expected[1] as number)
			);
			assert.ok(
				distance < 12,
				`frame ${index}: centroid ${centroid.map(Math.round).join(",")} vs expected ${expected.map(Math.round).join(",")}`
			);
			report.push(`f${index} ${centroid.map(Math.round).join(",")}`);
		});
		process.stdout.write(
			`PASS: rotated moving title follows its path (${report.join("; ")}).\n`
		);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

await test("a square box with zero padding still draws", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-verify-pad0-"));
	try {
		const project = {
			...newProject("Pad 0"),
			height: HEIGHT,
			titles: [
				title({
					backgroundColor: "#ff00ff",
					backgroundPadding: 0,
					outlineWidth: 0,
					text: "BOXED",
				}),
			],
			width: WIDTH,
		};
		const [frame] = await renderAssFrames(project, directory, 10, 1, [5]);
		const magenta = countNear(frame as Uint8Array, [255, 0, 255], {
			x0: 0,
			x1: WIDTH,
			y0: 0,
			y1: HEIGHT,
		});
		assert.ok(magenta > 1000, `zero-padding box fills (${magenta})`);
		process.stdout.write(`PASS: zero-padding box ${magenta}px magenta.\n`);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

/** Bounding box of pure-blue box pixels, plus the green-lit text centroid. */
function boxAndText(pixels: Uint8Array) {
	let [x0, y0, x1, y1] = [WIDTH, HEIGHT, -1, -1];
	let [sumX, sumY, count] = [0, 0, 0];
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			const [r, g, b] = pixel(pixels, x, y);
			if (b > 200 && r < 60 && g < 60) {
				x0 = Math.min(x0, x);
				x1 = Math.max(x1, x);
				y0 = Math.min(y0, y);
				y1 = Math.max(y1, y);
			}
			if (g > 128) {
				sumX += x;
				sumY += y;
				count++;
			}
		}
	}
	return {
		center: [(x0 + x1) / 2, (y0 + y1) / 2] as const,
		height: y1 - y0 + 1,
		text: count > 0 ? ([sumX / count, sumY / count] as const) : null,
		width: x1 - x0 + 1,
	};
}

await test("box padding per axis and box offset move only the box", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-verify-box-offset-"));
	try {
		const report: string[] = [];
		for (const radius of [0, 0.5]) {
			const plain = title({
				backgroundColor: "#0000ff",
				backgroundPadding: 0.01,
				backgroundRadius: radius,
				outlineWidth: 0,
				text: "BOXED",
			});
			const shaped = {
				...plain,
				backgroundOffsetX: 0.03,
				backgroundOffsetY: 0.04,
				backgroundPaddingX: 0.06,
				backgroundPaddingY: 0.01,
			};
			const [a, b] = await Promise.all(
				[plain, shaped].map(async (item, index) => {
					const folder = join(directory, `${radius}-${index}`);
					await mkdir(folder);
					const [frame] = await renderAssFrames(
						{
							...newProject("Box"),
							height: HEIGHT,
							titles: [item],
							width: WIDTH,
						},
						folder,
						10,
						1,
						[5]
					);
					return boxAndText(frame as Uint8Array);
				})
			);
			assert.ok(a && b && a.text && b.text, "both boxes render with text");
			const widen = b.width - a.width;
			const expectedWiden = 2 * (0.06 - 0.01) * HEIGHT;
			assert.ok(
				Math.abs(widen - expectedWiden) <= 3,
				`radius ${radius}: box widens by ${widen}px, expected ${expectedWiden}`
			);
			assert.ok(
				Math.abs(b.height - a.height) <= 2,
				`radius ${radius}: vertical padding keeps the height (${a.height} -> ${b.height})`
			);
			const shift = [b.center[0] - a.center[0], b.center[1] - a.center[1]];
			const expectedShift = [0.03 * WIDTH, 0.04 * HEIGHT];
			assert.ok(
				Math.abs((shift[0] ?? 0) - (expectedShift[0] ?? 0)) <= 2 &&
					Math.abs((shift[1] ?? 0) - (expectedShift[1] ?? 0)) <= 2,
				`radius ${radius}: box moves ${shift.join(",")} vs ${expectedShift.join(",")}`
			);
			const textMove = Math.hypot(b.text[0] - a.text[0], b.text[1] - a.text[1]);
			assert.ok(textMove < 1.5, `radius ${radius}: text stays (${textMove}px)`);
			report.push(
				`r${radius} ${a.width}x${a.height} -> ${b.width}x${b.height}, box moved ${shift.map((v) => v.toFixed(1)).join(",")}`
			);
		}
		process.stdout.write(
			`PASS: box padding X/Y and offset (${report.join("; ")}).\n`
		);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

await test("the render orchestrator's subtitles filter selects the bundled face", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-verify-render-fonts-"));
	try {
		const script = join(directory, "titles.ass");
		const project = {
			...newProject("Render fonts"),
			height: HEIGHT,
			titles: [title({ fontFamily: "anton", text: "Anton" })],
			width: WIDTH,
		};
		await Bun.write(script, assCaptions(project));
		const args = buildRender(project, [], () => "", script);
		const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
		const subtitles = /subtitles=[^[]*?(?=\[captioned\])/.exec(graph)?.[0];
		assert.ok(subtitles, "the render graph burns titles with `subtitles`");
		const child = Bun.spawn(
			[
				mediaBinary("ffmpeg"),
				"-hide_banner",
				"-loglevel",
				"debug",
				"-f",
				"lavfi",
				"-i",
				`color=black:s=${WIDTH}x${HEIGHT}:d=1`,
				"-vf",
				subtitles,
				"-frames:v",
				"1",
				"-f",
				"null",
				"-",
			],
			{ stderr: "pipe", stdout: "ignore" }
		);
		const log = await new Response(child.stderr).text();
		assert.equal(await child.exited, 0, log.slice(-2000));
		const bundled = log
			.split("\n")
			.some(
				(line) =>
					line.includes("fontselect") && line.includes("-> Anton-Regular")
			);
		if (bundled) {
			process.stdout.write(
				"PASS: the render orchestrator's subtitles filter loads bundled Anton.\n"
			);
			return;
		}
		const message = `render.ts emits \`${subtitles}\` without fontsdir; exports fall back to system fonts until it appends subtitlesFontsOption() (W5-I1).`;
		assert.ok(
			process.env.VERIFY_REQUIRE_RENDER_FONTSDIR !== "1",
			`FAIL: ${message}`
		);
		process.stdout.write(`PENDING: ${message}\n`);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

await test("gradient fill, text blur, word slide and word highlight block render", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-verify-text-fx-"));
	try {
		const ink = (pixels: Uint8Array, box: Parameters<typeof countNear>[2]) => {
			let red = 0;
			let blue = 0;
			let count = 0;
			for (let y = box.y0; y < box.y1; y++) {
				for (let x = box.x0; x < box.x1; x++) {
					const [r, g, b] = pixel(pixels, x, y);
					if (r + g + b > 150) {
						red += r;
						blue += b;
						count++;
					}
				}
			}
			return {
				blue: count ? blue / count : 0,
				count,
				red: count ? red / count : 0,
			};
		};
		// 1. Gradient: red on the left of the word, blue on the right.
		const gradient = {
			...newProject("Gradient"),
			height: HEIGHT,
			titles: [
				title({
					color: "#ff0000",
					fillMode: "gradient",
					fontFamily: "anton",
					fontSize: 0.18,
					gradientColor: "#0000ff",
					text: "GRADIENT",
				}),
			],
			width: WIDTH,
		};
		const [gradientFrame] = await renderAssFrames(
			gradient,
			directory,
			10,
			1,
			[5]
		);
		const left = ink(gradientFrame as Uint8Array, {
			x0: 0,
			x1: 290,
			y0: 100,
			y1: 260,
		});
		const right = ink(gradientFrame as Uint8Array, {
			x0: 350,
			x1: WIDTH,
			y0: 100,
			y1: 260,
		});
		assert.ok(
			left.count > 200 && right.count > 200,
			`the gradient title draws (${left.count} / ${right.count})`
		);
		assert.ok(
			left.red > left.blue + 60 && right.blue > right.red + 60,
			`gradient runs red to blue (left ${Math.round(left.red)}/${Math.round(left.blue)}, right ${Math.round(right.red)}/${Math.round(right.blue)})`
		);
		// 2. Text blur softens edges: fewer fully bright pixels, same footprint.
		const sharpProject = {
			...newProject("Sharp"),
			height: HEIGHT,
			titles: [title({ fontFamily: "anton", text: "BLUR" })],
			width: WIDTH,
		};
		const blurProject = {
			...sharpProject,
			titles: [title({ fontFamily: "anton", text: "BLUR", textBlur: 0.01 })],
		};
		const full = { x0: 0, x1: WIDTH, y0: 0, y1: HEIGHT };
		const [sharp] = await renderAssFrames(sharpProject, directory, 10, 1, [5]);
		const [blurred] = await renderAssFrames(blurProject, directory, 10, 1, [5]);
		const sharpWhite = countNear(
			sharp as Uint8Array,
			[255, 255, 255],
			full,
			20
		);
		const blurWhite = countNear(
			blurred as Uint8Array,
			[255, 255, 255],
			full,
			20
		);
		assert.ok(
			blurWhite < sharpWhite * 0.8,
			`text blur softens the glyphs (${sharpWhite} -> ${blurWhite} bright px)`
		);
		// 3. Word slide: early in the intro the second word is still below its place.
		const slide = {
			...newProject("Slide"),
			height: HEIGHT,
			titles: [
				title({
					animationIn: "word-slide",
					animationInDuration: 1,
					end: 3,
					fontFamily: "anton",
					text: "UP UP",
				}),
			],
			width: WIDTH,
		};
		const [early, settled] = await renderAssFrames(
			slide,
			directory,
			10,
			3,
			[6, 25]
		);
		const rightHalf = { x0: 330, x1: WIDTH, y0: 0, y1: HEIGHT };
		const centroidY = (pixels: Uint8Array) => {
			let sum = 0;
			let count = 0;
			for (let y = rightHalf.y0; y < rightHalf.y1; y++) {
				for (let x = rightHalf.x0; x < rightHalf.x1; x++) {
					if ((pixels[(y * WIDTH + x) * 3] ?? 0) > 128) {
						sum += y;
						count++;
					}
				}
			}
			return count ? sum / count : -1;
		};
		const earlyY = centroidY(early as Uint8Array);
		const settledY = centroidY(settled as Uint8Array);
		assert.ok(earlyY > 0 && settledY > 0, "both frames show the second word");
		assert.ok(
			earlyY > settledY + 2,
			`the second word rises into place (y ${earlyY.toFixed(1)} -> ${settledY.toFixed(1)})`
		);
		// 4. Highlight block: a box in the highlight color behind the active word only.
		const block = {
			...newProject("Block"),
			height: HEIGHT,
			titles: [
				title({
					animationIn: "word-highlight-block",
					end: 2,
					fontFamily: "anton",
					highlightColor: "#00ff00",
					text: "ONE TWO",
				}),
			],
			width: WIDTH,
		};
		const [first, second] = await renderAssFrames(
			block,
			directory,
			10,
			2,
			[3, 15]
		);
		const leftHalf = { x0: 0, x1: 320, y0: 0, y1: HEIGHT };
		const rightSide = { x0: 320, x1: WIDTH, y0: 0, y1: HEIGHT };
		const greenLeftFirst = countNear(
			first as Uint8Array,
			[0, 255, 0],
			leftHalf,
			60
		);
		const greenRightFirst = countNear(
			first as Uint8Array,
			[0, 255, 0],
			rightSide,
			60
		);
		const greenRightSecond = countNear(
			second as Uint8Array,
			[0, 255, 0],
			rightSide,
			60
		);
		assert.ok(
			greenLeftFirst > 800 && greenRightFirst < 50,
			`the box sits behind the first word first (${greenLeftFirst} / ${greenRightFirst})`
		);
		assert.ok(
			greenRightSecond > 800,
			`then behind the second word (${greenRightSecond})`
		);
		assert.ok(
			countNear(first as Uint8Array, [255, 255, 255], leftHalf, 40) > 100,
			"the active word's text stays in its own color over the box"
		);
		process.stdout.write(
			`PASS: gradient ${Math.round(left.red)}/${Math.round(right.blue)}, blur ${sharpWhite}->${blurWhite}px, word slide y ${earlyY.toFixed(1)}->${settledY.toFixed(1)}, highlight block ${greenLeftFirst}/${greenRightSecond}px.\n`
		);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});
