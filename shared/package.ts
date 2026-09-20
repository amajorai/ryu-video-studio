import { z } from "zod";
import { type Credits, creditsForProject, creditsSchema } from "./credits.ts";
import {
	type Asset,
	assetSchema,
	type Project,
	projectSchema,
} from "./project.ts";

export const projectPackageSchema = z
	.object({
		assets: z.array(assetSchema).max(2000),
		credits: creditsSchema,
		exportedAt: z.iso.datetime(),
		format: z.literal("ryu.video-studio.package.v1"),
		project: projectSchema,
	})
	.strict();

export type ProjectPackage = z.infer<typeof projectPackageSchema>;

export function projectPackage(
	project: Project,
	assets: Asset[],
	exportedAt = new Date().toISOString()
): ProjectPackage {
	const used = new Set(project.segments.map((segment) => segment.assetId));
	for (const scene of project.scenes) {
		for (const assetId of scene.assetIds) {
			used.add(assetId);
		}
	}
	const includedAssets = assets.filter((asset) => used.has(asset.id));
	const credits: Credits = creditsForProject(project, includedAssets);
	return projectPackageSchema.parse({
		assets: includedAssets,
		credits,
		exportedAt,
		format: "ryu.video-studio.package.v1",
		project,
	});
}
