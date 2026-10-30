import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { z } from "zod";
import { projectSchema } from "../../../shared/project.ts";
import { download, loadAssets, request } from "../bridge.ts";
import { openFresh, withProject } from "./project-actions-open.ts";
import type { EditorRuntime } from "./runtime.ts";

/** English fallback until a caller passes the Companion's `tl`. */
const englishMessages: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

/** ZIP archives start with "PK\x03\x04". */
async function isZipFile(file: Blob): Promise<boolean> {
	const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
	return head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4;
}

const libraryImportSchema = z
	.object({ added: z.array(z.string()), reused: z.array(z.string()) })
	.default({ added: [], reused: [] });

const archiveChunkSchema = z.object({
	data: z.string(),
	done: z.boolean(),
	offset: z.number(),
	size: z.number(),
});

/**
 * Build a self-contained project archive (package JSON plus every referenced
 * media file) on the node and download it in chunks.
 */
export const downloadProjectArchive = (
	runtime: EditorRuntime,
	onProgress?: (fraction: number) => void,
	tl: LiteralMessage = englishMessages
) =>
	runtime.act(async () => {
		const saved = runtime.dirty ? await runtime.save() : runtime.project;
		if (!saved) {
			return;
		}
		runtime.setStatus("Packing the project and its media…");
		const built = await request(
			z.object({
				archiveId: z.string(),
				assets: z.number(),
				filename: z.string(),
				fonts: z.number().default(0),
				luts: z.number().default(0),
				missing: z.array(z.string()),
				missingFonts: z.array(z.string()).default([]),
				missingLuts: z.array(z.string()).default([]),
				size: z.number(),
			}),
			`/projects/${saved.id}/package-archive`
		);
		const parts: Uint8Array<ArrayBuffer>[] = [];
		for (let offset = 0; ; ) {
			const chunk = await request(
				archiveChunkSchema,
				`/package-archive-data?id=${encodeURIComponent(built.archiveId)}&offset=${offset}`
			);
			const bytes = Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0));
			parts.push(bytes);
			offset += bytes.length;
			onProgress?.(built.size ? offset / built.size : 1);
			runtime.setStatus(
				tl("Downloading the project archive · {percent}%", {
					percent: String(Math.round((offset / Math.max(1, built.size)) * 100)),
				})
			);
			if (chunk.done) {
				break;
			}
			if (!bytes.length) {
				throw new Error("The project archive download stopped early.");
			}
		}
		download(new Blob(parts, { type: "application/zip" }), built.filename);
		runtime.setStatus(archiveDownloadStatus(built, tl));
	});

/** Count values for an ICU plural whose `#` would group digits. */
const counted = (count: number) => ({ count, countLabel: String(count) });

/** The " plus 2 LUTs and 1 font" part of an archive status, or "". */
function libraryPart(luts: number, fonts: number, tl: LiteralMessage): string {
	const lutText = tl(
		"{count, plural, one {{countLabel} LUT} other {{countLabel} LUTs}}",
		counted(luts)
	);
	const fontText = tl(
		"{count, plural, one {{countLabel} font} other {{countLabel} fonts}}",
		counted(fonts)
	);
	if (luts && fonts) {
		return tl(" plus {luts} and {fonts}", { fonts: fontText, luts: lutText });
	}
	if (luts || fonts) {
		return tl(" plus {items}", { items: luts ? lutText : fontText });
	}
	return "";
}

/** Status line after a project archive download. */
export function archiveDownloadStatus(
	built: {
		assets: number;
		fonts: number;
		luts: number;
		missing: string[];
		missingFonts: string[];
		missingLuts: string[];
	},
	tl: LiteralMessage = englishMessages
): string {
	const media = built.missing.length
		? tl("{included} of {total} media files", {
				included: String(built.assets - built.missing.length),
				total: String(built.assets),
			})
		: tl(
				"{count, plural, one {{countLabel} media file} other {{countLabel} media files}}",
				counted(built.assets)
			);
	const left = [
		...(built.missing.length
			? [
					tl(
						"{count, plural, one {{countLabel} offline file} other {{countLabel} offline files}}",
						counted(built.missing.length)
					),
				]
			: []),
		...(built.missingLuts.length
			? [
					tl(
						"{count, plural, one {{countLabel} missing LUT} other {{countLabel} missing LUTs}}",
						counted(built.missingLuts.length)
					),
				]
			: []),
		...(built.missingFonts.length
			? [
					tl(
						"{count, plural, one {{countLabel} missing font} other {{countLabel} missing fonts}}",
						counted(built.missingFonts.length)
					),
				]
			: []),
	];
	return tl("Project archive downloaded with {media}{library}{leftOut}.", {
		leftOut: left.length
			? tl("; {items} left out", { items: left.join(", ") })
			: "",
		library: libraryPart(built.luts, built.fonts, tl),
		media,
	});
}

/** Upload a project archive in chunks and import it as a new project. */
async function importProjectArchive(
	runtime: EditorRuntime,
	file: File,
	tl: LiteralMessage
) {
	const started = await request(
		z.object({ chunkSize: z.number(), id: z.string() }),
		"/package-archive-imports",
		"POST",
		{ size: file.size }
	);
	for (let offset = 0; offset < file.size; ) {
		const bytes = new Uint8Array(
			await file.slice(offset, offset + started.chunkSize).arrayBuffer()
		);
		let binary = "";
		for (const byte of bytes) {
			binary += String.fromCharCode(byte);
		}
		const sent = await request(
			z.object({ offset: z.number() }),
			"/package-archive-import-chunks",
			"POST",
			{ data: btoa(binary), id: started.id, offset }
		);
		offset = sent.offset;
		runtime.setStatus(
			tl("Uploading the project archive · {percent}%", {
				percent: String(Math.round((offset / file.size) * 100)),
			})
		);
	}
	runtime.setStatus("Unpacking the project archive and its media…");
	const result = await request(
		z.object({
			added: z.array(z.string()),
			fonts: libraryImportSchema,
			luts: libraryImportSchema,
			project: projectSchema,
			reused: z.array(z.string()),
		}),
		"/package-archive-import-finish",
		"POST",
		{ id: started.id }
	);
	runtime.setAssets(await loadAssets());
	runtime.setProjects((current) => withProject(current, result.project));
	openFresh(runtime, result.project, { resetRange: false, resetTime: false });
	runtime.setDirty(false);
	runtime.setStatus(
		tl(
			"Project archive imported as a new project with {media}{library}{reused}.",
			{
				library: libraryPart(
					result.luts.added.length,
					result.fonts.added.length,
					tl
				),
				media: tl(
					"{count, plural, one {{countLabel} new media file} other {{countLabel} new media files}}",
					counted(result.added.length)
				),
				reused: result.reused.length
					? tl(" ({count} already in the library)", {
							count: String(result.reused.length),
						})
					: "",
			}
		)
	);
}

export async function importPackage(
	runtime: EditorRuntime,
	file: File,
	tl: LiteralMessage = englishMessages
) {
	if (await isZipFile(file)) {
		await importProjectArchive(runtime, file, tl);
		return;
	}
	const bundle = z.json().parse(JSON.parse(await file.text()));
	const imported = await request(
		projectSchema,
		"/projects/package",
		"POST",
		bundle
	);
	runtime.setProjects((current) => withProject(current, imported));
	openFresh(runtime, imported, { resetRange: false, resetTime: false });
	runtime.setDirty(false);
	runtime.setStatus("Production package imported as a new project.");
}
