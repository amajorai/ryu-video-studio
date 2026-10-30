import { useEffect, useRef } from "react";
import type { Segment } from "../../../shared/project.ts";
import type { TrimTool } from "../editing-ui.ts";
import { razorCut } from "../editor/actions/split.ts";
import type { EditorRuntime } from "../editor/runtime.ts";

export interface ClipClickInput {
	/** Pointer position as timeline seconds (the razor snaps it). */
	at: number;
	segment: Segment;
	/** Shift-click: with the razor, cut through all tracks. */
	shiftKey: boolean;
	tool: TrimTool;
}

/** Receives razor clicks for the mounted timeline. */
export type RazorClickSink = (input: ClipClickInput) => void;

const sinks: RazorClickSink[] = [];

/**
 * Route razor clicks to `sink` until the returned function is called. The
 * most recently registered sink receives each click, so a remounted
 * timeline takes over from the one it replaces.
 */
export function registerRazorSink(sink: RazorClickSink): () => void {
	sinks.push(sink);
	return () => {
		const index = sinks.lastIndexOf(sink);
		if (index >= 0) {
			sinks.splice(index, 1);
		}
	};
}

/**
 * Connect razor clicks to the editor while the calling component is
 * mounted. The runtime is read through a ref, so each click sees the
 * latest render without re-registering.
 */
export function useRazorClicks(runtime: EditorRuntime) {
	const latest = useRef(runtime);
	latest.current = runtime;
	useEffect(
		() =>
			registerRazorSink((input) => {
				razorCut(latest.current, input);
			}),
		[]
	);
}

/**
 * Tool-specific click on a clip. Returns true when the tool consumed the
 * click (the clip is then not selected): the razor cuts the clip at the
 * pointer, or every unlocked track with Shift. Other tools select.
 */
export function handleToolClick(input: ClipClickInput): boolean {
	if (input.tool !== "razor") {
		return false;
	}
	const sink = sinks.at(-1);
	if (!sink) {
		return false;
	}
	sink(input);
	return true;
}
