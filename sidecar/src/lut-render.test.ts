/**
 * LUT clips through the real render entry points (W2-V5): export, the
 * `inspect-frame` route and the agent color route's LUT validation.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { serializeCubeLut } from "../../shared/cube-lut.ts";
import { type Asset, newSegment } from "../../shared/project.ts";
import { lutStoreFor } from "./lut-store.ts";
import { runMedia } from "./media.ts";
import { RenderQueue } from "./render.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const task of cleanup.splice(0).reverse()) {
		await task();
	}
});

/** A size-2 LUT that inverts every channel. */
const invertCube = serializeCubeLut({
	domainMax: [1, 1, 1],
	domainMin: [0, 0, 0],
	size: 2,
	data: Float32Array.from(
		[0, 1, 2, 3, 4, 5, 6, 7].flatMap((index) => [
			1 - (index % 2),
			1 - (Math.floor(index / 2) % 2),
			1 - Math.floor(index / 4),
		])
	),
	title: "Invert",
});

async function lutProject() {
	const directory = await mkdtemp(
		join(tmpdir(), "ryu-video-studio-lut-render-")
	);
	const store = new StudioStore(directory);
	cleanup.push(async () => {
		store.close();
		await rm(directory, { force: true, recursive: true });
	});
	const source: Asset = {
		createdAt: new Date().toISOString(),
		duration: 1,
		hasAudio: false,
		height: 180,
		id: crypto.randomUUID(),
		kind: "video",
		name: "Red",
		width: 320,
	};
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		"color=red:size=320x180:duration=1:rate=30",
		"-pix_fmt",
		"yuv420p",
		"-f",
		"mp4",
		store.mediaPath(source.id),
	]);
	store.putAsset(source);
	const lut = await lutStoreFor(directory).add("Invert", invertCube);
	const segment = { ...newSegment(source), sourceOut: 1 };
	segment.colorGrade = {
		...segment.colorGrade,
		lut: { intensity: 1, lutId: lut.id },
	};
	const project = store.save({
		...store.create("LUT clip"),
		fps: 30,
		height: 180,
		segments: [segment],
		width: 320,
	});
	return { directory, lutId: lut.id, project, store };
}

/** The RGB of the centre pixel of an image or the first frame of a video. */
async function centrePixel(path: string, directory: string) {
	const raw = join(directory, `pixel-${crypto.randomUUID()}.rgb`);
	await runMedia([
		"-y",
		"-i",
		path,
		"-frames:v",
		"1",
		"-vf",
		"format=rgb24,crop=1:1:160:90",
		"-f",
		"rawvideo",
		"-pix_fmt",
		"rgb24",
		raw,
	]);
	return [...new Uint8Array(await Bun.file(raw).arrayBuffer())];
}

/** Which channels of a pixel read as the inverted (cyan) red card. */
function cyanChannels([red = 255, green = 0, blue = 0]: number[]) {
	return { blue: blue > 215, green: green > 215, red: red < 40 };
}
const cyan = { blue: true, green: true, red: true };

async function serve(store: StudioStore) {
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, store, token });
	cleanup.push(() => app.stop());
	return (path: string, init: RequestInit = {}) =>
		fetch(`http://127.0.0.1:${app.server.port}/api/video-studio${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				...init.headers,
			},
		});
}

test("inspect-frame applies a clip's LUT", async () => {
	const { directory, project, store } = await lutProject();
	const call = await serve(store);
	const response = await call(`/projects/${project.id}/inspect-frame?time=0.5`);
	expect(response.status).toBe(200);
	const { data } = z.object({ data: z.string() }).parse(await response.json());
	const png = join(directory, "inspected.png");
	await Bun.write(png, Buffer.from(data, "base64"));
	expect(cyanChannels(await centrePixel(png, directory))).toEqual(cyan);
	// `ungraded` renders the clip with a neutral grade (no LUT): red again.
	const neutral = await call(
		`/projects/${project.id}/inspect-frame?time=0.5&ungraded=${project.segments[0]?.id}`
	);
	expect(neutral.status).toBe(200);
	const plain = z.object({ data: z.string() }).parse(await neutral.json());
	const plainPng = join(directory, "ungraded.png");
	await Bun.write(plainPng, Buffer.from(plain.data, "base64"));
	const [red = 0, green = 255, blue = 255] = await centrePixel(
		plainPng,
		directory
	);
	expect(red).toBeGreaterThan(215);
	expect(Math.max(green, blue)).toBeLessThan(40);
	const invalid = await call(
		`/projects/${project.id}/inspect-frame?time=0.5&ungraded=nope`
	);
	expect(invalid.status).toBe(400);
}, 30_000);

test("export renders a clip's LUT", async () => {
	const { directory, project, store } = await lutProject();
	const job = new RenderQueue(store).start(project);
	let status = job.status;
	let error: string | undefined;
	for (let attempt = 0; attempt < 300; attempt++) {
		const current = store.jobs().find((candidate) => candidate.id === job.id);
		status = current?.status ?? status;
		error = current?.error;
		if (status === "completed" || status === "failed") {
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	expect({ error, status }).toEqual({ error: undefined, status: "completed" });
	const exported = await centrePixel(
		store.renderPath(job.id, project.exportCodec),
		directory
	);
	expect(cyanChannels(exported)).toEqual(cyan);
}, 30_000);

test("the color route refuses LUTs that are not in the library", async () => {
	const { lutId, project, store } = await lutProject();
	const call = await serve(store);
	const segmentId = project.segments[0]?.id;
	const missing = await call(`/projects/${project.id}/color`, {
		body: JSON.stringify({
			clipIds: [segmentId],
			patch: { lut: { intensity: 1, lutId: crypto.randomUUID() } },
			revision: project.revision,
		}),
		method: "POST",
	});
	expect(missing.status).toBe(400);
	expect(await missing.text()).toContain("is not in the library");
	const stored = await call(`/projects/${project.id}/color`, {
		body: JSON.stringify({
			clipIds: [segmentId],
			patch: { lut: { intensity: 0.5, lutId } },
			revision: project.revision,
		}),
		method: "POST",
	});
	expect(stored.status).toBe(200);
});
