import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { customFontIdsIn } from "../../shared/library-refs.ts";
import {
	type Asset,
	activeCaptions,
	assetSchema,
	type Project,
	projectDuration,
	segmentDuration,
	validateProject,
} from "../../shared/project.ts";
import { clipSourceOffset } from "../../shared/speed-curve.ts";
import { fontLibraryFor } from "./font-library.ts";
import { lutResolver } from "./lut-store.ts";
import { MAX_THUMBNAIL_BYTES, runMedia, thumbnail } from "./media.ts";
import { type MediaOperation, withMediaOperation } from "./media-operation.ts";
import { renderMeshPngAsync } from "./mesh-render-runner.ts";
import { assCaptions, buildRender } from "./render.ts";
import type { StudioStore } from "./store.ts";

interface FrameOptions {
	operation?: MediaOperation;
	signal?: AbortSignal;
}
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_WORK_BYTES = 10 * 1024 * 1024 * 1024;

/** Each source revision/time is sampled once; no nested timeline is encoded. */
class FrameTraversal {
	readonly assets: Asset[];
	private readonly projects = new Map<string, Project>();
	private readonly completed = new Map<string, string>();
	private readonly visiting = new Set<string>();
	private readonly visited = new Set<string>();
	private samples = 0;
	private bytes = 0;
	private remainingMeshPixels = 1_000_000_000;
	private remainingMeshBytes = 512 * 1024 * 1024;
	private readonly meshWork = { remainingPixels: 1_000_000_000 };
	constructor(
		private readonly store: StudioStore,
		private readonly directory: string,
		private readonly operation: MediaOperation
	) {
		this.assets = store.assets();
	}
	private project(id: string): Project {
		const project = this.projects.get(id) ?? this.store.project(id);
		this.projects.set(id, project);
		return project;
	}
	check(): void {
		this.operation.check();
		for (const id of this.visited) {
			if (this.store.project(id).revision !== this.project(id).revision) {
				throw new Error(
					"A source timeline changed during inspection. Retry its current revision."
				);
			}
		}
	}
	async render(project: Project, requestedTime: number): Promise<string> {
		this.operation.check();
		if (this.project(project.id).revision !== project.revision) {
			throw new Error(
				"A source timeline changed during inspection. Retry its current revision."
			);
		}
		validateProject(project, this.assets);
		const duration = projectDuration(project);
		if (
			!(
				duration > 0 &&
				Number.isFinite(requestedTime) &&
				requestedTime >= 0 &&
				requestedTime <= duration
			)
		) {
			throw new Error("Choose a frame inside the saved timeline.");
		}
		const time = Math.min(
			requestedTime,
			Math.max(0, duration - 1 / project.fps)
		);
		const key = `${project.id}:${project.revision}:${time}`;
		if (this.visiting.has(project.id)) {
			throw new Error(
				"A timeline cannot contain itself, directly or indirectly."
			);
		}
		const cached = this.completed.get(key);
		if (cached) {
			return cached;
		}
		this.visited.add(project.id);
		if (this.visited.size > 64 || ++this.samples > 512) {
			throw new Error(
				"Frame inspection exceeds its 64-source or 512-frame budget."
			);
		}
		this.visiting.add(project.id);
		const work = join(this.directory, crypto.randomUUID());
		try {
			await mkdir(work, { recursive: true, mode: 0o700 });
			const paths = new Map<string, string>();
			const assets = this.assets.map((asset) => ({ ...asset }));
			for (const segment of project.segments) {
				if (
					time < segment.start ||
					time > segment.start + segmentDuration(segment)
				) {
					continue;
				}
				const asset = assets.find(
					(candidate) => candidate.id === segment.assetId
				);
				if (!asset?.sequenceProjectId) {
					continue;
				}
				const child = this.project(asset.sequenceProjectId);
				const nestedTime =
					segment.sourceIn + clipSourceOffset(segment, time - segment.start);
				paths.set(segment.id, await this.render(child, nestedTime));
				// The sampled PNG retains the clip's existing timing and transformation data.
				asset.kind = "image";
				asset.hasAudio = false;
			}
			const captions = Boolean(
				activeCaptions(project).length || project.titles.length
			);
			const meshInputs: Array<{ path: string; start: number; end: number }> =
				[];
			for (const [index, mesh] of project.meshes.entries()) {
				if (time < mesh.start || time > mesh.end) {
					continue;
				}
				this.operation.check();
				this.remainingMeshPixels -= project.width * project.height;
				if (this.remainingMeshPixels < 0) {
					throw new Error("Frame mesh preprocessing exceeds its pixel budget.");
				}
				const png = await renderMeshPngAsync(
					project,
					mesh,
					project.width,
					project.height,
					time,
					this.operation.signal,
					this.meshWork
				);
				this.operation.check();
				this.remainingMeshBytes -= png.byteLength;
				if (
					png.byteLength > MAX_FRAME_BYTES ||
					this.remainingMeshBytes < 0 ||
					this.bytes + png.byteLength > MAX_WORK_BYTES
				) {
					throw new Error(
						"Frame mesh preprocessing exceeds its temporary storage budget."
					);
				}
				this.bytes += png.byteLength;
				const path = join(work, `mesh-${index}.png`);
				await Bun.write(path, png);
				meshInputs.push({ path, start: mesh.start, end: mesh.end });
			}
			if (captions) {
				await Bun.write(join(work, "captions.ass"), assCaptions(project));
			}
			const frame = join(work, "frame.png");
			const args = buildRender(
				project,
				assets,
				(id, clipId) => paths.get(clipId ?? "") ?? this.store.mediaPath(id),
				captions ? "captions.ass" : undefined,
				meshInputs,
				time,
				{
					fontsDirectory: await fontLibraryFor(
						this.store.directory
					).renderFontsDirectory(customFontIdsIn(project)),
					lutPath: lutResolver(this.store.directory),
				}
			);
			await runMedia([...args, frame], {
				cwd: work,
				signal: this.operation.signal,
				timeoutMs: this.operation.remainingMs(),
				outputPath: frame,
				maxOutputBytes: Math.min(MAX_FRAME_BYTES, MAX_WORK_BYTES - this.bytes),
			});
			this.check();
			const size = (await stat(frame)).size;
			if (
				!size ||
				size > MAX_FRAME_BYTES ||
				this.bytes + size > MAX_WORK_BYTES
			) {
				throw new Error("The composited frame exceeded its output budget.");
			}
			this.bytes += size;
			this.completed.set(key, frame);
			return frame;
		} finally {
			this.visiting.delete(project.id);
		}
	}
}

