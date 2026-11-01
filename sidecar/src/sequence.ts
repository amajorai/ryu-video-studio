import { copyFile, link, mkdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { customFontIdsIn } from "../../shared/library-refs.ts";
import {
	applyNest,
	type DecomposeResult,
	decomposeSequence,
	nestedAssetName,
	planNest,
} from "../../shared/nest.ts";
import {
	type Asset,
	activeCaptions,
	assetSchema,
	type Project,
	projectDuration,
} from "../../shared/project.ts";
import type { DecomposeRequest, NestRequest } from "../../shared/sequences.ts";
import { fontLibraryFor } from "./font-library.ts";
import { lutResolver } from "./lut-store.ts";
import { MAX_THUMBNAIL_BYTES, probe, runMedia, thumbnail } from "./media.ts";
import { type MediaOperation, withMediaOperation } from "./media-operation.ts";
import { assCaptions, buildRenderProgram } from "./render.ts";
import { runRenderProgram } from "./render-chunks.ts";
import { prepareShapeSequences } from "./render-graphics.ts";
import { ConflictError, type StudioStore } from "./store.ts";
import { prepareCurveAudio } from "./varispeed.ts";

const filesystemErrorSchema = z.object({ code: z.string() });

const MAX_PROJECT_REVISIONS = 64;
const MAX_BINDINGS = 512;
const MAX_WORK_BYTES = 10 * 1024 * 1024 * 1024;
const WORK_BUDGET_MESSAGE =
	"Nested timeline working data exceeds the ten-gigabyte budget.";
interface Options {
	bindingDirectory?: string;
	operation?: MediaOperation;
	signal?: AbortSignal;
}
/**
 * The project as a nested-timeline render sees it: an H.264 MP4 with picture
 * and audio at the timeline's own size and length. The nested project's saved
 * export settings (container, publish preset, output size, audio, alpha,
 * range) describe its own exports, not the intermediate a parent timeline
 * plays, so they are dropped; `buildRender` then resolves a neutral plan.
 */
export function nestedRenderProject(project: Project): Project {
	return { ...project, exportCodec: "h264", exportSettings: undefined };
}

function sequenceAssets(project: Project, assets: readonly Asset[]) {
	const ids = new Set(project.segments.map((segment) => segment.assetId));
	return assets.filter((asset) => ids.has(asset.id) && asset.sequenceProjectId);
}
class SequenceTraversal {
	readonly projects: Map<string, Project>;
	readonly assets: Asset[];
	private readonly completed = new Map<string, string>();
	private readonly visiting = new Set<string>();
	private readonly bindings = new Map<string, string>();
	private readonly visited = new Set<string>();
	private bytes = 0;
	constructor(
		private readonly store: StudioStore,
		private readonly work: string,
		private readonly operation: MediaOperation
	) {
		this.projects = new Map(
			store.projects().map((project) => [project.id, project])
		);
		this.assets = store.assets();
	}
	private project(id: string): Project {
		const project = this.projects.get(id);
		if (!project) {
			throw new Error("A nested timeline source is unavailable.");
		}
		return project;
	}
	dependsOn(id: string, target: string, visited = new Set<string>()): boolean {
		this.operation.check();
		if (id === target) {
			return true;
		}
		if (visited.has(id)) {
			return false;
		}
		visited.add(id);
		if (visited.size > MAX_PROJECT_REVISIONS) {
			throw new Error(
				"Nested timelines exceed the 64-project traversal budget."
			);
		}
		return sequenceAssets(this.project(id), this.assets).some((asset) =>
			this.dependsOn(asset.sequenceProjectId!, target, visited)
		);
	}
	bind(id: string, output: string): void {
		this.bindings.set(id, output);
		if (this.bindings.size > MAX_BINDINGS) {
			throw new Error(
				"Nested timelines exceed the 512-binding traversal budget."
			);
		}
	}
	async render(id: string): Promise<string> {
		this.operation.check();
		const project = this.project(id);
		if (this.visiting.has(id)) {
			throw new Error("Nested timeline cycles are not allowed.");
		}
		const key = `${project.id}-${project.revision}`;
		const complete = this.completed.get(key);
		if (complete) {
			return complete;
		}
		this.visited.add(id);
		if (this.visited.size > MAX_PROJECT_REVISIONS) {
			throw new Error(
				"Nested timelines exceed the 64-project traversal budget."
			);
		}
		this.visiting.add(id);
		try {
			const directory = join(this.work, key);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			for (const asset of sequenceAssets(project, this.assets)) {
				this.operation.check();
				this.bind(asset.id, await this.render(asset.sequenceProjectId!));
			}
			const captions = activeCaptions(project).length || project.titles.length;
			if (captions) {
				await Bun.write(join(directory, "captions.ass"), assCaptions(project));
			}
			const output = join(directory, "sequence.mp4");
			const nested = nestedRenderProject(project);
			const resolveMedia = (assetId: string) =>
				this.bindings.get(assetId) ?? this.store.mediaPath(assetId);
			const curveAudio = await prepareCurveAudio(
				nested,
				this.assets,
				resolveMedia,
				directory,
				{
					budgetBytes: Math.max(0, MAX_WORK_BYTES - this.bytes),
					remainingMs: () => this.operation.remainingMs(),
					signal: this.operation.signal,
				}
			);
			this.operation.check();
			for (const path of curveAudio.values()) {
				this.bytes += (await stat(path)).size;
			}
			if (this.bytes > MAX_WORK_BYTES) {
				throw new Error(WORK_BUDGET_MESSAGE);
			}
			// Animated shapes are drawn ahead of the graph, off the event loop's
			// critical path, into the sequence's folder and under its budget.
			const shapes = await prepareShapeSequences(nested, {
				budgetBytes: Math.max(0, MAX_WORK_BYTES - this.bytes),
				rasterDirectory: join(directory, "graphics"),
				remainingMs: () => this.operation.remainingMs(),
				signal: this.operation.signal,
			});
			this.bytes += shapes.bytes;
			this.operation.check();
			// Long nested timelines render as exports do: in chunks, with
			// every graph that is too long for one argv string read from a
			// script file in the sequence's folder.
			const program = buildRenderProgram(
				nested,
				this.assets,
				resolveMedia,
				captions ? "captions.ass" : undefined,
				[],
				{
					curveAudio,
					shapeSequences: shapes.sequences,
					codec: "h264",
					fontsDirectory: await fontLibraryFor(
						this.store.directory
					).renderFontsDirectory(customFontIdsIn(nested)),
					lutPath: lutResolver(this.store.directory),
					output,
				}
			);
			await runRenderProgram(program, {
				check: () => this.operation.check(),
				run: async (step) => {
					// Chunk intermediates and audio mixes count against the
					// same budget as the nested renders themselves.
					const written = resolve(directory, step.output);
					if (this.bytes >= MAX_WORK_BYTES) {
						throw new Error(WORK_BUDGET_MESSAGE);
					}
					await runMedia([...step.args, step.output], {
						cwd: directory,
						signal: this.operation.signal,
						timeoutMs: this.operation.remainingMs(),
						outputPath: written,
						maxOutputBytes: MAX_WORK_BYTES - this.bytes,
					});
					this.operation.check();
					this.bytes += (await stat(written)).size;
					if (this.bytes > MAX_WORK_BYTES) {
						throw new Error(WORK_BUDGET_MESSAGE);
					}
				},
				write: async (name, content) => {
					await Bun.write(join(directory, name), content);
				},
			});
			this.completed.set(key, output);
			return output;
		} finally {
			this.visiting.delete(id);
		}
	}
	assertSnapshot(): void {
		this.operation.check();
		for (const id of this.visited) {
			if (this.store.project(id).revision !== this.project(id).revision) {
				throw new Error(
					"A source timeline changed during rendering. Retry its current revision."
				);
			}
		}
	}
	async materialize(source: string, target: string): Promise<void> {
		this.assertSnapshot();
		try {
			await link(source, target);
		} catch (error) {
			const parsed = filesystemErrorSchema.safeParse(error);
			if (
				!(
					parsed.success &&
					["EXDEV", "ENOTSUP", "EPERM"].includes(parsed.data.code)
				)
			) {
				throw error;
			}
			const bytes = (await stat(source)).size;
			if (this.bytes + bytes > MAX_WORK_BYTES) {
				throw new Error(
					"Nested timeline copies exceed the ten-gigabyte budget."
				);
			}
			this.bytes += bytes;
			await copyFile(source, target);
		}
		this.assertSnapshot();
	}
	async publishBindings(): Promise<void> {
		this.assertSnapshot();
		for (const [id, output] of this.bindings) {
			const temporary = join(
				this.store.directory,
				"media",
				`.sequence-bind-${crypto.randomUUID()}`
			);
			try {
				await this.materialize(output, temporary);
				await rename(temporary, this.store.mediaPath(id));
			} finally {
				await rm(temporary, { force: true });
			}
		}
	}
}
async function traversal<T>(
	store: StudioStore,
	options: Options,
	work: (graph: SequenceTraversal, operation: MediaOperation) => Promise<T>
): Promise<T> {
	return await withMediaOperation(30 * 60_000, options, async (operation) => {
		const directory = join(
			store.directory,
			"renders",
			`.sequence-${crypto.randomUUID()}`
		);
		try {
			const graph = new SequenceTraversal(store, directory, operation);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			return await work(graph, operation);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}
export async function createSequenceAsset(
	store: StudioStore,
	parent: Project,
	source: Project,
	name?: string,
	options: Options = {}
): Promise<Asset> {
	return await traversal(store, options, async (graph, operation) => {
		if (graph.dependsOn(source.id, parent.id)) {
			throw new Error(
				"A timeline cannot contain itself, directly or indirectly."
			);
		}
		if (projectDuration(source) <= 0) {
			throw new Error("Add media to the source timeline before nesting it.");
		}
		// Claim an asset slot before rendering; bytes are admitted once the output size is known.
		let reservation = store.reserveMediaStorage(MAX_THUMBNAIL_BYTES);
		const id = crypto.randomUUID();
		const temporary = join(store.directory, "media", `.sequence-${id}.mp4`);
		try {
			const output = await graph.render(source.id);
			const outputBytes = (await stat(output)).size;
			reservation.release();
			reservation = store.reserveMediaStorage(
				outputBytes + MAX_THUMBNAIL_BYTES
			);
			const info = await probe(output, operation.signal);
			operation.check();
			const asset = assetSchema.parse({
				...info,
				createdAt: new Date().toISOString(),
				id,
				name: name?.trim() || `Sequence · ${source.title}`,
				sequenceProjectId: source.id,
			});
			await graph.publishBindings();
			await graph.materialize(output, temporary);
			await rename(temporary, store.mediaPath(id));
			graph.assertSnapshot();
			store.putAsset(asset);
			await thumbnail(
				store.mediaPath(id),
				join(store.directory, "media"),
				id,
				operation.signal
			).catch(() => undefined);
			reservation.commit();
			operation.check();
			return asset;
		} finally {
			reservation.release();
			await rm(temporary, { force: true });
		}
	});
}
export async function refreshSequenceAsset(
	store: StudioStore,
	asset: Asset,
	options: Options = {}
): Promise<Asset> {
	if (!asset.sequenceProjectId) {
		throw new Error("This media item is not a sequence asset.");
	}
	return await traversal(store, options, async (graph, operation) => {
		const temporary = join(
			store.directory,
			"media",
			`.sequence-refresh-${crypto.randomUUID()}.mp4`
		);
		try {
			const output = await graph.render(asset.sequenceProjectId!);
			const info = await probe(output, operation.signal);
			operation.check();
			const next = assetSchema.parse({ ...asset, ...info });
			await graph.publishBindings();
			await graph.materialize(output, temporary);
			await rename(temporary, store.mediaPath(asset.id));
			graph.assertSnapshot();
			store.upsertAsset(next);
			await thumbnail(
				store.mediaPath(next.id),
				join(store.directory, "media"),
				next.id,
				operation.signal
			).catch(() => undefined);
			operation.check();
			return next;
		} finally {
			await rm(temporary, { force: true });
		}
	});
}
export async function refreshSequenceAssets(
	store: StudioStore,
	project: Project,
	options: Options = {}
): Promise<{ paths: Map<string, string>; assets: Asset[] }> {
	return await traversal(store, options, async (graph, operation) => {
		const roots = sequenceAssets(project, graph.assets);
		for (const asset of roots) {
			graph.bind(asset.id, await graph.render(asset.sequenceProjectId!));
		}
		const infos = new Map<string, Awaited<ReturnType<typeof probe>>>();
		const refreshed: Asset[] = [];
		for (const asset of roots) {
			const output = await graph.render(asset.sequenceProjectId!);
			let info = infos.get(output);
			if (!info) {
				info = await probe(output, operation.signal);
				infos.set(output, info);
			}
			graph.assertSnapshot();
			refreshed.push(assetSchema.parse({ ...asset, ...info }));
		}
		operation.check();
		await graph.publishBindings();
		const paths = new Map<string, string>();
		if (options.bindingDirectory) {
			for (const asset of roots) {
				const path = join(options.bindingDirectory, `sequence-${asset.id}.mp4`);
				await graph.materialize(
					await graph.render(asset.sequenceProjectId!),
					path
				);
				paths.set(asset.id, path);
			}
		}
		graph.assertSnapshot();
		for (const asset of refreshed) {
			store.upsertAsset(asset);
			const index = graph.assets.findIndex((old) => old.id === asset.id);
			graph.assets[index] = asset;
			await thumbnail(
				store.mediaPath(asset.id),
				join(store.directory, "media"),
				asset.id,
				operation.signal
			).catch(() => undefined);
			graph.assertSnapshot();
		}
		return { paths, assets: graph.assets };
	});
}

export interface NestResult {
	asset: Asset;
	clipId: string;
	project: Project;
	sequenceProject: Project;
}

/** Remove a nest's half-made outputs after a refusal or failure. */
async function discardNest(
	store: StudioStore,
	child: Project,
	asset: Asset | undefined
): Promise<void> {
	if (asset) {
		store.organizeAsset(asset.id, { delete: true });
		await rm(store.mediaPath(asset.id), { force: true });
		await rm(join(store.directory, "media", `${asset.id}.jpg`), {
			force: true,
		});
	}
	try {
		store.deleteProject(child.id, store.project(child.id).revision);
	} catch {
		// The child is unreferenced; a concurrent delete already removed it.
	}
}

/**
 * Nest clips (W4-N1): create a child project holding the selection, render
 * it through the sequence path, and swap the selection for one sequence clip
 * on the parent. The parent revision is checked before and after the render;
 * a conflict or failure deletes the child project and its sequence media.
 */
export async function nestClips(
	store: StudioStore,
	projectId: string,
	input: NestRequest,
	options: Options = {}
): Promise<NestResult> {
	const stale = "The project changed. Reload before nesting clips.";
	const parent = store.project(projectId);
	if (parent.revision !== input.revision) {
		throw new ConflictError(stale);
	}
	const plan = planNest(parent, store.assets(), input);
	const created = store.create(plan.child.title, parent.requireApproval);
	const child = store.save({
		...plan.child,
		id: created.id,
		revision: created.revision,
	});
	let asset: Asset | undefined;
	try {
		asset = await createSequenceAsset(
			store,
			parent,
			child,
			nestedAssetName(child),
			options
		);
		const current = store.project(projectId);
		if (current.revision !== input.revision) {
			throw new ConflictError(stale);
		}
		const nested = applyNest(current, store.assets(), plan, asset);
		return {
			asset,
			clipId: nested.clipId,
			project: store.save(nested.project),
			sequenceProject: store.project(child.id),
		};
	} catch (error) {
		await discardNest(store, child, asset);
		throw error;
	}
}

/**
 * Decompose a sequence clip (W4-N1) back into its child project's clips,
 * titles, and graphics. The child project stays in the library.
 */
export function decomposeSequenceClip(
	store: StudioStore,
	projectId: string,
	input: DecomposeRequest
): DecomposeResult {
	const parent = store.project(projectId);
	if (parent.revision !== input.revision) {
		throw new ConflictError(
			"The project changed. Reload before decomposing the sequence clip."
		);
	}
	const assets = store.assets();
	const clip = parent.segments.find((segment) => segment.id === input.clipId);
	const sequence = assets.find((asset) => asset.id === clip?.assetId);
	if (!(clip && sequence?.sequenceProjectId)) {
		throw new Error("This clip is not a nested sequence.");
	}
	const result = decomposeSequence(
		parent,
		assets,
		store.project(sequence.sequenceProjectId),
		clip.id
	);
	return { ...result, project: store.save(result.project) };
}
