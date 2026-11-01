import type { MediaRecordingInput } from "@ryu/app-host/media-recording";
import { z } from "zod";
import { parseMediaDataUrl, type RecordedMedia } from "./import.ts";

/**
 * Host microphone capture (`media.recording`). Replies are validated by the
 * recorder, so the bridge may return anything the host sends.
 */
export type RecordingBridge = (input: MediaRecordingInput) => Promise<unknown>;

/** Seconds counted down over the preview before the microphone opens. */
export const COUNT_IN_SECONDS = 3;

export const UNAVAILABLE_MESSAGE =
	"Ryu has not granted Video Studio microphone capture on this surface. Import a voice recording from Media instead.";

const recordingResultSchema = z.object({
	audio: z.string().optional(),
	available: z.boolean(),
	durationMs: z.number().nonnegative().optional(),
	filename: z.string().optional(),
	id: z.string().min(1).max(80).optional(),
	message: z.string().optional(),
	startedAt: z.string().optional(),
	state: z.enum(["idle", "recording", "pending"]),
});
type RecordingResult = z.infer<typeof recordingResultSchema>;

/**
 * The host `media.recording` bridge, or null when this surface does not
 * expose one. Results are validated before the recorder trusts them.
 */
export function hostRecordingBridge(
	host: unknown = globalThis.window?.ryu
): RecordingBridge | null {
	if (!(typeof host === "object" && host !== null)) {
		return null;
	}
	const media: unknown = Reflect.get(host, "media");
	if (!(typeof media === "object" && media !== null)) {
		return null;
	}
	const capture: unknown = Reflect.get(media, "recording");
	if (typeof capture !== "function") {
		return null;
	}
	return async (input) =>
		await Promise.resolve(Reflect.apply(capture, media, [input]));
}

export type VoiceoverState =
	| { phase: "checking" }
	| { message: string; phase: "unavailable" }
	| { error?: string; notice?: string; phase: "idle" }
	| { phase: "counting"; remaining: number }
	| { error?: string; id: string; phase: "recording"; startedAt: number }
	| { id: string; phase: "stopping"; startedAt: number }
	| { durationMs?: number; error?: string; id: string; phase: "pending" }
	| { id: string; phase: "importing" };

export type VoiceoverEvent =
	| { result: RecordingResult; type: "status"; now: number }
	| { error: string; type: "failed" }
	| { remaining: number; type: "count" }
	| { type: "cancel" }
	| { type: "importing" }
	| { type: "stopping" }
	| { notice: string; type: "placed" };

function fromStatus(result: RecordingResult, now: number): VoiceoverState {
	if (!result.available) {
		return {
			message: result.message?.trim() || UNAVAILABLE_MESSAGE,
			phase: "unavailable",
		};
	}
	if (result.state === "recording" && result.id) {
		const started = result.startedAt
			? Date.parse(result.startedAt)
			: Number.NaN;
		return {
			id: result.id,
			phase: "recording",
			startedAt: Number.isFinite(started)
				? started
				: now - (result.durationMs ?? 0),
		};
	}
	if (result.state === "pending" && result.id) {
		return result.durationMs === undefined
			? { id: result.id, phase: "pending" }
			: { durationMs: result.durationMs, id: result.id, phase: "pending" };
	}
	return { phase: "idle" };
}

/**
 * The voiceover state machine. Pure: the recorder feeds it host status
 * replies and user steps, and renders whatever it returns.
 */
