import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@ryu/ui/components/popover.tsx";
import { keyframeCurve, withCurve } from "../../../shared/animation.ts";
import type {
	GraphicKeyframeChannel,
	TitleKeyframeChannel,
} from "../../../shared/overlay-keyframes.ts";
import type { Keyframe } from "../../../shared/project.ts";
import type { KeyframeProperty } from "../../../shared/schema/keyframe.ts";
import { GraphEditor } from "../keyframes/GraphEditor.tsx";
import {
	channelLabel,
	type LaneChannel,
	withoutKeyframe,
} from "../keyframes/lane-math.ts";
import type { LaneView } from "./OverlayKeyframeLanes-model.ts";

/** The view, curve, delete and add controls above the overlay keyframe lanes. */
export function OverlayKeyframeToolbar({
	adding,
	addAtPlayhead,
	channels,
	chooseView,
	curveOpen,
	hasNext,
	noun,
	playheadInside,
	save,
	selectedChannel,
	selectedFrame,
	setAdding,
	setCurveOpen,
	view,
}: {
	adding: KeyframeProperty;
	addAtPlayhead: () => void;
	channels: readonly (GraphicKeyframeChannel | TitleKeyframeChannel)[];
	chooseView: (next: LaneView) => void;
	curveOpen: boolean;
	hasNext: boolean;
	noun: "title" | "graphic";
	playheadInside: boolean;
	save: (
		channel: Pick<LaneChannel, "group">,
		frames: Keyframe[],
		label: string,
		select?: { channel: string; time: number } | null
	) => unknown;
	selectedChannel: LaneChannel | undefined;
	selectedFrame: Keyframe | undefined;
	setAdding: (next: KeyframeProperty) => void;
	setCurveOpen: (open: boolean) => void;
	view: LaneView;
}) {
	const tl = useLiteralMessages();
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
				open={curveOpen && hasNext}
			>
				<PopoverAnchor>
					<span className="inline-flex">
						<Button
							disabled={!hasNext}
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
					{selectedFrame && selectedChannel ? (
						<GraphEditor
							curve={keyframeCurve(selectedFrame)}
							onChange={(curve) =>
								save(
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
				disabled={!(selectedFrame && selectedChannel)}
				onClick={() => {
					if (selectedChannel && selectedFrame) {
						save(
							selectedChannel,
							withoutKeyframe(selectedChannel.frames, selectedFrame.id),
							"Delete keyframe",
							null
						);
						setCurveOpen(false);
					}
				}}
				size="xs"
				type="button"
				variant="ghost"
			>
				Delete
			</Button>
			<NativeSelect
				aria-label={tl(
					"{kind, select, title {Title} other {Graphic}} keyframe channel to add",
					{ kind: noun }
				)}
				onChange={(event) => {
					const { value } = event.target;
					const match = channels.find((channel) => channel === value);
					if (match) {
						setAdding(match);
					}
				}}
				size="sm"
				value={adding}
			>
				{channels.map((channel) => (
					<NativeSelectOption key={channel} value={channel}>
						{channelLabel({ property: channel })}
					</NativeSelectOption>
				))}
			</NativeSelect>
			<Button
				disabled={!playheadInside}
				onClick={addAtPlayhead}
				size="xs"
				title={
					playheadInside
						? "Record this channel's value at the playhead"
						: "Move the playhead inside this item to add a keyframe"
				}
				type="button"
				variant="ghost"
			>
				Add
			</Button>
		</div>
	);
}
