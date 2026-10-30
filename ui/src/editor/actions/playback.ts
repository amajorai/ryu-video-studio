import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { resumePreviewAudio } from "../../audio-preview.ts";
import { activeSourceTransport } from "../../preview/source-tabs.ts";
import { clock } from "../format.ts";
import {
	nextShuttleRate,
	type PlaybackDirection,
	playAroundWindow,
	playbackTransport,
} from "../playback-clock.ts";
import type { EditorRuntime } from "../runtime.ts";
import type { EditorStore, LoopMode } from "../store.ts";
import type { ActionHandlers, ShortcutEventLike } from "./types.ts";

/** English fallback until a caller passes the Companion's `tl`. */
const englishMessages: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

const isInsideButton = (target: EventTarget | null) =>
	typeof (target as Element | null)?.closest === "function" &&
	Boolean((target as Element).closest("button"));

/** Direction of the last J/L press per editor, for J/L acceleration. */
const shuttleDirections = new WeakMap<EditorStore, PlaybackDirection>();

/** Start playback once preview audio is allowed to run. */
function startPlaying(runtime: EditorRuntime) {
	void resumePreviewAudio()
		.then(() => runtime.setPlaying(true))
		.catch(() => runtime.setStatus("Audio playback is unavailable."));
}

/** Start or stop playback, rewinding first when the playhead is at the end. */
export function togglePlayback(runtime: EditorRuntime) {
	if (runtime.time >= runtime.duration) {
		runtime.setTime(0);
	}
	const { playing } = runtime;
	if (!playing) {
		// Space always plays at normal speed; J/L acceleration starts over.
		runtime.store.setState({ playbackRate: 1 });
	}
	void resumePreviewAudio()
		.then(() => runtime.setPlaying(!playing))
		.catch(() => runtime.setStatus("Audio playback is unavailable."));
}

/**
 * J/L shuttle: play in one direction from the current playhead. Pressing
 * the same key again while playing that way doubles the speed (1x, 2x,
 * 4x, 8x); the other key or K starts over at 1x.
 */
export function shuttle(
	runtime: EditorRuntime,
	direction: PlaybackDirection,
	tl: LiteralMessage = englishMessages
) {
	const { store } = runtime;
	const accelerate =
		runtime.playing && shuttleDirections.get(store) === direction;
	const rate = nextShuttleRate(store.getState().playbackRate, accelerate);
	shuttleDirections.set(store, direction);
	// J/L takes over from `/`: keep playing instead of snapping back.
	playbackTransport(runtime)?.cancelPlayAround();
	store.setState({ playbackRate: rate });
	runtime.setPlaybackDirection(direction);
	if (rate > 1) {
		runtime.setStatus(
			direction < 0
				? tl("Playing in reverse at {rate}x.", { rate })
				: tl("Playing at {rate}x.", { rate })
		);
	}
	startPlaying(runtime);
}

/** K: stop and reset the shuttle speed. */
export function pausePlayback(runtime: EditorRuntime) {
	runtime.setPlaying(false);
	runtime.store.setState({ playbackRate: 1 });
	shuttleDirections.delete(runtime.store);
}

/** Loop modes in the order Cmd+L cycles through them. */
const LOOP_CYCLE: Readonly<Record<LoopMode, LoopMode>> = {
	all: "off",
	off: "range",
	range: "all",
};

/** Cmd+L: cycle loop playback off → I/O range → whole timeline → off. */
export function toggleLoop(
	runtime: EditorRuntime,
	tl: LiteralMessage = englishMessages
): LoopMode {
	const mode = LOOP_CYCLE[runtime.store.getState().loop.mode];
	runtime.store.setState({ loop: { mode } });
	const { end, start } = runtime.range;
	runtime.setStatus(
		mode === "off"
			? "Loop playback off."
			: mode === "range"
				? tl("Looping the range {start}–{end}.", {
						end: clock(end),
						start: clock(start),
					})
				: "Looping the whole timeline."
	);
	return mode;
}

/**
 * `/`: play from two seconds before the playhead to two seconds after it,
 * then stop and return the playhead to where it was.
 */
export function playAround(runtime: EditorRuntime) {
	if (!(runtime.duration > 0)) {
		return false;
	}
	const window = playAroundWindow(runtime.time, runtime.duration);
	const transport = playbackTransport(runtime);
	runtime.store.setState({ playbackRate: 1 });
	// Apply 1x now: a later rate change would cancel the play-around.
	transport?.configure({ ...transport.settings(), rate: 1 });
	shuttleDirections.delete(runtime.store);
	runtime.setPlaybackDirection(1);
	runtime.setTime(window.start);
	// After the seek and direction change, which cancel a pending play-around.
	transport?.playAround(window);
	startPlaying(runtime);
}

/** Transport handlers: play/pause, J/K/L shuttle, loop, and play around. */
export const playbackActions: ActionHandlers = {
	"playback.forward": (runtime) => {
		const source = activeSourceTransport(runtime.store);
		if (source) {
			source.shuttle(1);
			return;
		}
		shuttle(runtime, 1);
	},
	"playback.pause": (runtime) => {
		const source = activeSourceTransport(runtime.store);
		if (source) {
			source.pause();
			return;
		}
		pausePlayback(runtime);
	},
	"playback.playAround": (runtime) =>
		activeSourceTransport(runtime.store) ? false : playAround(runtime),
	"playback.reverse": (runtime) => {
		const source = activeSourceTransport(runtime.store);
		if (source) {
			source.shuttle(-1);
			return;
		}
		shuttle(runtime, -1);
	},
	"playback.toggle": (runtime, event?: ShortcutEventLike) => {
		// Space on a focused button activates the button instead.
		if (event && isInsideButton(event.target)) {
			return false;
		}
		const source = activeSourceTransport(runtime.store);
		if (source) {
			source.toggle();
			return;
		}
		togglePlayback(runtime);
	},
	"playback.toggleLoop": (runtime) => {
		toggleLoop(runtime);
	},
};
