/** Browser screen and camera capture (feature-detected), recorded to WebM. */

export type CaptureSource = "screen" | "camera";

export const CAPTURE_LABELS: Readonly<Record<CaptureSource, string>> = {
	camera: "Camera recording",
	screen: "Screen recording",
};

/** Longest browser capture kept in memory before it stops on its own. */
export const MAX_CAPTURE_SECONDS = 30 * 60;

/** WebM types tried in order; the first the browser can record wins. */
export const WEBM_TYPES = [
	"video/webm;codecs=vp9,opus",
	"video/webm;codecs=vp8,opus",
	"video/webm;codecs=vp9",
	"video/webm;codecs=vp8",
	"video/webm",
] as const;

/** The parts of a `MediaStreamTrack` the recorder uses. */
export interface CaptureTrack {
	addEventListener(type: "ended", listener: () => void): void;
	stop(): void;
}

/** The parts of a `MediaStream` the recorder uses. */
export interface CaptureStream {
	getTracks(): CaptureTrack[];
}

/** Callbacks a capture recorder reports to. */
export interface CaptureRecorderHandlers {
	data(chunk: Blob): void;
	error(): void;
	stop(): void;
}

/** The parts of a `MediaRecorder` the recorder uses. */
export interface CaptureMediaRecorder {
	/** Attach handlers, or detach them with null. */
	listen(handlers: CaptureRecorderHandlers | null): void;
	readonly mimeType: string;
	start(timeslice?: number): void;
	readonly state: string;
	stop(): void;
}

/** What capture needs from the browser; every member is optional so it can be feature-detected. */
export interface CaptureEnvironment {
	createRecorder?: (
		stream: CaptureStream,
		mimeType: string | undefined
	) => CaptureMediaRecorder;
	getDisplayMedia?: (constraints: {
		audio: boolean;
		video: boolean;
	}) => Promise<CaptureStream>;
	getUserMedia?: (constraints: {
		audio: boolean;
		video: boolean;
	}) => Promise<CaptureStream>;
	isTypeSupported?: (mimeType: string) => boolean;
}

/** The live browser capture environment, detected without calling anything. */
export function browserCaptureEnvironment(
	scope: typeof globalThis = globalThis
): CaptureEnvironment {
	const environment: CaptureEnvironment = {};
	const devices = scope.navigator?.mediaDevices;
	if (typeof devices?.getDisplayMedia === "function") {
		environment.getDisplayMedia = (constraints) =>
			devices.getDisplayMedia(constraints);
	}
	if (typeof devices?.getUserMedia === "function") {
		environment.getUserMedia = (constraints) =>
			devices.getUserMedia(constraints);
	}
	const Recorder = scope.MediaRecorder;
	if (typeof Recorder === "function") {
		environment.isTypeSupported = (mimeType) =>
			typeof Recorder.isTypeSupported === "function" &&
			Recorder.isTypeSupported(mimeType);
		environment.createRecorder = (stream, mimeType) => {
			if (!(stream instanceof MediaStream)) {
				throw new Error("Capture did not return a media stream.");
			}
			const native = new Recorder(stream, mimeType ? { mimeType } : undefined);
			return {
				listen: (handlers) => {
					native.ondataavailable = handlers
						? (event) => handlers.data(event.data)
						: null;
					native.onerror = handlers ? () => handlers.error() : null;
					native.onstop = handlers ? () => handlers.stop() : null;
				},
				get mimeType() {
					return native.mimeType;
				},
				start: (timeslice) => native.start(timeslice),
				get state() {
					return native.state;
				},
				stop: () => native.stop(),
			};
		};
	}
	return environment;
}

export interface CaptureAvailability {
	available: boolean;
	/** Why the source is unavailable. */
	reason?: string;
}

const NO_RECORDER =
	"This view cannot record video: the host webview has no MediaRecorder.";

/** Which capture sources this environment exposes, with a reason for each missing one. */
export function captureSupport(
	environment: CaptureEnvironment
): Record<CaptureSource, CaptureAvailability> {
	const recorder = Boolean(environment.createRecorder);
	return {
		camera: environment.getUserMedia
			? recorder
				? { available: true }
				: { available: false, reason: NO_RECORDER }
			: {
					available: false,
					reason:
						"Ryu has not granted Video Studio camera capture on this surface.",
				},
		screen: environment.getDisplayMedia
			? recorder
				? { available: true }
				: { available: false, reason: NO_RECORDER }
			: {
					available: false,
					reason:
						"Ryu has not granted Video Studio screen capture on this surface.",
				},
	};
}

