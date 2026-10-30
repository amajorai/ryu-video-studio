import { z } from "zod";
import { generationTaskSchema, TASK_LABELS } from "./generation-models.ts";
import { customFontIdsIn } from "./library-refs.ts";
import type { Asset, Project } from "./project.ts";
import { idSchema } from "./project.ts";
import { fontOriginSchema, type ImportedFont } from "./schema/font.ts";

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

/** Provenance of host-generated media the project uses. */
export const generatedCreditSchema = z
	.object({
		assetId: idSchema,
		assetName: z.string().min(1).max(200),
		kind: z.enum(["image", "video", "audio"]),
		/** The provider and model the host ran; "Ryu default" when unset. */
		provider: z.string().min(1).max(200),
		model: z.string().min(1).max(200),
		task: generationTaskSchema.optional(),
		/** Set when the sender accepted the likeness consent notice. */
		consent: z.literal("subjects-agreed").optional(),
	})
	.strict();
export type GeneratedCredit = z.infer<typeof generatedCreditSchema>;

/** An online-catalog font the project's titles or captions use, with its license. */
export const fontCreditSchema = z
	.object({
		family: z.string().min(1).max(64),
		fontId: idSchema,
		origin: fontOriginSchema,
	})
	.strict();
export type FontCredit = z.infer<typeof fontCreditSchema>;

export const creditsSchema = z
	.object({
		entries: z.array(creditEntrySchema).max(200),
		/** Fonts added from an online catalog; absent when none is used. */
		fonts: z.array(fontCreditSchema).max(100).optional(),
		/** Generated media and the model that made it; absent when none is used. */
		generated: z.array(generatedCreditSchema).max(200).optional(),
		projectId: idSchema,
		projectRevision: z.number().int().nonnegative(),
		projectTitle: z.string().min(1).max(200),
	})
	.strict();

export type CreditEntry = z.infer<typeof creditEntrySchema>;
export type Credits = z.infer<typeof creditsSchema>;

export function creditsForProject(
	project: Project,
	assets: Asset[],
	fonts: readonly ImportedFont[] = []
): Credits {
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
			const credit: CreditEntry = {
				assetId: asset.id,
				assetName: asset.name,
				attribution: origin.attribution,
				identifier: origin.identifier,
				pageUrl: origin.pageUrl,
				provider: origin.provider,
				rights: origin.rights,
			};
			if (origin.licenseUrl) {
				credit.licenseUrl = origin.licenseUrl;
			}
			return creditEntrySchema.parse(credit);
		})
		.filter((entry): entry is CreditEntry => entry !== null);
	const generated: GeneratedCredit[] = [];
	for (const asset of assets) {
		const stamp = asset.generation;
		if (!(used.has(asset.id) && stamp)) {
			continue;
		}
		const credit: GeneratedCredit = {
			assetId: asset.id,
			assetName: asset.name,
			kind: stamp.kind,
			model: stamp.model ?? "Ryu default",
			provider: stamp.provider ?? "Ryu default",
		};
		if (stamp.task) {
			credit.task = stamp.task;
		}
		if (stamp.consent) {
			credit.consent = stamp.consent;
		}
		generated.push(credit);
	}
	const usedFonts = customFontIdsIn(project);
	const fontCredits: FontCredit[] = fonts.flatMap((font) =>
		font.origin && usedFonts.has(font.id)
			? [{ family: font.family, fontId: font.id, origin: font.origin }]
			: []
	);
	return creditsSchema.parse({
		entries,
		...(fontCredits.length ? { fonts: fontCredits.slice(0, 100) } : {}),
		...(generated.length ? { generated: generated.slice(0, 200) } : {}),
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
		...(credits.fonts?.length
			? [
					"## Fonts",
					...credits.fonts.flatMap((entry) => [
						`- **${entry.family}** — ${entry.origin.attribution}`,
						`  Provider: ${entry.origin.provider}; identifier: ${entry.origin.identifier}`,
						`  License: ${entry.origin.license} (${entry.origin.licenseUrl})`,
						`  Source: ${entry.origin.pageUrl}`,
						"",
					]),
				]
			: []),
		...(credits.generated?.length
			? [
					"## Generated media",
					...credits.generated.flatMap((entry) => [
						`- **${entry.assetName}** — ${entry.task ? TASK_LABELS[entry.task] : entry.kind}`,
						`  Provider: ${entry.provider}; model: ${entry.model}`,
						...(entry.consent
							? [
									"  Consent: the sender confirmed the people shown agreed to this use.",
								]
							: []),
						"",
					]),
				]
			: []),
	];
	return `${lines.join("\n")}\n`;
}
