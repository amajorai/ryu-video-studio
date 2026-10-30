import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useState } from "react";
import {
	animationInDurationOf,
	animationLoopPeriodOf,
	animationOutDurationOf,
	clipAnimationLoopLabels,
	clipAnimationLoops,
	clipAnimationMoveLabels,
	clipAnimationMoves,
	isClipAnimationLoop,
	isClipAnimationMove,
} from "../../../../shared/clip-animation.ts";
import type { Segment } from "../../../../shared/project.ts";
import {
	DEFAULT_REVEAL_DURATION,
	isShapedReveal,
	newRevealTransition,
	type RevealTransition,
	revealTransitionInfo,
} from "../../../../shared/reveal-transitions.ts";
import type {
	ClipAnimation,
	EdgeTransition,
	TransitionIn,
} from "../../../../shared/schema/transition.ts";
import {
	applyRevealTransition,
	cutPredecessor,
	DEFAULT_EXIT_DURATION,
} from "../../../../shared/transitions.ts";
import { useEditorProject } from "../../editor/context.tsx";
import { message } from "../../editor/format.ts";
import { NumberField } from "../../NumberField.tsx";
import { TransitionGallery } from "../../transitions/TransitionGallery.tsx";
import type { ClipSectionProps } from "../section-props.ts";

const exitOptions: { label: string; value: EdgeTransition }[] = [
	{ label: "None", value: "none" },
	{ label: "Fade out", value: "crossfade" },
	{ label: "Shrink (zoom in)", value: "zoom-in" },
	{ label: "Shrink and fade (zoom out)", value: "zoom-out" },
	{ label: "Slide out left", value: "slide-left" },
	{ label: "Slide out right", value: "slide-right" },
	{ label: "Slide out up", value: "slide-up" },
	{ label: "Slide out down", value: "slide-down" },
];

const isExit = (value: string): value is EdgeTransition =>
	exitOptions.some((option) => option.value === value);

/** Drop undefined keys and return undefined for an empty animation. */
function cleanAnimation(animation: ClipAnimation): ClipAnimation | undefined {
	const entries = Object.entries(animation).filter(
		([, value]) => value !== undefined
	);
	const hasMove =
		animation.in !== undefined ||
		animation.out !== undefined ||
		(animation.loop !== undefined && animation.loop !== "none");
	return hasMove ? (Object.fromEntries(entries) as ClipAnimation) : undefined;
}

/** The reveal transition into this clip: gallery, duration and softness. */
function RevealControls({ segment }: { segment: Segment }) {
	const tl = useLiteralMessages();
	const runtime = useEditorProject();
	const { assets, edit, project, setStatus } = runtime;
	const current = segment.transitionIn;
	const [duration, setDuration] = useState(
		current?.duration ?? DEFAULT_REVEAL_DURATION
	);
	const predecessor = cutPredecessor(project, segment);
	// Agents make the same edit with POST /projects/:id/transition.
	const apply = (transition: TransitionIn | null, label: string) => {
		try {
			edit(
				applyRevealTransition(project, assets, segment.id, transition),
				label
			);
		} catch (error) {
			setStatus(message(error));
		}
	};
	const pick = (type: RevealTransition) =>
		apply(
			{
				...newRevealTransition(type, duration),
				softness: current?.softness ?? newRevealTransition(type).softness,
			},
			`Transition: ${revealTransitionInfo[type].label}`
		);
	return (
		<RyuAppField
			description={
				current
					? tl(
							"{transitionName} over the previous clip. Changing it re-applies the overlap it needs.",
							{ transitionName: revealTransitionInfo[current.type].label }
						)
					: "Pick a transition for the cut into this clip. The clip extends under the previous one so the program length stays the same."
			}
			label="Transition in"
		>
			<TransitionGallery
				disabledReason={
					predecessor
						? null
						: "Place this clip right after another clip on its track to add a transition."
				}
				onPick={pick}
				selected={current?.type}
			/>
			<div className="studio-inline-fields">
				<NumberField
					label="Duration (s)"
					max={5}
					min={0.04}
					onChange={(value) => {
						setDuration(value);
						if (current) {
							apply({ ...current, duration: value }, "Transition duration");
						}
					}}
					step={0.1}
					value={current?.duration ?? duration}
				/>
				{current && isShapedReveal(current.type) ? (
					<NumberField
						label="Softness"
						max={1}
						min={0}
						onChange={(value) =>
							apply({ ...current, softness: value }, "Transition softness")
						}
						step={0.05}
						value={current.softness}
					/>
				) : null}
			</div>
			{current ? (
				<Button
					onClick={() => apply(null, "Removed transition")}
					size="sm"
					variant="outline"
				>
					Remove transition
				</Button>
			) : null}
		</RyuAppField>
	);
}

