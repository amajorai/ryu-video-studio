import { RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs.tsx";
import { useState } from "react";
import { applyLayout as applyLayoutPreset } from "../../../shared/layouts.ts";
import { withActiveCaptions } from "../../../shared/project.ts";
import {
	captionsForSource,
	highlightedCaptionsForSource,
} from "../../../shared/transcript.ts";
import { AvatarPanel } from "../AvatarPanel.tsx";
import { BeatCutPanel } from "../BeatCutPanel.tsx";
import { CleanupPanel } from "../CleanupPanel.tsx";
import { CreditsPanel } from "../CreditsPanel.tsx";
import { detachAudio } from "../editor/actions/audio-detach.ts";
import { addAssetToTimeline } from "../editor/actions/placement.ts";
import { narrateTitle } from "../editor/actions/title-narration.ts";
import { useEditorProject } from "../editor/context.tsx";
import { message } from "../editor/format.ts";
import {
	applyProjectRoute,
	makeHighlightShort,
	manageMulticam,
	markHighlight,
	removeTimelineRanges,
	syncProject,
} from "../editor/project-actions.ts";
import { GenerationPanel } from "../GenerationPanel.tsx";
import { GraphicsPanel } from "../GraphicsPanel.tsx";
import { HighlightsPanel } from "../HighlightsPanel.tsx";
import { LayoutPanel } from "../LayoutPanel.tsx";
import { AssetLibrary, type LibraryFilters } from "../library/AssetLibrary.tsx";
import { MeshPanel } from "../MeshPanel.tsx";
import { MulticamPanel } from "../MulticamPanel.tsx";
import { RecipePanel } from "../RecipePanel.tsx";
import { ReferencePanel } from "../ReferencePanel.tsx";
import { SearchPanel } from "../SearchPanel.tsx";
import { SpeedRampPanel } from "../SpeedRampPanel.tsx";
import { SplitEditPanel } from "../SplitEditPanel.tsx";
import { StagePanel } from "../StagePanel.tsx";
import { StockPanel } from "../StockPanel.tsx";
import { SyncPanel } from "../SyncPanel.tsx";
import { TitlesPanel } from "../TitlesPanel.tsx";
import { TranscriptPanel } from "../TranscriptPanel.tsx";
import { CaptionsPanel } from "./CaptionsPanel.tsx";
import { ExportHistoryPanel } from "./ExportHistoryPanel.tsx";
import { libraryTabs, RegisteredPanels } from "./registry.tsx";
import { StoryboardPanel } from "./StoryboardPanel.tsx";

/** Captions per project, matching the sidecar's schema bound. */
const CAPTION_COUNT_LIMIT = 5000;

/** The library column: category tabs and the open category's panels. */
export function LibraryTabs() {
	const tl = useLiteralMessages();
	const runtime = useEditorProject();
	const {
		assets,
		busy,
		edit,
		editingCaptions,
		ensureSaved,
		panel,
		project,
		setPanel,
		setStatus,
		time,
	} = runtime;
	const [filters, setFilters] = useState<LibraryFilters>({
		importUrl: "",
		mediaFolder: "",
		query: "",
	});
	const seek = (value: number) => {
		runtime.setPlaying(false);
		runtime.setTime(value);
	};
	return (
		<aside className="studio-library">
			<Tabs onValueChange={setPanel} value={panel}>
				<TabsList>
					{libraryTabs().map((tab) => (
						<TabsTrigger key={tab.value} value={tab.value}>
							{tab.label}
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>
			{panel === "search" && (
				<SearchPanel
					assets={assets}
					onRange={(assetId, start, end) => {
						const asset = assets.find((item) => item.id === assetId);
						if (!asset) {
							setStatus("The source media is unavailable.");
							return;
						}
						addAssetToTimeline(runtime, asset, { end, start });
					}}
					onStatus={setStatus}
				/>
			)}
			{panel === "stock" && (
				<RyuAppSection title="Open media">
					<StockPanel
						onAsset={(asset) => {
							runtime.setAssets((current) => [asset, ...current]);
						}}
						onStatus={setStatus}
					/>
				</RyuAppSection>
			)}
			{panel === "reference" && (
				<ReferencePanel
					assets={assets}
					captions={editingCaptions}
					onBrief={(brief) => {
						edit({ ...project, brief });
						setPanel("storyboard");
						setStatus("Reference brief copied to Plan.");
					}}
					onChange={(referenceProfile) =>
						edit({ ...project, referenceProfile })
					}
					onStatus={setStatus}
					profile={project.referenceProfile}
				/>
			)}
			{panel === "media" && (
				<AssetLibrary
					filters={filters}
					onFiltersChange={(patch) =>
						setFilters((current) => ({ ...current, ...patch }))
					}
				/>
			)}
			<div hidden={panel !== "transcript"}>
				<TranscriptPanel
					assets={assets}
					onStatus={setStatus}
					onUse={(transcript, highlighted) => {
						const cues = highlighted
							? highlightedCaptionsForSource(project, transcript)
							: captionsForSource(project, transcript);
						const kept = editingCaptions.filter(
							(cue) => cue.sourceAssetId !== transcript.assetId
						);
						if (cues.length + kept.length > CAPTION_COUNT_LIMIT) {
							setStatus(
								"These ranges exceed the 5,000-caption project limit. Shorten the timeline before applying."
							);
							return;
						}
						if (!cues.length) {
							setStatus(
								"Add this source to the timeline before applying its transcript."
							);
							return;
						}
						edit(withActiveCaptions(project, [...kept, ...cues]));
						setStatus(
							"Source transcript mapped onto the timeline, including trims and speed changes."
						);
					}}
				/>
			</div>
			{panel === "titles" && (
				<TitlesPanel
					onChange={(titles) => edit({ ...project, titles })}
					onNarrate={(titleId, voice) => narrateTitle(runtime, titleId, voice)}
					time={time}
					titles={project.titles}
				/>
			)}
			{panel === "graphics" && (
				<GraphicsPanel
					graphics={project.graphics}
					onChange={(graphics) => edit({ ...project, graphics })}
					styleProfile={project.styleProfile}
					time={time}
				/>
			)}
			{panel === "avatars" && (
				<AvatarPanel
					avatars={project.avatars}
					onChange={(avatars) => edit({ ...project, avatars })}
					time={time}
				/>
			)}
			{panel === "stage" && (
				<StagePanel
					camera={project.stageCamera}
					objects={project.spatialObjects}
					onCameraChange={(stageCamera) => edit({ ...project, stageCamera })}
					onChange={(spatialObjects) => edit({ ...project, spatialObjects })}
					onWorldChange={({ camera, objects, prompt }) =>
						edit({
							...project,
							spatialObjects: objects,
							stageCamera: camera,
							stageWorldPrompt: prompt,
						})
					}
					onWorldPromptChange={(stageWorldPrompt) =>
						edit({ ...project, stageWorldPrompt })
					}
					time={time}
					worldPrompt={project.stageWorldPrompt ?? ""}
				/>
			)}
			{panel === "meshes" && (
				<MeshPanel
					meshes={project.meshes}
					onChange={(meshes) => edit({ ...project, meshes })}
					onStatus={setStatus}
					time={time}
				/>
			)}
			{panel === "credits" && (
				<CreditsPanel
					onStatus={setStatus}
					projectId={project.id}
					revision={project.revision}
				/>
			)}
			{panel === "generate" && (
				<GenerationPanel
					assets={assets}
					onAsset={(asset) =>
						runtime.setAssets((current) => [asset, ...current])
					}
					onStatus={setStatus}
					productionBudget={project.productionBudget}
					projectId={project.id}
				/>
			)}
			{panel === "recipes" && (
				<RecipePanel
					assets={assets}
					busy={busy}
					onApply={(recipe) =>
						void applyProjectRoute(
							runtime,
							"recipe",
							{ ...recipe },
							"Recipe applied and saved. Review the timeline before exporting."
						)
					}
				/>
			)}
			{panel === "layouts" && (
				<LayoutPanel
					assets={assets}
					busy={busy}
					onApply={(layout, segmentIds, options) => {
						try {
							const next = applyLayoutPreset(
								project,
								segmentIds,
								layout,
								options
							);
							edit(next, `Apply ${layout} layout`);
							const first = next.segments.find(
								(segment) => segment.id === segmentIds[0]
							);
							if (first) {
								runtime.setSelected(first.id);
								runtime.setTime(first.start);
							}
							setStatus(
								tl("{layout} layout applied to {clipCount} clips.", {
									clipCount: String(segmentIds.length),
									layout,
								})
							);
						} catch (error) {
							setStatus(message(error));
						}
					}}
					project={project}
				/>
			)}
			{panel === "sync" && (
				<SyncPanel
					assets={assets}
					busy={busy}
					onSync={(input) => syncProject(runtime, input)}
					project={project}
				/>
			)}
			{panel === "multicam" && (
				<MulticamPanel
					assets={assets}
					busy={busy}
					onChange={(groupId, entries) =>
						void manageMulticam(
							runtime,
							{ action: "change", entries, groupId },
							"Camera angle switched over the selected range."
						)
					}
					onCreate={(input) =>
						void manageMulticam(
							runtime,
							{ action: "create", ...input },
							"Multicam session created with a program-audio track."
						)
					}
					onUngroup={(groupId) =>
						void manageMulticam(
							runtime,
							{ action: "ungroup", groupId },
							"Multicam metadata removed; timeline clips remain editable."
						)
					}
					project={project}
				/>
			)}
			{panel === "split-edits" && (
				<SplitEditPanel
					assets={assets}
					busy={busy}
					ensureSaved={ensureSaved}
					onApply={({ crossfade, proposals }) =>
						runtime.routeEdit(
							"split-edits",
							{ crossfade, proposals },
							(extras) => {
								const applied = Array.isArray(extras.applied)
									? extras.applied.length
									: proposals.length;
								const skipped = Array.isArray(extras.skipped)
									? extras.skipped.length
									: 0;
								return `Applied ${applied} split edit${applied === 1 ? "" : "s"}${skipped ? ` · ${skipped} skipped because the cut changed` : ""}.`;
							}
						)
					}
					onDetach={(clipIds) => detachAudio(runtime, clipIds)}
					onError={setStatus}
					onGuides={runtime.setTimelineGuides}
					onSeek={seek}
					project={project}
				/>
			)}
			{panel === "cleanup" && (
				<CleanupPanel
					busy={busy}
					ensureSaved={ensureSaved}
					onError={setStatus}
					onGuides={runtime.setTimelineGuides}
					onRemoveRanges={(ranges, description, stamp) =>
						removeTimelineRanges(runtime, ranges, description, stamp)
					}
					onSeek={seek}
					project={project}
				/>
			)}
			{panel === "highlights" && (
				<HighlightsPanel
					busy={busy}
					ensureSaved={ensureSaved}
					onError={setStatus}
					onGuides={runtime.setTimelineGuides}
					onMakeShort={(candidate, rank, stamp) =>
						void makeHighlightShort(runtime, candidate, rank, stamp)
					}
					onMark={(candidate, rank, stamp) =>
						markHighlight(runtime, candidate, rank, stamp)
					}
					onSeek={seek}
					project={project}
				/>
			)}
			{panel === "tempo" && (
				<>
					<SpeedRampPanel
						assets={assets}
						busy={busy}
						onEdit={runtime.localEdit}
						onError={setStatus}
						project={project}
						segment={runtime.selectedSegment}
					/>
					<BeatCutPanel
						assets={assets}
						busy={busy}
						onEdit={runtime.latestEdit}
						onError={setStatus}
						project={project}
						selectedIds={runtime.selectedIds}
					/>
				</>
			)}
			{panel === "storyboard" && <StoryboardPanel />}
			{panel === "captions" && <CaptionsPanel />}
			{panel === "exports" && <ExportHistoryPanel />}
			<RegisteredPanels value={panel} />
		</aside>
	);
}
