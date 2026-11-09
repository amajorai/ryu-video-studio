/**
 * Audio scrubbing: while the preview is paused and the playhead moves (ruler
 * or playhead drags, frame steps), each clip under the playhead plays a short
 * grain of its audio at the new source time. Grains are throttled so a fast
 * drag stays a readable stutter rather than a buzz. Viewers can turn it off;
 * the choice is a per-viewer preference.
 *
 * Audio comes from the sidecar's 20 s, 16 kHz mono `audio-window` extracts,
 * never from the original media, so scrubbing a long or heavy video only
 * decodes a few small windows. The window cache is bounded by decoded bytes.
 * Grains play through the preview master (limiter and meter).
 */
import { z } from "zod";
import { TRANSCRIPT_WINDOW_SECONDS } from "../../../shared/transcript.ts";
import { mediaDataUrlBlob, request } from "../bridge.ts";
import { readViewerValue, writeViewerValue } from "../editor/viewer-storage.ts";
import {
	decodePreviewAudio,
	previewAudioContext,
	previewMasterMeter,
} from "./graph.ts";

export interface PreviewScrubContext {
	/** Whether the playhead is inside the clip. */
	active: boolean;
	/**
	 * The clip's library asset. Required for scrubbing: without it the clip
	 * stays silent rather than downloading the original media.
	 */
	assetId?: string;
	/** Whether the clip's audio is part of the mix (track not muted/soloed out). */
	audible: boolean;
	/**
	 * The clip's final gain at the playhead: keyframes and fades applied, times
	 * `previewClipMixGain` (clip mute, high-speed mute and track gain).
	 */
	volume: number;
}

/** Length of one scrub grain. */
export const SCRUB_GRAIN_SECONDS = 0.06;
/** Fade at each grain edge, so grains never click. */
export const SCRUB_FADE_SECONDS = 0.005;
/** Minimum spacing between grains of the same clip. */
export const SCRUB_MIN_INTERVAL_MS = 40;
/** Source moves shorter than this are re-renders, not scrubs. */
export const SCRUB_MIN_MOVE_SECONDS = 0.0005;
/** Length of one scrub audio window (the sidecar's `audio-window` size). */
export const SCRUB_WINDOW_SECONDS = TRANSCRIPT_WINDOW_SECONDS;
/** Decoded scrub windows kept, by decoded size (about twelve 20 s windows). */
export const SCRUB_CACHE_BYTES = 16 * 1024 * 1024;
const SCRUB_PREFERENCE_KEY = "audio-scrub";

/** What the scrubber should do for one paused sync. */
export type ScrubDecision =
	| { kind: "skip" }
	| { kind: "track" }
	| { kind: "grain"; offset: number };

export interface ScrubState {
	lastGrainAt?: number;
	lastSourceTime?: number;
}

/**
 * Decide whether a paused sync plays a grain. The first sync after mount and
 * syncs that do not move the source only record the position; inaudible clips
 * track it too, so they never blip when they become audible.
 */
export function scrubDecision(
	state: ScrubState,
	sourceTime: number,
	context: PreviewScrubContext,
	nowMs: number
): ScrubDecision {
	if (!Number.isFinite(sourceTime)) {
		return { kind: "skip" };
	}
	const previous = state.lastSourceTime;
	if (
		previous === undefined ||
		Math.abs(sourceTime - previous) < SCRUB_MIN_MOVE_SECONDS
	) {
		return previous === undefined ? { kind: "track" } : { kind: "skip" };
	}
	if (!(context.active && context.audible && context.volume > 0)) {
		return { kind: "track" };
	}
	if (
		state.lastGrainAt !== undefined &&
		nowMs - state.lastGrainAt < SCRUB_MIN_INTERVAL_MS
	) {
		return { kind: "track" };
	}
	return { kind: "grain", offset: Math.max(0, sourceTime) };
}

/** Gain automation points `[time, gain]` of one grain, relative to its start. */
export function grainEnvelope(
	volume: number,
	duration = SCRUB_GRAIN_SECONDS
): [number, number][] {
	const gain = Math.min(4, Math.max(0, volume));
	const fade = Math.min(SCRUB_FADE_SECONDS, duration / 2);
	return [
		[0, 0],
		[fade, gain],
		[duration - fade, gain],
		[duration, 0],
	];
}

/** Decoded audio covering `[start, start + buffer.duration)` of a source. */
export interface ScrubWindow {
	buffer: AudioBuffer;
	start: number;
}

/** Start of the aligned window holding `sourceTime`. */
export function scrubWindowStart(sourceTime: number): number {
	return (
		Math.floor(Math.max(0, sourceTime) / SCRUB_WINDOW_SECONDS) *
		SCRUB_WINDOW_SECONDS
	);
}

export interface ScrubberDeps {
	enabled(): boolean;
	/** Decoded audio around `sourceTime`, or null when it cannot be scrubbed. */
	load(
		element: HTMLMediaElement,
		sourceTime: number,
		context: PreviewScrubContext
	): Promise<ScrubWindow | null> | null;
	now(): number;
	play(buffer: AudioBuffer, offset: number, volume: number): void;
}