/** The first WebM type the recorder supports, or undefined to let it choose. */
export function recorderMimeType(
	isTypeSupported: ((mimeType: string) => boolean) | undefined
): string | undefined {
	if (!isTypeSupported) {
		return;
	}
	return WEBM_TYPES.find((type) => {
		try {
			return isTypeSupported(type);
		} catch {
			return false;
		}
	});
}

/** A user-facing reason for a refused or failed capture request. */
export function captureErrorMessage(
	source: CaptureSource,
	error: unknown
): string {
	const name =
		typeof error === "object" && error !== null && "name" in error
			? String(error.name)
			: "";
	const what = source === "screen" ? "screen" : "camera";
	if (name === "NotAllowedError" || name === "SecurityError") {
		return `The ${what} capture request was declined or the host has not granted it to Video Studio.`;
	}
	if (name === "NotFoundError" || name === "OverconstrainedError") {
		return source === "camera"
			? "No camera was found."
			: "No screen source was available.";
	}
	if (name === "NotReadableError") {
		return `The ${what} is in use by another app.`;
	}
	return error instanceof Error && error.message
		? error.message
		: `The ${what} capture did not start.`;
}

export type CaptureState =
	| { phase: "idle"; error?: string; notice?: string }
	| { phase: "requesting"; source: CaptureSource }
	| { phase: "recording"; source: CaptureSource; startedAt: number }
	| { phase: "stopping"; source: CaptureSource }
	| {
			blob: Blob;
			durationMs: number;
			error?: string;
			phase: "ready";
			source: CaptureSource;
	  }
	| { phase: "importing"; source: CaptureSource };

export interface CaptureDependencies {
	environment: CaptureEnvironment;
	now: () => number;
	/** Schedule the automatic stop; returns a cancel function. */
	schedule: (ms: number, run: () => void) => () => void;
}

const defaultSchedule = (ms: number, run: () => void) => {
	const timer = setTimeout(run, ms);
	return () => clearTimeout(timer);
};

/**
 * Records one screen or camera capture at a time with `MediaRecorder`. The
 * finished take waits in `ready` until it is imported or discarded; ending
 * the share from the browser's own controls stops it the same way.
 */
export class CaptureRecorder {
	private state: CaptureState = { phase: "idle" };
	private readonly listeners = new Set<() => void>();
	private readonly dependencies: CaptureDependencies;
	private recorder: CaptureMediaRecorder | null = null;
	private stream: CaptureStream | null = null;
	private chunks: Blob[] = [];
	private cancelLimit: (() => void) | null = null;
	private stopped: Promise<void> | null = null;

	constructor(dependencies: Partial<CaptureDependencies> = {}) {
		this.dependencies = {
			environment: dependencies.environment ?? browserCaptureEnvironment(),
			now: dependencies.now ?? Date.now,
			schedule: dependencies.schedule ?? defaultSchedule,
		};
	}

	getState = (): CaptureState => this.state;

	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	support() {
		return captureSupport(this.dependencies.environment);
	}

	private set(next: CaptureState) {
		this.state = next;
		for (const listener of this.listeners) {
			listener();
		}
	}

	private releaseStream() {
		for (const track of this.stream?.getTracks() ?? []) {
			track.stop();
		}
		this.stream = null;
		this.cancelLimit?.();
		this.cancelLimit = null;
	}

