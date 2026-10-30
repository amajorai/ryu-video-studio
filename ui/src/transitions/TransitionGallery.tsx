import { useMemo } from "react";
import {
	type RevealGroup,
	type RevealTransition,
	revealGroupLabels,
	revealTransitionInfo,
	revealTransitions,
} from "../../../shared/reveal-transitions.ts";
import {
	demoAnimationName,
	transitionDemoKeyframes,
} from "./transition-demo.ts";
import { writeTransitionDrag } from "./transition-drag.ts";
import "./TransitionGallery.css";

const groups: RevealGroup[] = ["dissolve", "wipe", "shape", "motion"];

export interface TransitionGalleryProps {
	/** Why tiles cannot be applied right now (shown, and tiles disabled). */
	disabledReason?: string | null;
	onPick: (type: RevealTransition) => void;
	selected?: RevealTransition;
}

/**
 * Reveal transitions as animated tiles (W2-V10). Clicking a tile applies it
 * to the cut into the inspected clip; tiles are also draggable with the
 * `transition-drag.ts` payload for a timeline drop onto a cut.
 */
export function TransitionGallery({
	disabledReason,
	onPick,
	selected,
}: TransitionGalleryProps) {
	const keyframes = useMemo(
		() => revealTransitions.map(transitionDemoKeyframes).join("\n"),
		[]
	);
	const disabled = Boolean(disabledReason);
	return (
		<div className="studio-transition-gallery">
			<style>{keyframes}</style>
			{disabledReason ? <small>{disabledReason}</small> : null}
			{groups.map((group) => (
				<fieldset className="studio-transition-gallery__group" key={group}>
					<legend>{revealGroupLabels[group]}</legend>
					<div className="studio-transition-gallery__tiles">
						{revealTransitions
							.filter((type) => revealTransitionInfo[type].group === group)
							.map((type) => (
								<button
									aria-pressed={selected === type}
									className="studio-transition-gallery__tile"
									disabled={disabled}
									draggable={!disabled}
									key={type}
									onClick={() => onPick(type)}
									onDragStart={(event) =>
										writeTransitionDrag(event.dataTransfer, type)
									}
									title={revealTransitionInfo[type].label}
									type="button"
								>
									<span
										aria-hidden="true"
										className="studio-transition-gallery__demo"
									>
										<span
											className="studio-transition-gallery__layer studio-transition-gallery__layer--a"
											style={{ animationName: demoAnimationName(type, "a") }}
										>
											A
										</span>
										<span
											className="studio-transition-gallery__layer studio-transition-gallery__layer--b"
											style={{ animationName: demoAnimationName(type, "b") }}
										>
											B
										</span>
									</span>
									<span className="studio-transition-gallery__label">
										{revealTransitionInfo[type].label}
									</span>
								</button>
							))}
					</div>
				</fieldset>
			))}
		</div>
	);
}
