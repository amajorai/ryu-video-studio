import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
	ArchiveShelf,
	buildProjectArchive,
	importProjectArchive,
} from "../package-archive.ts";
import { ConflictError, type StudioStore } from "../store.ts";
import type { StudioRoute } from "./registry.ts";

/**
 * Self-contained project archives (ZIP of the package plus media). Both
 * directions are chunked like media uploads and downloads, because the app
 * bridge carries JSON bodies of at most 2 MB.
 */
const shelf = new ArchiveShelf();

interface ArchiveUpload {
	busy: boolean;
	id: string;
	offset: number;
	path: string;
	size: number;
	updated: number;
}
const uploads = new Map<string, ArchiveUpload>();
const UPLOAD_TTL_MS = 30 * 60_000;
const MAX_PENDING_UPLOADS = 2;

const offsetSchema = z.coerce.number().int().nonnegative();

const safeFilename = (title: string) =>
	`${
		title
			.replace(/[^\p{L}\p{N} _.-]+/gu, "")
			.trim()
			.slice(0, 80) || "project"
	}.ryu-video-project.zip`;

async function sweepUploads(now = Date.now()) {
	for (const upload of [...uploads.values()]) {
		if (!upload.busy && now - upload.updated > UPLOAD_TTL_MS) {
			uploads.delete(upload.id);
			await rm(upload.path, { force: true });
		}
	}
}

/** Build and shelve an archive; also answers `GET /projects/:id/package?media=1`. */
export async function projectArchiveResponse(
	store: StudioStore,
	id: string,
	json: <Payload>(body: Payload, status?: number) => Response
): Promise<Response> {
	const project = store.project(id);
	const built = await buildProjectArchive(store, project);
	const archive = await shelf.add(built, safeFilename(project.title));
	return json({
		archiveId: archive.id,
		assets: archive.package.assets.length,
		filename: archive.filename,
		fonts: archive.package.fonts?.length ?? 0,
		luts: archive.package.luts?.length ?? 0,
		missing: archive.missing,
		missingFonts: archive.missingFonts,
		missingLuts: archive.missingLuts,
		size: archive.size,
	});
}

