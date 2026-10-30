import type { LiteralMessage } from "@ryu/i18n/react";
import { formatDb, gainToDb } from "../../../shared/decibels.ts";
import type { Segment } from "../../../shared/project.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { commitChannel, commitVolume } from "../keyframes/commit.ts";
import type { VolumeLineEdit } from "../keyframes/volume-line.ts";

export const POINT_PX = 8;
/** Clips at least this wide place the volume handle off-centre. */
export const HANDLE_OFFSET_MIN_WIDTH_PX = 96;
export const volumeGroup = { property: "volume" } as const;
export const noSubscription = () => () => undefined;

/** The clip with a pending volume edit applied, for the live preview. */
export function previewed(
	segment: Segment,
	edit: VolumeLineEdit | null
): Segment {
	if (!edit) {
		return segment;
	}
	if (edit.kind === "static") {
		return { ...segment, volume: edit.volume };
	}
	return {
		...segment,
		keyframes: [
			...segment.keyframes.filter((frame) => frame.property !== "volume"),
			...edit.frames,
		],
	};
}

/** Commit a line edit as one undoable change. */
export function commitLineEdit(
	runtime: EditorRuntime,
	segmentId: string,
	edit: VolumeLineEdit,
	label: string,
	tl: LiteralMessage
) {
	if (edit.kind === "static") {
		if (commitVolume(runtime, segmentId, edit.volume)) {
			runtime.setStatus(
				tl("Clip volume {level}.", { level: formatDb(gainToDb(edit.volume)) })
			);
		}
		return;
	}
	commitChannel(runtime, segmentId, volumeGroup, edit.frames, label);
}