function ExitControls({ onChange, segment }: ClipSectionProps) {
	const exit = segment.exitTransition ?? "none";
	return (
		<RyuAppField
			description="Plays over the clip's last seconds. Pushes set this on the outgoing clip automatically."
			label="Exit"
		>
			<div className="studio-inline-fields">
				<NativeSelect
					aria-label="Exit transition"
					onChange={(event) => {
						const { value } = event.target;
						if (!isExit(value)) {
							return;
						}
						onChange(
							value === "none"
								? { exitDuration: undefined, exitTransition: undefined }
								: {
										exitDuration: segment.exitDuration ?? DEFAULT_EXIT_DURATION,
										exitTransition: value,
									}
						);
					}}
					value={exit}
				>
					{exitOptions.map((option) => (
						<NativeSelectOption key={option.value} value={option.value}>
							{option.label}
						</NativeSelectOption>
					))}
				</NativeSelect>
				{exit === "none" ? null : (
					<NumberField
						label="Exit (s)"
						max={5}
						min={0.04}
						onChange={(value) => onChange({ exitDuration: value })}
						step={0.1}
						value={segment.exitDuration ?? DEFAULT_EXIT_DURATION}
					/>
				)}
			</div>
		</RyuAppField>
	);
}

function AnimationControls({ onChange, segment }: ClipSectionProps) {
	const tl = useLiteralMessages();
	const animation: ClipAnimation = segment.animation ?? {};
	const update = (patch: Partial<ClipAnimation>) =>
		onChange({ animation: cleanAnimation({ ...animation, ...patch }) });
	return (
		<RyuAppField
			description="In and out moves play at the clip's edges; a loop runs for the whole clip."
			label="Animation"
		>
			<div className="studio-inline-fields">
				<NativeSelect
					aria-label="In animation"
					onChange={(event) => {
						const { value } = event.target;
						update({ in: isClipAnimationMove(value) ? value : undefined });
					}}
					value={animation.in ?? ""}
				>
					<NativeSelectOption value="">No in move</NativeSelectOption>
					{clipAnimationMoves.map((move) => (
						<NativeSelectOption key={move} value={move}>
							{tl("In: {moveName}", {
								moveName: clipAnimationMoveLabels[move],
							})}
						</NativeSelectOption>
					))}
				</NativeSelect>
				{animation.in ? (
					<NumberField
						label="In (s)"
						max={5}
						min={0}
						onChange={(value) => update({ inDuration: value })}
						step={0.1}
						value={animationInDurationOf(animation)}
					/>
				) : null}
				<NativeSelect
					aria-label="Out animation"
					onChange={(event) => {
						const { value } = event.target;
						update({ out: isClipAnimationMove(value) ? value : undefined });
					}}
					value={animation.out ?? ""}
				>
					<NativeSelectOption value="">No out move</NativeSelectOption>
					{clipAnimationMoves.map((move) => (
						<NativeSelectOption key={move} value={move}>
							{tl("Out: {moveName}", {
								moveName: clipAnimationMoveLabels[move],
							})}
						</NativeSelectOption>
					))}
				</NativeSelect>
				{animation.out ? (
					<NumberField
						label="Out (s)"
						max={5}
						min={0}
						onChange={(value) => update({ outDuration: value })}
						step={0.1}
						value={animationOutDurationOf(animation)}
					/>
				) : null}
				<NativeSelect
					aria-label="Loop animation"
					onChange={(event) => {
						const { value } = event.target;
						update({
							loop:
								isClipAnimationLoop(value) && value !== "none"
									? value
									: undefined,
						});
					}}
					value={animation.loop ?? "none"}
				>
					{clipAnimationLoops.map((loop) => (
						<NativeSelectOption key={loop} value={loop}>
							{tl("Loop: {loopName}", {
								loopName: clipAnimationLoopLabels[loop],
							})}
						</NativeSelectOption>
					))}
				</NativeSelect>
				{animation.loop && animation.loop !== "none" ? (
					<NumberField
						label="Period (s)"
						max={10}
						min={0.2}
						onChange={(value) => update({ loopPeriod: value })}
						step={0.1}
						value={animationLoopPeriodOf(animation)}
					/>
				) : null}
			</div>
		</RyuAppField>
	);
}

/**
 * Clip transitions and animations (W2-V10): the reveal transition from the
 * previous clip (gallery), the exit transition, and in/out/loop animation.
 * Agents set the same fields through `clip-properties`.
 */
export function TransitionSection(props: ClipSectionProps) {
	if (!props.visualControls || props.isAudio) {
		return null;
	}
	return (
		<>
			<RevealControls segment={props.segment} />
			<ExitControls {...props} />
			<AnimationControls {...props} />
		</>
	);
}
