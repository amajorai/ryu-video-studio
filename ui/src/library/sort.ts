/**
 * Media library ordering, filtering and view preferences (W1-L1). Pure and
 * deterministic: equal keys fall back to name, then id, so the list never
 * reshuffles between renders.
 */
import { z } from "zod";
import type { Asset } from "../../../shared/project.ts";

export const librarySortKeySchema = z.enum([
	"date",
	"name",
	"type",
	"duration",
	"size",
]);
export type LibrarySortKey = z.infer<typeof librarySortKeySchema>;

export const librarySortDirectionSchema = z.enum(["asc", "desc"]);
export type LibrarySortDirection = z.infer<typeof librarySortDirectionSchema>;

export const libraryViewSchema = z.enum(["list", "grid"]);
export type LibraryView = z.infer<typeof libraryViewSchema>;

export const libraryPreferencesSchema = z
	.object({
		direction: librarySortDirectionSchema,
		sort: librarySortKeySchema,
		view: libraryViewSchema,
	})
	.strict();
export type LibraryPreferences = z.infer<typeof libraryPreferencesSchema>;

/** Per-viewer storage key for the library's sort and view. */
export const LIBRARY_PREFERENCES_KEY = "library.preferences";

/** Newest first in a list, matching the order imports have always appeared. */
export const DEFAULT_LIBRARY_PREFERENCES: LibraryPreferences = {
	direction: "desc",
	sort: "date",
	view: "list",
};

export const LIBRARY_SORT_LABELS: Record<LibrarySortKey, string> = {
	date: "Date added",
	duration: "Duration",
	name: "Name",
	size: "Frame size",
	type: "Type",
};

/** The direction a sort key starts in when picked. */
export const LIBRARY_SORT_DEFAULT_DIRECTION: Record<
	LibrarySortKey,
	LibrarySortDirection
> = {
	date: "desc",
	duration: "desc",
	name: "asc",
	size: "desc",
	type: "asc",
};

const KIND_ORDER: Record<Asset["kind"], number> = {
	video: 0,
	image: 1,
	audio: 2,
};

const collator = new Intl.Collator(undefined, {
	numeric: true,
	sensitivity: "base",
});

type SortableAsset = Pick<
	Asset,
	"createdAt" | "duration" | "height" | "id" | "kind" | "name" | "width"
>;

function primaryCompare(
	key: LibrarySortKey,
	a: SortableAsset,
	b: SortableAsset
): number {
	switch (key) {
		case "date":
			return Date.parse(a.createdAt) - Date.parse(b.createdAt);
		case "duration":
			return a.duration - b.duration;
		case "size":
			// Audio has no frame; it sorts as the smallest.
			return a.width * a.height - b.width * b.height;
		case "type":
			return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
		default:
			return collator.compare(a.name, b.name);
	}
}

/**
 * Sort a copy of `assets` by `sort` in `direction`. Ties order by name
 * (always A to Z) and then id, so the result is stable and deterministic.
 */
export function sortAssets<Item extends SortableAsset>(
	assets: readonly Item[],
	sort: LibrarySortKey,
	direction: LibrarySortDirection
): Item[] {
	const sign = direction === "asc" ? 1 : -1;
	return [...assets].sort((a, b) => {
		const primary = primaryCompare(sort, a, b) * sign;
		if (primary !== 0) {
			return primary;
		}
		const byName = collator.compare(a.name, b.name);
		if (byName !== 0) {
			return byName;
		}
		return a.id < b.id ? -1 : Number(a.id > b.id);
	});
}

/** Assets whose name contains `query` (any case) inside `folder` (`""` = all). */
export function filterAssets<Item extends Pick<Asset, "folder" | "name">>(
	assets: readonly Item[],
	{ folder, query }: { folder: string; query: string }
): Item[] {
	const needle = query.trim().toLowerCase();
	return assets.filter(
		(asset) =>
			asset.name.toLowerCase().includes(needle) &&
			(!folder || asset.folder === folder)
	);
}

/** The sorted, distinct folders used by the library. */
export function libraryFolders(
	assets: readonly Pick<Asset, "folder">[]
): string[] {
	return [
		...new Set(assets.flatMap((asset) => (asset.folder ? [asset.folder] : []))),
	].sort();
}
