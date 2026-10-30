import { z } from "zod";
import {
	type Asset,
	assetSchema,
	projectSchema,
} from "../../../shared/project.ts";
import { request, uploadMedia } from "../bridge.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { studioFormat } from "../i18n/format.ts";
import { isLottieFile } from "../import/lottie-import.ts";
import { runLottieImport } from "./NewMediaMenu.tsx";

interface AssetOrganizationInput {
	delete: boolean;
	folder?: string;
	name?: string;
	projectRevisions?: Record<string, number>;
}

/** Upload picked files into the media library, one at a time. */
export const importFiles = (runtime: EditorRuntime, files: FileList | null) =>
	runtime.act(async () => {
		if (!files) {
			return;
		}
		const all = Array.from(files);
		const animations = all.filter(isLottieFile);
		const media = all.filter((file) => !isLottieFile(file));
		for (const file of animations) {
			// Lottie JSON and .lottie files become videos with transparency.
			await runLottieImport(runtime, file, runtime.project?.fps ?? 30);
		}
		if (!media.length) {
			return;
		}
		for (const file of media) {
			const asset = await uploadMedia(file, (progress) =>
				runtime.setStatus(
					studioFormat("Importing {name} · {percent}%", {
						name: file.name,
						percent: Math.round(progress * 100),
					})
				)
			);
			runtime.setAssets((current) => [asset, ...current]);
		}
		runtime.setStatus(
			"Media imported. Add it to the timeline from the library.",
			{ clearOn: "edit" }
		);
	});

/** Copy an HTTPS media URL into app-owned storage. */
export const importRemoteMedia = (
	runtime: EditorRuntime,
	value: string,
	onImported: () => void
) =>
	runtime.act(async () => {
		const url = value.trim();
		if (!url) {
			throw new Error("Enter an HTTPS media URL first.");
		}
		const parsed = new URL(url);
		const filename = parsed.pathname.split("/").filter(Boolean).at(-1);
		const asset = await request(assetSchema, "/assets/import", "POST", {
			name: filename || undefined,
			source: { url },
		});
		runtime.setAssets((current) => [asset, ...current]);
		onImported();
		runtime.setStatus(
			"Remote media imported. Add it to the timeline from the library.",
			{ clearOn: "edit" }
		);
	});

/**
 * Rename, refile, or delete an asset. Deleting saves pending edits first and
 * removes its clips from every project at the revisions this editor knows.
 */
export const organizeAsset = (
	runtime: EditorRuntime,
	asset: Asset,
	patch: { folder?: string; name?: string },
	options: { onDeleted?: (asset: Asset) => void; remove?: boolean } = {}
) =>
	runtime.act(async () => {
		const remove = options.remove ?? false;
		let currentProjects = runtime.projects;
		if (remove && runtime.dirty) {
			const saved = await runtime.save();
			currentProjects = currentProjects.map((item) =>
				item.id === saved.id ? saved : item
			);
		}
		const organizationInput: AssetOrganizationInput = {
			...patch,
			delete: remove,
		};
		if (remove) {
			organizationInput.projectRevisions = Object.fromEntries(
				currentProjects.map((item) => [item.id, item.revision])
			);
		}
		const result = await request(
			z.object({
				asset: assetSchema,
				clipsRemoved: z.number(),
				deleted: z.boolean(),
				projects: z.array(projectSchema),
			}),
			`/assets/${asset.id}/organize`,
			"POST",
			{ ...organizationInput }
		);
		if (!result.deleted) {
			runtime.setAssets((current) =>
				current.map((item) =>
					item.id === result.asset.id ? result.asset : item
				)
			);
			runtime.setStatus(
				studioFormat("{name} metadata saved.", { name: result.asset.name })
			);
			return;
		}
		runtime.setAssets((current) =>
			current.filter((item) => item.id !== asset.id)
		);
		options.onDeleted?.(asset);
		runtime.previewSources.remove(asset.id);
		runtime.setSources(runtime.previewSources.snapshot());
		runtime.setProjects(result.projects);
		const current = result.projects.find(
			(item) => item.id === runtime.project?.id
		);
		if (current) {
			runtime.setProject(current);
			if (
				runtime.selectedId &&
				!current.segments.some((segment) => segment.id === runtime.selectedId)
			) {
				runtime.setSelected(null);
			}
		} else {
			runtime.setProject(null);
			runtime.setSelected(null);
		}
		runtime.setStatus(
			studioFormat(
				"Deleted {name}; removed {count, plural, one {# timeline clip} other {# timeline clips}}.",
				{ count: result.clipsRemoved, name: asset.name }
			)
		);
	});

export const upscaleAsset = (
	runtime: EditorRuntime,
	asset: Asset,
	factor: 2 | 4
) =>
	runtime.act(async () => {
		const next = await request(
			assetSchema,
			`/assets/${asset.id}/upscale`,
			"POST",
			{ factor }
		);
		runtime.setAssets((current) => [next, ...current]);
		runtime.setStatus(
			studioFormat("{name} added to the media library.", { name: next.name })
		);
	});

export const refreshSequence = (runtime: EditorRuntime, asset: Asset) =>
	runtime.act(async () => {
		const next = await request(
			assetSchema,
			`/assets/${asset.id}/refresh-sequence`,
			"POST",
			{}
		);
		runtime.setAssets((current) =>
			current.map((item) => (item.id === next.id ? next : item))
		);
		runtime.setStatus(
			studioFormat("{name} refreshed from its source timeline.", {
				name: next.name,
			})
		);
	});
