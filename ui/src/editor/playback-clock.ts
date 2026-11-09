import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorStore, LoopMode } from "./store.ts";
import { useEditorStore } from "./store.ts";

export type PlaybackDirection = 1 | -1;

/** Where playback started: timeline seconds at a `performance.now()` instant. */
export interface PlaybackOrigin {
	at: number;
	time: number;
}

/** A span playback wraps inside: reaching `end` jumps back to `start`. */
export interface LoopWindow {
	end: number;
	start: number;
}

/** Play-around: play `start`..`end`, then stop and return to `returnTo`. */
export interface PlayAroundWindow {
	end: number;
	returnTo: number;
	start: number;
}

/** Shortest span that loops; matches the editor's smallest I/O range. */
export const MIN_LOOP_SECONDS = 0.04;
/** Default play-around preroll and postroll, in seconds. */
export const PLAY_AROUND_SECONDS = 2;
/** J/L shuttle speeds; repeated presses step through them. */
export const SHUTTLE_RATES = [1, 2, 4, 8] as const;

/**
 * The span loop playback wraps inside: the I/O range (`range`), the whole
 * timeline (`all`), or none (`off`, or a span too short to loop).
 */
export function loopWindow(
	mode: LoopMode,
	range: { end: number; start: number },
	duration: number
): LoopWindow | null {
	if (mode === "off" || !(duration > 0)) {
		return null;
	}
	const window =
		mode === "all"
			? { end: duration, start: 0 }
			: {
					end: Math.min(duration, Math.max(0, range.end)),
					start: Math.min(duration, Math.max(0, range.start)),
				};
	return window.end - window.start >= MIN_LOOP_SECONDS ? window : null;
}

/** Play-around window: `preroll` before `time` to `postroll` after it. */
export function playAroundWindow(
	time: number,
	duration: number,
	{
		postroll = PLAY_AROUND_SECONDS,
		preroll = PLAY_AROUND_SECONDS,
	}: { postroll?: number; preroll?: number } = {}
): PlayAroundWindow {
	const returnTo = Math.min(duration, Math.max(0, time));
	return {
		end: Math.min(duration, returnTo + postroll),
		returnTo,
		start: Math.max(0, returnTo - preroll),
	};
}

/**
 * The next J/L shuttle rate: pressing the key that matches the current
 * direction while playing speeds up (1→2→4→8, holding at 8); otherwise
 * playback restarts at 1x.
 */
export function nextShuttleRate(rate: number, accelerate: boolean): number {
	if (!accelerate) {
		return 1;
	}
	return SHUTTLE_RATES.find((candidate) => candidate > rate) ?? 8;
}

/** Drift (seconds) a playing preview element may lag the clock at 1x. */
export const MEDIA_DRIFT_SECONDS = 0.15;

/**
 * How a preview media element follows a clock running at `transportRate`
 * (J/L shuttle): its own `playbackRate` is the segment's tempo times the
 * shuttle rate, and the re-seek tolerance grows with the rate so fast
 * shuttling does not seek every few frames. Browsers clamp `playbackRate`
 * (16x in Chromium), so the result is capped there.
 */
export function previewMediaSync(
	segmentRate: number,
	transportRate: number
): { driftTolerance: number; playbackRate: number } {
	const segment =
		Number.isFinite(segmentRate) && segmentRate > 0 ? segmentRate : 1;
	const shuttleRate =
		Number.isFinite(transportRate) && transportRate > 0 ? transportRate : 1;
	return {
		driftTolerance: MEDIA_DRIFT_SECONDS * Math.max(1, shuttleRate),
		playbackRate: Math.min(16, segment * shuttleRate),
	};
}

export interface ClockOptions {
	/** Wrap inside this span instead of ending at the timeline bounds. */
	loop?: LoopWindow | null;
	/** Speed multiplier (default 1). */
	rate?: number;
	/** Forward playback ends here (play-around postroll). */
	stopAt?: number | null;
}

/**
 * Timeline position `now` milliseconds into playback from `origin`, clamped
 * to the timeline. `ended` is true once playback reaches the end (forward)
 * or the start (reverse), or `stopAt` going forward. With a loop window,
 * reaching its end (forward) jumps to its start, or its start (reverse)
 * jumps to its end; `wrapped` reports the jump so the caller re-anchors.
 */
export function clockPosition(
	origin: PlaybackOrigin,
	now: number,
	direction: PlaybackDirection,
	duration: number,
	{ loop = null, rate = 1, stopAt = null }: ClockOptions = {}
): { ended: boolean; time: number; wrapped?: true } {
	const speed = Number.isFinite(rate) && rate > 0 ? rate : 1;
	const raw = origin.time + (direction * speed * (now - origin.at)) / 1000;
	if (direction > 0 && stopAt !== null && raw >= stopAt) {
		return { ended: true, time: Math.min(duration, Math.max(0, stopAt)) };
	}
	if (loop) {
		if (direction > 0 && raw >= loop.end) {
			return { ended: false, time: loop.start, wrapped: true };
		}
		if (direction < 0 && raw <= loop.start) {
			return { ended: false, time: loop.end, wrapped: true };
		}
	}
	const time = Math.max(0, Math.min(duration, raw));
	return {
		ended: (direction > 0 && time >= duration) || (direction < 0 && time <= 0),
		time,
	};
}

