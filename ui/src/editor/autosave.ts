import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { type Project, projectSchema } from "../../../shared/project.ts";
import {
	isRevisionConflict,
	request,
	studioResponseSchema,
} from "../bridge.ts";
import { studioFormat } from "../i18n/format.ts";
import { reloadLatestProject } from "./actions/history.ts";
import { registerAutosave } from "./autosave-registry.ts";
import { message } from "./format.ts";
import { recordHistory } from "./history.ts";
import type { EditorRuntime } from "./runtime.ts";
import { mergeRemoteRevision, recordSavedBase } from "./saved-base.ts";

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
/** Most settle waits while this editor stays busy after a conflict. */
const CONFLICT_SETTLE_ATTEMPTS = 5;

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

function browserScheduler(): AutosaveScheduler {
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

/**
 * Save the latest timeline through the revision-checked `PUT`. The saved
 * revision is merged into whatever the viewer has now: if they edited while
 * the request was out, those edits stay (still dirty) on top of the new
 * revision instead of being replaced by the saved copy. Resolves `true` when
 * such newer edits remain.
 */
export async function saveLatestProject(
	getRuntime: () => EditorRuntime
): Promise<boolean> {
	const start = getRuntime();
	const target = start.latestProject.current ?? start.project;
	if (!target) {
		return false;
	}
	const saved = projectSchema.parse(
		await request(studioResponseSchema, `/projects/${target.id}`, "PUT", target)
	);
	recordSavedBase(saved);
	const runtime = getRuntime();
	const latest = runtime.latestProject.current ?? runtime.project;
	const unchanged =
		latest === target &&
		(runtime.project === target || runtime.project === null);
	const rebase = (current: Project): Project =>
		current.id === saved.id
			? {
					...current,
					revision: saved.revision,
					updatedAt: saved.updatedAt,
				}
			: current;
	if (unchanged) {
		runtime.latestProject.current = saved;
		runtime.setProject((current) =>
			current === target ? saved : current && rebase(current)
		);
		runtime.setDirty(false);
	} else {
		// Rebase the latest edits once and show that same object, so the next
		// save sees the shown project as the one it writes.
		const before = runtime.latestProject.current;
		const rebased = before && rebase(before);
		runtime.latestProject.current = rebased;
		runtime.setProject((current) =>
			current === before ? rebased : current && rebase(current)
		);
	}
	runtime.setProjects((current) => [
		saved,
		...current.filter((item) => item.id !== saved.id),
	]);
	return !unchanged;
}

/** Most re-reads when the viewer keeps editing while the newer revision loads. */
const MERGE_REREAD_ATTEMPTS = 3;

/**
 * After a conflict from a save elsewhere, merge the newer saved revision under
 * the editor's unsaved edits (three-way, base = the editor's last saved
 * revision). A clean merge is shown, still unsaved, at the newer revision,
 * recorded as an "Agent edit" undo step (like the revision watch's merge),
 * and resolves `true` so autosave writes it next. A conflict is recorded for
 * the "Changed elsewhere" banner and resolves `false`, as does a missing base.
 *
 * The merge is computed from the timeline the viewer has when the newer
 * revision arrives: an edit made while it loads is never replaced by a merge
 * of the older timeline. When the timeline changed during the read, the
 * revision is read again (at most `MERGE_REREAD_ATTEMPTS` times) and nothing
 * is merged if the viewer is still editing; the conflict then stands.
 */
export async function mergeAfterConflict(
	runtime: EditorRuntime
): Promise<boolean> {
	for (let attempt = 0; attempt < MERGE_REREAD_ATTEMPTS; attempt++) {
		const local = runtime.latestProject.current ?? runtime.project;
		if (!local) {
			return false;
		}
		const remote = projectSchema.parse(
			await request(studioResponseSchema, `/projects/${local.id}`)
		);
		const now = runtime.latestProject.current ?? runtime.project;
		if (now !== local) {
			continue;
		}
		return applyConflictMerge(runtime, local, remote);
	}
	return false;
}

function applyConflictMerge(
	runtime: EditorRuntime,
	local: Project,
	remote: Project
): boolean {
	if (remote.id !== local.id || remote.revision <= local.revision) {
		return false;
	}
	const merged = mergeRemoteRevision(local, remote);
	if (merged.status === "conflict") {
		runtime.store.setState({ mergeConflicts: merged.conflicts });
		return false;
	}
	if (merged.status === "no-base") {
		return false;
	}
	recordSavedBase(remote);
	const next = merged.project;
	runtime.latestProject.current = next;
	runtime.setProject((current) => (current === local ? next : current));
	runtime.setDirty(true);
	runtime.setProjects((current) => [
		remote,
		...current.filter((item) => item.id !== remote.id),
	]);
	runtime.store.setState((state) => ({
		history: recordHistory(state.history, local, "Agent edit"),
		mergeConflicts: [],
	}));
	runtime.setStatus(
		studioFormat(
			"Merged an edit saved outside this editor (revision {revision}) under your unsaved edits.",
			{ revision: remote.revision }
		)
	);
	return true;
}

/**
 * Run `operation` inside `runtime.act`, so the editor is busy (buttons and
 * shortcuts that save or edit through the sidecar wait) while it runs, but
 * hand its result or error back instead of letting `act` report it.
 */
async function underAct<T>(
	runtime: EditorRuntime,
	operation: () => Promise<T>
): Promise<T> {
	const box: { outcome?: { error: unknown } | { value: T } } = {};
	await runtime.act(async () => {
		try {
			box.outcome = { value: await operation() };
		} catch (error) {
			box.outcome = { error };
		}
	});
	const { outcome } = box;
	if (!outcome) {
		throw new Error("Autosave did not run.");
	}
	if ("error" in outcome) {
		throw outcome.error;
	}
	return outcome.value;
}

/**
 * One autosave write: `saveLatestProject` with the editor marked busy. A
 * revision conflict is first checked against this editor's own saves: an
 * action that started just before autosave (before its busy state rendered)
 * may have saved the same timeline. Autosave waits for it to land; when the
 * editor's revision has moved on, the conflict was its own and autosave goes
 * on (resolving `true` while edits are still unsaved). Otherwise the newer
 * revision is merged under the unsaved edits (`mergeAfterConflict`); only
 * when that merge conflicts is the conflict rethrown, as a save from
 * elsewhere.
 */
export async function autosaveOnce(
	getRuntime: () => EditorRuntime,
	wait: (ms: number) => Promise<void>,
	settleMs = AUTOSAVE_CONFLICT_SETTLE_MS
): Promise<boolean> {
	const start = getRuntime();
	const attempted = start.latestProject.current ?? start.project;
	try {
		return await underAct(start, () => saveLatestProject(getRuntime));
	} catch (error) {
		if (!(attempted && isRevisionConflict(error))) {
			throw error;
		}
		await wait(settleMs);
		for (
			let attempt = 1;
			attempt < CONFLICT_SETTLE_ATTEMPTS && getRuntime().busy;
			attempt++
		) {
			await wait(settleMs);
		}
		const runtime = getRuntime();
		const now = runtime.latestProject.current ?? runtime.project;
		if (now?.id === attempted.id && now.revision !== attempted.revision) {
			return runtime.dirty;
		}
		// Merge under the busy state, so the revision watch (which skips while
		// the editor is busy) cannot merge the same revision at the same time
		// and actions that save wait for the merge.
		const merged = await underAct(runtime, () =>
			mergeAfterConflict(getRuntime())
		).catch(() => false);
		if (merged) {
			return true;
		}
		throw error;
	}
}

export interface AutosaveHandle {
	/** Save now when edits are pending. */
	flush: () => Promise<void>;
	/** Load the latest saved revision after a conflict and resume autosave. */
	reload: () => Promise<void>;
	status: AutosaveStatus;
}

/**
 * Autosave the open project 2 s after the last edit (at an idle moment) and
 * when the page is hidden, and warn before leaving while edits are unsaved.
 * Saves go through the host bridge, which has no `keepalive`, so a save
 * started as the page closes may not finish: the leave warning is the
 * protection on close. Each write marks the editor busy, and Cmd+S and
 * saved-revision restores wait for it (see `autosave-registry.ts`). Mount
 * once, inside the editor provider.
 */
export function useAutosave(
	runtime: EditorRuntime,
	timing: Pick<AutosaveOptions, "delayMs" | "scheduler"> = {}
): AutosaveHandle {
	const runtimeRef = useRef(runtime);
	useLayoutEffect(() => {
		runtimeRef.current = runtime;
	});
	const [controller] = useState(() => {
		const scheduler = timing.scheduler ?? browserScheduler();
		const wait = (ms: number) =>
			new Promise<void>((resolve) => {
				scheduler.setTimeout(resolve, ms);
			});
		return createAutosaveController({
			canSave: () => !runtimeRef.current.busy,
			isDirty: () => runtimeRef.current.dirty,
			isConflict: isRevisionConflict,
			onError: (error) =>
				runtimeRef.current.setStatus(`Autosave failed: ${message(error)}`),
			save: () => autosaveOnce(() => runtimeRef.current, wait),
			...timing,
			scheduler,
		});
	});
	const { store } = runtime;
	useEffect(() => registerAutosave(store, controller), [store, controller]);
	// Unmounting (closing the editor) writes pending edits instead of dropping
	// them; it is a no-op when nothing is pending, so a remount is harmless.
	useEffect(
		() => () => {
			void controller.flush();
		},
		[controller]
	);
	const status = useSyncExternalStore(
		controller.subscribe,
		controller.getStatus,
		controller.getStatus
	);
	const { dirty, project } = runtime;
	useEffect(() => {
		if (!project) {
			return;
		}
		if (dirty) {
			controller.notifyEdit();
		} else {
			controller.markSaved();
		}
	}, [controller, dirty, project]);
	useEffect(() => {
		const onVisibility = () => {
			if (document.visibilityState === "hidden") {
				void controller.flush();
			}
		};
		// Best effort only: the page may unload before this save completes.
		const onPageHide = () => {
			void controller.flush();
		};
		const onBeforeUnload = (event: BeforeUnloadEvent) => {
			if (!(runtimeRef.current.dirty || controller.getStatus() === "saving")) {
				return;
			}
			void controller.flush();
			event.preventDefault();
			// Older engines show the leave prompt only when returnValue is set.
			event.returnValue = "";
		};
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("pagehide", onPageHide);
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => {
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("pagehide", onPageHide);
			window.removeEventListener("beforeunload", onBeforeUnload);
		};
	}, [controller]);
	return {
		flush: controller.flush,
		reload: async () => {
			const current = runtimeRef.current;
			const id = current.project?.id;
			if (!id) {
				return;
			}
			await current.act(async () => {
				await reloadLatestProject(current, id);
				current.store.setState({ mergeConflicts: [] });
				controller.resolveConflict();
				current.setStatus("Loaded the latest saved revision.");
			});
		},
		status,
	};
}
