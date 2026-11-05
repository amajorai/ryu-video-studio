import { z } from "zod";
import { type Project, projectDuration } from "../../../shared/project.ts";
import type { StudioRoute } from "./registry.ts";

const restoreHistoryRequestSchema = z
	.object({
		historyRevision: z.number().int().nonnegative(),
		revision: z.number().int().nonnegative(),
	})
	.strict();

/** `?summary=1` (or `true`) asks for the light revision list. */
const summaryFlagSchema = z
	.enum(["0", "1", "false", "true"])
	.nullable()
	.transform((value) => value === "1" || value === "true");

/** One saved revision, without its timeline, for cross-session history lists. */
export interface HistoryRevisionSummary {
	/** Timeline length in seconds. */
	duration: number;
	revision: number;
	segmentCount: number;
	title: string;
	/** When this revision was saved (ISO 8601). */
	updatedAt: string;
}

export interface HistorySummary {
	/** The project's current saved revision. */
	current: { revision: number; updatedAt: string };
	/** Earlier revisions that `POST history` can restore, newest first. */
	revisions: HistoryRevisionSummary[];
}

/** Summarise stored revisions (newest first) for the history panel. */
export function summarizeHistory(
	current: Pick<Project, "revision" | "updatedAt">,
	history: readonly Project[]
): HistorySummary {
	return {
		current: { revision: current.revision, updatedAt: current.updatedAt },
		revisions: history
			.map((project) => ({
				duration: projectDuration(project),
				revision: project.revision,
				segmentCount: project.segments.length,
				title: project.title,
				updatedAt: project.updatedAt,
			}))
			.sort((left, right) => right.revision - left.revision),
	};
}

export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "history",
		method: "GET",
		operation: {
			id: "video_studio_project_history",
			description:
				"Read up to 100 prior project revisions. With summary=1, return only each revision's number, save time, title, clip count, and duration plus the current revision, for listing restore points across sessions.",
			query: [
				{
					name: "summary",
					schema: { type: "string", enum: ["0", "1", "false", "true"] },
				},
			],
		},
		handle: ({ id, json, store, url }) => {
			const summary = summaryFlagSchema.parse(url.searchParams.get("summary"));
			const history = store.history(id);
			return json(
				summary ? summarizeHistory(store.project(id), history) : { history }
			);
		},
	},
	{
		scope: "project",
		action: "history",
		method: "POST",
		operation: {
			id: "video_studio_restore_project_history",
			description:
				"Restore a selected saved project revision as a new current revision. Requires the current revision and a historyRevision returned by GET.",
			body: restoreHistoryRequestSchema,
			bodyJsonSchema: {
				type: "object",
				properties: {
					historyRevision: { type: "integer", minimum: 0 },
					revision: { type: "integer", minimum: 0 },
				},
				required: ["historyRevision", "revision"],
			},
		},
		handle: async ({ id, json, request, store }) => {
			const input = restoreHistoryRequestSchema.parse(await request.json());
			return json(
				store.restoreHistory(id, input.revision, input.historyRevision)
			);
		},
	},
];
