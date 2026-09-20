import { z } from "zod";

export const productionActivityEventSchema = z
	.object({
		createdAt: z.iso.datetime(),
		detail: z.string().min(1).max(500),
		id: z.string().trim().min(1).max(160),
		kind: z.enum(["project", "generation", "render", "stage"]),
		status: z.string().trim().min(1).max(40),
		title: z.string().trim().min(1).max(160),
	})
	.strict();

export const productionActivitySchema = z
	.object({
		events: z.array(productionActivityEventSchema).max(200),
	})
	.strict();

export type ProductionActivity = z.infer<typeof productionActivitySchema>;

function bounded(value: string, limit: number): string {
	return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

export interface ActivityProject {
	avatars?: unknown[];
	brief?: string;
	graphics?: unknown[];
	id: string;
	meshes?: unknown[];
	requireApproval?: boolean;
	revision: number;
	scenes?: Array<{
		approved: boolean;
		assetIds: string[];
		reviewStatus?: string;
	}>;
	segments?: unknown[];
	spatialObjects?: unknown[];
	title: string;
	titles?: unknown[];
	updatedAt: string;
}

export interface ActivityGeneration {
	createdAt: string;
	id: string;
	message: string;
	request: {
		kind: string;
		model: string;
		prompt: string;
		rationale: string;
		route: string;
	};
	status: string;
}

export interface ActivityRender {
	createdAt: string;
	error?: string;
	id: string;
	review?: { passed?: boolean };
	revision: number;
	status: string;
}

export function productionActivity(
	project: ActivityProject,
	generations: ActivityGeneration[],
	renders: ActivityRender[]
): ProductionActivity {
	const hasScenes = Boolean(project.scenes?.length);
	const scenesHaveTakes =
		hasScenes && project.scenes?.every((scene) => scene.assetIds.length > 0);
	const approvalsReady =
		!project.requireApproval ||
		Boolean(
			scenesHaveTakes && project.scenes?.every((scene) => scene.approved)
		);
	const changesRequested =
		project.scenes?.filter(
			(scene) => scene.reviewStatus === "changes-requested"
		).length ?? 0;
	const hasTimeline = Boolean(
		project.segments?.length ||
			project.titles?.length ||
			project.graphics?.length ||
			project.avatars?.length ||
			project.spatialObjects?.length ||
			project.meshes?.length
	);
	const stages = [
		{
			detail: project.brief?.trim()
				? "A production brief is saved."
				: "Add a brief before drafting scenes.",
			id: "brief",
			status: project.brief?.trim() ? "ready" : "waiting",
			title: "Brief",
		},
		{
			detail: hasScenes
				? `${project.scenes?.length ?? 0} scene plan entries are saved.`
				: "No storyboard scenes are attached.",
			id: "storyboard",
			status: hasScenes ? "ready" : "waiting",
			title: "Storyboard",
		},
		{
			detail: scenesHaveTakes
				? "Every scene has a selected visual take."
				: "Select a visual take for every scene.",
			id: "takes",
			status: scenesHaveTakes ? "ready" : hasScenes ? "waiting" : "optional",
			title: "Takes",
		},
		{
			detail: approvalsReady
				? "Creative review is complete or not required."
				: changesRequested
					? `${changesRequested} scene${changesRequested === 1 ? " has" : "s have"} requested changes.`
					: "Creative approval is still waiting.",
			id: "approval",
			status: approvalsReady ? "ready" : "waiting",
			title: "Approval",
		},
		{
			detail: hasTimeline
				? "The editable timeline has composition content."
				: "Assemble the plan or add media to the timeline.",
			id: "assembly",
			status: hasTimeline ? "ready" : "waiting",
			title: "Assembly",
		},
	];
	const events = [
		{
			createdAt: project.updatedAt,
			detail: `Revision ${project.revision} is the current saved creative state.`,
			id: `project:${project.id}`,
			kind: "project" as const,
			status: "saved",
			title: project.title,
		},
		...stages.map((stage) => ({
			createdAt: project.updatedAt,
			detail: stage.detail,
			id: `stage:${stage.id}`,
			kind: "stage" as const,
			status: stage.status,
			title: stage.title,
		})),
		...generations.map((job) => ({
			createdAt: job.createdAt,
			detail: bounded(
				`${job.request.kind} · ${job.request.route} · ${job.request.prompt}${job.message ? ` · ${job.message}` : ""}`,
				500
			),
			id: `generation:${job.id}`,
			kind: "generation" as const,
			status: job.status,
			title: `Generate ${job.request.kind}`,
		})),
		...renders.map((job) => ({
			createdAt: job.createdAt,
			detail: bounded(
				`Revision ${job.revision}${job.review?.passed ? " · delivery review passed" : job.error ? ` · ${job.error}` : ""}`,
				500
			),
			id: `render:${job.id}`,
			kind: "render" as const,
			status: job.status,
			title: `Export ${job.status}`,
		})),
	].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return productionActivitySchema.parse({ events });
}
