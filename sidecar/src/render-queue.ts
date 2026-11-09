import {
	copyFile,
	mkdir,
	readdir,
	rename,
	rm,
	stat,
	statfs,
} from "node:fs/promises";
import { join } from "node:path";
import { customFontIdsIn } from "../../shared/library-refs.ts";
import type { Asset } from "../../shared/project.ts";
import {
	activeCaptions,
	assetSchema,
	type Project,
	projectDuration,
	validateProject,
} from "../../shared/project.ts";
import { publishMetadataText } from "../../shared/publish-presets.ts";
import {
	type ExportJobOutput,
	exportJobOutputOf,
	importableExport,
	type RenderPlan,
	type RenderRequest,
	resolveRenderPlan,
} from "../../shared/render-options.ts";
import {
	type RenderReview,
	renderReviewSchema,
} from "../../shared/render-review.ts";
import { MAX_ZIP_BYTES, zipFiles } from "./export-zip.ts";
import { fontLibraryFor } from "./font-library.ts";
import { lutResolver } from "./lut-store.ts";
import { probe, runMedia, thumbnail } from "./media.ts";
import {
	acquireMediaOperation,
	MediaBusyError,
	type MediaOperation,
} from "./media-operation.ts";
import { renderMeshPngAsync } from "./mesh-render-runner.ts";
import {
	buildRenderProgram,
	type MeshInput,
	type RenderProgram,
	type RenderStep,
} from "./render.ts";
import { assCaptions } from "./render-ass.ts";
import { runRenderProgram } from "./render-chunks.ts";
import { prepareShapeSequences } from "./render-graphics.ts";
import { segmentAudible } from "./render-stages/visibility.ts";
import { reviewRender } from "./review.ts";
import type { RenderJob, StudioStore } from "./store.ts";
import { prepareCurveAudio, SILENT_CURVE_AUDIO } from "./varispeed.ts";

/** A render job plus what the export produces (persisted with the job). */
export type ExportRenderJob = RenderJob & { export?: ExportJobOutput };

const MAX_RENDER_BYTES = 10 * 1024 * 1024 * 1024;
const AUDIO_DURATION_TOLERANCE = 0.25;
/**
 * Most bytes a chunked export's intermediates (lossless chunks, float audio
 * sub-mixes and the summed mix) may hold in the work folder before the final
 * step joins them. The budget shrinks to the disk's free space, less
 * `WORK_DISK_HEADROOM`, when that is smaller.
 */
export const MAX_RENDER_WORK_BYTES = 64 * 1024 * 1024 * 1024;
const WORK_DISK_HEADROOM = 1024 * 1024 * 1024;
const GIGABYTE = 1024 * 1024 * 1024;

/** Message of an export whose intermediates outgrow the work budget. */
export function workBudgetMessage(limit: number): string {
	const gigabytes = Math.max(0.1, Math.floor((limit / GIGABYTE) * 10) / 10);
	return `The long-export working files exceed their ${gigabytes} GB budget, which free disk space also caps. Export a shorter range or a smaller output size, or free disk space.`;
}

/**
 * The intermediate budget of an export run in `work`: the configured limit,
 * capped by the free space of its disk less the headroom.
 */
export async function renderWorkBudget(
	work: string,
	limit = MAX_RENDER_WORK_BYTES
): Promise<number> {
	try {
		const disk = await statfs(work);
		const free = Number(disk.bavail) * Number(disk.bsize);
		return Math.max(0, Math.min(limit, free - WORK_DISK_HEADROOM));
	} catch {
		return limit;
	}
}

const SEQUENCE_BUDGET_MESSAGE =
	"The image sequence exceeds the 4 GB frame budget. Export a shorter range or a smaller output size.";

/** Color transfers of the assets the timeline's clips read. */
function timelineTransfers(project: Project, assets: readonly Asset[]) {
	const used = new Set(project.segments.map((segment) => segment.assetId));
	return assets.flatMap((asset) =>
		used.has(asset.id) && asset.colorTransfer ? [asset.colorTransfer] : []
	);
}