export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "package-archive",
		method: "GET",
		operation: {
			id: "video_studio_build_project_archive",
			description:
				"Build a self-contained project archive: a ZIP of the editable package (package.json: project, every referenced library asset's metadata, and credits) plus each referenced asset's media file at media/<asset id> (preview proxies are left out), each imported LUT a clip grades with at luts/<lut id>.cube, and each imported title font at fonts/<font id>.<ttf|otf> (their library records are in package.json luts and fonts). Offline media is listed in missing, and LUTs or fonts gone from the library in missingLuts and missingFonts; they are left out. The archive is kept for an hour; download it in chunks with GET /package-archive-data?id=<archiveId>&offset=<n> until done. GET /projects/{id}/package?media=1 is an alias. Returns archiveId, filename, size, assets, luts, fonts, missing, missingLuts and missingFonts.",
		},
		handle: ({ id, json, store }) => projectArchiveResponse(store, id, json),
	},
	{
		scope: "root",
		path: "package-archive-data",
		method: "GET",
		operation: {
			id: "video_studio_project_archive_data",
			description:
				"Read one chunk of a built project archive (GET /projects/{id}/package-archive): base64 data from offset, the total size, and done on the last chunk. The archive is deleted after its last chunk is read.",
			query: [
				{
					name: "id",
					required: true,
					schema: { format: "uuid", type: "string" },
				},
				{ name: "offset", schema: { minimum: 0, type: "integer" } },
			],
		},
		handle: async ({ json, uploadLimits, url }) => {
			const archive = shelf.get(z.uuid().parse(url.searchParams.get("id")));
			if (!archive) {
				return json(
					{ code: "NOT_FOUND", message: "Archive not found or expired." },
					404
				);
			}
			const offset = offsetSchema.parse(url.searchParams.get("offset") ?? 0);
			if (offset > archive.size) {
				throw new Error("Offset exceeds the archive size.");
			}
			const chunk = uploadLimits.chunkSize;
			const data = await Bun.file(archive.path)
				.slice(offset, offset + chunk)
				.arrayBuffer();
			const done = offset + chunk >= archive.size;
			if (done) {
				await shelf.remove(archive.id);
			}
			return json({
				data: Buffer.from(data).toString("base64"),
				done,
				offset,
				size: archive.size,
			});
		},
	},
	{
		scope: "root",
		path: "package-archive-imports",
		method: "POST",
		operation: {
			id: "video_studio_start_project_archive_import",
			description:
				"Start importing a project archive (.ryu-video-project.zip): send its byte size; returns an import id and the chunk size. Then POST /package-archive-import-chunks {id, offset, data (base64)} for each chunk in order, and POST /package-archive-import-finish {id}.",
			body: z.object({ size: z.number().int().min(22) }).strict(),
		},
		handle: async ({ json, request, store, uploadLimits }) => {
			const input = z
				.object({
					size: z.number().int().min(22).max(uploadLimits.maxMediaBytes),
				})
				.strict()
				.parse(await request.json());
			await sweepUploads();
			if (uploads.size >= MAX_PENDING_UPLOADS) {
				throw new Error("Another project archive import is in progress.");
			}
			const id = crypto.randomUUID();
			const upload: ArchiveUpload = {
				busy: false,
				id,
				offset: 0,
				path: join(store.directory, "media", `${id}.archive-upload`),
				size: input.size,
				updated: Date.now(),
			};
			await Bun.write(upload.path, new Uint8Array());
			uploads.set(id, upload);
			return json({ chunkSize: uploadLimits.chunkSize, id }, 201);
		},
	},
	{
		scope: "root",
		path: "package-archive-import-chunks",
		method: "POST",
		operation: {
			id: "video_studio_project_archive_import_chunk",
			description:
				"Append one base64 chunk to a project archive import at its current offset. Returns the new offset.",
			body: z
				.object({ data: z.string(), id: z.uuid(), offset: z.number().int() })
				.strict(),
		},
		handle: async ({ json, request, uploadLimits }) => {
			const input = z
				.object({
					data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
					id: z.uuid(),
					offset: z.number().int().nonnegative(),
				})
				.strict()
				.parse(await request.json());
			const upload = uploads.get(input.id);
			if (!upload) {
				return json(
					{ code: "NOT_FOUND", message: "Import not found or expired." },
					404
				);
			}
			const bytes = Buffer.from(input.data, "base64");
			if (
				upload.busy ||
				!bytes.length ||
				bytes.length > uploadLimits.chunkSize ||
				input.offset !== upload.offset ||
				upload.offset + bytes.length > upload.size
			) {
				throw new ConflictError("Invalid archive offset or chunk size.");
			}
			upload.busy = true;
			try {
				const file = await open(upload.path, "a");
				try {
					await file.writeFile(bytes);
				} finally {
					await file.close();
				}
				upload.offset += bytes.length;
				upload.updated = Date.now();
			} finally {
				upload.busy = false;
			}
			return json({ offset: upload.offset });
		},
	},
	{
		scope: "root",
		path: "package-archive-import-finish",
		method: "POST",
		operation: {
			id: "video_studio_finish_project_archive_import",
			description:
				"Finish a project archive import: the archive is unpacked, its imported LUTs and title fonts are validated and re-registered in this node's LUT and font libraries under their original ids, each asset's media that is not already on this node is re-ingested under its original asset id (all ids are UUIDs, so an existing id is the same file and is reused), and the project is saved as a new copy titled '<title> (imported)'. Returns the project, added and reused asset ids, and luts and fonts as {added, reused} id lists.",
			body: z.object({ id: z.uuid() }).strict(),
		},
		handle: async ({ json, request, store, uploadLimits }) => {
			const { id } = z
				.object({ id: z.uuid() })
				.strict()
				.parse(await request.json());
			const upload = uploads.get(id);
			if (!upload) {
				return json(
					{ code: "NOT_FOUND", message: "Import not found or expired." },
					404
				);
			}
			if (upload.offset !== upload.size) {
				throw new Error("The archive upload is incomplete.");
			}
			upload.busy = true;
			try {
				const bytes = await Bun.file(upload.path).bytes();
				const result = await importProjectArchive(
					store,
					bytes,
					uploadLimits.maxMediaBytes
				);
				return json(result, 201);
			} finally {
				uploads.delete(id);
				await rm(upload.path, { force: true });
			}
		},
	},
];
