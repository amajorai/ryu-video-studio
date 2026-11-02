/**
 * Real-FFmpeg proof for layout presets (W2-V9). Solid 16:9 cards are placed
 * with `applyLayout` and single frames render through `buildRender`:
 *
 * - `three-up` with `fill` has no letterboxing: the top and bottom rows of
 *   every column carry the clip colour (plan acceptance), while `fit` shows
 *   the black letterbox there (control).
 * - `main-sidebar` with `fill` covers 70/30 columns.
 * - `pip-top-left` draws a 25% inset 4% from the corner over the main clip.
 * - `three-stack` with `fill` covers three rows.
 *
 * Run: `bun src/verify-layouts.ts`
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyLayout,
	type Layout,
	type LayoutFit,
} from "../../shared/layouts.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	segmentSchema,
} from "../../shared/project.ts";
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

const WIDTH = 480;
const HEIGHT = 270;
const TOLERANCE = 24;
const BLACK: Rgb = [0, 0, 0];
const COLORS: Rgb[] = [
	[230, 30, 30],
	[30, 200, 30],
	[30, 60, 230],
];

const hex = ([r, g, b]: Rgb) =>
	`0x${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-layouts-"));
const results: string[] = [];
try {
	const cards: { asset: Asset; path: string }[] = [];
	for (const [index, color] of COLORS.entries()) {
		const path = join(directory, `card-${index}.png`);
		await runMedia([
			"-y",
			"-f",
			"lavfi",
			"-i",
			`color=c=${hex(color)}:s=${WIDTH}x${HEIGHT},format=rgb24`,
			"-frames:v",
			"1",
			path,
		]);
		cards.push({
			asset: {
				createdAt: "2026-01-01T00:00:00.000Z",
				duration: 5,
				hasAudio: false,
				height: HEIGHT,
				id: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
				kind: "image",
				name: `card-${index}.png`,
				width: WIDTH,
			},
			path,
		});
	}
	const paths = new Map(cards.map((card) => [card.asset.id, card.path]));
	const assets = cards.map((card) => card.asset);

	async function renderLayout(
		name: string,
		layout: Layout,
		count: number,
		fit: LayoutFit
	): Promise<(x: number, y: number) => Rgb> {
		const base: Project = {
			...newProject("Layout proof"),
			height: HEIGHT,
			styleProfile: "clean-professional",
			width: WIDTH,
		};
		base.segments = cards.slice(0, count).map((card, track) =>
			segmentSchema.parse({
				...newSegment(card.asset, 0, track),
				sourceOut: 2,
			})
		);
		const project = applyLayout(
			base,
			base.segments.map((segment) => segment.id),
			layout,
			{ assets, fit }
		);
		const png = join(directory, `${name}.png`);
		await runMedia(
			[
				...buildRender(
					project,
					assets,
					(id) => paths.get(id) ?? "",
					undefined,
					[],
					1
				),
				png,
			],
			{ cwd: directory }
		);
		const raw = join(directory, `${name}.rgb`);
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
			const offset = (Math.round(y) * WIDTH + Math.round(x)) * 3;
			return [
				pixels[offset] ?? 0,
				pixels[offset + 1] ?? 0,
				pixels[offset + 2] ?? 0,
			];
		};
	}

	function expectPixel(name: string, actual: Rgb, expected: Rgb) {
		const off = actual.some(
			(value, index) => Math.abs(value - (expected[index] ?? 0)) > TOLERANCE
		);
		ensure(
			!off,
			`${name}: got rgb(${actual.join(",")}), expected rgb(${expected.join(",")})`
		);
	}

	const edgeRows = [3, HEIGHT / 2, HEIGHT - 4];
	const columnCentres = [WIDTH / 6, WIDTH / 2, (5 * WIDTH) / 6];

	const filled = await renderLayout("three-up-fill", "three-up", 3, "fill");
	for (const [column, x] of columnCentres.entries()) {
		for (const y of edgeRows) {
			expectPixel(
				`three-up fill column ${column + 1} y=${y}`,
				filled(x, y),
				COLORS[column]!
			);
		}
	}
	results.push("three-up with fill has no letterboxing");

	const fitted = await renderLayout("three-up-fit", "three-up", 3, "fit");
	for (const [column, x] of columnCentres.entries()) {
		expectPixel(`three-up fit column ${column + 1} top`, fitted(x, 3), BLACK);
		expectPixel(
			`three-up fit column ${column + 1} centre`,
			fitted(x, HEIGHT / 2),
			COLORS[column]!
		);
	}
	results.push("three-up with fit letterboxes each column (control)");

	const sidebar = await renderLayout(
		"main-sidebar-fill",
		"main-sidebar",
		2,
		"fill"
	);
	for (const y of edgeRows) {
		expectPixel(`main y=${y}`, sidebar(WIDTH * 0.35, y), COLORS[0]!);
		expectPixel(`sidebar y=${y}`, sidebar(WIDTH * 0.85, y), COLORS[1]!);
	}
	expectPixel("main right edge", sidebar(WIDTH * 0.68, HEIGHT / 2), COLORS[0]!);
	expectPixel(
		"sidebar left edge",
		sidebar(WIDTH * 0.72, HEIGHT / 2),
		COLORS[1]!
	);
	results.push("main-sidebar with fill splits 70/30");

	const pip = await renderLayout("pip-top-left", "pip-top-left", 2, "fill");
	// Inset spans 4%..29% of each axis.
	expectPixel("inset centre", pip(WIDTH * 0.165, HEIGHT * 0.165), COLORS[1]!);
	expectPixel("inset margin", pip(WIDTH * 0.02, HEIGHT * 0.02), COLORS[0]!);
	expectPixel("past the inset", pip(WIDTH * 0.32, HEIGHT * 0.32), COLORS[0]!);
	expectPixel("main elsewhere", pip(WIDTH * 0.8, HEIGHT * 0.8), COLORS[0]!);
	results.push("pip-top-left places a 25% inset with a 4% margin");

	const stack = await renderLayout(
		"three-stack-fill",
		"three-stack",
		3,
		"fill"
	);
	for (const [row, y] of [HEIGHT / 6, HEIGHT / 2, (5 * HEIGHT) / 6].entries()) {
		for (const x of [3, WIDTH / 2, WIDTH - 4]) {
			expectPixel(
				`three-stack row ${row + 1} x=${x}`,
				stack(x, y),
				COLORS[row]!
			);
		}
	}
	results.push("three-stack with fill covers three rows");

	for (const result of results) {
		console.log(`ok  ${result}`);
	}
	console.log(`verify-layouts: ${results.length} checks passed`);
} finally {
	await rm(directory, { force: true, recursive: true });
}