/**
 * Transparent exports often hold only overlays, so an all-black luma sample
 * is expected there: the content check becomes a warning.
 */
export function alphaReview(review: RenderReview): RenderReview {
	const checks = review.checks.map((check) =>
		check.id === "content" && check.status === "failed"
			? {
					...check,
					status: "warning" as const,
					message:
						"Sampled frames are dark; transparent areas decode as black. Check the alpha channel in your compositor.",
				}
			: check
	);
	return renderReviewSchema.parse({
		...review,
		checks,
		passed: checks.every((check) => check.status !== "failed"),
	});
}

/**
 * Whether a plan is the pre-export-options render: a plain MP4/MOV video
 * whose file type the job's `codec` alone names. Every other plan (stored
 * containers, presets, alpha, new codecs) records `job.export`, so the
 * download type, metadata and frame count never depend on the request body.
 */
export function isLegacyExport(plan: RenderPlan): boolean {
	const codec = plan.videoCodec;
	if (plan.kind !== "video" || plan.preset || plan.alpha || !codec) {
		return false;
	}
	if (codec === "prores") {
		return plan.container === "mov";
	}
	return (codec === "h264" || codec === "h265") && plan.container === "mp4";
}

/**
 * Watch a frames folder while FFmpeg writes an image sequence and call
 * `onExceeded` once its total size passes `limit`. Frames are written in
 * order, so only new files and the newest known file are re-measured.
 */
export function watchDirectoryBytes(
	directory: string,
	limit: number,
	onExceeded: () => void,
	intervalMs = 250
): () => void {
	const sizes = new Map<string, number>();
	let newest: string | undefined;
	let running = false;
	let stopped = false;
	const measure = async () => {
		if (running || stopped) {
			return;
		}
		running = true;
		try {
			const names = await readdir(directory).catch(() => [] as string[]);
			const pending = names.filter((name) => !sizes.has(name));
			if (newest) {
				pending.push(newest);
			}
			for (const name of pending) {
				const info = await stat(join(directory, name)).catch(() => undefined);
				if (info) {
					sizes.set(name, info.size);
				}
				if (!newest || name > newest) {
					newest = name;
				}
			}
			let total = 0;
			for (const size of sizes.values()) {
				total += size;
			}
			if (total > limit && !stopped) {
				stopped = true;
				onExceeded();
			}
		} finally {
			running = false;
		}
	};
	const timer = setInterval(() => void measure(), intervalMs);
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}

/** Where an export's last FFmpeg step writes inside the work folder. */
interface ExportTarget {
	/** Folder of an image sequence's numbered frames. */
	framesDirectory: string;
	/** The last step's output: the export file, or the frame pattern. */
	output: string;
	/** The export file (the ZIP of the frames for a sequence). */
	path: string;
	sequence: boolean;
}

function exportTarget(plan: RenderPlan, work: string): ExportTarget {
	const path = join(work, `export.${plan.file.extension}`);
	const sequence = plan.kind === "sequence";
	const framesDirectory = join(work, "frames");
	return {
		framesDirectory,
		output: sequence
			? join(
					framesDirectory,
					`frame_%06d.${plan.container === "png-sequence" ? "png" : "jpg"}`
				)
			: path,
		path,
		sequence,
	};
}

/** The plan and job summary for an export request; throws when invalid. */
export function planExport(
	project: Project,
	assets: readonly Asset[],
	request: RenderRequest
): { output: ExportJobOutput; plan: RenderPlan } {
	const { revision: _revision, saveAsAsset, ...options } = request;
	const plan = resolveRenderPlan(project, options, {
		sourceTransfers: timelineTransfers(project, assets),
		timelineDuration: projectDuration(project),
	});
	if (saveAsAsset && !importableExport(plan.container)) {
		throw new Error(
			"Only video and audio exports can be saved to the library."
		);
	}
	return { output: exportJobOutputOf(plan, request), plan };
}