	/**
	 * Ask for the source and start recording. Call this straight from the
	 * click handler: browsers require a user gesture for screen capture.
	 */
	async start(source: CaptureSource): Promise<boolean> {
		if (this.state.phase !== "idle") {
			return false;
		}
		const { environment } = this.dependencies;
		const availability = captureSupport(environment)[source];
		const request =
			source === "screen"
				? environment.getDisplayMedia
				: environment.getUserMedia;
		if (!(availability.available && request && environment.createRecorder)) {
			this.set({
				error: availability.reason ?? "Capture is unavailable.",
				phase: "idle",
			});
			return false;
		}
		this.set({ phase: "requesting", source });
		let stream: CaptureStream;
		try {
			stream = await request({ audio: true, video: true });
		} catch (error) {
			this.set({ error: captureErrorMessage(source, error), phase: "idle" });
			return false;
		}
		let recorder: CaptureMediaRecorder;
		try {
			recorder = environment.createRecorder(
				stream,
				recorderMimeType(environment.isTypeSupported)
			);
		} catch (error) {
			for (const track of stream.getTracks()) {
				track.stop();
			}
			this.set({ error: captureErrorMessage(source, error), phase: "idle" });
			return false;
		}
		this.stream = stream;
		this.recorder = recorder;
		this.chunks = [];
		const startedAt = this.dependencies.now();
		this.stopped = new Promise<void>((resolve) => {
			recorder.listen({
				data: (chunk) => {
					if (chunk.size > 0) {
						this.chunks.push(chunk);
					}
				},
				error: () => {
					this.finish(source, startedAt, "The recorder stopped with an error.");
					resolve();
				},
				stop: () => {
					this.finish(source, startedAt);
					resolve();
				},
			});
		});
		for (const track of stream.getTracks()) {
			track.addEventListener("ended", () => {
				this.stop().catch(() => undefined);
			});
		}
		this.cancelLimit = this.dependencies.schedule(
			MAX_CAPTURE_SECONDS * 1000,
			() => {
				this.stop().catch(() => undefined);
			}
		);
		try {
			recorder.start(1000);
		} catch (error) {
			this.releaseStream();
			this.recorder = null;
			this.set({ error: captureErrorMessage(source, error), phase: "idle" });
			return false;
		}
		this.set({ phase: "recording", source, startedAt });
		return true;
	}

	private finish(source: CaptureSource, startedAt: number, error?: string) {
		if (!this.recorder) {
			return;
		}
		const mimeType = this.recorder.mimeType || "video/webm";
		this.recorder = null;
		this.releaseStream();
		const blob = new Blob(this.chunks, { type: mimeType });
		this.chunks = [];
		if (blob.size === 0) {
			this.set({
				error: error ?? "The capture produced no video. Record again.",
				phase: "idle",
			});
			return;
		}
		const durationMs = Math.max(0, this.dependencies.now() - startedAt);
		this.set(
			error
				? { blob, durationMs, error, phase: "ready", source }
				: { blob, durationMs, phase: "ready", source }
		);
	}

	/** Stop recording; resolves once the take is `ready` (or failed). */
	async stop(): Promise<void> {
		const { state, recorder } = this;
		if (state.phase !== "recording" || !recorder) {
			await this.stopped;
			return;
		}
		this.set({ phase: "stopping", source: state.source });
		if (recorder.state !== "inactive") {
			try {
				recorder.stop();
			} catch {
				this.finish(state.source, state.startedAt);
				return;
			}
		}
		await this.stopped;
	}

	/**
	 * Hand the ready take to `place` (import plus placement). A failed
	 * `place` keeps the take ready for another try.
	 */
	async commit(
		place: (blob: Blob, source: CaptureSource) => Promise<string>
	): Promise<boolean> {
		const { state } = this;
		if (state.phase !== "ready") {
			return false;
		}
		this.set({ phase: "importing", source: state.source });
		try {
			const notice = await place(state.blob, state.source);
			this.set({ notice, phase: "idle" });
			return true;
		} catch (error) {
			this.set({
				...state,
				error:
					error instanceof Error && error.message
						? error.message
						: "The recording could not be imported.",
			});
			return false;
		}
	}

	/** Throw away the ready take, or abandon a running capture. */
	discard() {
		if (this.recorder) {
			const recorder = this.recorder;
			this.recorder = null;
			recorder.listen(null);
			if (recorder.state !== "inactive") {
				try {
					recorder.stop();
				} catch {
					// Already stopped; the stream is released below.
				}
			}
		}
		this.releaseStream();
		this.chunks = [];
		this.stopped = null;
		this.set({ notice: "Recording discarded.", phase: "idle" });
	}
}

let shared: CaptureRecorder | null = null;

/**
 * The capture recorder for this document. It outlives the panel so a
 * recording keeps running while the viewer switches library tabs.
 */
export function sharedCaptureRecorder(): CaptureRecorder {
	shared ??= new CaptureRecorder();
	return shared;
}
