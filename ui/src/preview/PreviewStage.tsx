import { type ReactNode, useCallback, useState } from "react";
import type { Asset, Project } from "../../../shared/project.ts";
import { stageCameraAtTime } from "../../../shared/stage-camera.ts";
import {
	PreviewMediaRegistry,
	PreviewMediaRegistryContext,
} from "./compositor/media-registry.ts";
import {
	type CompositorPlan,
	compositorPlan,
	compositorZIndex,
} from "./compositor/plan.ts";
import { MaskHandles } from "./overlays/MaskHandles.tsx";
import { PreviewCropMode } from "./overlays/PreviewCropMode.tsx";
import { PreviewGuides } from "./overlays/PreviewGuides.tsx";
import { PreviewMarkers } from "./overlays/PreviewMarkers.tsx";
import { PreviewSlipTwoUp } from "./overlays/PreviewSlipTwoUp.tsx";
import { PreviewSnapGuides } from "./overlays/PreviewSnapGuides.tsx";
import { PreviewTrackingRegion } from "./overlays/PreviewTrackingRegion.tsx";
import { PreviewTransformHandles } from "./overlays/PreviewTransformHandles.tsx";
import { TextEditOverlay } from "./overlays/TextEditOverlay.tsx";
import { PreviewAdjustmentLayer } from "./PreviewAdjustmentLayer.tsx";
import { PreviewAvatars } from "./PreviewAvatars.tsx";
import { PreviewBlendCompositor } from "./PreviewBlendCompositor.tsx";
import { PreviewCaptions } from "./PreviewCaptions.tsx";
import { PreviewExactBlendFrame } from "./PreviewExactBlendFrame.tsx";
import { PreviewGraphics } from "./PreviewGraphics.tsx";
import {
	PreviewMediaLayer,
	usePreviewTransport,
} from "./PreviewMediaLayer.tsx";
import { PreviewMesh } from "./PreviewMesh.tsx";
import { PreviewStageObjects } from "./PreviewStageObjects.tsx";
import { PreviewTitles } from "./PreviewTitles.tsx";
import { PreviewViewport } from "./PreviewViewport.tsx";
import type { PreviewStyle } from "./preview-style.ts";
import { PreviewCanvasBackground } from "./stages/background.tsx";
import {
	previewSegmentAudible,
	previewSegmentVisible,
} from "./stages/visibility.ts";

export interface PreviewStageProps {
	assets: Asset[];
	onError?: (message: string) => void;
	/** Extra overlays drawn above every built-in layer and overlay. */
	overlays?: ReactNode;
	playing: boolean;
	project: Project;
	sources: Record<string, string>;
	time: number;
}

/**
 * The preview frame. Layer order (bottom to top): canvas background, media
 * clips (z-index by track), adjustment layers, titles, graphics, avatars,
 * stage objects, meshes, captions, then interactive overlays.
 *
 * While a blended clip is on screen and every stage of the media stack can
 * be drawn in WebGL2 (`compositorPlan`), `PreviewBlendCompositor` draws the
 * background and media clips into one canvas over the CSS media stack, with
 * the render's blend maths, below titles, graphics and captions. While its
 * frame is not drawn (media or masks still loading) the CSS stack shows
 * through. Otherwise (or without WebGL2) the CSS stack shows, with the
 * paused exact server frame for approximate modes; that frame also covers
 * the compositor while paused when a title or graphic blend is approximate.
 */
export function PreviewStage({
	project,
	assets,
	sources,
	time,
	playing,
	onError,
	overlays,
}: PreviewStageProps) {
	const camera = stageCameraAtTime(project.stageCamera, time);
	const frameStyle: PreviewStyle = {
		"--studio-preview-aspect-ratio": `${project.width}/${project.height}`,
		"--studio-preview-width": `min(100cqw, calc(100cqh * ${project.width / project.height}))`,
	};
	const overlayProps = { playing, project, time };
	const [registry] = useState(() => new PreviewMediaRegistry());
	const [compositorFailed, setCompositorFailed] = useState(false);
	// Whether the compositor canvas is on screen (drawn), not only planned.
	const [compositorShown, setCompositorShown] = useState(false);
	const { quality } = usePreviewTransport();
	const plan: CompositorPlan = compositorFailed
		? { active: false, gaps: [] }
		: compositorPlan(project, assets, time);
	const handleCompositorUnavailable = useCallback(
		(message: string) => {
			setCompositorFailed(true);
			onError?.(message);
		},
		[onError]
	);

	return (
		<PreviewMediaRegistryContext.Provider value={registry}>
			<PreviewViewport project={project}>
				<div
					className="studio-preview-frame"
					data-style-profile={project.styleProfile}
					style={frameStyle}
				>
					<PreviewCanvasBackground project={project} time={time} />
					{project.segments.map((s) => {
						const asset = assets.find((a) => a.id === s.assetId);
						const src = sources[s.assetId];
						return asset && src && previewSegmentVisible(project, s) ? (
							<PreviewMediaLayer
								asset={asset}
								audible={previewSegmentAudible(project, s)}
								fps={project.fps}
								key={`${s.id}:${asset.id}`}
								onError={onError}
								playing={playing}
								project={project}
								segment={s}
								src={src}
								time={time}
							/>
						) : null;
					})}
					{plan.active ? (
						<PreviewBlendCompositor
							onShownChange={setCompositorShown}
							onUnavailable={handleCompositorUnavailable}
							plan={plan}
							playing={playing}
							quality={quality}
							registry={registry}
							zIndex={compositorZIndex(plan)}
						/>
					) : null}
					<PreviewAdjustmentLayer project={project} time={time} />
					<PreviewExactBlendFrame
						compositorShown={plan.active && compositorShown}
						project={project}
						time={time}
					/>
					<PreviewTitles project={project} time={time} />
					<PreviewGraphics project={project} time={time} />
					<PreviewAvatars project={project} time={time} />
					<PreviewStageObjects camera={camera} project={project} time={time} />
					<PreviewMesh camera={camera} project={project} time={time} />
					<PreviewCaptions project={project} time={time} />
					<PreviewGuides {...overlayProps} />
					<PreviewSnapGuides {...overlayProps} />
					<PreviewMarkers {...overlayProps} />
					<PreviewCropMode {...overlayProps} />
					<MaskHandles {...overlayProps} />
					<PreviewTransformHandles {...overlayProps} />
					<TextEditOverlay {...overlayProps} />
					<PreviewSlipTwoUp {...overlayProps} />
					<PreviewTrackingRegion {...overlayProps} />
					{overlays}
				</div>
			</PreviewViewport>
		</PreviewMediaRegistryContext.Provider>
	);
}
