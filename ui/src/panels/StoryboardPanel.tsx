import { RyuAppField, RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Button, Input, Textarea } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useEffect, useState } from "react";
import {
	type ProductionReadiness,
	productionReadinessSchema,
} from "../../../shared/production-readiness.ts";
import {
	type Project,
	type SceneReviewStatus,
	sceneReviewStatusSchema,
} from "../../../shared/project.ts";
import { request } from "../bridge.ts";
import { DecisionLogPanel } from "../DecisionLogPanel.tsx";
import { useEditorProject } from "../editor/context.tsx";
import { message } from "../editor/format.ts";
import {
	appendProductionDecision,
	applyProjectRoute,
	approveScene,
	changeApprovalRequirement,
	draftScenes,
	newScene,
} from "../editor/project-actions.ts";
import { ProductionActivityPanel } from "../ProductionActivityPanel.tsx";
import { ProductionBudgetPanel } from "../ProductionBudgetPanel.tsx";
import { ProductionPreflightPanel } from "../ProductionPreflightPanel.tsx";
import { ProductionStagesPanel } from "../ProductionStagesPanel.tsx";
import { ResearchSourcesPanel } from "../ResearchSourcesPanel.tsx";
import { SceneContactSheet } from "../SceneContactSheet.tsx";
import { SceneMedia } from "../SceneMedia.tsx";

type Scene = Project["scenes"][number];

const sceneReviewStatus = (scene: Scene): SceneReviewStatus =>
	scene.approved
		? "approved"
		: scene.reviewStatus === "changes-requested"
			? "changes-requested"
			: "in-review";

const sceneReviewLabel = (status: SceneReviewStatus) =>
	status === "changes-requested"
		? "Changes requested"
		: status === "approved"
			? "Approved"
			: "In review";

