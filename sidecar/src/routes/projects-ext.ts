/**
 * Project library routes for the projects dashboard: summaries for the grid,
 * a cached poster frame per project revision, and revision-checked delete.
 */
import { existsSync } from "node:fs";
import { z } from "zod";
import {
	type ProjectSummary,
	posterTime,
	summarizeProject,
} from "../../../shared/project-summary.ts";
import { renderTimelineFrame } from "../capture.ts";
import { ProjectDeleteRefusedError, type StudioStore } from "../store.ts";
import type { ProjectRouteContext, StudioRoute } from "./registry.ts";

/** Summaries of every project in the library, most recently modified first. */
export function projectSummaries(store: StudioStore): ProjectSummary[] {
	const created = store.projectCreatedTimes();
	return store
		.projects()
		.map((project) =>
			summarizeProject(project, created.get(project.id) ?? project.updatedAt)
		);
}

const deleteQuerySchema = z
	.object({
		// Strict digits: `z.coerce.number()` would read an empty `revision=`
		// as 0 and delete a project still at revision 0.
		revision: z
			.string()
			.regex(/^\d+$/, "revision must be a non-negative integer.")
			.transform(Number)
			.pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)),
	})
	.strict();

/**
 * `DELETE /projects/:id/delete?revision=N`. Exported so a later shell change
 * can also answer `DELETE /projects/:id` with the same contract.
 */
export function deleteProjectResponse(context: ProjectRouteContext): Response {
	const query = deleteQuerySchema.parse(
		Object.fromEntries(context.url.searchParams)
	);
	try {
		const deleted = context.store.deleteProject(context.id, query.revision);
		return context.json({ deleted });
	} catch (error) {
		if (error instanceof ProjectDeleteRefusedError) {
			return context.json({ code: error.code, message: error.message }, 409);
		}
		throw error;
	}
}

/** `GET /projects/:id/poster`: the poster frame, rendered once per revision. */
export async function posterResponse(
	context: ProjectRouteContext
): Promise<Response> {
	const { store } = context;
	const project = store.project(context.id);
	const time = posterTime(project, store.assets());
	if (time === null) {
		return context.json(
			{
				code: "NO_POSTER",
				message: "This project has no visual content to show yet.",
			},
			404
		);
	}
	const path = store.posterPath(project.id, project.revision);
	const cached = existsSync(path);
	let bytes: Uint8Array;
	if (cached) {
		bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
	} else {
		bytes = await renderTimelineFrame(store, project, time, {
			signal: context.mediaSignal(context.request),
		});
		await Bun.write(path, bytes);
		store.prunePosters(project.id, project.revision);
	}
	return context.json({
		cached,
		data: Buffer.from(bytes).toString("base64"),
		height: project.height,
		mimeType: "image/png",
		projectId: project.id,
		revision: project.revision,
		time,
		width: project.width,
	});
}

export const routes: StudioRoute[] = [
	{
		scope: "root",
		path: "project-summaries",
		method: "GET",
		operation: {
			id: "video_studio_project_summaries",
			description:
				"List every project as a dashboard summary: id, title, revision, duration in seconds, segment count, canvas size, created and updated times, and posterUrl (the sidecar path of its poster frame). Lighter than GET /projects, which returns full timelines.",
		},
		handle: (context) =>
			context.json({ projects: projectSummaries(context.store) }),
	},
	{
		scope: "project",
		action: "poster",
		method: "GET",
		operation: {
			id: "video_studio_project_poster",
			description:
				"Return the project's poster frame as base64 PNG (data, mimeType, width, height, revision, time). The frame is the composited timeline at 0, or at the first visual element when the timeline opens on a gap, and is cached per revision. Answers 404 NO_POSTER when the project has no visual content.",
		},
		handle: posterResponse,
	},
	{
		scope: "project",
		action: "delete",
		method: "DELETE",
		operation: {
			id: "video_studio_delete_project",
			description:
				"Permanently delete a project with its saved history, export records, export files, and cached posters. Media in the library is kept; a nested-sequence render of this project stays as ordinary video media (listed in sequenceAssetIds) with its sequence link cleared. Requires the current revision; answers 409 CONFLICT for a stale revision, 409 RENDER_ACTIVE while an export of the project is pending or running, and 409 PROJECT_IN_USE while another project uses it as a nested sequence.",
			query: [
				{
					name: "revision",
					required: true,
					schema: { type: "integer", minimum: 0 },
				},
			],
		},
		handle: deleteProjectResponse,
	},
];
