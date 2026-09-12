import { z } from "zod";
import {
	type Asset,
	exportCodecSchema,
	type Project,
	projectSchema,
	validateProject,
} from "./project.ts";
import { styleProfileSchema } from "./styles.ts";

const dimension = z.number().int().min(128).max(3840).multipleOf(2);
const fps = z.union([
	z.literal(24),
	z.literal(25),
	z.literal(30),
	z.literal(60),
]);
const aspectRatioPreset = z.enum([
	"16:9",
	"9:16",
	"1:1",
	"4:3",
	"9:14",
	"2.4:1",
]);
const aspectRatio = z.union([
	aspectRatioPreset,
	z
		.string()
		.regex(/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/)
		.refine((value) => {
			const [width, height] = value.split(":").map(Number);
			return (
				Number.isFinite(width) &&
				Number.isFinite(height) &&
				width > 0 &&
				height > 0 &&
				width / height >= 0.1 &&
				width / height <= 10
			);
		}, "Aspect ratio must be between 1:10 and 10:1."),
]);
const quality = z.enum(["720p", "1080p", "2K", "4K"]);
const qualityShortEdges = {
	"720p": 720,
	"1080p": 1080,
	"2K": 1440,
	"4K": 2160,
} as const;

export const projectSettingsRequestSchema = z
	.object({
		aspectRatio: aspectRatio.optional(),
		exportCodec: exportCodecSchema.optional(),
		exportPreset: projectSchema.shape.exportPreset.optional(),
		fps: fps.optional(),
		height: dimension.optional(),
		quality: quality.optional(),
		revision: z.number().int().nonnegative(),
		styleProfile: styleProfileSchema.optional(),
		width: dimension.optional(),
	})
	.strict()
	.refine(
		(input) =>
			(input.width === undefined) === (input.height === undefined) &&
			(input.width === undefined ||
				(input.aspectRatio === undefined && input.quality === undefined)) &&
			(input.width !== undefined ||
				input.height !== undefined ||
				input.aspectRatio !== undefined ||
				input.quality !== undefined ||
				input.fps !== undefined ||
				input.exportPreset !== undefined ||
				input.styleProfile !== undefined),
		"Provide width and height together, or an aspect ratio/quality preset, plus at least one setting."
	);
export type ProjectSettingsRequest = z.infer<
	typeof projectSettingsRequestSchema
>;

function evenDimension(value: number): number {
	return Math.max(128, Math.min(3840, Math.round(value / 2) * 2));
}

function ratioValue(value: string): number {
	const [width, height] = value.split(":").map(Number);
	if (
		!(Number.isFinite(width) && Number.isFinite(height)) ||
		width <= 0 ||
		height <= 0
	) {
		throw new Error("Aspect ratio must contain two positive numbers.");
	}
	return width / height;
}

function canvasFor(
	project: Project,
	settings: ProjectSettingsRequest
): { height: number; width: number } | null {
	if (settings.width !== undefined && settings.height !== undefined) {
		return { height: settings.height, width: settings.width };
	}
	if (settings.aspectRatio === undefined && settings.quality === undefined) {
		return null;
	}
	const ratio = ratioValue(
		settings.aspectRatio ?? `${project.width}:${project.height}`
	);
	const shortEdge =
		settings.quality === undefined
			? Math.min(project.width, project.height)
			: qualityShortEdges[settings.quality];
	let width = ratio >= 1 ? shortEdge * ratio : shortEdge;
	let height = ratio >= 1 ? shortEdge : shortEdge / ratio;
	const fit = Math.min(1, 3840 / width, 3840 / height);
	width = evenDimension(width * fit);
	height = evenDimension(height * fit);
	return { height, width };
}

/** Apply bounded canvas, aspect ratio, quality, frame-rate, and export-preset settings. */
export function updateProjectSettings(
	project: Project,
	assets: readonly Asset[],
	input: unknown
): Project {
	const settings = projectSettingsRequestSchema.parse(input);
	const canvas = canvasFor(project, settings);
	return validateProject(
		{
			...project,
			...(settings.exportPreset === undefined
				? {}
				: { exportPreset: settings.exportPreset }),
			...(settings.exportCodec === undefined
				? {}
				: { exportCodec: settings.exportCodec }),
			...(settings.styleProfile === undefined
				? {}
				: { styleProfile: settings.styleProfile }),
			...(settings.fps === undefined ? {} : { fps: settings.fps }),
			...(canvas === null ? {} : canvas),
		},
		[...assets]
	);
}