export function voiceoverTransition(
	state: VoiceoverState,
	event: VoiceoverEvent
): VoiceoverState {
	switch (event.type) {
		case "status":
			return fromStatus(event.result, event.now);
		case "count":
			return state.phase === "idle" || state.phase === "counting"
				? { phase: "counting", remaining: event.remaining }
				: state;
		case "cancel":
			return state.phase === "counting" ? { phase: "idle" } : state;
		case "stopping":
			return state.phase === "recording"
				? { id: state.id, phase: "stopping", startedAt: state.startedAt }
				: state;
		case "importing":
			return state.phase === "pending"
				? { id: state.id, phase: "importing" }
				: state;
		case "placed":
			return { notice: event.notice, phase: "idle" };
		case "failed":
			if (state.phase === "importing" || state.phase === "pending") {
				return { error: event.error, id: state.id, phase: "pending" };
			}
			// The host may still be capturing: a failed poll or stop keeps the
			// take live (and stoppable) until the host itself reports pending.
			if (state.phase === "recording" || state.phase === "stopping") {
				return {
					error: event.error,
					id: state.id,
					phase: "recording",
					startedAt: state.startedAt,
				};
			}
			return { error: event.error, phase: "idle" };
		default:
			return state;
	}
}

export interface VoiceoverDependencies {
	bridge: RecordingBridge | null;
	now: () => number;
	/** Resolve after `ms`, or reject when `signal` aborts. */
	wait: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const realWait = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true }
		);
	});

const errorText = (error: unknown, fallback: string) =>
	error instanceof Error && error.message ? error.message : fallback;

/**
 * Drives host microphone capture for a voiceover: status, a count-in,
 * start, stop, read, and discard once the take is safely imported. The
 * host keeps the take until it is discarded, so a recorder rebuilt after
 * the panel remounts picks it up again through `refresh`.
 */
export class VoiceoverRecorder {
	private state: VoiceoverState;
	private readonly listeners = new Set<() => void>();
	private countIn: AbortController | null = null;
	private readonly dependencies: VoiceoverDependencies;

	constructor(dependencies: Partial<VoiceoverDependencies> = {}) {
		this.dependencies = {
			bridge:
				dependencies.bridge === undefined
					? hostRecordingBridge()
					: dependencies.bridge,
			now: dependencies.now ?? Date.now,
			wait: dependencies.wait ?? realWait,
		};
		this.state = this.dependencies.bridge
			? { phase: "checking" }
			: { message: UNAVAILABLE_MESSAGE, phase: "unavailable" };
	}

	getState = (): VoiceoverState => this.state;

	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	private dispatch(event: VoiceoverEvent) {
		const next = voiceoverTransition(this.state, event);
		if (next !== this.state) {
			this.state = next;
			for (const listener of this.listeners) {
				listener();
			}
		}
	}

	private async call(input: MediaRecordingInput): Promise<RecordingResult> {
		const { bridge } = this.dependencies;
		if (!bridge) {
			throw new Error(UNAVAILABLE_MESSAGE);
		}
		return recordingResultSchema.parse(await bridge(input));
	}

	private async status(input: MediaRecordingInput) {
		const result = await this.call(input);
		this.dispatch({ now: this.dependencies.now(), result, type: "status" });
		return result;
	}

	/** Ask the host for the current capture state (also detects a host auto-stop). */
	async refresh(): Promise<void> {
		if (!this.dependencies.bridge) {
			return;
		}
		try {
			await this.status({ action: "status" });
		} catch (error) {
			this.dispatch({
				error: errorText(error, "Could not reach the microphone."),
				type: "failed",
			});
		}
	}

