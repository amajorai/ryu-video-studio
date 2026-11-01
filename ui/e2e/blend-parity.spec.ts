import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	expect,
	test,
} from "../../../../apps/desktop/node_modules/@playwright/test/index.mjs";
import { blendModes } from "../../shared/blend.ts";

// The preview's whole-stack blend compositor must match the export. For each
// blend mode the page mounts `PreviewBlendCompositor` on a three-clip scene
// (rotation, crop, opacity, flip, stretch, a mask and a gradient alpha) and
// compares every pixel with the server's `inspect-frame` PNG of the same
// project and time. The render passes through 4:2:0 chroma and FFmpeg's
// bicubic/bilinear resamplers while the compositor samples the source once
// bilinearly, so a small error remains. Over the whole frame the mean stays
// under 3/255 and under 2% of values are more than 16/255 off (clip, crop
// and mask edges, whose partial pixels the resamplers place differently).
// Away from those edges 99% of values are within 12/255.
const MEAN_LIMIT = 3;
const FAR_SHARE_LIMIT = 0.02;
const INTERIOR_P99_LIMIT = 12;

test.beforeEach(async ({ page }) => {
	await page.goto("/");
	await page.waitForFunction(() => typeof window.blendParity === "function");
	expect(
		await page.evaluate(() => window.blendParityWebGl2()),
		"headless Chromium must provide WebGL2 for the parity check"
	).toBe(true);
});

for (const mode of blendModes) {
	test(`${mode}: the compositor matches the inspect-frame export`, async ({
		page,
	}, testInfo) => {
		const result = await page.evaluate(
			(name) => window.blendParity(name),
			mode
		);
		// The compositor frame and the amplified difference, for review.
		const directory = testInfo.outputPath();
		await mkdir(directory, { recursive: true });
		for (const [name, url] of Object.entries(result.images ?? {})) {
			await writeFile(
				path.join(directory, `${mode}-${name}.png`),
				Buffer.from(url.slice(url.indexOf(",") + 1), "base64")
			);
		}
		console.log(
			`${mode}: mean ${result.mean.toFixed(3)}, p99 ${result.p99}, max ${result.max}, >16 ${(result.farShare * 100).toFixed(3)}%; interior (${(result.interiorShare * 100).toFixed(1)}% of pixels) p99 ${result.interiorP99}, max ${result.interiorMax}`
		);
		expect(result.gaps).toEqual([]);
		expect(result.mean).toBeLessThan(MEAN_LIMIT);
		expect(result.farShare).toBeLessThan(FAR_SHARE_LIMIT);
		expect(result.interiorShare).toBeGreaterThan(0.9);
		expect(result.interiorP99).toBeLessThanOrEqual(INTERIOR_P99_LIMIT);
	});
}

// The production path: `PreviewStage` with its own `PreviewMediaLayer`
// elements, playing, with the playhead advancing every frame through a fade,
// an entry slide, a keyframed crop, a fill box, a levels grade pass and a
// keyframed mask. Every playback frame must draw (an animated mask draws
// with its previous raster while the next one decodes, never freezing the
// canvas), and the frame at the scene time must match the export.
test("PreviewStage playback: animated stages draw every frame and match the export", async ({
	page,
}, testInfo) => {
	const result = await page.evaluate(() => window.blendStageParity());
	const directory = testInfo.outputPath();
	await mkdir(directory, { recursive: true });
	for (const [name, url] of Object.entries(result.images ?? {})) {
		await writeFile(
			path.join(directory, `stage-${name}.png`),
			Buffer.from(url.slice(url.indexOf(",") + 1), "base64")
		);
	}
	console.log(
		`stage: frames ${result.advancing.join(",")}; mean ${result.mean.toFixed(3)}, p99 ${result.p99}, max ${result.max}, >16 ${(result.farShare * 100).toFixed(3)}%; interior (${(result.interiorShare * 100).toFixed(1)}% of pixels) p99 ${result.interiorP99}, max ${result.interiorMax}`
	);
	expect(result.gaps).toEqual([]);
	expect(result.advancing).toHaveLength(30);
	expect(
		result.advancing.filter((state) => state === "waiting"),
		"no playback frame may leave the canvas waiting"
	).toEqual([]);
	expect(result.advancingShown.every(Boolean)).toBe(true);
	// Below graphics (z-index 15), captions and titles.
	expect(result.zIndex).toBeLessThan(15);
	expect(result.mean).toBeLessThan(MEAN_LIMIT);
	expect(result.farShare).toBeLessThan(FAR_SHARE_LIMIT);
	expect(result.interiorShare).toBeGreaterThan(0.9);
	expect(result.interiorP99).toBeLessThanOrEqual(INTERIOR_P99_LIMIT);
});
