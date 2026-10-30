import { z } from "zod";
import {
	type Asset,
	type Project,
	titleSchema,
	validateProject,
} from "./project.ts";
import { customFontSchema, systemFontSchema } from "./schema/font.ts";
import { applyTextTemplate, TEXT_TEMPLATES } from "./text-templates.ts";

const titlePatchSchema = titleSchema.omit({ id: true }).partial().strict();
const templateIds = TEXT_TEMPLATES.map((template) => template.id) as [
	string,
	...string[],
];

export const titleEditRequestSchema = z
	.object({
		action: z.enum(["append", "remove", "replace", "update", "apply-template"]),
		/** An imported font for every title `apply-template` adds. */
		customFont: customFontSchema.optional(),
		patch: titlePatchSchema.default({}),
		revision: z.number().int().nonnegative(),
		/** Where `apply-template` places the template (seconds). */
		start: z.number().finite().min(0).max(7200).optional(),
		/** A system font for every title `apply-template` adds. */
		systemFont: systemFontSchema.optional(),
		/** The template `apply-template` adds (see `TEXT_TEMPLATES`). */
		templateId: z.enum(templateIds).optional(),
		/** Replacement text for each template title, in order. */
		texts: z.array(z.string().max(500)).max(4).optional(),
		titleId: z.uuid().optional(),
		titles: z.array(titleSchema).max(200).default([]),
	})
	.strict();

export type EditTitlesInput = z.input<typeof titleEditRequestSchema>;

/** Apply one bounded title or lower-third edit without replacing the project body. */
export function editTitles(
	project: Project,
	assets: readonly Asset[],
	input: EditTitlesInput
): Project {
	const request = titleEditRequestSchema.parse(input);
	if (request.action === "apply-template") {
		if (!request.templateId) {
			throw new Error("A templateId is required to apply a text template.");
		}
		return applyTextTemplate(project, assets, request.templateId, {
			font: { customFont: request.customFont, systemFont: request.systemFont },
			start: request.start ?? 0,
			texts: request.texts,
		});
	}
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