/** A scrubber bound to its dependencies; the module default uses Web Audio. */
export function createScrubber(deps: ScrubberDeps) {
	const states = new WeakMap<HTMLMediaElement, ScrubState>();
	return (
		element: HTMLMediaElement,
		sourceTime: number,
		context: PreviewScrubContext
	) => {
		if (!deps.enabled()) {
			return;
		}
		const state = states.get(element) ?? {};
		states.set(element, state);
		const now = deps.now();
		const decision = scrubDecision(state, sourceTime, context, now);
		if (decision.kind === "skip") {
			return;
		}
		state.lastSourceTime = sourceTime;
		if (decision.kind === "track") {
			return;
		}
		const pending = deps.load(element, decision.offset, context);
		if (!pending) {
			return;
		}
		state.lastGrainAt = now;
		pending
			.then((window) => {
				// Only the latest position plays: a newer scrub supersedes this one.
				if (window && state.lastSourceTime === sourceTime) {
					deps.play(
						window.buffer,
						decision.offset - window.start,
						context.volume
					);
				}
			})
			.catch(() => {
				// Undecodable sources stay silent while scrubbing.
			});
	};
}

export function audioScrubEnabled(): boolean {
	return readViewerValue(SCRUB_PREFERENCE_KEY, z.boolean(), true);
}

/** Turn audio scrubbing on or off for this viewer. */
export function setAudioScrubEnabled(enabled: boolean): boolean {
	return writeViewerValue(SCRUB_PREFERENCE_KEY, enabled);
}

/** Bytes an AudioBuffer holds once decoded (32-bit float per sample). */
export function decodedBytes(
	buffer: Pick<AudioBuffer, "length" | "numberOfChannels">
): number {
	return buffer.length * buffer.numberOfChannels * 4;
}

interface CachedWindow {
	bytes: number;
	pending: Promise<ScrubWindow | null>;
}

/**
 * A least-recently-used cache of decoded windows bounded by decoded bytes.
 * Failed loads are dropped so a later scrub retries them.
 */
export function createScrubWindowCache(
	fetchWindow: (assetId: string, start: number) => Promise<ScrubWindow | null>,
	budgetBytes = SCRUB_CACHE_BYTES
) {
	const entries = new Map<string, CachedWindow>();
	const evict = (keep: string) => {
		let total = 0;
		for (const entry of entries.values()) {
			total += entry.bytes;
		}
		for (const [key, entry] of entries) {
			if (total <= budgetBytes) {
				break;
			}
			if (key !== keep) {
				entries.delete(key);
				total -= entry.bytes;
			}
		}
	};
	return {
		get(assetId: string, start: number): Promise<ScrubWindow | null> {
			const key = `${assetId}:${start}`;
			const cached = entries.get(key);
			if (cached) {
				// Refresh recency so the least recently scrubbed window goes first.
				entries.delete(key);
				entries.set(key, cached);
				return cached.pending;
			}
			const entry: CachedWindow = {
				bytes: 0,
				pending: fetchWindow(assetId, start)
					.catch(() => null)
					.then((window) => {
						if (entries.get(key) !== entry) {
							return window;
						}
						if (window) {
							entry.bytes = decodedBytes(window.buffer);
							evict(key);
						} else {
							entries.delete(key);
						}
						return window;
					}),
			};
			entries.set(key, entry);
			return entry.pending;
		},
		/** Decoded bytes currently held. */
		size(): number {
			let total = 0;
			for (const entry of entries.values()) {
				total += entry.bytes;
			}
			return total;
		},
	};
}

const windowResponseSchema = z.object({
	dataUrl: z.string(),
	start: z.number(),
});

async function fetchScrubWindow(
	assetId: string,
	start: number
): Promise<ScrubWindow | null> {
	const window = await request(
		windowResponseSchema,
		`/assets/${encodeURIComponent(assetId)}/audio-window`,
		"POST",
		{ start }
	);
	const bytes = await mediaDataUrlBlob(window.dataUrl).arrayBuffer();
	return { buffer: await decodePreviewAudio(bytes), start: window.start };
}

const windows = createScrubWindowCache(fetchScrubWindow);

function loadScrubAudio(
	element: HTMLMediaElement,
	sourceTime: number,
	context: PreviewScrubContext
): Promise<ScrubWindow | null> | null {
	// Metadata must be loaded so the window is known to lie inside the source.
	if (
		!(context.assetId && Number.isFinite(element.duration)) ||
		sourceTime >= element.duration
	) {
		return null;
	}
	return windows.get(context.assetId, scrubWindowStart(sourceTime));
}

function playGrain(buffer: AudioBuffer, offset: number, volume: number) {
	if (offset < 0 || offset >= buffer.duration) {
		return;
	}
	const audio = previewAudioContext();
	if (audio.state === "suspended") {
		// Scrubbing starts from a pointer gesture, which lets the context resume.
		audio.resume().catch(() => undefined);
	}
	const source = audio.createBufferSource();
	source.buffer = buffer;
	const envelope = audio.createGain();
	const start = audio.currentTime;
	for (const [index, [at, gain]] of grainEnvelope(volume).entries()) {
		if (index === 0) {
			envelope.gain.setValueAtTime(gain, start + at);
		} else {
			envelope.gain.linearRampToValueAtTime(gain, start + at);
		}
	}
	source.connect(envelope);
	// Through the master limiter and meter, like playback.
	envelope.connect(previewMasterMeter()?.master ?? audio.destination);
	source.onended = () => {
		source.disconnect();
		envelope.disconnect();
	};
	source.start(start, offset, SCRUB_GRAIN_SECONDS);
}

const scrub = createScrubber({
	enabled: audioScrubEnabled,
	load: loadScrubAudio,
	now: () => performance.now(),
	play: playGrain,
});

/** Called on every paused preview sync after the element was seeked to `sourceTime`. */
export function scrubPreviewAudio(
	element: HTMLMediaElement,
	sourceTime: number,
	context: PreviewScrubContext
): void {
	scrub(element, sourceTime, context);
}
