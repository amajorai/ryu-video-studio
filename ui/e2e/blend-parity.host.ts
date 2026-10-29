/**
 * Test host for the blend compositor parity spec (`blend-parity.spec.ts`).
 *
 * It runs the real Video Studio server in process on a temporary store,
 * builds gradient image assets with FFmpeg, and serves:
 *
 * - `/` and `/page.js`: a page that mounts the preview's
 *   `PreviewBlendCompositor` (bundled from `blend-parity.page.tsx`);
 * - `/scene/<mode>`: the stored project for a blend mode, its assets and
 *   the frame time;
 * - `/scene/stage`: an animated scene (fade, entry motion, keyframed crop,
 *   fill, a grade pass, a keyframed mask) that the page plays through the
 *   real `PreviewStage`;
 * - `/media/<asset id>`: the stored media files;
 * - `/reference/<mode>` and `/reference/stage`: the PNG the server's
 *   `inspect-frame` export renders for that project and time (FFmpeg,
 *   `buildRender`).
 *
 * Run through `bun run test:e2e:blend-parity`.
 */
import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { type BlendMode, isBlendMode } from "../../shared/blend.ts";
import {
	type Asset,
	newSegment,
	type Project,
	type Segment,
	segmentSchema,
} from "../../shared/project.ts";
import { probe, runMedia } from "../../sidecar/src/media.ts";
import { createStudioServer } from "../../sidecar/src/server.ts";
import { StudioStore } from "../../sidecar/src/store.ts";

const WIDTH = 320;
const HEIGHT = 180;
/** Timeline second every scene is compared at. */
const FRAME_TIME = 1;
const PORT = Number(Bun.env.RYU_BLEND_PARITY_PORT ?? 5198);

const directory = await mkdtemp(path.join(tmpdir(), "ryu-blend-parity-"));
const store = new StudioStore(directory);
const token = crypto.randomUUID();
const studio = createStudioServer({ port: 0, store, token });
const api = `http://127.0.0.1:${studio.server.port}/api/video-studio`;

