/**
 * Real-FFmpeg proof for proxy media (W2-M1).
 *
 * 1. Importing a 4K testsrc through `importMediaAsset` and then the import
 *    hook (`autoProxyOnImport`) creates a hidden `derivation: "proxy"` asset
 *    whose video stream ffprobe reports as H.264, 960 px wide, with
 *    keyframes at most 12 frames apart.
 * 2. A 1280x720 low-bitrate import gets no proxy.
 * 3. A render of a project using the 4K clip names only the original media
 *    even though the proxy is in the library.
 *
 * Run: `bun src/verify-proxy.ts`
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { newProject, newSegment } from "../../shared/project.ts";
import { importMediaAsset } from "./import-media.ts";
import { runMedia } from "./media.ts";
import { autoProxyOnImport, libraryAssets, PROXY_GOP } from "./proxy.ts";
import { buildRender } from "./render.ts";
import { StudioStore } from "./store.ts";

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const framesSchema = z.object({
	frames: z.array(z.object({ key_frame: z.number() })),
	streams: z
		.array(
			z.object({
				codec_name: z.string(),
				width: z.number(),
				height: z.number(),
			})
		)
		.min(1),
});

async function inspect(path: string) {
	return framesSchema.parse(
		JSON.parse(
			await runMedia(
				[
					"-v",
					"error",
					"-select_streams",
					"v:0",
					"-show_entries",
					"stream=codec_name,width,height:frame=key_frame",
					"-of",
					"json",
					path,
				],
				{ probe: true }
			)
		)
	);
}

async function testsrc(path: string, size: string, seconds: number) {
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		`testsrc2=s=${size}:r=30:d=${seconds}`,
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-pix_fmt",
		"yuv420p",
		path,
	]);
}

async function main() {
	const work = await mkdtemp(join(tmpdir(), "ryu-verify-proxy-"));
	const store = new StudioStore(join(work, "store"));
	try {
		const imports = join(work, "imports");
		await Bun.write(join(imports, ".keep"), "");
		await testsrc(join(imports, "uhd.mp4"), "3840x2160", 2);
		await testsrc(join(imports, "hd.mp4"), "1280x720", 2);

		const uhd = await importMediaAsset(
			store,
			{ source: { path: join(imports, "uhd.mp4") } },
			{ localImportRoot: imports }
		);
		ensure(uhd.width === 3840, `4K import probed ${uhd.width} px wide.`);
		const proxy = await autoProxyOnImport(store, uhd);
		ensure(proxy, "The 4K import did not get a proxy.");
		ensure(proxy.derivation === "proxy", "The proxy is not marked as one.");
		ensure(proxy.derivedFromAssetId === uhd.id, "The proxy lost its source.");
		ensure(proxy.width === 960, `The proxy is ${proxy.width} px wide.`);
		const probed = await inspect(store.mediaPath(proxy.id));
		const stream = probed.streams[0];
		ensure(stream?.codec_name === "h264", "The proxy is not H.264.");
		ensure(stream.width === 960 && stream.height === 540, "Bad proxy size.");
		const keyframes = probed.frames
			.map((frame, index) => (frame.key_frame === 1 ? index : -1))
			.filter((index) => index >= 0);
		const gaps = keyframes.slice(1).map((index, at) => index - keyframes[at]!);
		ensure(
			keyframes[0] === 0 && gaps.every((gap) => gap <= PROXY_GOP),
			`Proxy keyframes are too sparse: ${keyframes.join(",")}`
		);
		console.log(
			`ok proxy: ${stream.width}x${stream.height} h264, keyframes every ${Math.max(...gaps)} frames`
		);

		const hd = await importMediaAsset(
			store,
			{ source: { path: join(imports, "hd.mp4") } },
			{ localImportRoot: imports }
		);
		ensure(
			(await autoProxyOnImport(store, hd)) === null,
			"A light 720p import got a proxy."
		);
		ensure(
			libraryAssets(store.assets()).every(
				(asset) => asset.derivation !== "proxy"
			),
			"The library listing shows a proxy."
		);
		console.log("ok light media: no proxy; library hides proxies");

		const project = newProject("Proxy render");
		const withClip = {
			...project,
			segments: [newSegment(uhd, 0)],
		};
		const requested: string[] = [];
		buildRender(withClip, store.assets(), (id) => {
			requested.push(id);
			return store.mediaPath(id);
		});
		ensure(
			requested.length > 0 && requested.every((id) => id !== proxy.id),
			"The render read the proxy."
		);
		console.log("ok render: originals only");
	} finally {
		store.close();
		await rm(work, { recursive: true, force: true });
	}
}

await main();
