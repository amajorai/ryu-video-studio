import {
	RyuAppEmpty,
	RyuAppMain,
	RyuAppToolbar,
} from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { AgentHandoffDialog } from "./agent/AgentHandoffDialog.tsx";
import {
	AutosaveConflictBanner,
	AutosaveProvider,
} from "./editor/AutosaveIndicator.tsx";
import { hasRenderableContent } from "./editor/actions/export.ts";
import { togglePlayback } from "./editor/actions/playback.ts";
import { EditorProvider } from "./editor/context.tsx";
import { clock } from "./editor/format.ts";
import { openProject } from "./editor/project-actions.ts";
import type { EditorRuntime } from "./editor/runtime.ts";
import { ClipInspector } from "./inspector/ClipInspector.tsx";
import { Preview } from "./Preview.tsx";
import { LibraryTabs } from "./panels/LibraryTabs.tsx";
import { PreviewTabsPanel } from "./preview/PreviewTabs.tsx";
import { ProjectTabs } from "./projects/ProjectTabs.tsx";
import { MediaMismatchPrompt } from "./settings/MediaMismatchPrompt.tsx";
import { ConnectedShortcutsDialog } from "./shortcuts/ShortcutsDialog.tsx";
import { Timeline } from "./timeline/Timeline.tsx";
import { StudioToolbarActions } from "./toolbar/StudioToolbarActions.tsx";
import { WorkspaceLayout } from "./workspace/WorkspaceLayout.tsx";

export interface StudioAppShellProps {
	ready: boolean;
	reportPreviewError: (text: string) => void;
	runtime: EditorRuntime;
	sources: Record<string, string>;
	status: string;
}

/** The editor's chrome: toolbar, status line, banners, and the workspace. */
export function StudioAppShell({
	ready,
	reportPreviewError,
	runtime,
	sources,
	status,
}: StudioAppShellProps) {
	const tl = useLiteralMessages();
	const {
		assets,
		busy,
		duration,
		playing,
		project,
		projects,
		setPlaybackDirection: setDirection,
		time,
	} = runtime;
	return (
		<EditorProvider value={runtime}>
			<AutosaveProvider>
				<div className="studio-app">
					<RyuAppToolbar className="studio-toolbar">
						<strong>Video Studio</strong>
						<NativeSelect
							aria-label="Project"
							className="min-w-[9rem]"
							disabled={!ready || busy}
							onChange={(event) =>
								void openProject(runtime, event.target.value)
							}
							value={project?.id ?? ""}
						>
							{!project && (
								<NativeSelectOption value="">
									Your film library
								</NativeSelectOption>
							)}
							{projects.map((p) => (
								<NativeSelectOption key={p.id} value={p.id}>
									{p.title}
								</NativeSelectOption>
							))}
						</NativeSelect>
						<StudioToolbarActions ready={ready} />
					</RyuAppToolbar>
					<ProjectTabs />
					<div aria-live="polite" className="studio-status" role="status">
						{status}
					</div>
					<div className="studio-banner empty:hidden">
						<AutosaveConflictBanner />
					</div>
					{project ? (
						<div
							aria-label="Media settings"
							className="studio-banner empty:hidden"
							role="region"
						>
							<MediaMismatchPrompt />
						</div>
					) : null}
					{project ? <AgentHandoffDialog /> : null}
					<ConnectedShortcutsDialog />
					{project ? (
						<WorkspaceLayout
							busy={busy}
							inspector={<ClipInspector />}
							library={<LibraryTabs />}
							stage={
								<main className="studio-stage">
									<div className="studio-stage-heading">
										<span>{project.title}</span>
										<span>
											{tl("{width} × {height} · {fps} fps", {
												fps: project.fps,
												height: project.height,
												width: project.width,
											})}
										</span>
									</div>
									<PreviewTabsPanel>
										<div className="studio-preview">
											<Preview
												assets={assets}
												onError={reportPreviewError}
												playing={playing}
												project={project}
												sources={sources}
												time={time}
											/>
											{!hasRenderableContent(project) && (
												<p className="studio-preview-empty">
													Add media, graphics, an avatar, a mesh, or a 3D block
													to start your timeline
												</p>
											)}
										</div>
										<div className="studio-playback">
											<Button
												aria-label={
													playing ? "Pause playback" : "Play timeline"
												}
												disabled={!duration}
												onClick={() => {
													setDirection(1);
													togglePlayback(runtime);
												}}
												variant="ghost"
											>
												{playing ? "Pause" : "Play"}
											</Button>
											<span className="font-mono">
												{clock(time)} / {clock(duration)}
											</span>
										</div>
									</PreviewTabsPanel>
								</main>
							}
							timeline={<Timeline />}
						/>
					) : (
						<RyuAppMain>
							<RyuAppEmpty
								description="Import your footage, build a timeline, and shape each scene. Your projects and exports stay on your Ryu node."
								title="A place for your next film"
							/>
						</RyuAppMain>
					)}
				</div>
			</AutosaveProvider>
		</EditorProvider>
	);
}
