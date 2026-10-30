/**
 * Which projects use a media asset, and the deletion plan for a batch of
 * assets (W1-L1). An asset is "in use" when any saved project refers to its
 * id anywhere: clips, multicam members, scenes, caption sources, reference
 * profiles, backgrounds, lip-sync sources, and every field later waves add.
 * The scan walks the whole project instead of listing fields, so a new
 * reference kind can never be missed and silently orphaned by a bulk delete.
 */
import { z } from "zod";
import { type Asset, idSchema, type Project } from "./project.ts";

/** Most assets one bulk request may name (the library holds at most 2000). */
export const MAX_BULK_ASSET_IDS = 500;

export const deleteManyAssetsRequestSchema = z
	.object({ ids: z.array(idSchema).min(1).max(MAX_BULK_ASSET_IDS) })
	.strict();
export type DeleteManyAssetsRequest = z.infer<
	typeof deleteManyAssetsRequestSchema
>;

export interface AssetProjectReference {
	id: string;
	title: string;
}

export type RefusedAssetReason = "in-use" | "not-found";

export interface RefusedAsset {
	id: string;
	name?: string;
	/** Projects that still use the asset (empty for `not-found`). */
	projects: AssetProjectReference[];
	reason: RefusedAssetReason;
}

export interface AssetDeletionPlan {
	/** Ids that no project uses, in request order without duplicates. */
	deletable: string[];
	refused: RefusedAsset[];
}

export const refusedAssetSchema = z
	.object({
		id: idSchema,
		name: z.string().optional(),
		projects: z.array(z.object({ id: idSchema, title: z.string() }).strict()),
		reason: z.enum(["in-use", "not-found"]),
	})
	.strict();

export const deleteManyAssetsResponseSchema = z
	.object({ deleted: z.array(idSchema), refused: z.array(refusedAssetSchema) })
	.strict();
export type DeleteManyAssetsResponse = z.infer<
	typeof deleteManyAssetsResponseSchema
>;

/** Every string anywhere in a JSON value that is one of `ids`. */
function collectReferencedIds(
	value: unknown,
	ids: ReadonlySet<string>,
	found: Set<string>
) {
	const pending: unknown[] = [value];
	while (pending.length > 0) {
		const next = pending.pop();
		if (typeof next === "string") {
			if (ids.has(next)) {
				found.add(next);
			}
		} else if (Array.isArray(next)) {
			pending.push(...next);
		} else if (next !== null && typeof next === "object") {
			pending.push(...Object.values(next));
		}
	}
}

/**
 * For each asset id, the projects that refer to it. Ids no project uses map
 * to an empty list. The project's own id is never counted as a reference.
 */
export function assetUsage(
	projects: readonly Project[],
	ids: Iterable<string>
): Map<string, AssetProjectReference[]> {
	const wanted = new Set(ids);
	const usage = new Map<string, AssetProjectReference[]>();
	for (const id of wanted) {
		usage.set(id, []);
	}
	for (const project of projects) {
		const found = new Set<string>();
		const { id: _projectId, ...body } = project;
		collectReferencedIds(body, wanted, found);
		for (const id of found) {
			usage.get(id)?.push({ id: project.id, title: project.title });
		}
	}
	return usage;
}

/**
 * Split a bulk delete into assets that can go and assets that must stay:
 * missing ids and ids any project still uses are refused with the reason
 * and, for in-use media, the projects to edit first.
 */
export function planAssetDeletion(
	assets: readonly Pick<Asset, "id" | "name">[],
	projects: readonly Project[],
	ids: readonly string[]
): AssetDeletionPlan {
	const unique = [...new Set(ids)];
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	const usage = assetUsage(
		projects,
		unique.filter((id) => byId.has(id))
	);
	const deletable: string[] = [];
	const refused: RefusedAsset[] = [];
	for (const id of unique) {
		const asset = byId.get(id);
		if (!asset) {
			refused.push({ id, projects: [], reason: "not-found" });
			continue;
		}
		const users = usage.get(id) ?? [];
		if (users.length > 0) {
			refused.push({
				id,
				name: asset.name,
				projects: users,
				reason: "in-use",
			});
			continue;
		}
		deletable.push(id);
	}
	return { deletable, refused };
}

/** One-line summary of a bulk delete for a status bar. */
export function describeAssetDeletion(
	result: Pick<DeleteManyAssetsResponse, "deleted" | "refused">
): string {
	const deleted = result.deleted.length;
	const parts = [`Deleted ${deleted} media item${deleted === 1 ? "" : "s"}.`];
	const inUse = result.refused.filter((item) => item.reason === "in-use");
	if (inUse.length > 0) {
		const names = inUse
			.slice(0, 3)
			.map((item) => {
				const titles = item.projects.map((project) => project.title);
				return `${item.name ?? item.id} (used in ${titles.join(", ")})`;
			})
			.join("; ");
		const more = inUse.length > 3 ? `; and ${inUse.length - 3} more` : "";
		parts.push(
			`Kept ${inUse.length} in use: ${names}${more}. Remove their clips first.`
		);
	}
	const missing = result.refused.length - inUse.length;
	if (missing > 0) {
		parts.push(
			`${missing} item${missing === 1 ? " was" : "s were"} not found.`
		);
	}
	return parts.join(" ");
}