/** A still asset drawn by an FFmpeg `geq` expression (smooth, so 4:2:0 chroma stays close). */
async function gradientAsset(
	name: string,
	size: { height: number; width: number },
	expression: string
): Promise<Asset> {
	const file = path.join(directory, `${name}.png`);
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=c=black:s=${size.width}x${size.height},format=rgba,geq=${expression}`,
		"-frames:v",
		"1",
		file,
	]);
	const id = crypto.randomUUID();
	await Bun.write(store.mediaPath(id), Bun.file(file));
	const asset: Asset = {
		...(await probe(file)),
		createdAt: new Date().toISOString(),
		id,
		name: `${name}.png`,
	};
	store.putAsset(asset);
	return asset;
}

const base = await gradientAsset(
	"base",
	{ height: HEIGHT, width: WIDTH },
	"r='255*X/W':g='255*Y/H':b='150+60*sin(X/40)':a=255"
);
const layer = await gradientAsset(
	"layer",
	{ height: 240, width: 240 },
	"r='255*(1-Y/H)':g='128+110*sin(X/23)':b='255*X/W':a=255"
);
const translucent = await gradientAsset(
	"translucent",
	{ height: 120, width: 200 },
	"r='230':g='200*Y/H':b='60+180*X/W':a='255*(0.35+0.65*X/W)'"
);
const assets = [base, layer, translucent];

function clip(asset: Asset, fields: Partial<Segment>): Segment {
	return segmentSchema.parse({
		...newSegment(asset),
		sourceOut: 4,
		...fields,
	});
}

/**
 * The parity scene: a full-frame base, a rotated, cropped, partly opaque
 * layer and a flipped, stretched, masked layer with a gradient alpha, both
 * in `mode`.
 */
function sceneProject(mode: BlendMode): Project {
	const blend = mode === "normal" ? {} : { blendMode: mode };
	return store.save({
		...store.create(`Blend parity ${mode}`),
		height: HEIGHT,
		segments: [
			clip(base, { track: 0 }),
			clip(layer, {
				...blend,
				crop: { bottom: 0, left: 0.1, right: 0, top: 0.05 },
				opacity: 0.85,
				rotation: 15,
				scale: 0.7,
				track: 1,
				x: 0.25,
				y: -0.1,
			}),
			clip(translucent, {
				...blend,
				fit: "stretch",
				flipH: true,
				masks: [
					{
						feather: 0,
						height: 0.9,
						id: crypto.randomUUID(),
						invert: false,
						opacity: 1,
						rotation: 0,
						shape: "ellipse",
						width: 1.2,
						x: 0.1,
						y: 0,
					},
				],
				scale: 0.6,
				scaleX: 0.8,
				track: 2,
				x: -0.3,
				y: 0.3,
			}),
		],
		width: WIDTH,
	});
}

/**
 * The playback scene: every stage the compositor animates, at a time where
 * each is mid-way. The multiply layer fades in, slides in, crops a
 * keyframed left edge, fills its box and runs a levels grade pass; the
 * screen layer's elliptical mask moves with keyframes.
 */
function stageScene(): Project {
	const maskId = crypto.randomUUID();
	const keyframe = (property: string, time: number, value: number) => ({
		id: crypto.randomUUID(),
		property,
		time,
		value,
	});
	return store.save({
		...store.create("Blend parity stage"),
		height: HEIGHT,
		segments: [
			clip(base, { track: 0 }),
			clip(layer, {
				blendMode: "multiply",
				colorGrade: {
					exposure: 0,
					temperature: 0,
					tint: 0,
					vibrance: 0,
					whites: 0.3,
				},
				entryDuration: 1.2,
				entryTransition: "slide-left",
				fadeIn: 1.5,
				fit: "fill",
				keyframes: [keyframe("cropLeft", 0, 0), keyframe("cropLeft", 2, 0.3)],
				scale: 0.7,
				start: 0.2,
				track: 1,
				x: 0.2,
			}),
			clip(translucent, {
				blendMode: "screen",
				keyframes: [
					{ ...keyframe("maskX", 0, -0.3), target: maskId },
					{ ...keyframe("maskX", 2, 0.3), target: maskId },
				],
				masks: [
					{
						feather: 0,
						height: 0.8,
						id: maskId,
						invert: false,
						opacity: 1,
						rotation: 0,
						shape: "ellipse",
						width: 0.8,
						x: 0,
						y: 0,
					},
				],
				scale: 0.6,
				track: 2,
				x: -0.3,
				y: 0.25,
			}),
		],
		width: WIDTH,
	});
}

let stage: Project | null = null;
const stageOf = (): Project => {
	stage ??= stageScene();
	return stage;
};

const projects = new Map<BlendMode, Project>();
const projectOf = (mode: BlendMode): Project => {
	let project = projects.get(mode);
	if (!project) {
		project = sceneProject(mode);
		projects.set(mode, project);
	}
	return project;
};

const frameSchema = z.object({ data: z.string() });

async function reference(project: Project): Promise<Response> {
	const response = await fetch(
		`${api}/projects/${project.id}/inspect-frame?time=${FRAME_TIME}`,
		{ headers: { authorization: `Bearer ${token}` } }
	);
	if (!response.ok) {
		return new Response(await response.text(), { status: 502 });
	}
	const { data } = frameSchema.parse(await response.json());
	return new Response(Buffer.from(data, "base64"), {
		headers: { "content-type": "image/png" },
	});
}

const build = await Bun.build({
	define: { "process.env.NODE_ENV": JSON.stringify("production") },
	entrypoints: [path.join(import.meta.dirname, "blend-parity.page.tsx")],
	minify: false,
	target: "browser",
});
if (!(build.success && build.outputs[0])) {
	throw new Error(
		`The parity page did not build: ${build.logs.map(String).join("\n")}`
	);
}
const pageScript = await build.outputs[0].text();
const pageHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Blend parity</title></head><body style="margin:0;background:#000"><div id="root"></div><script type="module" src="/page.js"></script></body></html>`;

const modeOf = (value: string | undefined): BlendMode | null =>
	value && isBlendMode(value) ? value : null;

const host = Bun.serve({
	hostname: "127.0.0.1",
	idleTimeout: 120,
	port: PORT,
	async fetch(request) {
		const url = new URL(request.url);
		const [, route, key] = url.pathname.split("/");
		if (url.pathname === "/__ready") {
			return new Response("ok");
		}
		if (url.pathname === "/") {
			return new Response(pageHtml, {
				headers: { "content-type": "text/html" },
			});
		}
		if (url.pathname === "/page.js") {
			return new Response(pageScript, {
				headers: { "content-type": "text/javascript" },
			});
		}
		if (route === "media" && key && assets.some((item) => item.id === key)) {
			return new Response(Bun.file(store.mediaPath(key)), {
				headers: { "content-type": "image/png" },
			});
		}
		if (key === "stage" && route === "scene") {
			return Response.json({ assets, project: stageOf(), time: FRAME_TIME });
		}
		if (key === "stage" && route === "reference") {
			return await reference(stageOf());
		}
		const mode = modeOf(key);
		if (route === "scene" && mode) {
			return Response.json({
				assets,
				project: projectOf(mode),
				time: FRAME_TIME,
			});
		}
		if (route === "reference" && mode) {
			return await reference(projectOf(mode));
		}
		return new Response("Not found", { status: 404 });
	},
});

let stopping = false;
const stop = async () => {
	if (stopping) {
		return;
	}
	stopping = true;
	host.stop();
	studio.server.stop();
	await rm(directory, { force: true, recursive: true });
	process.exit(0);
};
// Playwright may end the host without a signal handler running to completion.
process.once("exit", () => rmSync(directory, { force: true, recursive: true }));
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