export async function renderTimelineFrame(
	store: StudioStore,
	project: Project,
	time: number,
	options: FrameOptions = {}
): Promise<Uint8Array> {
	return await withMediaOperation(60_000, options, async (operation) => {
		const frame = await renderFrameSnapshot(store, project, time, operation);
		frame.assertSnapshot();
		return frame.bytes;
	});
}

async function renderFrameSnapshot(
	store: StudioStore,
	project: Project,
	time: number,
	operation: MediaOperation
) {
	const work = join(
		store.directory,
		"renders",
		`capture-${crypto.randomUUID()}`
	);
	try {
		const traversal = new FrameTraversal(store, work, operation);
		const path = await traversal.render(project, time);
		const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
		traversal.check();
		return { bytes, assertSnapshot: () => traversal.check() };
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

export async function captureTimelineFrame(
	store: StudioStore,
	project: Project,
	time: number,
	name: string,
	options: FrameOptions = {}
): Promise<Asset> {
	return await withMediaOperation(60_000, options, async (operation) => {
		const reservation = store.reserveMediaStorage(
			MAX_FRAME_BYTES + MAX_THUMBNAIL_BYTES
		);
		const id = crypto.randomUUID();
		const path = store.mediaPath(id);
		const thumb = join(store.directory, "media", `${id}.jpg`);
		let saved = false;
		try {
			const frame = await renderFrameSnapshot(store, project, time, operation);
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
			operation.check();
			await Bun.write(path, frame.bytes);
			await thumbnail(
				path,
				join(store.directory, "media"),
				id,
				operation.signal
			);
			operation.check();
			frame.assertSnapshot();
			store.putAsset(asset);
			reservation.commit();
			saved = true;
			return asset;
		} finally {
			if (!saved) {
				await Promise.all([
					rm(path, { force: true }),
					rm(thumb, { force: true }),
				]);
			}
			reservation.release();
		}
	});
}

/** Sample source media under the same node-wide admission as timeline inspection. */
export async function inspectMediaAsset(
	store: StudioStore,
	asset: Asset,
	samples: number,
	includeThumbnail: boolean,
	options: FrameOptions = {}
) {
	if (!Number.isInteger(samples) || samples < 0 || samples > 4) {
		throw new Error("Choose up to four inspection samples.");
	}
	return await withMediaOperation(60_000, options, async (operation) => {
		const work = join(
			store.directory,
			"renders",
			`inspect-${crypto.randomUUID()}`
		);
		try {
			const thumb = Bun.file(join(store.directory, "media", `${asset.id}.jpg`));
			const thumbnailData =
				includeThumbnail && (await thumb.exists())
					? Buffer.from(await boundedFrame(thumb)).toString("base64")
					: undefined;
			const frames: Array<{ data: string; time: number }> = [];
			if (asset.kind === "video" && samples > 0) {
				await mkdir(work, { recursive: true, mode: 0o700 });
				for (let index = 0; index < samples; index++) {
					operation.check();
					const time =
						Math.floor(
							Math.min(
								Math.max(0, asset.duration - 1 / 30),
								(asset.duration * index) / Math.max(1, samples - 1)
							) * 1000
						) / 1000;
					const path = join(work, `frame-${index}.jpg`);
					await runMedia(
						[
							"-hide_banner",
							"-loglevel",
							"error",
							"-nostdin",
							"-ss",
							String(time),
							"-i",
							store.mediaPath(asset.id),
							"-frames:v",
							"1",
							"-q:v",
							"3",
							"-pix_fmt",
							"yuvj420p",
							path,
						],
						{
							cwd: work,
							signal: operation.signal,
							timeoutMs: operation.remainingMs(),
							outputPath: path,
							maxOutputBytes: MAX_FRAME_BYTES,
						}
					);
					operation.check();
					frames.push({
						data: Buffer.from(await boundedFrame(Bun.file(path))).toString(
							"base64"
						),
						time,
					});
				}
			}
			operation.check();
			return {
				analysis: store.analysis(asset.id),
				asset,
				frames,
				thumbnail: thumbnailData,
				transcript: store.transcript(asset.id),
			};
		} finally {
			await rm(work, { recursive: true, force: true });
		}
	});
}

async function boundedFrame(
	file: ReturnType<typeof Bun.file>
): Promise<ArrayBuffer> {
	if (file.size > MAX_FRAME_BYTES) {
		throw new Error("Frame inspection exceeded its output budget.");
	}
	const bytes = await file.arrayBuffer();
	if (bytes.byteLength > MAX_FRAME_BYTES) {
		throw new Error("Frame inspection exceeded its output budget.");
	}
	return bytes;
}
