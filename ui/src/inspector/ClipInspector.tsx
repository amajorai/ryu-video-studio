import { RyuAppActions, RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useState } from "react";
import {
	manageClipLinks,
	overlappingLinkCandidate,
} from "../../../shared/clip-links.ts";
import type { Keyframe, Segment } from "../../../shared/project.ts";
import { GapFillAction } from "../ai/GapFillAction.tsx";
import { useEditorProject } from "../editor/context.tsx";
import { message } from "../editor/format.ts";
import { ProjectSettingsPanel } from "../settings/ProjectSettingsPanel.tsx";
import {
	type ClipSectionProps,
	changeSelectedSegment,
} from "./section-props.ts";
import { AiEditSection } from "./sections/AiEditSection.tsx";
import { AudioSection } from "./sections/AudioSection.tsx";
import { BackgroundSection } from "./sections/BackgroundSection.tsx";
import { BlendSection } from "./sections/BlendSection.tsx";
import { ClipboardSection } from "./sections/ClipboardSection.tsx";
import { ClipMetaSection } from "./sections/ClipMetaSection.tsx";
import { ColorAdvancedSection } from "./sections/ColorAdvancedSection.tsx";
import { ColorSection } from "./sections/ColorSection.tsx";
import { DetachSection } from "./sections/DetachSection.tsx";
import { EffectsSection } from "./sections/EffectsSection.tsx";
import { KeyframesSection } from "./sections/KeyframesSection.tsx";
import { KeySection } from "./sections/KeySection.tsx";
import { MaskSection } from "./sections/MaskSection.tsx";
import { MediaToolsSection } from "./sections/MediaToolsSection.tsx";
import { SpeedSection } from "./sections/SpeedSection.tsx";
import { TransformSection } from "./sections/TransformSection.tsx";
import { TransitionSection } from "./sections/TransitionSection.tsx";

/** Link or unlink the inspected clip with its overlapping audio/video partner. */
function LinkActions({ segment }: { segment: Segment }) {
	const { assets, edit, project, setStatus } = useEditorProject();
	const linkCandidate = overlappingLinkCandidate(project, assets, segment.id);
	const manage = (input: Parameters<typeof manageClipLinks>[2]) => {
		try {
			edit(manageClipLinks(project, assets, input));
		} catch (error) {
			setStatus(message(error));
		}
	};
	return (
		<RyuAppActions>
			{segment.linkGroupId ? (
				<Button
					onClick={() =>
						manage({
							action: "unlink",
							clipIds: [segment.id],
							revision: project.revision,
						})
					}
					size="sm"
					variant="outline"
				>
					Unlink audio/video
				</Button>
			) : (
				<Button
					disabled={!linkCandidate}
					onClick={() => {
						if (linkCandidate) {
							manage({
								action: "link",
								clipIds: [segment.id, linkCandidate.id],
								revision: project.revision,
							});
						}
					}}
					size="sm"
					variant="outline"
				>
					Link overlapping audio/video
				</Button>
			)}
		</RyuAppActions>
	);
}

function ClipSections({
	animationProperty,
	onAnimationPropertyChange,
	segment,
}: {
	animationProperty: Keyframe["property"];
	onAnimationPropertyChange: (property: Keyframe["property"]) => void;
	segment: Segment;
}) {
	const runtime = useEditorProject();
	const isAudio =
		runtime.assets.find((asset) => asset.id === segment.assetId)?.kind ===
		"audio";
	const visualControls = !isAudio || segment.visualization === "waveform";
	const props: ClipSectionProps = {
		isAudio,
		onChange: (patch) => changeSelectedSegment(runtime, patch),
		segment,
		visualControls,
	};
	return (
		<>
			{runtime.selectedTrackLocked && (
				<small>
					Track locked · unlock it from the timeline header to edit.
				</small>
			)}
			<strong>
				{runtime.assets.find((asset) => asset.id === segment.assetId)?.name}
			</strong>
			<ClipMetaSection {...props} />
			<LinkActions segment={segment} />
			<DetachSection {...props} />
			<SpeedSection {...props} />
			<ClipboardSection {...props} />
			<TransformSection {...props} />
			<BlendSection {...props} />
			<ColorSection {...props} />
			<ColorAdvancedSection {...props} />
			<EffectsSection {...props} />
			<TransitionSection {...props} />
			<MaskSection {...props} />
			<KeySection {...props} />
			<BackgroundSection {...props} />
			<MediaToolsSection {...props} />
			<AiEditSection {...props} />
			{isAudio ? null : <GapFillAction key={segment.id} segment={segment} />}
			<AudioSection {...props} />
			<KeyframesSection
				{...props}
				onPropertyChange={onAnimationPropertyChange}
				property={visualControls ? animationProperty : "volume"}
			/>
			<Button onClick={() => runtime.setSelected(null)} variant="ghost">
				Project settings
			</Button>
		</>
	);
}

/** The right column: the inspected clip's sections, or project settings. */
export function ClipInspector() {
	const { selectedSegment, selectedTrackLocked } = useEditorProject();
	const [animationProperty, setAnimationProperty] =
		useState<Keyframe["property"]>("scale");
	return (
		<aside className="studio-inspector">
			<RyuAppSection
				aria-disabled={selectedTrackLocked || undefined}
				inert={selectedTrackLocked || undefined}
				title={selectedSegment ? "Clip inspector" : "Project settings"}
			>
				{selectedSegment ? (
					<ClipSections
						animationProperty={animationProperty}
						onAnimationPropertyChange={setAnimationProperty}
						segment={selectedSegment}
					/>
				) : (
					<ProjectSettingsPanel />
				)}
			</RyuAppSection>
		</aside>
	);
}
