import { z } from "zod";
import {
	type Asset,
	type Project,
	titleSchema,
	validateProject,
} from "./project.ts";

const titlePatchSchema = titleSchema.omit({ id: true }).partial().strict();

export const titleEditRequestSchema = z
	.object({
		action: z.enum(["append", "remove", "replace", "update"]),
		patch: titlePatchSchema.default({}),
		revision: z.number().int().nonnegative(),
		titleId: z.uuid().optional(),
		titles: z.array(titleSchema).max(200).default([]),
	})
	.strict();

/** Apply one bounded title or lower-third edit without replacing the project body. */
export function editTitles(
	project: Project,
	assets: readonly Asset[],
	input: unknown
): Project {
	const request = titleEditRequestSchema.parse(input);
	if (request.action === "append") {
		return validateProject(
			{ ...project, titles: [...project.titles, ...request.titles] },
			[...assets]
		);
	}
	if (request.action === "replace") {
		return validateProject({ ...project, titles: request.titles }, [...assets]);
	}
	if (!request.titleId) {
		throw new Error("A titleId is required for this title edit.");
	}
	if (!project.titles.some((title) => title.id === request.titleId)) {
		throw new Error("Title not found.");
	}
	const titles =
		request.action === "remove"
			? project.titles.filter((title) => title.id !== request.titleId)
			: project.titles.map((title) =>
					title.id === request.titleId ? { ...title, ...request.patch } : title
				);
	return validateProject({ ...project, titles }, [...assets]);
}
