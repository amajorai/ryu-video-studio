import { z } from "zod";
import {
	CubeLutError,
	MAX_CUBE_BYTES,
	MAX_LUT_REQUEST_BYTES,
} from "../../../shared/cube-lut.ts";
import { lutIdsIn } from "../../../shared/library-refs.ts";
import { LutInUseError, lutStoreFor } from "../lut-store.ts";
import type { StudioQueryParameter, StudioRoute } from "./registry.ts";

/** JSON import body: the `.cube` text and an optional display name. */
export const lutImportSchema = z
	.object({
		name: z.string().trim().max(120).default(""),
		cube: z.string().min(1).max(MAX_CUBE_BYTES),
	})
	.strict();

const idQuery: StudioQueryParameter = {
	name: "id",
	schema: { type: "string", format: "uuid" },
};

const lutId = (url: URL) => z.uuid().parse(url.searchParams.get("id"));

/** Read a JSON `{name, cube}` body or a multipart form with a `file` field. */
async function importBody(
	request: Request
): Promise<z.infer<typeof lutImportSchema>> {
	const type = request.headers.get("content-type") ?? "";
	if (!type.startsWith("multipart/form-data")) {
		return lutImportSchema.parse(await request.json());
	}
	const form = await request.formData();
	const file = form.get("file");
	if (!(file instanceof Blob)) {
		throw new Error("Attach the .cube file as the `file` field.");
	}
	if (file.size > MAX_LUT_REQUEST_BYTES) {
		throw new Error(
			"The LUT is larger than the 2 MB import limit. Export it at 33 points (or smaller)."
		);
	}
	const named = form.get("name");
	const fileName =
		file instanceof File ? file.name.replace(/\.cube$/i, "") : "";
	return lutImportSchema.parse({
		cube: await file.text(),
		name: typeof named === "string" && named.trim() ? named : fileName,
	});
}

export const routes: StudioRoute[] = [
	{
		scope: "root",
		path: "luts",
		method: "GET",
		operation: {
			id: "video_studio_luts",
			description:
				"List imported .cube LUTs ({luts}). With ?id=<lut id>, return that LUT's record and its canonical .cube text ({lut, cube}). Reference a LUT on a clip with colorGrade.lut = {lutId, intensity} through the color or clip-properties routes.",
			query: [idQuery],
		},
		handle: async ({ json, store, url }) => {
			const luts = lutStoreFor(store.directory);
			if (!url.searchParams.has("id")) {
				// A retired LUT that undo brought back into a project is listed
				// again, so the inspector can still name it.
				const inUse = lutIdsIn(store.projects());
				const restored = (await luts.retired()).filter((record) =>
					inUse.has(record.id)
				);
				return json({ luts: [...(await luts.list()), ...restored] });
			}
			const id = lutId(url);
			const record = await luts.get(id);
			if (!record) {
				return json({ code: "NOT_FOUND", message: "LUT not found." }, 404);
			}
			return json({ cube: await luts.read(id), lut: record });
		},
	},
	{
		scope: "root",
		path: "luts",
		method: "POST",
		operation: {
			id: "video_studio_import_lut",
			description:
				"Import a 3D .cube LUT (LUT_3D_SIZE 2-65) as JSON {name, cube} or as multipart form data with a `file` field. The whole request is limited to 2 MB, which fits typical 33-point LUTs but not most 65-point ones. The LUT is validated and stored in canonical form; returns its record.",
			body: lutImportSchema,
		},
		handle: async ({ json, request, store }) => {
			const input = await importBody(request);
			try {
				return json(
					await lutStoreFor(store.directory).add(input.name, input.cube),
					201
				);
			} catch (error) {
				if (error instanceof CubeLutError) {
					return json({ code: "INVALID_LUT", message: error.message }, 400);
				}
				throw error;
			}
		},
	},
	{
		scope: "root",
		path: "luts",
		method: "DELETE",
		operation: {
			id: "video_studio_delete_lut",
			description:
				"Delete the imported LUT named by ?id=<lut id>. Refused with LUT_IN_USE while any project still references it. When only saved undo history references it, it leaves the library but its file is kept (keptForHistory: true) so undo still renders; it is purged once no revision references it.",
			query: [{ ...idQuery, required: true }],
		},
		handle: async ({ json, store, url }) => {
			const id = lutId(url);
			const projects = store.projects();
			try {
				const { keptForHistory } = await lutStoreFor(store.directory).remove(
					id,
					projects,
					projects.flatMap((project) => store.history(project.id))
				);
				return json({ deleted: id, keptForHistory });
			} catch (error) {
				if (error instanceof LutInUseError) {
					return json({ code: "LUT_IN_USE", message: error.message }, 409);
				}
				throw error;
			}
		},
	},
];
