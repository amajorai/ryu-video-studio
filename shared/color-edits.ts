import { z } from "zod";
import {
	type Asset,
	colorGradeSchema,
	type Project,
	trackSettingFor,
	validateProject,
} from "./project.ts";

const colorPatchSchema = colorGradeSchema.partial().strict();

export const colorEditRequestSchema = z
	.object({
		clipIds: z.array(z.uuid()).min(1).max(8),
		color: colorGradeSchema.optional(),
		patch: colorPatchSchema.default({}),
		reset: z.boolean().default(false),
		revision: z.number().int().nonnegative(),
		sourceClipId: z.uuid().optional(),
	})
	.strict()
	.superRefine((input, context) => {
		if (input.color && (input.reset || Object.keys(input.patch).length)) {
			context.addIssue({
				code: "custom",
				message: "Choose a complete color, a patch, or reset.",
				path: ["color"],
			});
		}
		if (input.sourceClipId && (input.reset || input.color)) {
			context.addIssue({
				code: "custom",
				message: "A source clip can only copy its saved color grade.",
				path: ["sourceClipId"],
			});
		}
	});

/** Apply or copy one bounded color grade to several visual clips. */
export function applyColor(
	project: Project,
	assets: readonly Asset[],
	input: unknown
): Project {
	const request = colorEditRequestSchema.parse(input);
	if (new Set(request.clipIds).size !== request.clipIds.length) {
		throw new Error("Choose each color target once.");
	}
	const targets = request.clipIds.map((id) => {
		const segment = project.segments.find((item) => item.id === id);
		if (!segment) {
			throw new Error("Color target clip not found.");
		}
		if (trackSettingFor(project, segment.track).locked) {
			throw new Error("Unlock every color target track before grading.");
		}
		if (
			assets.find((asset) => asset.id === segment.assetId)?.kind === "audio"
		) {
			throw new Error("Color grading only applies to visual clips.");
		}
		return segment;
	});
	let color = request.color;
	if (request.sourceClipId) {
		const source = project.segments.find(
			(segment) => segment.id === request.sourceClipId
		);
		if (!source) {
			throw new Error("Color source clip not found.");
		}
		color = source.colorGrade;
	}
	const targetIds = new Set(targets.map((segment) => segment.id));
	return validateProject(
		{
			...project,
			segments: project.segments.map((segment) => {
				if (!targetIds.has(segment.id)) {
					return segment;
				}
				if (request.reset) {
					return {
						...segment,
						colorGrade: colorGradeSchema.parse({}),
					};
				}
				if (color) {
					return { ...segment, colorGrade: colorGradeSchema.parse(color) };
				}
				return {
					...segment,
					colorGrade: colorGradeSchema.parse({
						...segment.colorGrade,
						...request.patch,
					}),
				};
			}),
		},
		[...assets]
	);
}
