import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ViewerStorageArea } from "../editor/viewer-storage.ts";
import { isEditableTarget } from "../shortcuts/registry.ts";
import {
	readTourSeen,
	TOUR_STEPS,
	type TourEvent,
	type TourState,
	type TourStep,
	tourReducer,
	writeTourSeen,
} from "./tour-state.ts";

export interface TourController {
	/** The open step, or null when the tour is closed. */
	current: TourStep | null;
	send: (event: TourEvent) => void;
	state: TourState;
}

/**
 * Tour state for this viewer: opens on first run, and remembers it was seen
 * once finished or dismissed. `start` relaunches it from help.
 */
export function useTour(
	area?: ViewerStorageArea | null,
	steps: readonly TourStep[] = TOUR_STEPS
): TourController {
	const [state, setState] = useState<TourState>(() =>
		readTourSeen(area)
			? { step: null }
			: tourReducer({ step: null }, { type: "start" }, steps)
	);
	const send = useCallback(
		(event: TourEvent) => {
			const next = tourReducer(state, event, steps);
			if (state.step !== null && next.step === null) {
				writeTourSeen(area);
			}
			setState(next);
		},
		[area, state, steps]
	);
	const current = state.step === null ? null : (steps[state.step] ?? null);
	return { current, send, state };
}

/**
 * The first-run tour: an inline card above the workspace (never an overlay,
 * so it cannot block the editor) that steps through the panels. The panel a
 * step describes is highlighted by the layout.
 */
export function Tour({
	controller,
	steps = TOUR_STEPS,
}: {
	controller: TourController;
	steps?: readonly TourStep[];
}) {
	const tl = useLiteralMessages();
	const { current, send, state } = controller;
	const headingId = useId();
	const headingRef = useRef<HTMLHeadingElement>(null);
	const step = state.step;
	useEffect(() => {
		// Move focus with the tour so screen readers announce each step.
		if (step !== null && step > 0) {
			headingRef.current?.focus();
		}
	}, [step]);
	const open = current !== null && step !== null;
	useEffect(() => {
		// Escape closes the tour wherever focus is (the first step does not take
		// focus), except while the viewer is typing or another handler claimed it.
		if (!open) {
			return;
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				event.key !== "Escape" ||
				event.defaultPrevented ||
				isEditableTarget(event.target)
			) {
				return;
			}
			send({ type: "dismiss" });
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [open, send]);
	if (!current || step === null) {
		return null;
	}
	const last = step === steps.length - 1;
	return (
		<section
			aria-labelledby={headingId}
			className="studio-tour"
			data-tour-step={current.id}
		>
			<div className="studio-tour-copy">
				<p className="studio-tour-progress">
					{tl("Step {step} of {total}", {
						step: step + 1,
						total: steps.length,
					})}
				</p>
				<h2 id={headingId} ref={headingRef} tabIndex={-1}>
					{current.title}
				</h2>
				<p>{current.body}</p>
			</div>
			<div className="studio-tour-actions">
				<Button
					onClick={() => send({ type: "dismiss" })}
					size="sm"
					variant="ghost"
				>
					Skip tour
				</Button>
				<Button
					disabled={step === 0}
					onClick={() => send({ type: "back" })}
					size="sm"
					variant="outline"
				>
					Back
				</Button>
				<Button onClick={() => send({ type: "next" })} size="sm">
					{last ? "Done" : "Next"}
				</Button>
			</div>
		</section>
	);
}
