import { RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import {
	type ProductionStageId,
	transitionProductionStage,
} from "../../shared/production-stages.ts";
import type { Project } from "../../shared/project.ts";

const labels: Record<ProductionStageId, string> = {
	assets: "Assets",
	compose: "Compose",
	edit: "Edit",
	proposal: "Proposal",
	research: "Research",
	scene_plan: "Scene plan",
	script: "Script",
};

export function ProductionStagesPanel({
	onChange,
	project,
}: {
	onChange: (project: Project) => void;
	project: Project;
}) {
	return (
		<RyuAppSection title="Pipeline checkpoints">
			<p className="text-muted-foreground">
				Advance the production in explicit stages. A stage must be started
				before it can complete; later stages stay pending until their
				predecessor is complete.
			</p>
			<div className="studio-activity-list">
				{project.stages.map((stage) => (
					<div className="studio-activity-item" key={stage.id}>
						<div>
							<strong>{labels[stage.id]}</strong>
							<small>{stage.note || "No checkpoint note."}</small>
						</div>
						<div className="flex gap-2">
							<span
								className={`studio-activity-status studio-activity-status-${stage.status}`}
							>
								{stage.status}
							</span>
							{stage.status === "pending" && (
								<Button
									onClick={() =>
										onChange(
											transitionProductionStage(project, {
												action: "start",
												revision: project.revision,
												stage: stage.id,
											})
										)
									}
									size="sm"
									variant="outline"
								>
									Start
								</Button>
							)}
							{stage.status === "active" && (
								<Button
									onClick={() =>
										onChange(
											transitionProductionStage(project, {
												action: "complete",
												revision: project.revision,
												stage: stage.id,
											})
										)
									}
									size="sm"
									variant="outline"
								>
									Complete
								</Button>
							)}
						</div>
					</div>
				))}
			</div>
		</RyuAppSection>
	);
}