	/**
	 * Count in, then open the microphone. `onCount` sees each remaining
	 * second (3, 2, 1) and then 0 when capture begins. Resolves false when
	 * the count-in was cancelled or capture did not start.
	 */
	async start(
		countIn = COUNT_IN_SECONDS,
		onCount?: (remaining: number) => void
	): Promise<boolean> {
		if (this.state.phase !== "idle") {
			return false;
		}
		const controller = new AbortController();
		this.countIn = controller;
		try {
			for (
				let remaining = Math.max(0, Math.round(countIn));
				remaining > 0;
				remaining -= 1
			) {
				this.dispatch({ remaining, type: "count" });
				onCount?.(remaining);
				await this.dependencies.wait(1000, controller.signal);
			}
		} catch {
			return false;
		} finally {
			if (this.countIn === controller) {
				this.countIn = null;
			}
		}
		if (controller.signal.aborted) {
			return false;
		}
		onCount?.(0);
		try {
			const result = await this.status({ action: "start" });
			const after = this.getState();
			if (after.phase === "recording") {
				return true;
			}
			if (after.phase === "idle" && result.available) {
				this.dispatch({
					error:
						result.message?.trim() ||
						"The microphone did not start. Check that Ryu may use it, then try again.",
					type: "failed",
				});
			}
			return false;
		} catch (error) {
			this.dispatch({
				error: errorText(error, "The microphone did not start."),
				type: "failed",
			});
			return false;
		}
	}

	/** Cancel a running count-in. */
	cancel() {
		this.countIn?.abort(new Error("Count-in cancelled."));
		this.countIn = null;
		this.dispatch({ type: "cancel" });
	}

	/** Stop capture; the take stays pending on the host until it is placed or discarded. */
	async stop(): Promise<void> {
		const { state } = this;
		if (state.phase !== "recording") {
			return;
		}
		this.dispatch({ type: "stopping" });
		try {
			await this.status({ action: "stop", id: state.id });
		} catch (error) {
			this.dispatch({
				error: errorText(error, "The recording did not stop cleanly."),
				type: "failed",
			});
		}
	}

	/**
	 * Read the pending take, hand it to `place` (import plus timeline
	 * placement), and discard the host copy once `place` succeeds. A failed
	 * `place` keeps the take pending so it can be retried.
	 */
	async commit(
		place: (media: RecordedMedia, durationMs?: number) => Promise<string>,
		name: string
	): Promise<boolean> {
		const { state } = this;
		if (state.phase !== "pending") {
			return false;
		}
		this.dispatch({ type: "importing" });
		try {
			const take = await this.call({ action: "read", id: state.id });
			const audio = take.audio ? parseMediaDataUrl(take.audio) : null;
			if (!audio) {
				throw new Error("The host returned no audio for this recording.");
			}
			const notice = await place(
				{ base64: audio.base64, mimeType: audio.mimeType, name },
				take.durationMs ?? state.durationMs
			);
			await this.call({ action: "discard", id: state.id }).catch(
				() => undefined
			);
			this.dispatch({ notice, type: "placed" });
			return true;
		} catch (error) {
			this.dispatch({
				error: errorText(error, "The recording could not be imported."),
				type: "failed",
			});
			return false;
		}
	}

	/** Throw away the pending take. */
	async discard(): Promise<void> {
		const { state } = this;
		if (state.phase !== "pending" && state.phase !== "recording") {
			return;
		}
		try {
			await this.call({ action: "discard", id: state.id });
			this.dispatch({ notice: "Recording discarded.", type: "placed" });
		} catch (error) {
			this.dispatch({
				error: errorText(error, "The recording could not be discarded."),
				type: "failed",
			});
		}
	}
}

/** Seconds elapsed in a recording, for the live readout. */
export function elapsedSeconds(state: VoiceoverState, now: number): number {
	return state.phase === "recording"
		? Math.max(0, (now - state.startedAt) / 1000)
		: 0;
}

/**
 * Preroll playback: when the timeline plays during the count-in, start it
 * `countIn` seconds before the anchor (clamped at 0) and delay it so the
 * playhead reaches the anchor as capture begins.
 */
export function prerollPlan(
	anchor: number,
	countIn = COUNT_IN_SECONDS
): { delayMs: number; startTime: number } {
	const safeAnchor = Math.max(0, Number.isFinite(anchor) ? anchor : 0);
	const startTime = Math.max(0, safeAnchor - countIn);
	return {
		delayMs: Math.round((countIn - (safeAnchor - startTime)) * 1000),
		startTime,
	};
}
