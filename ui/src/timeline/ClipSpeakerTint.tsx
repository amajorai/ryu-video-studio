import { useContext } from "react";
import type { Project, Segment } from "../../../shared/project.ts";
import type { Speaker } from "../../../shared/schema/speaker.ts";
import { speakerById } from "../../../shared/speakers.ts";
import { EditorContext } from "../editor/context.tsx";
import type { ClipSlotProps } from "./clip-slot-props.ts";

/** The speaker a clip is tagged with, when the project still lists it. */
export function speakerTintFor(
	project: Pick<Project, "speakers"> | null | undefined,
	segment: Pick<Segment, "speakerId">
): Speaker | undefined {
	return project ? speakerById(project, segment.speakerId) : undefined;
}

/** A thin stripe along the clip's top edge in its dominant speaker's color. */
export function ClipSpeakerTint({ segment }: ClipSlotProps) {
	const runtime = useContext(EditorContext);
	const speaker = speakerTintFor(runtime?.project, segment);
	if (!speaker) {
		return null;
	}
	return (
		<span
			aria-hidden="true"
			className="pointer-events-none absolute inset-x-0 top-0 z-[2] h-[3px]"
			data-speaker-id={speaker.id}
			data-testid="clip-speaker-tint"
			style={{ backgroundColor: speaker.color }}
			title={speaker.label}
		/>
	);
}
