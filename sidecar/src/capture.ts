import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	type Asset,
	activeCaptions,
	assetSchema,
	type Project,
	projectDuration,
	validateProject,
} from "../../shared/project.ts";
import { runMedia, thumbnail } from "./media.ts";
import { assCaptions, buildRender } from "./render.ts";
import type { StudioStore } from "./store.ts";

/** Render a saved composite frame without creating a library asset. */
export async function renderTimelineFrame(
	store: StudioStore,
	project: Project,
	time: number
): Promise<Uint8Array> {
	const assets = store.assets();
	validateProject(project, assets);
	const duration = projectDuration(project);
	if (!(Number.isFinite(time) && time >= 0 && time <= duration)) {
		throw new Error("Choose a frame inside the saved timeline.");
	}
	const id = crypto.randomUUID();
	const work = join(store.directory, "renders", `capture-${id}`);
	const rendered = join(work, "timeline.mp4");
	const frame = join(work, "frame.png");
	try {
		await mkdir(work, { recursive: true, mode: 0o700 });
		const captions = activeCaptions(project).length || project.titles.length;
		const { refreshSequenceAssets } = await import("./sequence.ts");
		await refreshSequenceAssets(store, project);
		if (captions) {
			await Bun.write(join(work, "captions.ass"), assCaptions(project));
		}
		const args = buildRender(
			{ ...project, exportCodec: "h264" },
			assets,
			(assetId) => store.mediaPath(assetId),
			captions ? "captions.ass" : undefined
		);
		await runMedia([...args, rendered], { cwd: work });
		await runMedia(
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostdin",
				"-y",
				"-ss",
				String(time),
				"-i",
				rendered,
				"-frames:v",
				"1",
				"-vf",
				"format=rgba",
				frame,
			],
			{ cwd: work }
		);
		if (!(await Bun.file(frame).size)) {
			throw new Error("The composited frame was empty.");
		}
		return new Uint8Array(await Bun.file(frame).arrayBuffer());
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

export async function captureTimelineFrame(
	store: StudioStore,
	project: Project,
	time: number,
	name: string
): Promise<Asset> {
	const id = crypto.randomUUID();
	const frame = await renderTimelineFrame(store, project, time);
	const asset = assetSchema.parse({
		createdAt: new Date().toISOString(),
		id,
		kind: "image",
		name: name.trim() || `Frame at ${time.toFixed(2)}s`,
		duration: 5,
		width: project.width,
		height: project.height,
		hasAudio: false,
	});
	await Bun.write(store.mediaPath(id), frame);
	store.putAsset(asset);
	await thumbnail(store.mediaPath(id), join(store.directory, "media"), id);
	return asset;
}
