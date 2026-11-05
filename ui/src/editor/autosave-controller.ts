/** Quiet time after the last edit before autosave writes it. */
export const AUTOSAVE_DELAY_MS = 2000;
/** Longest wait for an idle moment once the quiet time has passed. */
export const AUTOSAVE_IDLE_TIMEOUT_MS = 1000;
/** Wait before retrying a save that failed for a reason other than a conflict. */
export const AUTOSAVE_RETRY_MS = 10_000;
/**
 * After a revision conflict, how long autosave waits for one of this editor's
 * own saves to land before treating the conflict as a save from elsewhere.
 */
export const AUTOSAVE_CONFLICT_SETTLE_MS = 1000;

/**
 * `conflict` means the sidecar holds a newer revision: autosave stops until
 * the viewer reloads. `error` retries after `AUTOSAVE_RETRY_MS`.
 */
export type AutosaveStatus =
	| "saved"
	| "unsaved"
	| "saving"
	| "conflict"
	| "error";

export const AUTOSAVE_STATUS_LABELS: Record<AutosaveStatus, string> = {
	conflict: "Changed elsewhere",
	error: "Save failed",
	saved: "Saved",
	saving: "Saving…",
	unsaved: "Unsaved",
};

/** Timer surface, injectable so tests can drive time. */
export interface AutosaveScheduler {
	clearTimeout: (handle: unknown) => void;
	/** Run `run` when the page is idle, at most `timeoutMs` later; returns a cancel. */
	requestIdle?: (run: () => void, timeoutMs: number) => () => void;
	setTimeout: (run: () => void, ms: number) => unknown;
}

export interface AutosaveOptions {
	/** False while another operation owns the project (autosave waits). */
	canSave?: () => boolean;
	delayMs?: number;
	idleTimeoutMs?: number;
	/** Classify a failed save; conflicts stop autosave until `resolveConflict`. */
	isConflict?: (error: unknown) => boolean;
	/** False when nothing is left to write (a pending save then just settles). */
	isDirty?: () => boolean;
	onError?: (error: unknown) => void;
	retryMs?: number;
	/**
	 * Write the pending edits. Resolve `true` when newer edits arrived while
	 * saving, so another save is scheduled.
	 */
	save: () => Promise<boolean>;
	scheduler?: AutosaveScheduler;
}

export interface AutosaveController {
	dispose: () => void;
	/** Save now if edits are pending (visibility hidden, page hide). */
	flush: () => Promise<void>;
	getStatus: () => AutosaveStatus;
	/** The project was saved by someone else (manual save, route edit). */
	markSaved: () => void;
	/** An edit happened: restart the quiet-time debounce. */
	notifyEdit: () => void;
	/** The viewer reloaded after a conflict; autosave may run again. */
	resolveConflict: () => void;
	/**
	 * Manual save (Cmd+S): wait for any in-flight autosave, then save now if
	 * edits are still pending. Resolves with the resulting status; a conflict
	 * is reported, not overwritten.
	 */
	saveNow: () => Promise<AutosaveStatus>;
	/** Resolve once no autosave write is in flight. */
	settled: () => Promise<void>;
	subscribe: (listener: () => void) => () => void;
}

export function browserScheduler(): AutosaveScheduler {
	const idle = globalThis.requestIdleCallback;
	return {
		clearTimeout: (handle) => {
			globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
		},
		requestIdle:
			typeof idle === "function"
				? (run, timeoutMs) => {
						const handle = idle(() => run(), { timeout: timeoutMs });
						return () => globalThis.cancelIdleCallback(handle);
					}
				: undefined,
		setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
	};
}

/**
 * Debounced, single-flight autosave. Edits restart a quiet-time timer; when it
 * fires, the save waits for an idle moment and then runs once. Edits during a
 * save schedule exactly one follow-up save. A conflict halts autosave.
 */
export function createAutosaveController(
	options: AutosaveOptions
): AutosaveController {
	const scheduler = options.scheduler ?? browserScheduler();
	const delayMs = options.delayMs ?? AUTOSAVE_DELAY_MS;
	const idleTimeoutMs = options.idleTimeoutMs ?? AUTOSAVE_IDLE_TIMEOUT_MS;
	const retryMs = options.retryMs ?? AUTOSAVE_RETRY_MS;
	const canSave = options.canSave ?? (() => true);
	const isConflict = options.isConflict ?? (() => false);
	const isDirty = options.isDirty ?? (() => true);
	const listeners = new Set<() => void>();
	let status: AutosaveStatus = "saved";
	let timer: unknown = null;
	let cancelIdle: (() => void) | null = null;
	let inFlight: Promise<void> | null = null;
	let editedDuringSave = false;
	let disposed = false;

	const setStatus = (next: AutosaveStatus) => {
		if (next === status) {
			return;
		}
		status = next;
		for (const listener of listeners) {
			listener();
		}
	};
	const cancelPending = () => {
		if (timer !== null) {
			scheduler.clearTimeout(timer);
			timer = null;
		}
		cancelIdle?.();
		cancelIdle = null;
	};
	const schedule = (ms: number) => {
		cancelPending();
		timer = scheduler.setTimeout(() => {
			timer = null;
			if (scheduler.requestIdle) {
				cancelIdle = scheduler.requestIdle(() => {
					cancelIdle = null;
					void run();
				}, idleTimeoutMs);
				return;
			}
			void run();
		}, ms);
	};
	const pending = () => status === "unsaved" || status === "error";

	/** `force` skips the busy check: the caller (a manual save) owns the timing. */
	function run(force = false): Promise<void> {
		if (inFlight) {
			editedDuringSave = true;
			return inFlight;
		}
		if (disposed || !pending()) {
			return Promise.resolve();
		}
		if (!isDirty()) {
			cancelPending();
			setStatus("saved");
			return Promise.resolve();
		}
		if (!(force || canSave())) {
			schedule(delayMs);
			return Promise.resolve();
		}
		cancelPending();
		editedDuringSave = false;
		setStatus("saving");
		inFlight = options
			.save()
			.then((newerEdits) => {
				inFlight = null;
				if (disposed) {
					return;
				}
				if (newerEdits || editedDuringSave) {
					setStatus("unsaved");
					schedule(delayMs);
					return;
				}
				setStatus("saved");
			})
			.catch((error: unknown) => {
				inFlight = null;
				if (disposed) {
					return;
				}
				if (isConflict(error)) {
					cancelPending();
					setStatus("conflict");
					return;
				}
				options.onError?.(error);
				setStatus("error");
				schedule(retryMs);
			});
		return inFlight;
	}

	return {
		dispose: () => {
			disposed = true;
			cancelPending();
			listeners.clear();
		},
		flush: () => run(),
		getStatus: () => status,
		markSaved: () => {
			if (inFlight || status === "conflict") {
				return;
			}
			cancelPending();
			setStatus("saved");
		},
		notifyEdit: () => {
			if (disposed || status === "conflict") {
				return;
			}
			if (inFlight) {
				editedDuringSave = true;
				return;
			}
			setStatus("unsaved");
			schedule(delayMs);
		},
		resolveConflict: () => {
			if (status === "conflict") {
				setStatus("saved");
			}
		},
		saveNow: async () => {
			if (inFlight) {
				await inFlight;
			}
			if (disposed || status === "conflict") {
				return status;
			}
			if (!isDirty()) {
				cancelPending();
				setStatus("saved");
				return status;
			}
			setStatus("unsaved");
			await run(true);
			return status;
		},
		settled: () =>
			inFlight ? inFlight.then(() => undefined) : Promise.resolve(),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
