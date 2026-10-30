import { z } from "zod";
import {
	readViewerValue,
	type ViewerStorageArea,
	writeViewerValue,
} from "../editor/viewer-storage.ts";
import type { WorkspacePanel } from "./layout-presets.ts";

/** Where a tour step points: a workspace panel or the layout controls. */
export type TourTarget = WorkspacePanel | "layout";

export interface TourStep {
	body: string;
	id: string;
	target: TourTarget;
	title: string;
}

/** The first-run tour, in order. */
export const TOUR_STEPS: readonly TourStep[] = [
	{
		body: "Import footage, audio, and images here, then drag them onto the timeline or insert them at the playhead.",
		id: "library",
		target: "library",
		title: "Your library",
	},
	{
		body: "The preview plays your edit as it will render. Press Space to play and pause, and J, K, and L to shuttle.",
		id: "preview",
		target: "stage",
		title: "Preview",
	},
	{
		body: "Arrange clips on tracks. Press S to split the selected clip at the playhead, and drag clip edges to trim.",
		id: "timeline",
		target: "timeline",
		title: "Timeline",
	},
	{
		body: "Select a clip to adjust its timing, transform, color, audio, and keyframes.",
		id: "inspector",
		target: "inspector",
		title: "Inspector",
	},
	{
		body: "Drag the dividers to resize panels. Pick the Edit, Color, Audio, or Review layout, or save your own. Press ` to maximize the focused panel.",
		id: "layout",
		target: "layout",
		title: "Layouts",
	},
	{
		body: "Press ? to see and change every keyboard shortcut. Reopen this tour any time with Take the tour.",
		id: "shortcuts",
		target: "layout",
		title: "Shortcuts and help",
	},
];

export interface TourState {
	/** Open step index, or null when the tour is closed. */
	step: number | null;
}

export type TourEvent =
	| { type: "start" }
	| { type: "next" }
	| { type: "back" }
	| { type: "dismiss" };

/**
 * Advance the tour. `next` on the last step finishes it; `dismiss` closes it
 * from any step; `back` stops at the first step.
 */
export function tourReducer(
	state: TourState,
	event: TourEvent,
	steps: readonly TourStep[] = TOUR_STEPS
): TourState {
	switch (event.type) {
		case "start":
			return { step: steps.length > 0 ? 0 : null };
		case "dismiss":
			return { step: null };
		case "next":
			if (state.step === null) {
				return state;
			}
			return { step: state.step + 1 < steps.length ? state.step + 1 : null };
		case "back":
			if (state.step === null) {
				return state;
			}
			return { step: Math.max(0, state.step - 1) };
		default:
			return state;
	}
}

const tourSeenSchema = z.object({ seen: z.boolean() }).strict();
export const TOUR_SEEN_KEY = "workspace.tour";

/** Whether this viewer already finished or dismissed the tour. */
export function readTourSeen(area?: ViewerStorageArea | null): boolean {
	return readViewerValue(TOUR_SEEN_KEY, tourSeenSchema, { seen: false }, area)
		.seen;
}

export function writeTourSeen(area?: ViewerStorageArea | null): boolean {
	return writeViewerValue(TOUR_SEEN_KEY, { seen: true }, area);
}
