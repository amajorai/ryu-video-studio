/**
 * Project library summaries for the projects dashboard and its agent route.
 *
 * Everything here is pure and deterministic: the sidecar builds summaries
 * from stored projects, and the dashboard searches and sorts them without
 * loading full timelines.
 */
import { z } from "zod";
import {
	type Asset,
	idSchema,
	type Project,
	projectDuration,
} from "./project.ts";
import { clipVisible } from "./sync-lock.ts";

export const projectSummarySchema = z
	.object({
		createdAt: z.iso.datetime(),
		duration: z.number().finite().nonnegative(),
		height: z.number().int().nonnegative(),
		id: idSchema,
		/** Sidecar path that returns the cached poster frame. */
		posterUrl: z.string().min(1).max(200),
		revision: z.number().int().nonnegative(),
		segmentCount: z.number().int().nonnegative(),
		title: z.string(),
		updatedAt: z.iso.datetime(),
		width: z.number().int().nonnegative(),
	})
	.strict();
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const projectSummariesResponseSchema = z
	.object({ projects: z.array(projectSummarySchema) })
	.strict();

export const projectSortSchema = z.enum(["modified", "created", "title"]);
export type ProjectSort = z.infer<typeof projectSortSchema>;

/** Sidecar path of a project's poster frame, relative to the API root. */
export const projectPosterPath = (id: string) => `/projects/${id}/poster`;

/** Summarize one project; `createdAt` comes from the store's library record. */
export function summarizeProject(
	project: Project,
	createdAt: string
): ProjectSummary {
	return {
		createdAt,
		duration: projectDuration(project),
		height: project.height,
		id: project.id,
		posterUrl: projectPosterPath(project.id),
		revision: project.revision,
		segmentCount: project.segments.length,
		title: project.title,
		updatedAt: project.updatedAt,
		width: project.width,
	};
}

/**
 * Start times of everything that draws pixels on the canvas. A clip counts
 * only when it is visible (neither the clip nor its track eye is hidden) and
 * draws a picture: any non-audio clip, or an audio clip shown as a waveform,
 * matching what the render composites.
 */
function visualStarts(project: Project, assets: readonly Asset[]): number[] {
	const kinds = new Map(assets.map((asset) => [asset.id, asset.kind]));
	return [
		...project.segments
			.filter(
				(segment) =>
					(kinds.get(segment.assetId) !== "audio" ||
						segment.visualization === "waveform") &&
					clipVisible(project, segment)
			)
			.map((segment) => segment.start),
		...project.titles.map((title) => title.start),
		...project.graphics.map((graphic) => graphic.start),
		...project.avatars.map((avatar) => avatar.start),
		...project.spatialObjects.map((object) => object.start),
		...project.meshes.map((mesh) => mesh.start),
	];
}

/**
 * The time a poster frame is taken at: 0 when the canvas has content there,
 * otherwise the first moment anything visual starts, so a timeline that opens
 * on a gap still gets a meaningful poster. `null` when nothing is visual.
 */
export function posterTime(
	project: Project,
	assets: readonly Asset[]
): number | null {
	const starts = visualStarts(project, assets);
	if (starts.length === 0) {
		return null;
	}
	return Math.max(0, Math.min(...starts));
}

/** Case-insensitive title search; every whitespace-separated term must match. */
export function filterProjectSummaries(
	summaries: readonly ProjectSummary[],
	query: string
): ProjectSummary[] {
	const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) {
		return [...summaries];
	}
	return summaries.filter((summary) => {
		const title = summary.title.toLocaleLowerCase();
		return terms.every((term) => title.includes(term));
	});
}

const byTitle = (left: ProjectSummary, right: ProjectSummary) =>
	left.title.localeCompare(right.title, undefined, {
		numeric: true,
		sensitivity: "base",
	});

/**
 * Sort summaries without mutating the input. Modified and created put the
 * newest first; title sorts naturally (A–Z, "Cut 2" before "Cut 10"). Ties fall
 * back to the title and then the id, so the order is fully deterministic.
 */
export function sortProjectSummaries(
	summaries: readonly ProjectSummary[],
	sort: ProjectSort
): ProjectSummary[] {
	const tieBreak = (left: ProjectSummary, right: ProjectSummary) =>
		byTitle(left, right) || left.id.localeCompare(right.id);
	return [...summaries].sort((left, right) => {
		if (sort === "title") {
			return tieBreak(left, right);
		}
		const key = sort === "created" ? "createdAt" : "updatedAt";
		const difference = Date.parse(right[key]) - Date.parse(left[key]);
		return difference || tieBreak(left, right);
	});
}
