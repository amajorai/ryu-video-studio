/**
 * Real-FFmpeg proof for color scopes and the timeline overview.
 *
 * 1. Scopes: a timeline frame whose left half is black and right half white
 *    must put the parade's left columns in the darkest bin and its right
 *    columns in the brightest bin, split the luma histogram between code 0
 *    and 255, and keep every vectorscope count in the neutral centre cell.
 * 2. Vectorscope: a red clip must land in the red cell BT.709 predicts.
 * 3. Overview: a red-then-green timeline tiled 2x1 must show a red left tile
 *    and a green right tile at the reported sprite size.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SCOPE_PARADE_BINS,
	SCOPE_VECTOR_SIZE,
	vectorscopeCell,
} from "../../shared/color-scopes.ts";
import { type Asset, newSegment, type Project } from "../../shared/project.ts";
import { inspectTimelineScopes } from "./color-scopes.ts";
import { probe, runMedia } from "./media.ts";
import { renderOverview } from "./overview.ts";
import { StudioStore } from "./store.ts";

async function fixture(
	store: StudioStore,
	name: string,
	filter: string
): Promise<Asset> {
	const file = join(store.directory, `${crypto.randomUUID()}.mp4`);
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		filter,
		"-pix_fmt",
		"yuv444p",
		"-c:v",
		"libx264",
		"-qp",
		"0",
		file,
	]);
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

function timeline(store: StudioStore, title: string, clips: Asset[]): Project {
	let start = 0;
	const segments = clips.map((asset) => {
		const segment = { ...newSegment(asset, start), sourceOut: 1 };
		start += 1;
		return segment;
	});
	return store.save({
		...store.create(title),
		fps: 30,
		height: 180,
		segments,
		width: 320,
	});
}

const peakBin = (values: readonly number[]) =>
	values.reduce(
		(best, value, index) => (value > (values[best] ?? 0) ? index : best),
		0
	);

async function decodeRgb(store: StudioStore, png: Uint8Array) {
	const input = join(store.directory, `${crypto.randomUUID()}.png`);
	const output = join(store.directory, `${crypto.randomUUID()}.rgb`);
	await Bun.write(input, png);
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-i",
		input,
		"-f",
		"rawvideo",
		"-pix_fmt",
		"rgb24",
		output,
	]);
	return new Uint8Array(await Bun.file(output).arrayBuffer());
}

async function test(_name: string, run: () => Promise<void>) {
	await run();
}

await test("color scopes and overview read real frames", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-verify-scopes-"));
	const store = new StudioStore(directory);
	try {
		const split = await fixture(
			store,
			"Black and white split",
			"color=c=black:s=320x180:d=1,drawbox=x=160:y=0:w=160:h=180:color=white:t=fill"
		);
		const splitScopes = await inspectTimelineScopes(
			store,
			timeline(store, "Split", [split]),
			0.5,
			8
		);
		const { histogram, parade, pixels, vectorscope } = splitScopes.waveforms;
		for (const [index, column] of parade.r.entries()) {
			const expected = index < parade.columns / 2 ? 0 : SCOPE_PARADE_BINS - 1;
			assert.equal(peakBin(column), expected, `parade column ${index}`);
		}
		const dark = histogram.slice(0, 8).reduce((a, b) => a + b, 0);
		const bright = histogram.slice(248).reduce((a, b) => a + b, 0);
		assert.ok(dark / pixels > 0.45, `dark share ${dark / pixels}`);
		assert.ok(bright / pixels > 0.45, `bright share ${bright / pixels}`);
		const centre = SCOPE_VECTOR_SIZE / 2;
		let neutral = 0;
		for (let row = centre - 1; row <= centre; row++) {
			for (let column = centre - 1; column <= centre; column++) {
				neutral += vectorscope.cells[row]?.[column] ?? 0;
			}
		}
		assert.ok(neutral / pixels > 0.98, `neutral share ${neutral / pixels}`);
		console.info(
			`scopes: parade split ok, histogram dark ${dark} bright ${bright} of ${pixels}`
		);

		const red = await fixture(store, "Red", "color=c=red:s=320x180:d=1");
		const green = await fixture(store, "Green", "color=c=lime:s=320x180:d=1");
		const redScopes = await inspectTimelineScopes(
			store,
			timeline(store, "Red", [red]),
			0.5
		);
		const expectedRed = vectorscopeCell(255, 0, 0);
		let redHits = 0;
		for (let row = expectedRed.row; row <= expectedRed.row + 1; row++) {
			for (
				let column = expectedRed.column - 1;
				column <= expectedRed.column + 1;
				column++
			) {
				redHits += redScopes.waveforms.vectorscope.cells[row]?.[column] ?? 0;
			}
		}
		assert.ok(
			redHits / redScopes.waveforms.pixels > 0.98,
			`red vectorscope share ${redHits / redScopes.waveforms.pixels}`
		);
		console.info(
			`vectorscope: red lands at row ${expectedRed.row} column ${expectedRed.column}`
		);

		const overview = await renderOverview(
			store,
			timeline(store, "Overview", [red, green]),
			{ columns: 2, count: 2, height: 36, start: 0 }
		);
		assert.deepEqual(
			[overview.width, overview.height, overview.rows],
			[128, 36, 1]
		);
		const sprite = await decodeRgb(store, Buffer.from(overview.data, "base64"));
		assert.equal(sprite.byteLength, overview.width * overview.height * 3);
		const pixel = (x: number, y: number) => {
			const offset = (y * overview.width + x) * 3;
			return [...sprite.subarray(offset, offset + 3)];
		};
		const [leftR = 0, leftG = 0] = pixel(32, 18);
		const [rightR = 0, rightG = 0] = pixel(96, 18);
		assert.ok(leftR > 200 && leftG < 40, `left tile ${pixel(32, 18)}`);
		assert.ok(rightG > 200 && rightR < 40, `right tile ${pixel(96, 18)}`);
		console.info(
			`overview: ${overview.width}x${overview.height} at ${overview.times.join(", ")}s, red then green`
		);
		console.info("verify-scopes: ok");
	} finally {
		store.close();
		await rm(directory, { force: true, recursive: true });
	}
});
