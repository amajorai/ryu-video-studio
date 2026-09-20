import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	type Asset,
	activeCaptions,
	assetSchema,
	type Project,
	projectDuration,
} from "../../shared/project.ts";
import { probe, runMedia, thumbnail } from "./media.ts";
import { assCaptions, buildRender } from "./render.ts";
import type { StudioStore } from "./store.ts";

function sequenceAssets(project: Project, assets: readonly Asset[]) {
	const ids = new Set(project.segments.map((segment) => segment.assetId));
	return assets.filter((asset) => ids.has(asset.id) && asset.sequenceProjectId);
}

function dependsOn(
	store: StudioStore,
	projectId: string,
	targetId: string,
	visited = new Set<string>()
): boolean {
	if (projectId === targetId) {
		return true;
	}
	if (visited.has(projectId)) {
		return false;
	}
	visited.add(projectId);
	const project = store.project(projectId);
	return sequenceAssets(project, store.assets()).some((asset) =>
		asset.sequenceProjectId
			? dependsOn(store, asset.sequenceProjectId, targetId, visited)
			: false
	);
}

async function renderProjectInto(
	store: StudioStore,
	project: Project,
	output: string,
	work: string,
	stack: Set<string>
) {
	if (stack.has(project.id)) {
		throw new Error("Nested timeline cycles are not allowed.");
	}
	const nextStack = new Set(stack).add(project.id);
	const assets = store.assets();
	for (const asset of sequenceAssets(project, assets)) {
		if (!asset.sequenceProjectId) {
			continue;
		}
		const child = store.project(asset.sequenceProjectId);
		const childOutput = join(work, `${asset.id}.mp4`);
		await renderProjectInto(store, child, childOutput, work, nextStack);
		await rename(childOutput, store.mediaPath(asset.id));
	}
	const captions = activeCaptions(project).length || project.titles.length;
	if (captions) {
		await Bun.write(join(work, "captions.ass"), assCaptions(project));
	}
	const args = buildRender(
		{ ...project, exportCodec: "h264" },
		store.assets(),
		(id) => store.mediaPath(id),
		captions ? "captions.ass" : undefined
	);
	await runMedia([...args, output], { cwd: work });
}

async function renderSequence(
	store: StudioStore,
	project: Project,
	output: string
) {
	const work = join(
		store.directory,
		"renders",
		`.sequence-${crypto.randomUUID()}`
	);
	await mkdir(work, { recursive: true, mode: 0o700 });
	try {
		await renderProjectInto(store, project, output, work, new Set());
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

export async function createSequenceAsset(
	store: StudioStore,
	parent: Project,
	source: Project,
	name?: string
): Promise<Asset> {
	if (parent.id === source.id || dependsOn(store, source.id, parent.id)) {
		throw new Error(
			"A timeline cannot contain itself, directly or indirectly."
		);
	}
	if (projectDuration(source) <= 0) {
		throw new Error("Add media to the source timeline before nesting it.");
	}
	const id = crypto.randomUUID();
	const temporary = join(store.directory, "media", `.sequence-${id}.mp4`);
	try {
		await renderSequence(store, source, temporary);
		const info = await probe(temporary);
		const asset = assetSchema.parse({
			...info,
			createdAt: new Date().toISOString(),
			id,
			name: name?.trim() || `Sequence · ${source.title}`,
			sequenceProjectId: source.id,
		});
		await rename(temporary, store.mediaPath(id));
		store.putAsset(asset);
		await thumbnail(
			store.mediaPath(id),
			join(store.directory, "media"),
			id
		).catch(() => undefined);
		return asset;
	} finally {
		await rm(temporary, { force: true });
	}
}

export async function refreshSequenceAsset(
	store: StudioStore,
	asset: Asset
): Promise<Asset> {
	if (!asset.sequenceProjectId) {
		throw new Error("This media item is not a sequence asset.");
	}
	const source = store.project(asset.sequenceProjectId);
	const temporary = join(
		store.directory,
		"media",
		`.sequence-refresh-${asset.id}.mp4`
	);
	try {
		await renderSequence(store, source, temporary);
		const info = await probe(temporary);
		const next = assetSchema.parse({
			...asset,
			...info,
		});
		await rename(temporary, store.mediaPath(asset.id));
		store.upsertAsset(next);
		await thumbnail(
			store.mediaPath(next.id),
			join(store.directory, "media"),
			next.id
		).catch(() => undefined);
		return next;
	} finally {
		await rm(temporary, { force: true });
	}
}

export async function refreshSequenceAssets(
	store: StudioStore,
	project: Project
) {
	for (const asset of sequenceAssets(project, store.assets())) {
		await refreshSequenceAsset(store, asset);
	}
}
