import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Asset } from "../../shared/project.ts";
import { aiMatteAsset } from "./ai-matte.ts";
import { alphaPreviewArgs, alphaPreviewBudget } from "./alpha-preview.ts";
import { runMedia } from "./media.ts";
import { StudioStore } from "./store.ts";

const WIDTH = 64;
const HEIGHT = 48;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup();
	}
});

async function testStore() {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-alpha-preview-"))
	);
	cleanups.push(async () => {
		store.close();
		await rm(store.directory, { force: true, recursive: true });
	});
	return store;
}

let nextId = 1;
async function addVideo(
	store: StudioStore,
	name: string,
	filter: string,
	duration: number
): Promise<Asset> {
	const asset: Asset = {
		createdAt: "2026-01-01T00:00:00.000Z",
		duration,
		frameRate: 25,
		hasAudio: false,
		height: HEIGHT,
		id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
		kind: "video",
		name,
		width: WIDTH,
	};
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		filter,
		"-c:v",
		"libx264",
		"-qp",
		"0",
		"-pix_fmt",
		"yuv444p",
		"-f",
		"mp4",
		store.mediaPath(asset.id),
	]);
	store.putAsset(asset);
	return asset;
}

/** Alpha at (x, y) of the first frame, decoded with libvpx-vp9 as Chromium does. */
async function vp9Alpha(
	store: StudioStore,
	path: string,
	x: number,
	y: number
): Promise<number> {
	const output = join(store.directory, `${crypto.randomUUID()}.gray`);
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-c:v",
		"libvpx-vp9",
		"-i",
		path,
		"-vf",
		`alphaextract,crop=1:1:${x}:${y},format=gray`,
		"-frames:v",
		"1",
		"-f",
		"rawvideo",
		output,
	]);
	return (await readFile(output))[0] ?? -1;
}

describe("alpha preview copies", () => {
	test("arguments copy the first video stream to VP9 with alpha", () => {
		const args = alphaPreviewArgs("in.mov", "out.webm");
		const flagValue = (flag: string) => args[args.indexOf(flag) + 1];
		expect(flagValue("-c:v")).toBe("libvpx-vp9");
		expect(flagValue("-pix_fmt")).toBe("yuva420p");
		expect(flagValue("-map")).toBe("0:v:0");
		expect(args).toContain("-an");
		expect(args.at(-2)).toBe("webm");
		expect(args.at(-1)).toBe("out.webm");
		expect(
			alphaPreviewBudget({ duration: 2, frameRate: 25, height: 10, width: 10 })
		).toBe(50 * 50 + 16 * 1024 * 1024);
	});

	test("a matted clip gets a VP9 preview proxy that keeps its alpha", async () => {
		const store = await testStore();
		const clip = await addVideo(
			store,
			"Blue clip.mp4",
			`color=c=0x2040ff:s=${WIDTH}x${HEIGHT}:r=25:d=1`,
			1
		);
		// Left half white (subject), right half black (background).
		const matte = await addVideo(
			store,
			"Matte.mp4",
			`color=c=black:s=${WIDTH}x${HEIGHT}:r=25:d=1,geq=lum='if(lt(X,32),235,16)':cb=128:cr=128`,
			1
		);
		const matted = await aiMatteAsset(store, clip, { matteAssetId: matte.id });
		const previews = store
			.assets()
			.filter(
				(asset) =>
					asset.derivation === "proxy" && asset.derivedFromAssetId === matted.id
			);
		expect(previews).toHaveLength(1);
		const preview = previews[0];
		if (!preview) {
			throw new Error("missing preview");
		}
		expect(preview).toMatchObject({
			height: HEIGHT,
			kind: "video",
			width: WIDTH,
		});
		const path = store.mediaPath(preview.id);
		expect(await vp9Alpha(store, path, 8, 24)).toBeGreaterThan(230);
		expect(await vp9Alpha(store, path, 56, 24)).toBeLessThan(25);
	}, 60_000);

	test("without a VP9 encoder the matte is kept with no preview copy", async () => {
		const store = await testStore();
		const clip = await addVideo(
			store,
			"Clip.mp4",
			`color=c=red:s=${WIDTH}x${HEIGHT}:r=25:d=1`,
			1
		);
		const matte = await addVideo(
			store,
			"Matte.mp4",
			`color=c=white:s=${WIDTH}x${HEIGHT}:r=25:d=1`,
			1
		);
		const matted = await aiMatteAsset(
			store,
			clip,
			{ matteAssetId: matte.id },
			{ encoders: { prores_ks: true } }
		);
		expect(matted.derivation).toBe("ai-matte");
		expect(
			store.assets().some((asset) => asset.derivedFromAssetId === matted.id)
		).toBe(false);
	}, 60_000);
});
