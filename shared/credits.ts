import { z } from "zod";
import type { Asset, Project } from "./project.ts";
import { idSchema } from "./project.ts";

export const creditEntrySchema = z
	.object({
		assetId: idSchema,
		assetName: z.string().min(1).max(200),
		attribution: z.string().min(1).max(500),
		identifier: z.string().min(1).max(200),
		licenseUrl: z.string().url().optional(),
		pageUrl: z.string().url(),
		provider: z.string().min(1).max(80),
		rights: z.string().min(1).max(2000),
	})
	.strict();

export const creditsSchema = z
	.object({
		entries: z.array(creditEntrySchema).max(200),
		projectId: idSchema,
		projectRevision: z.number().int().nonnegative(),
		projectTitle: z.string().min(1).max(200),
	})
	.strict();

export type CreditEntry = z.infer<typeof creditEntrySchema>;
export type Credits = z.infer<typeof creditsSchema>;

export function creditsForProject(project: Project, assets: Asset[]): Credits {
	const used = new Set(project.segments.map((segment) => segment.assetId));
	for (const scene of project.scenes) {
		for (const assetId of scene.assetIds) {
			used.add(assetId);
		}
	}
	const entries = assets
		.filter((asset) => used.has(asset.id) && asset.origin)
		.map((asset) => {
			const origin = asset.origin;
			if (!origin) {
				return null;
			}
			return creditEntrySchema.parse({
				assetId: asset.id,
				assetName: asset.name,
				attribution: origin.attribution,
				identifier: origin.identifier,
				...(origin.licenseUrl ? { licenseUrl: origin.licenseUrl } : {}),
				pageUrl: origin.pageUrl,
				provider: origin.provider,
				rights: origin.rights,
			});
		})
		.filter((entry): entry is CreditEntry => entry !== null);
	return creditsSchema.parse({
		entries,
		projectId: project.id,
		projectRevision: project.revision,
		projectTitle: project.title,
	});
}

export function creditsMarkdown(credits: Credits): string {
	const lines = [
		`# Credits — ${credits.projectTitle}`,
		"",
		`Project revision: ${credits.projectRevision}`,
		"",
		"## Sources",
		...(credits.entries.length
			? credits.entries.flatMap((entry) => [
					`- **${entry.assetName}** — ${entry.attribution}`,
					`  Provider: ${entry.provider}; identifier: ${entry.identifier}`,
					`  Rights: ${entry.rights}`,
					`  Source: ${entry.pageUrl}`,
					...(entry.licenseUrl ? [`  License: ${entry.licenseUrl}`] : []),
					"",
				])
			: ["No attributed source media is used in this project.", ""]),
	];
	return `${lines.join("\n")}\n`;
}
