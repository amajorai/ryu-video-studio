import type { Project } from "../../../shared/project.ts";

/** Undo depth kept in memory; older steps are dropped first. */
export const HISTORY_LIMIT = 100;

/**
 * One undoable snapshot. In `past` it is the state before an edit, and
 * `label`/`at` describe that edit; in `future` it is the state an undone edit
 * produced, and `label`/`at` describe the edit that produced it.
 */
export interface HistoryEntry {
	/** When the edit was made (epoch milliseconds). */
	at: number;
	/** Short description of the edit. */
	label: string;
	project: Project;
}

/**
 * Undo/redo stacks. Redo entries (the branch you undid) are kept until the
 * next edit replaces them, so jumping back and forth never loses a step.
 */
export interface HistoryState {
	/** Redo stack; the next redo target is first. */
	future: HistoryEntry[];
	/** Undo stack; the most recent snapshot is last. */
	past: HistoryEntry[];
	/**
	 * True once `recordHistory` dropped the oldest snapshot at `HISTORY_LIMIT`,
	 * so the oldest kept state is no longer the one the project opened in.
	 */
	trimmed?: boolean;
}

export const DEFAULT_EDIT_LABEL = "Edit";

export function emptyHistory(): HistoryState {
	return { future: [], past: [] };
}

/** Record `previous` before an edit; a new edit clears the redo stack. */
export function recordHistory(
	state: HistoryState,
	previous: Project,
	label = DEFAULT_EDIT_LABEL,
	at = Date.now()
): HistoryState {
	const drops = state.past.length >= HISTORY_LIMIT;
	return withTrimmed(
		{
			future: [],
			past: [
				...state.past.slice(-(HISTORY_LIMIT - 1)),
				{ at, label, project: previous },
			],
		},
		state.trimmed === true || drops
	);
}

/** Set `trimmed` only when true, so untrimmed states keep their plain shape. */
function withTrimmed(state: HistoryState, trimmed: boolean | undefined) {
	return trimmed ? { ...state, trimmed: true } : state;
}

/**
 * Restore the previous snapshot. Decisions and the revision always come from
 * `current`: the decision log is append-only on the sidecar and the revision
 * must stay the saved one for the next revision-checked save.
 */
export function undoHistory(
	state: HistoryState,
	current: Project
): { project: Project; state: HistoryState } | null {
	const previous = state.past.at(-1);
	if (!previous) {
		return null;
	}
	return {
		project: {
			...previous.project,
			decisions: current.decisions,
			revision: current.revision,
		},
		state: withTrimmed(
			{
				future: [
					{ at: previous.at, label: previous.label, project: current },
					...state.future,
				],
				past: state.past.slice(0, -1),
			},
			state.trimmed
		),
	};
}

/** Re-apply the next undone snapshot (same decision/revision rule as undo). */
export function redoHistory(
	state: HistoryState,
	current: Project
): { project: Project; state: HistoryState } | null {
	const next = state.future[0];
	if (!next) {
		return null;
	}
	return {
		project: {
			...next.project,
			decisions: current.decisions,
			revision: current.revision,
		},
		state: withTrimmed(
			{
				future: state.future.slice(1),
				past: [
					...state.past,
					{ at: next.at, label: next.label, project: current },
				],
			},
			state.trimmed
		),
	};
}

/** Apply `update` to every stored snapshot (for settings saved out of band). */
export function mapHistory(
	state: HistoryState,
	update: (project: Project) => Project
): HistoryState {
	return withTrimmed(
		{
			future: state.future.map((entry) => ({
				...entry,
				project: update(entry.project),
			})),
			past: state.past.map((entry) => ({
				...entry,
				project: update(entry.project),
			})),
		},
		state.trimmed
	);
}

/** Label of the oldest state when it is the state the project opened in. */
export const HISTORY_ORIGIN_LABEL = "Opened";
/** Label of the oldest state once older steps were dropped at the limit. */
export const HISTORY_TRIMMED_ORIGIN_LABEL = "Oldest kept step";

/** One state in the history list, oldest first. */
export interface HistoryStep {
	/** When the edit that produced this state was made; null for the origin. */
	at: number | null;
	/** Position to pass to `jumpHistory`. */
	index: number;
	/** The edit that produced this state (the origin uses `HISTORY_ORIGIN_LABEL`). */
	label: string;
	/** `current` is the shown state; `undone` steps are the kept redo branch. */
	state: "applied" | "current" | "undone";
}

/**
 * Every state the history can reach, oldest first: the origin, each applied
 * edit up to the current state, then the undone edits still available to
 * redo. `index` counts states, so the current one is `past.length`.
 */
export function historySteps(state: HistoryState): HistoryStep[] {
	const current = state.past.length;
	const steps: HistoryStep[] = [
		{
			at: null,
			index: 0,
			label: state.trimmed
				? HISTORY_TRIMMED_ORIGIN_LABEL
				: HISTORY_ORIGIN_LABEL,
			state: current === 0 ? "current" : "applied",
		},
	];
	for (const [offset, entry] of state.past.entries()) {
		const index = offset + 1;
		steps.push({
			at: entry.at,
			index,
			label: entry.label,
			state: index === current ? "current" : "applied",
		});
	}
	for (const [offset, entry] of state.future.entries()) {
		steps.push({
			at: entry.at,
			index: current + offset + 1,
			label: entry.label,
			state: "undone",
		});
	}
	return steps;
}

/** Position of the shown state in `historySteps`. */
export function currentHistoryIndex(state: HistoryState): number {
	return state.past.length;
}

/**
 * Move to the state at `index` (see `historySteps`) in one step: undo or redo
 * as many edits as it takes, keeping the rest of both stacks. Decisions and
 * the revision stay `current`'s, as with a single undo. Returns null when
 * `index` is out of range or already shown.
 */
export function jumpHistory(
	state: HistoryState,
	current: Project,
	index: number
): { project: Project; state: HistoryState } | null {
	const here = currentHistoryIndex(state);
	const last = here + state.future.length;
	if (!Number.isInteger(index) || index < 0 || index > last || index === here) {
		return null;
	}
	const step = index < here ? undoHistory : redoHistory;
	let result: { project: Project; state: HistoryState } = {
		project: current,
		state,
	};
	for (let moves = Math.abs(index - here); moves > 0; moves--) {
		const next = step(result.state, result.project);
		if (!next) {
			return null;
		}
		result = next;
	}
	return result;
}
