import { z } from "zod";
import type { Asset, Project } from "./project.ts";
import { takeQuality } from "./take-quality.ts";

export const productionReadinessCheckSchema = z
	.object({
		detail: z.string().min(1).max(400),
		id: z.string().min(1).max(80),
		label: z.string().min(1).max(120),
		status: z.enum(["ready", "blocked", "optional"]),
	})
	.strict();

export const productionReadinessSchema = z
	.object({
		checks: z.array(productionReadinessCheckSchema).max(20),
		exportReady: z.boolean(),
		ready: z.boolean(),
	})
	.strict();

export type ProductionReadiness = z.infer<typeof productionReadinessSchema>;

export interface ProductionReadinessJob {
	projectId: string;
	review?: { passed?: boolean };
	revision: number;
	status: string;
}

function check(
	id: string,
	label: string,
	status: "ready" | "blocked" | "optional",
	detail: string
) {
	return { id, label, status, detail };
}

/**
 * Evaluate the production stages without inventing provider or cost facts.
 * Storyboard stages are optional for a direct timeline edit; when present,
 * their scripts, takes, and approvals become explicit gates.
 */
export function productionReadiness(
	project: Project,
	assets: Asset[],
	jobs: ProductionReadinessJob[]
): ProductionReadiness {
	const assetIds = new Set(assets.map((asset) => asset.id));
	const hasScenes = project.scenes.length > 0;
	const hasBrief = project.brief.trim().length > 0;
	const scenePlanReady =
		hasScenes &&
		project.scenes.every(
			(scene) =>
				scene.title.trim().length > 0 &&
				scene.script.trim().length > 0 &&
				scene.prompt.trim().length > 0
		);
	const sceneAssetsReady =
		hasScenes &&
		project.scenes.every(
			(scene) =>
				scene.assetIds.length > 0 &&
				scene.assetIds.every((assetId) => assetIds.has(assetId))
		);
	const approvalsReady =
		!project.requireApproval ||
		(project.scenes.length > 0 &&
			project.scenes.every(
				(scene) => scene.approved && scene.assetIds.length > 0
			));
	const changesRequested = project.scenes.filter(
		(scene) => scene.reviewStatus === "changes-requested"
	).length;
	const sceneQualityReady =
		hasScenes &&
		project.scenes.every((scene) => {
			const visual = scene.assetIds
				.map((assetId) => assets.find((asset) => asset.id === assetId))
				.find((asset) => asset?.kind !== "audio");
			return takeQuality(visual, project).status === "ready";
		});
	const timelineReady =
		project.segments.length > 0 ||
		project.titles.length > 0 ||
		project.graphics.length > 0 ||
		project.avatars.length > 0 ||
		project.spatialObjects.length > 0 ||
		project.meshes.length > 0;
	const currentDelivery = jobs.some(
		(job) =>
			job.projectId === project.id &&
			job.revision === project.revision &&
			job.status === "completed" &&
			job.review?.passed === true
	);
	const stillOnlyTimeline =
		project.segments.length > 0 &&
		project.segments.every((segment) => {
			const asset = assets.find(
				(candidate) => candidate.id === segment.assetId
			);
			return (
				asset?.kind === "image" &&
				segment.entryTransition === "none" &&
				segment.keyframes.length === 0
			);
		}) &&
		project.graphics.length === 0 &&
		project.avatars.length === 0 &&
		project.spatialObjects.length === 0 &&
		project.meshes.length === 0;

	const checks = [
		hasScenes
			? check(
					"brief",
					"Production brief",
					hasBrief ? "ready" : "blocked",
					hasBrief
						? "A reviewed brief is saved."
						: "Add a brief before drafting a storyboard."
				)
			: check(
					"brief",
					"Production brief",
					"optional",
					"Direct timeline edits can skip a production brief."
				),
		hasScenes
			? check(
					"take-quality",
					"Technical take quality",
					sceneQualityReady
						? "ready"
						: project.requireApproval
							? "blocked"
							: "optional",
					sceneQualityReady
						? "Every selected visual take passes bounded technical checks."
						: project.requireApproval
							? "Review low-resolution or empty visual takes before approving."
							: "Review selected takes before approving the production."
				)
			: check(
					"take-quality",
					"Technical take quality",
					"optional",
					"Draft scenes to review selected visual takes."
				),
		hasScenes
			? check(
					"scene-plan",
					"Scene plan",
					scenePlanReady ? "ready" : "blocked",
					scenePlanReady
						? `${project.scenes.length} scene${project.scenes.length === 1 ? "" : "s"} ${project.scenes.length === 1 ? "has" : "have"} scripts and visual direction.`
						: "Complete every scene title, spoken script, and visual direction."
				)
			: check(
					"scene-plan",
					"Scene plan",
					"optional",
					"No storyboard scenes are attached to this direct edit."
				),
		hasScenes
			? check(
					"assets",
					"Scene assets",
					sceneAssetsReady ? "ready" : "blocked",
					sceneAssetsReady
						? "Every scene has imported or generated media."
						: "Select a saved media take for every scene."
				)
			: check(
					"assets",
					"Scene assets",
					"optional",
					"Direct timeline edits choose media on the timeline."
				),
		project.requireApproval
			? check(
					"approval",
					"Creative approval",
					approvalsReady ? "ready" : "blocked",
					approvalsReady
						? "Every required scene is approved."
						: changesRequested
							? `${changesRequested} scene${changesRequested === 1 ? " has" : "s have"} requested changes before approval.`
							: "Approve every scene before exporting this gated production."
				)
			: check(
					"approval",
					"Creative approval",
					"optional",
					"Scene approval is not required for this project."
				),
		check(
			"timeline",
			"Timeline",
			timelineReady ? "ready" : "blocked",
			timelineReady
				? "The timeline contains media, a composition card, an avatar, a 3D block, or a mesh."
				: "Assemble a storyboard or add media before exporting."
		),
		check(
			"motion-quality",
			"Motion quality",
			stillOnlyTimeline ? "optional" : "ready",
			stillOnlyTimeline
				? "This timeline uses still images without motion controls. Review the slideshow promise before delivery."
				: "The timeline includes motion media or authored motion controls."
		),
		check(
			"delivery",
			"Delivery review",
			currentDelivery ? "ready" : "blocked",
			currentDelivery
				? "The current saved revision has a passing post-render review."
				: "Export the current revision and review its encoded output."
		),
	];
	const exportReady = checks
		.filter((item) => item.id !== "delivery")
		.every((item) => item.status !== "blocked");
	const ready = exportReady && currentDelivery;

	return productionReadinessSchema.parse({ checks, exportReady, ready });
}
