import { Button } from "@ryu/blocks/companion/controls";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@ryu/ui/components/popover.tsx";
import { keyframeCurve, withCurve } from "../../../shared/animation.ts";
import type { Keyframe } from "../../../shared/project.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { GraphEditor } from "../keyframes/GraphEditor.tsx";
import type { LaneChannel } from "../keyframes/lane-math.ts";
import type { LaneSelection, LaneView } from "./ClipKeyframeLane-shared.ts";

interface ClipKeyframeLaneToolbarProps {
	chooseView: (next: LaneView) => void;
	curveOpen: boolean;
	editable: boolean;
	hasNext: boolean;
	removeSelected: () => void;
	runtime: EditorRuntime | null;
	save: (
		editor: EditorRuntime,
		channel: LaneChannel,
		frames: Keyframe[],
		label: string,
		select?: LaneSelection | null
	) => unknown;
	selectedChannel: LaneChannel | undefined;
	selectedFrame: Keyframe | undefined;
	setCurveOpen: (open: boolean) => void;
	view: LaneView;
}

/** The lanes/graph switch, the curve editor and Delete above the lanes. */
export function ClipKeyframeLaneToolbar({
	chooseView,
	curveOpen,
	editable,
	hasNext,
	removeSelected,
	runtime,
	save,
	selectedChannel,
	selectedFrame,
	setCurveOpen,
	view,
}: ClipKeyframeLaneToolbarProps) {
	return (
		<div className="flex flex-wrap items-center gap-1 border-border border-b px-1 py-0.5">
			<Button
				aria-pressed={view === "lanes"}
				onClick={() => chooseView("lanes")}
				size="xs"
				type="button"
				variant={view === "lanes" ? "default" : "ghost"}
			>
				Lanes
			</Button>
			<Button
				aria-pressed={view === "graph"}
				onClick={() => chooseView("graph")}
				size="xs"
				type="button"
				variant={view === "graph" ? "default" : "ghost"}
			>
				Graph
			</Button>
			<Popover
				onOpenChange={(open) => setCurveOpen(open)}
				open={curveOpen && hasNext && editable}
			>
				<PopoverAnchor>
					<span className="inline-flex">
						<Button
							disabled={!(hasNext && editable)}
							onClick={() => setCurveOpen(true)}
							size="xs"
							title={
								hasNext
									? "Shape the curve to the next keyframe"
									: "Select a keyframe that has a next keyframe"
							}
							type="button"
							variant="ghost"
						>
							Curve
						</Button>
					</span>
				</PopoverAnchor>
				<PopoverContent align="start" data-no-scrub="" spacing="form">
					{selectedFrame && selectedChannel && runtime ? (
						<GraphEditor
							curve={keyframeCurve(selectedFrame)}
							onChange={(curve) =>
								save(
									runtime,
									selectedChannel,
									selectedChannel.frames.map((frame) =>
										frame.id === selectedFrame.id
											? withCurve(frame, curve)
											: frame
									),
									"Keyframe curve",
									{ channel: selectedChannel.key, time: selectedFrame.time }
								)
							}
						/>
					) : null}
				</PopoverContent>
			</Popover>
			<Button
				disabled={!(selectedFrame && editable)}
				onClick={removeSelected}
				size="xs"
				type="button"
				variant="ghost"
			>
				Delete
			</Button>
		</div>
	);
}
