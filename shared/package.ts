import { z } from "zod";
import { assetUsage } from "./asset-usage.ts";
import { type Credits, creditsForProject, creditsSchema } from "./credits.ts";
import { importedFontFile } from "./font-file.ts";
import { customFontIdsIn, lutIdsIn } from "./library-refs.ts";
import {
	type Asset,
	assetSchema,
	type Project,
	projectSchema,
} from "./project.ts";
import { type LutRecord, lutRecordSchema } from "./schema/color.ts";
import { type ImportedFont, importedFontSchema } from "./schema/font.ts";

export const projectPackageSchema = z
	.object({
		assets: z.array(assetSchema).max(2000),
		credits: creditsSchema,
		exportedAt: z.iso.datetime(),
		/**
		 * Imported title fonts the project uses (archives only); each file is
		 * at `fonts/<id>.<ttf|otf>` in the archive.
		 */
		fonts: z.array(importedFontSchema).max(100).optional(),
		format: z.literal("ryu.video-studio.package.v1"),
		/**
		 * Imported `.cube` LUTs the project grades with (archives only); each
		 * canonical file is at `luts/<id>.cube` in the archive.
		 */
		luts: z.array(lutRecordSchema).max(200).optional(),
		project: projectSchema,
	})
	.strict();

export type ProjectPackage = z.infer<typeof projectPackageSchema>;

/**
 * The editable package (`GET /projects/:id/package`): the project, the
 * clip and scene assets' metadata and the same credits as the credits route
 * and the archive, including the licenses of the imported fonts it uses
 * (pass the node's font library as `fonts`). Font files are not included.
 */
export function projectPackage(
	project: Project,
	assets: Asset[],
	fonts: readonly ImportedFont[] = [],
	exportedAt = new Date().toISOString()
): ProjectPackage {
	const used = new Set(project.segments.map((segment) => segment.assetId));
	for (const scene of project.scenes) {
		for (const assetId of scene.assetIds) {
			used.add(assetId);
		}
	}
	const includedAssets = assets.filter((asset) => used.has(asset.id));
	const credits: Credits = creditsForProject(project, includedAssets, fonts);
	return projectPackageSchema.parse({
		assets: includedAssets,
		credits,
		exportedAt,
		format: "ryu.video-studio.package.v1",
		project,
	});
}

/** Archive name of the package JSON inside a project archive. */
export const ARCHIVE_PACKAGE_NAME = "package.json";
/** Archive name of one asset's media file. */
export const archiveMediaName = (assetId: string) => `media/${assetId}`;
/** Archive name of one imported LUT's canonical `.cube` file. */
export const archiveLutName = (lutId: string) => `luts/${lutId}.cube`;
/** Archive name of one imported font file. */
export const archiveFontName = (font: Pick<ImportedFont, "format" | "id">) =>
	`fonts/${importedFontFile(font)}`;

/** The node's LUT and font libraries, for {@link projectArchivePackage}. */
export interface ArchiveLibraries {
	fonts: readonly ImportedFont[];
	luts: readonly LutRecord[];
}

/**
 * The package for a self-contained project archive: every library asset the
 * project refers to anywhere (clips, scenes, backgrounds, lip-sync sources,
 * and the rest), not only clips and scenes, plus the records of every
 * imported LUT (`lutId`) and imported title font (`customFont`) it uses.
 * Preview proxies are left out; the importing node makes its own. A LUT or
 * font id that is not in `libraries` is left out here and reported by the
 * archive builder.
 */
export function projectArchivePackage(
	project: Project,
	assets: Asset[],
	libraries: ArchiveLibraries = { fonts: [], luts: [] },
	exportedAt = new Date().toISOString()
): ProjectPackage {
	const lutIds = lutIdsIn(project);
	const fontIds = customFontIdsIn(project);
	const luts = libraries.luts.filter((lut) => lutIds.has(lut.id));
	const fonts = libraries.fonts.filter((font) => fontIds.has(font.id));
	const usage = assetUsage(
		[project],
		assets.map((asset) => asset.id)
	);
	const included = assets.filter(
		(asset) =>
			(usage.get(asset.id)?.length ?? 0) > 0 && asset.derivation !== "proxy"
	);
	return projectPackageSchema.parse({
		assets: included,
		credits: creditsForProject(project, included, fonts),
		exportedAt,
		...(fonts.length ? { fonts } : {}),
		format: "ryu.video-studio.package.v1",
		...(luts.length ? { luts } : {}),
		project,
	});
}
