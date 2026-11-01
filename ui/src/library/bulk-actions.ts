import {
	assetUsage,
	type DeleteManyAssetsResponse,
	deleteManyAssetsResponseSchema,
	describeAssetDeletion,
} from "../../../shared/asset-usage.ts";
import type { Asset, Project } from "../../../shared/project.ts";
import { request } from "../bridge.ts";
import type { EditorRuntime } from "../editor/runtime.ts";

/**
 * Which selected assets a project uses, from the projects this editor knows
 * (the open one including unsaved edits). The confirm dialog shows them so
 * the user knows what a bulk delete will keep before asking the sidecar.
 */
export function selectedAssetsInUse(
	projects: readonly Project[],
	current: Project | null,
	ids: readonly string[]
): Map<string, string[]> {
	const known = current
		? [...projects.filter((project) => project.id !== current.id), current]
		: projects;
	const usage = assetUsage(known, ids);
	const inUse = new Map<string, string[]>();
	for (const [id, users] of usage) {
		if (users.length > 0) {
			inUse.set(
				id,
				users.map((project) => project.title)
			);
		}
	}
	return inUse;
}

/**
 * Delete the selected assets that no project uses
 * (`POST /assets-delete-many`). Pending edits are saved first so a clip
 * added since the last save counts as a use. Assets in use stay, and the
 * status line names them and their projects.
 */
export const deleteSelectedAssets = (
	runtime: EditorRuntime,
	ids: readonly string[],
	onDeleted?: (deleted: Asset[]) => void
) =>
	runtime.act(async () => {
		if (ids.length === 0) {
			return;
		}
		if (runtime.dirty) {
			await runtime.save();
		}
		const result: DeleteManyAssetsResponse = await request(
			deleteManyAssetsResponseSchema,
			"/assets-delete-many",
			"POST",
			{ ids: [...ids] }
		);
		const gone = new Set(result.deleted);
		const removed = runtime.assets.filter((asset) => gone.has(asset.id));
		runtime.setAssets((current) =>
			current.filter((asset) => !gone.has(asset.id))
		);
		for (const id of gone) {
			runtime.previewSources.remove(id);
		}
		if (gone.size > 0) {
			runtime.setSources(runtime.previewSources.snapshot());
		}
		onDeleted?.(removed);
		runtime.setStatus(describeAssetDeletion(result));
	});
