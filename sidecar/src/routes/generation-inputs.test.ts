import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generationInputSchema } from "../../../shared/generation-inputs.ts";
import { type Asset, newSegment } from "../../../shared/project.ts";
import { probe, runMedia } from "../media.ts";
import { createStudioServer } from "../server.ts";
import { StudioStore } from "../store.ts";
import { studioRoutes } from "./index.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-inputs-"));
	const store = new StudioStore(directory);
	const token = crypto.randomUUID();
	const app = createStudioServer({
		port: 0,
		routes: studioRoutes,
		store,
		token,
	});
	cleanup.push(async () => {
		app.stop();
		store.close();
		await rm(directory, { force: true, recursive: true });
	});
	const call = (path: string, method = "GET", body?: unknown) =>
		fetch(`http://127.0.0.1:${app.server.port}/api/video-studio${path}`, {
			body: body === undefined ? undefined : JSON.stringify(body),
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			method,
		});
	const read = async (id: string) => {
		const parts: Buffer[] = [];
		let offset = 0;
		for (;;) {
			const chunk = (await (
				await call(`/generation-inputs/${id}/data?offset=${offset}`)
			).json()) as { data: string; done: boolean };
			const bytes = Buffer.from(chunk.data, "base64");
			parts.push(bytes);
			offset += bytes.length;
			if (chunk.done) {
				return Buffer.concat(parts);
			}
		}
	};
	return { call, directory, read, store };
}

/** A 1920x1080 clip with a tone, `seconds` long. */
async function clip(store: StudioStore, seconds: number): Promise<Asset> {
	const file = join(store.directory, `fixture-${crypto.randomUUID()}.mp4`);
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		`testsrc2=s=1600x900:r=25:d=${seconds}`,
		"-f",
		"lavfi",
		"-i",
		`sine=frequency=440:d=${seconds}`,
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-shortest",
		file,
	]);
	const asset: Asset = {
		...(await probe(file)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name: "Speaker",
	};
	await Bun.write(store.mediaPath(asset.id), Bun.file(file));
	store.putAsset(asset);
	return asset;
}

test("clip inputs are capped at 10 s and 720 lines, read in chunks, then deleted", async () => {
	const { call, directory, read, store } = await setup();
	const source = await clip(store, 12);
	const response = await call(`/assets/${source.id}/generation-input`, "POST", {
		end: 12,
		kind: "clip",
		start: 1,
	});
	const body = await response.json();
	expect({ body, status: response.status }).toMatchObject({ status: 201 });
	const input = generationInputSchema.parse(body);
	expect(input).toMatchObject({
		end: 11,
		height: 720,
		mediaType: "video/mp4",
		start: 1,
		width: 1280,
	});
	const bytes = await read(input.id);
	expect(bytes.length).toBe(input.size);
	const file = join(directory, "extract.mp4");
	await Bun.write(file, bytes);
	const info = await probe(file);
	expect(info.width).toBe(1280);
	expect(info.height).toBe(720);
	expect(Math.abs(info.duration - 10)).toBeLessThan(0.15);
	expect(info.hasAudio).toBe(true);
	// The extract is gone after the last chunk.
	expect((await call(`/generation-inputs/${input.id}/data`)).status).toBe(400);
	expect(
		await readdir(join(store.directory, "media", ".generation-inputs"))
	).toEqual([]);
}, 60_000);

test("frame and audio inputs, and refusals with a reason", async () => {
	const { call, read, store } = await setup();
	const source = await clip(store, 2);
	const frame = generationInputSchema.parse(
		await (
			await call(`/assets/${source.id}/generation-input`, "POST", {
				frame: 10,
				kind: "frame",
			})
		).json()
	);
	expect(frame).toMatchObject({
		frame: 10,
		mediaType: "image/png",
		start: 0.4,
	});
	expect((await read(frame.id)).subarray(1, 4).toString()).toBe("PNG");
	const audio = generationInputSchema.parse(
		await (
			await call(`/assets/${source.id}/generation-input`, "POST", {
				end: 2,
				kind: "audio",
				start: 0.5,
			})
		).json()
	);
	expect(audio.mediaType).toBe("audio/mp4");
	const silent: Asset = { ...source, hasAudio: false, id: crypto.randomUUID() };
	store.putAsset(silent);
	const refused = await call(`/assets/${silent.id}/generation-input`, "POST", {
		end: 1,
		kind: "audio",
		start: 0,
	});
	expect(refused.status).toBe(400);
	expect(((await refused.json()) as { message: string }).message).toContain(
		"no audio"
	);
	const empty = await call(`/assets/${source.id}/generation-input`, "POST", {
		end: 1,
		kind: "clip",
		start: 1,
	});
	expect(empty.status).toBe(400);
}, 60_000);