/** The Plan tab: readiness, decisions, budget, brief, and scene review. */
export function StoryboardPanel() {
	const tl = useLiteralMessages();
	const runtime = useEditorProject();
	const { assets, busy, drafting, edit, project, setStatus } = runtime;
	const [readiness, setReadiness] = useState<ProductionReadiness | null>(null);
	useEffect(() => {
		let mounted = true;
		void request(productionReadinessSchema, `/projects/${project.id}/readiness`)
			.then((value) => {
				if (mounted) {
					setReadiness(value);
				}
			})
			.catch((error) => {
				if (mounted) {
					setStatus(message(error));
				}
			});
		return () => {
			mounted = false;
		};
	}, [project.id, project.revision, setStatus]);
	const editScene = (id: string, patch: Partial<Scene>) =>
		edit({
			...project,
			scenes: project.scenes.map((scene) =>
				scene.id === id ? { ...scene, ...patch } : scene
			),
		});
	/** Text edits reopen review: approval covers the exact words and direction. */
	const reviseScene = (id: string, patch: Partial<Scene>) =>
		editScene(id, { ...patch, approved: false, reviewStatus: "in-review" });
	return (
		<RyuAppSection title="Production plan">
			<ProductionPreflightPanel
				projectId={project.id}
				revision={project.revision}
			/>
			{readiness && (
				<RyuAppSection title="Production readiness">
					<p>
						{readiness.ready
							? "Delivery ready for the current saved revision."
							: readiness.exportReady
								? "Export gate ready. Run a render to complete delivery review."
								: "Resolve the blocked production gates before exporting."}
					</p>
					<ul>
						{readiness.checks.map((check) => (
							<li key={check.id}>
								<strong>{check.label}:</strong> {check.status} · {check.detail}
							</li>
						))}
					</ul>
				</RyuAppSection>
			)}
			<ProductionActivityPanel
				projectId={project.id}
				revision={project.revision}
			/>
			<DecisionLogPanel
				onAppend={(decision) => appendProductionDecision(runtime, decision)}
				project={project}
			/>
			<ResearchSourcesPanel
				onChange={(researchSources) => edit({ ...project, researchSources })}
				sources={project.researchSources}
			/>
			<ProductionStagesPanel
				onChange={(next) => edit(next)}
				project={project}
			/>
			<ProductionBudgetPanel
				budget={project.productionBudget}
				onChange={(productionBudget) => edit({ ...project, productionBudget })}
				projectId={project.id}
				revision={project.revision}
			/>
			<SceneContactSheet
				assets={assets}
				onStatus={setStatus}
				project={project}
				scenes={project.scenes}
			/>
			<RyuAppField label="Brief">
				<Textarea
					onChange={(event) => edit({ ...project, brief: event.target.value })}
					placeholder="What are we making, and who is it for?"
					value={project.brief}
				/>
			</RyuAppField>
			<Button
				disabled={
					busy ||
					drafting ||
					!project.brief.trim() ||
					!window.ryu?.model?.complete
				}
				onClick={() => void draftScenes(runtime)}
				variant="outline"
			>
				{drafting ? "Drafting scenes…" : "Draft scenes with Ryu"}
			</Button>
			<Button
				disabled={busy || !project.scenes.length}
				onClick={() =>
					void applyProjectRoute(
						runtime,
						"assemble",
						{ includeTitles: true },
						"Storyboard assembled into the timeline. Review the edit before exporting."
					)
				}
				variant="outline"
			>
				Assemble storyboard
			</Button>
			<Button onClick={() => newScene(runtime)} variant="outline">
				Add scene
			</Button>
			<Button
				disabled={busy}
				onClick={() => void changeApprovalRequirement(runtime)}
				variant={project.requireApproval ? "secondary" : "ghost"}
			>
				{project.requireApproval
					? "Scene approval required"
					: "Require scene approval"}
			</Button>
			{project.scenes.map((scene, index) => (
				<div className="studio-scene" key={scene.id}>
					<small>
						{tl("Scene {number} · {status}", {
							number: String(index + 1),
							status: tl(sceneReviewLabel(sceneReviewStatus(scene))),
						})}
					</small>
					<Input
						aria-label={tl("Scene {number} title", {
							number: String(index + 1),
						})}
						onChange={(event) =>
							reviseScene(scene.id, { title: event.target.value })
						}
						value={scene.title}
					/>
					<RyuAppField label="Spoken script">
						<Textarea
							aria-label={tl("Scene {number} script", {
								number: String(index + 1),
							})}
							maxLength={8000}
							onChange={(event) =>
								reviseScene(scene.id, { script: event.target.value })
							}
							placeholder="Words for the narrator"
							value={scene.script}
						/>
					</RyuAppField>
					<RyuAppField label="Visual direction">
						<Textarea
							aria-label={tl("Scene {number} visual direction", {
								number: String(index + 1),
							})}
							maxLength={8000}
							onChange={(event) =>
								reviseScene(scene.id, { prompt: event.target.value })
							}
							placeholder="Camera, setting, action, and visual treatment"
							value={scene.prompt}
						/>
					</RyuAppField>
					<RyuAppField label="Review status">
						<NativeSelect
							aria-label={tl("Scene {number} review status", {
								number: String(index + 1),
							})}
							disabled={scene.approved}
							onChange={(event) =>
								editScene(scene.id, {
									approved: false,
									reviewStatus: sceneReviewStatusSchema.parse(
										event.target.value
									),
								})
							}
							value={sceneReviewStatus(scene)}
						>
							<NativeSelectOption value="in-review">
								In review
							</NativeSelectOption>
							<NativeSelectOption value="changes-requested">
								Changes requested
							</NativeSelectOption>
							<NativeSelectOption disabled value="approved">
								Approved by review action
							</NativeSelectOption>
						</NativeSelect>
					</RyuAppField>
					<RyuAppField label="Review note">
						<Textarea
							aria-label={tl("Scene {number} review note", {
								number: String(index + 1),
							})}
							disabled={scene.approved}
							maxLength={2000}
							onChange={(event) =>
								editScene(scene.id, { reviewNotes: event.target.value })
							}
							placeholder="What needs to change before approval?"
							value={scene.reviewNotes ?? ""}
						/>
					</RyuAppField>
					{scene.approved && <small>Reopen review to edit this note.</small>}
					<SceneMedia
						assets={assets}
						index={index}
						onChange={(next) =>
							edit({
								...project,
								scenes: project.scenes.map((item) =>
									item.id === scene.id ? next : item
								),
							})
						}
						onError={setStatus}
						scene={scene}
					/>
					<Button
						disabled={!scene.assetIds.length || busy}
						onClick={() => void approveScene(runtime, scene)}
						size="sm"
						variant="outline"
					>
						{scene.approved ? "Reopen review" : "Approve scene"}
					</Button>
				</div>
			))}
		</RyuAppSection>
	);
}