/** Loop and speed settings a running clock reads on every frame. */
export interface TransportSettings {
	loop: LoopWindow | null;
	rate: number;
}

/**
 * Live controls for one playback clock: loop window, shuttle rate, and
 * one-shot play-around. Reached from editor actions and timeline components
 * through `playbackTransport(runtime)`, keyed by the clock's `setTime`.
 */
export interface PlaybackTransport {
	/** Drop a pending play-around so playback continues normally. */
	cancelPlayAround: () => void;
	/** Apply loop and rate; a rate change cancels a pending play-around. */
	configure: (settings: TransportSettings) => void;
	playAround: (window: PlayAroundWindow) => void;
	settings: () => TransportSettings;
}

const transports = new WeakMap<(time: number) => void, PlaybackTransport>();

/**
 * The transport of the clock whose `setTime` the runtime carries, or
 * undefined when the runtime is not backed by `usePlaybackClock` (tests).
 */
export function playbackTransport(runtime: {
	setTime: (time: number) => void;
}): PlaybackTransport | undefined {
	return transports.get(runtime.setTime);
}

const sameLoop = (a: LoopWindow | null, b: LoopWindow | null) =>
	a === b ||
	(a !== null && b !== null && a.start === b.start && a.end === b.end);

/**
 * The editor's playhead and its requestAnimationFrame playback loop. Seeking
 * with `setTime` while playing re-anchors the loop at the new position.
 * Loop and rate come from the clock's transport. A pending play-around
 * ignores the loop window, and seeking, changing direction or changing the
 * rate cancels it.
 */
export function usePlaybackClock(duration: number) {
	const [time, setTimeState] = useState(0);
	const position = useRef(0);
	const origin = useRef<PlaybackOrigin>({ at: 0, time: 0 });
	const settings = useRef<TransportSettings>({ loop: null, rate: 1 });
	const around = useRef<PlayAroundWindow | null>(null);
	const [playing, setPlaying] = useState(false);
	const [direction, setDirectionState] = useState<PlaybackDirection>(1);
	const directionRef = useRef<PlaybackDirection>(1);
	const setDirection = useCallback((value: PlaybackDirection) => {
		if (directionRef.current !== value) {
			// Shuttling the other way abandons a play-around.
			around.current = null;
		}
		directionRef.current = value;
		setDirectionState(value);
	}, []);
	const setTime = useCallback((value: number) => {
		position.current = value;
		origin.current = { at: performance.now(), time: value };
		around.current = null;
		setTimeState(value);
	}, []);
	const [transport] = useState<PlaybackTransport>(() => ({
		cancelPlayAround: () => {
			around.current = null;
		},
		configure: (next) => {
			const current = settings.current;
			if (current.rate === next.rate && sameLoop(current.loop, next.loop)) {
				return;
			}
			if (current.rate !== next.rate) {
				// Re-anchor so the new speed applies from here, not from play start.
				origin.current = { at: performance.now(), time: position.current };
				around.current = null;
			}
			settings.current = { loop: next.loop, rate: next.rate };
		},
		playAround: (window) => {
			around.current = window;
		},
		settings: () => settings.current,
	}));
	transports.set(setTime, transport);
	useEffect(() => {
		if (!playing) {
			return;
		}
		origin.current = { at: performance.now(), time: position.current };
		let frame = 0;
		const tick = (now: number) => {
			const next = clockPosition(origin.current, now, direction, duration, {
				// A play-around ends at its postroll, whatever the loop says.
				loop: around.current ? null : settings.current.loop,
				rate: settings.current.rate,
				stopAt: around.current?.end ?? null,
			});
			if (next.wrapped) {
				origin.current = { at: now, time: next.time };
			}
			position.current = next.time;
			if (next.ended) {
				const finished = around.current;
				around.current = null;
				if (finished) {
					position.current = finished.returnTo;
					origin.current = { at: now, time: finished.returnTo };
				}
				setTimeState(position.current);
				setPlaying(false);
				return;
			}
			setTimeState(next.time);
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => {
			cancelAnimationFrame(frame);
		};
	}, [playing, duration, direction]);
	useEffect(() => {
		if (!playing) {
			around.current = null;
		}
	}, [playing]);
	return { direction, playing, setDirection, setPlaying, setTime, time };
}

/**
 * Keep the clock's transport in step with the editor: loop mode and the
 * I/O range from the store and runtime, and the J/L shuttle rate. Mounted
 * once by the timeline playhead.
 */
export function usePlaybackTransportSync({
	duration,
	range,
	setTime,
	store,
}: {
	duration: number;
	range: { end: number; start: number };
	setTime: (time: number) => void;
	store: EditorStore;
}) {
	const mode = useEditorStore(store, (state) => state.loop.mode);
	const rate = useEditorStore(store, (state) => state.playbackRate);
	const { end, start } = range;
	useEffect(() => {
		playbackTransport({ setTime })?.configure({
			loop: loopWindow(mode, { end, start }, duration),
			rate,
		});
	}, [duration, end, mode, rate, setTime, start]);
}