/** Job progress while the encode runs (between preprocessing and review). */
const ENCODE_PROGRESS = { end: 0.85, start: 0.05 } as const;

/** Options of a `RenderQueue`; the defaults are what exports use. */
export interface RenderQueueOptions {
	/**
	 * Target chunk length in seconds for exports that chunk (default 60 s,
	 * see `render-chunks.ts`). Verification uses short windows.
	 */
	chunkSeconds?: number;
	/** Called with each FFmpeg step just before it runs (verification). */
	onStep?: (step: RenderStep) => void;
	/**
	 * Bytes the intermediates of one export may use (default
	 * `MAX_RENDER_WORK_BYTES`, capped by free disk space). Tests use less.
	 */
	workBytes?: number;
}

/**
 * Export jobs: at most two concurrent renders, each preprocessing meshes and
 * nested sequences, encoding with the steps of `buildRenderProgram` (one
 * FFmpeg run, or chunks, audio sub-mixes and a final join for long
 * timelines), then running the delivery review and thumbnail before the job
 * completes. The request (range, audio-only, container, codec and settings
 * overrides) resolves into a `RenderPlan` before the job is queued, so
 * invalid combinations fail fast.
 */
export class RenderQueue {
	private readonly active = new Map<string, AbortController>();
	constructor(
		private readonly store: StudioStore,
		private readonly options: RenderQueueOptions = {}
	) {}
	start(project: Project, request: RenderRequest = {}): ExportRenderJob {
		validateProject(project, this.store.assets());
		if (
			!(
				project.segments.length ||
				project.titles.length ||
				project.graphics.length ||
				project.avatars.length ||
				project.spatialObjects.length ||
				project.meshes.length
			)
		) {
			throw new Error(
				"Add media, graphics, an avatar, or a 3D block before exporting."
			);
		}
		if (
			project.requireApproval &&
			(!project.scenes.length ||
				project.scenes.some((s) => !(s.approved && s.assetIds.length)))
		) {
			throw new Error(
				"Approve every storyboard scene and select its media before exporting."
			);
		}
		if (project.requireApproval) {
			const approvedAssets = new Set(
				project.scenes.filter((s) => s.approved).flatMap((s) => s.assetIds)
			);
			if (
				project.segments.some((segment) => !approvedAssets.has(segment.assetId))
			) {
				throw new Error(
					"The timeline contains media that has not been approved in the storyboard."
				);
			}
		}
		const { output, plan } = planExport(project, this.store.assets(), request);
		if (this.active.size >= 2) {
			throw new MediaBusyError();
		}
		const controller = new AbortController();
		const operation = acquireMediaOperation(30 * 60_000, controller.signal);
		const job: ExportRenderJob = {
			id: crypto.randomUUID(),
			projectId: project.id,
			revision: project.revision,
			status: "pending",
			progress: 0,
			createdAt: new Date().toISOString(),
		};
		// `codec` names the stored file's extension (`renderPath`), so only
		// video exports carry one; the empty request keeps the legacy shape.
		if (plan.videoCodec) {
			job.codec = plan.videoCodec;
		}
		if (Object.keys(request).length || !isLegacyExport(plan)) {
			job.export = output;
		}
		this.active.set(job.id, controller);
		try {
			this.store.putJob(job);
			void this.render(job, project, plan, controller, operation);
		} catch (error) {
			this.active.delete(job.id);
			operation.release();
			throw error;
		}
		return job;
	}
	cancel(id: string) {
		const controller = this.active.get(id);
		if (!controller) {
			throw new Error("This export is no longer running.");
		}
		controller.abort();
	}
	private async render(
		job: ExportRenderJob,
		project: Project,
		plan: RenderPlan,
		controller: AbortController,
		operation: MediaOperation
	) {
		const work = join(this.store.directory, "renders", job.id);
		const outputPath = this.store.renderPath(job.id, job.codec);
		const metadataPath = join(
			this.store.directory,
			"renders",
			`${job.id}.metadata.txt`
		);
		try {
			operation.check();
			await mkdir(work, { mode: 0o700 });
			job.status = "running";
			job.progress = 0.05;
			this.store.putJob(job);
			const audioOnly = plan.kind === "audio";
			const captions = activeCaptions(project);
			const burnIn = !audioOnly && (captions.length || project.titles.length);
			if (burnIn) {
				await Bun.write(join(work, "captions.ass"), assCaptions(project));
			}
			const meshInputs = audioOnly
				? []
				: await this.prepareMeshes(project, work, operation);
			const { refreshSequenceAssets } = await import("./sequence.ts");
			const sequenceSnapshot = await refreshSequenceAssets(
				this.store,
				project,
				{ operation, bindingDirectory: work }
			);
			const target = exportTarget(plan, work);
			const resolveMedia = (id: string) =>
				sequenceSnapshot.paths.get(id) ?? this.store.mediaPath(id);
			// Work files written ahead of the graph (curve audio and shape
			// frames) count against the same budget as the encode's
			// intermediates, measured once before anything is written.
			const workBudget = {
				limit: await renderWorkBudget(
					work,
					this.options.workBytes ?? MAX_RENDER_WORK_BYTES
				),
				used: 0,
			};
			// Speed-curve audio is remapped sample by sample ahead of the graph;
			// only clips the export range can hear are rendered.
			const curveAudio = plan.includeAudio
				? await prepareCurveAudio(
						project,
						sequenceSnapshot.assets,
						resolveMedia,
						work,
						{
							budgetBytes: workBudget.limit,
							range: { end: plan.start + plan.duration, start: plan.start },
							remainingMs: () => operation.remainingMs(),
							signal: operation.signal,
						}
					)
				: new Map<string, string>();
			for (const path of curveAudio.values()) {
				if (path !== SILENT_CURVE_AUDIO) {
					workBudget.used += (await stat(path)).size;
				}
			}
			operation.check();
			// Shape-keyframed graphics are drawn ahead too, off the graph
			// build, so a long animation never blocks the event loop.
			const shapes = audioOnly
				? { bytes: 0, sequences: new Map<string, string>() }
				: await prepareShapeSequences(project, {
						budgetBytes: workBudget.limit - workBudget.used,
						rasterDirectory: join(work, "graphics"),
						remainingMs: () => operation.remainingMs(),
						signal: operation.signal,
					});
			workBudget.used += shapes.bytes;
			operation.check();
			const program = buildRenderProgram(
				project,
				sequenceSnapshot.assets,
				resolveMedia,
				burnIn ? "captions.ass" : undefined,
				meshInputs,
				{
					curveAudio,
					shapeSequences: shapes.sequences,
					...(this.options.chunkSeconds === undefined
						? {}
						: { chunkSeconds: this.options.chunkSeconds }),
					fontsDirectory: await fontLibraryFor(
						this.store.directory
					).renderFontsDirectory(customFontIdsIn(project)),
					lutPath: lutResolver(this.store.directory),
					output: target.output,
					plan,
				}
			);
			const encoded = await this.encode(
				program,
				plan,
				target,
				work,
				workBudget,
				operation,
				(fraction) => {
					job.progress = Number(
						(
							ENCODE_PROGRESS.start +
							fraction * (ENCODE_PROGRESS.end - ENCODE_PROGRESS.start)
						).toFixed(4)
					);
					this.store.putJob(job);
				}
			);
			await rename(encoded.path, outputPath);
			job.progress = 0.9;
			this.store.putJob(job);
			const hasAudio =
				plan.includeAudio &&
				project.segments.some((segment) =>
					segmentAudible(
						project,
						segment,
						sequenceSnapshot.assets.find(
							(candidate) => candidate.id === segment.assetId
						)
					)
				);
			const review = await this.review(
				outputPath,
				project,
				plan,
				hasAudio,
				operation
			);
			if (review) {
				job.review = review;
			}
			if (plan.kind === "video") {
				await this.thumbnail(outputPath, job.id, operation);
			}
			const exported = job.export;
			if (exported && encoded.frames !== undefined) {
				exported.frames = encoded.frames;
			}
			if (exported && plan.preset) {
				const metadata = publishMetadataText(project, plan.preset, {
					start: plan.start,
					end: plan.start + plan.duration,
				});
				await Bun.write(metadataPath, metadata);
				exported.metadata = metadata;
			}
			if (exported?.saveAsAsset) {
				exported.assetId = await this.saveAsAsset(
					outputPath,
					project,
					plan,
					operation
				);
			}
			operation.check();
			job.status = "completed";
			job.progress = 1;
			this.store.putJob(job);
		} catch (error) {
			job.status = controller.signal.aborted ? "canceled" : "failed";
			job.error = controller.signal.aborted
				? undefined
				: error instanceof Error
					? error.message
					: "Export failed.";
			this.store.putJob(job);
			await rm(outputPath, { force: true });
			await rm(metadataPath, { force: true });
		} finally {
			try {
				await rm(work, { recursive: true, force: true });
			} finally {
				this.active.delete(job.id);
				operation.release();
			}
		}
	}
	/**
	 * Run the program's FFmpeg steps in the work folder (their helper files
	 * and intermediates are relative to it). Containers write
	 * `export.<ext>`; image sequences write numbered frames that are then
	 * zipped. The step that writes the export is held to the export size
	 * budget; the intermediates of a chunked export (chunks and audio mixes)
	 * share the work budget (`renderWorkBudget`): each step may write only
	 * what is left of it, and its output is measured once it finishes. Every
	 * step shares the operation's deadline and cancellation.
	 */
	private async encode(
		program: RenderProgram,
		plan: RenderPlan,
		{ framesDirectory, path, sequence }: ExportTarget,
		work: string,
		budget: { limit: number; used: number },
		operation: MediaOperation,
		progress: (fraction: number) => void
	): Promise<{ frames?: number; path: string }> {
		if (sequence) {
			await mkdir(framesDirectory, { mode: 0o700 });
		}
		// Frame sequences have no single output file to cap, so the frames
		// folder is watched instead and FFmpeg is stopped past the ZIP limit.
		const encodeAbort = new AbortController();
		const forwardAbort = () => encodeAbort.abort();
		if (operation.signal.aborted) {
			encodeAbort.abort();
		}
		operation.signal.addEventListener("abort", forwardAbort, { once: true });
		let framesExceeded = false;
		const workLimit = budget.limit;
		// Curve audio and shape frames written before the encode already
		// count against the budget.
		let workUsed = budget.used;
		let workExceeded = false;
		const stopWatching = sequence
			? watchDirectoryBytes(framesDirectory, MAX_ZIP_BYTES, () => {
					framesExceeded = true;
					encodeAbort.abort();
				})
			: undefined;
		try {
			await runRenderProgram(program, {
				check: () => operation.check(),
				progress,
				run: async (step) => {
					this.options.onStep?.(step);
					const writesExport = step.kind === "final" || step.kind === "single";
					if (writesExport) {
						await runMedia([...step.args, step.output], {
							cwd: work,
							signal: encodeAbort.signal,
							timeoutMs: operation.remainingMs(),
							...(sequence
								? {}
								: { outputPath: path, maxOutputBytes: MAX_RENDER_BYTES }),
						});
						return;
					}
					const intermediate = join(work, step.output);
					const allowed = workLimit - workUsed;
					if (allowed <= 0) {
						workExceeded = true;
						throw new Error(workBudgetMessage(workLimit));
					}
					try {
						await runMedia([...step.args, step.output], {
							cwd: work,
							signal: encodeAbort.signal,
							timeoutMs: operation.remainingMs(),
							outputPath: intermediate,
							maxOutputBytes: allowed,
						});
					} catch (error) {
						const written = await stat(intermediate).catch(() => undefined);
						if (written && written.size > allowed) {
							workExceeded = true;
						}
						throw error;
					}
					workUsed += (await stat(intermediate)).size;
					if (workUsed > workLimit) {
						workExceeded = true;
						throw new Error(workBudgetMessage(workLimit));
					}
				},
				write: async (name, content) => {
					await Bun.write(join(work, name), content);
				},
			});
		} catch (error) {
			if (framesExceeded) {
				throw new Error(SEQUENCE_BUDGET_MESSAGE);
			}
			if (workExceeded && !operation.signal.aborted) {
				throw new Error(workBudgetMessage(workLimit));
			}
			throw new Error(
				`Render encode failed: ${
					error instanceof Error ? error.message : "unknown error"
				}`
			);
		} finally {
			stopWatching?.();
			operation.signal.removeEventListener("abort", forwardAbort);
		}
		operation.check();
		if (!sequence) {
			return { path };
		}
		const names = (await readdir(framesDirectory)).filter((name) =>
			name.startsWith("frame_")
		);
		names.sort();
		if (!names.length) {
			throw new Error("The image sequence export produced no frames.");
		}
		const size = await zipFiles(
			names.map((name) => ({ name, path: join(framesDirectory, name) })),
			path
		);
		if (size > MAX_ZIP_BYTES) {
			throw new Error(SEQUENCE_BUDGET_MESSAGE);
		}
		operation.check();
		return { frames: names.length, path };
	}
	/**
	 * Delivery checks: the full review for video containers, and stream,
	 * duration and signature checks for audio, GIF and frame archives.
	 */
	private async review(
		path: string,
		project: Project,
		plan: RenderPlan,
		hasAudio: boolean,
		operation: MediaOperation
	): Promise<RenderReview | undefined> {
		if (plan.kind === "video") {
			let review: RenderReview;
			try {
				review = await reviewRender(
					path,
					{
						width: plan.output.width,
						height: plan.output.height,
						fps: project.fps,
						duration: plan.duration,
						hasAudio,
					},
					operation.signal
				);
			} catch (error) {
				throw new Error(
					`Delivery review could not inspect the render: ${
						error instanceof Error ? error.message : "unknown error"
					}`
				);
			}
			const checked = plan.alpha ? alphaReview(review) : review;
			if (!checked.passed) {
				const failed = checked.checks
					.filter((check) => check.status === "failed")
					.map((check) => check.message)
					.join(" ");
				throw new Error(`Delivery review failed. ${failed}`);
			}
			return checked;
		}
		if (plan.kind === "audio") {
			const info = await probe(path, operation.signal);
			if (!info.hasAudio) {
				throw new Error("Delivery review failed. The export has no audio.");
			}
			if (Math.abs(info.duration - plan.duration) > AUDIO_DURATION_TOLERANCE) {
				throw new Error(
					`Delivery review failed. Expected ${plan.duration.toFixed(2)} seconds of audio; received ${info.duration.toFixed(2)} seconds.`
				);
			}
			return;
		}
		const head = new Uint8Array(await Bun.file(path).slice(0, 6).arrayBuffer());
		const signature = new TextDecoder().decode(head);
		const valid =
			plan.kind === "gif"
				? signature === "GIF89a" || signature === "GIF87a"
				: signature.startsWith("PK");
		if (!valid || (await stat(path)).size < 64) {
			throw new Error("Delivery review failed. The export file is incomplete.");
		}
	}
	private async thumbnail(path: string, id: string, operation: MediaOperation) {
		try {
			await thumbnail(
				path,
				join(this.store.directory, "renders"),
				id,
				operation.signal
			);
		} catch (error) {
			throw new Error(
				`Delivery thumbnail failed: ${
					error instanceof Error ? error.message : "unknown error"
				}`
			);
		}
	}
	/** Import the finished export into the library as `derivation: "render"`. */
	private async saveAsAsset(
		path: string,
		project: Project,
		plan: RenderPlan,
		operation: MediaOperation
	): Promise<string> {
		const bytes = (await stat(path)).size;
		const reservation = this.store.reserveMediaStorage(bytes);
		const id = crypto.randomUUID();
		const mediaPath = this.store.mediaPath(id);
		try {
			const info = await probe(path, operation.signal);
			operation.check();
			const span = plan.range
				? ` ${plan.range.start.toFixed(1)}-${(plan.start + plan.duration).toFixed(1)}s`
				: "";
			const asset = assetSchema.parse({
				...info,
				createdAt: new Date().toISOString(),
				derivation: "render",
				id,
				name: `${project.title.slice(0, 150)} · export${span}`,
			});
			await copyFile(path, mediaPath);
			this.store.putAsset(asset);
			reservation.commit();
			if (asset.kind === "video") {
				await thumbnail(
					mediaPath,
					join(this.store.directory, "media"),
					id,
					operation.signal
				).catch(() => undefined);
			}
			return id;
		} catch (error) {
			await rm(mediaPath, { force: true });
			throw new Error(
				`Saving the export to the library failed: ${
					error instanceof Error ? error.message : "unknown error"
				}`
			);
		} finally {
			reservation.release();
		}
	}
	/** Render every mesh to PNG frames under the export's pixel and byte budgets. */
	private async prepareMeshes(
		project: Project,
		work: string,
		operation: MediaOperation
	): Promise<MeshInput[]> {
		const meshInputs: MeshInput[] = [];
		let remainingMeshPixels = 1_000_000_000;
		const meshWork = { remainingPixels: 1_000_000_000 };
		let remainingMeshBytes = 512 * 1024 * 1024;
		const writeMeshFrame = async (
			path: string,
			mesh: Project["meshes"][number],
			time: number
		) => {
			const png = await renderMeshPngAsync(
				project,
				mesh,
				project.width,
				project.height,
				time,
				operation.signal,
				meshWork
			);
			remainingMeshBytes -= png.byteLength;
			if (remainingMeshBytes < 0) {
				throw new Error(
					"Mesh preprocessing exceeds the supported 512 MB temporary storage budget."
				);
			}
			operation.check();
			await Bun.write(path, png);
		};
		for (const [index, mesh] of project.meshes.entries()) {
			operation.check();
			const animated = Boolean(
				mesh.keyframes?.length ||
					mesh.deformationFrames?.length ||
					mesh.rig?.keyframes?.length
			);
			const frameCount = animated
				? Math.ceil((mesh.end - mesh.start) * project.fps) + 1
				: 1;
			remainingMeshPixels -= frameCount * project.width * project.height;
			if (remainingMeshPixels < 0) {
				throw new Error(
					"Mesh preprocessing exceeds the supported export pixel budget. Shorten the mesh duration or reduce the resolution."
				);
			}
			if (!animated) {
				const path = join(work, `mesh-${index}.png`);
				await writeMeshFrame(path, mesh, mesh.start);
				meshInputs.push({ end: mesh.end, path, start: mesh.start });
				continue;
			}
			const directory = join(work, `mesh-${index}`);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			for (let frame = 0; frame < frameCount; frame++) {
				operation.check();
				await writeMeshFrame(
					join(directory, `frame-${String(frame).padStart(6, "0")}.png`),
					mesh,
					mesh.start + frame / project.fps
				);
			}
			meshInputs.push({
				end: mesh.end,
				path: directory,
				sequence: true,
				start: mesh.start,
			});
		}
		return meshInputs;
	}
	stop() {
		for (const controller of this.active.values()) {
			controller.abort();
		}
	}
}