test("photoreal inputs need consent, overlapping clips and 100% speed", async () => {
	const { call, read, store } = await setup();
	const picture = await clip(store, 4);
	const narration = await clip(store, 3);
	const pictureClip = newSegment(picture, 0, 0);
	const audioClip = {
		...newSegment(narration, 1, 1),
		sourceIn: 0.5,
		sourceOut: 3,
	};
	const project = store.save({
		...store.create("Photoreal"),
		segments: [pictureClip, audioClip],
	});
	const body = {
		audioClipId: audioClip.id,
		consent: "subjects-agreed",
		mode: "lipsync",
		pictureClipId: pictureClip.id,
		revision: project.revision,
	};
	const noConsent = await call(
		`/projects/${project.id}/avatars/photoreal-inputs`,
		"POST",
		{
			...body,
			consent: undefined,
		}
	);
	expect(noConsent.status).toBe(400);
	const response = await call(
		`/projects/${project.id}/avatars/photoreal-inputs`,
		"POST",
		body
	);
	expect(response.status).toBe(200);
	const result = (await response.json()) as {
		audio: { id: string; mediaType: string; start: number; end: number };
		picture: { id: string; mediaType: string; start: number; end: number };
		plan: { start: number; duration: number; track: number };
	};
	// Overlap is timeline 1-3.5 s: picture source 1-3.5, audio source 0.5-3.
	expect(result.plan).toMatchObject({ duration: 2.5, start: 1, track: 0 });
	expect(result.picture).toMatchObject({
		end: 3.5,
		mediaType: "video/mp4",
		start: 1,
	});
	expect(result.audio).toMatchObject({
		end: 3,
		mediaType: "audio/mp4",
		start: 0.5,
	});
	const pictureFile = join(store.directory, "picture.mp4");
	await Bun.write(pictureFile, await read(result.picture.id));
	expect((await probe(pictureFile)).hasAudio).toBe(false);

	const avatar = (await (
		await call(`/projects/${project.id}/avatars/photoreal-inputs`, "POST", {
			...body,
			mode: "avatar",
		})
	).json()) as { picture: { frame: number; mediaType: string } };
	expect(avatar.picture).toMatchObject({ frame: 25, mediaType: "image/png" });

	const fast = store.save({
		...project,
		segments: [{ ...pictureClip, speed: 2, sourceOut: 4 }, audioClip],
	});
	const refused = await call(
		`/projects/${project.id}/avatars/photoreal-inputs`,
		"POST",
		{
			...body,
			revision: fast.revision,
		}
	);
	expect(refused.status).toBe(400);
	expect(((await refused.json()) as { message: string }).message).toContain(
		"100% speed"
	);
}, 60_000);

test("generated audio is fitted to the timeline and keeps its provenance", async () => {
	const { call, store } = await setup();
	const file = join(store.directory, "music.wav");
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=220:d=6",
		file,
	]);
	const generated: Asset = {
		...(await probe(file)),
		createdAt: new Date().toISOString(),
		generation: {
			kind: "audio",
			model: "fal-ai/stable-audio",
			prompt: "warm music",
			provider: "fal",
			task: "music",
		},
		id: crypto.randomUUID(),
		name: "Music.wav",
	};
	await Bun.write(store.mediaPath(generated.id), Bun.file(file));
	store.putAsset(generated);
	const { generation: _generation, ...rest } = generated;
	const plain: Asset = { ...rest, id: crypto.randomUUID() };
	await Bun.write(store.mediaPath(plain.id), Bun.file(file));
	store.putAsset(plain);

	const refused = await call("/soundtrack-conform", "POST", {
		assetId: plain.id,
		duration: 2,
	});
	expect(refused.status).toBe(400);
	const fitted = (await (
		await call("/soundtrack-conform", "POST", {
			assetId: generated.id,
			duration: 2.5,
		})
	).json()) as Asset;
	expect(Math.abs(fitted.duration - 2.5)).toBeLessThan(0.05);
	expect(fitted.generation).toMatchObject({
		model: "fal-ai/stable-audio",
		provider: "fal",
	});
	expect(fitted.derivedFromAssetId).toBe(generated.id);
	const sfx = (await (
		await call("/sfx-conform", "POST", { assetId: generated.id, duration: 20 })
	).json()) as Asset;
	// Never longer than the generated audio.
	expect(Math.abs(sfx.duration - 6)).toBeLessThan(0.05);
	expect(sfx.folder ?? "").not.toContain("..");
}, 60_000);
