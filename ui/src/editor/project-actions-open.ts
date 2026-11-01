import type { Project } from "../../../shared/project.ts";
import { emptyHistory, recordHistory } from "./history.ts";
import type { EditorRuntime } from "./runtime.ts";

/** Forget undo history (another project, or a revision reloaded from disk). */
export function resetHistory(runtime: EditorRuntime) {
	runtime.store.setState({ history: emptyHistory() });
}

/** Record `previous` as an undo step without changing the project. */
export function pushHistory(
	runtime: EditorRuntime,
	previous: Project,
	label: string
) {
	runtime.store.setState((state) => ({
		history: recordHistory(state.history, previous, label),
	}));
}

/** Show `next` as a freshly opened project: no selection, history, or range. */
export function openFresh(
	runtime: EditorRuntime,
	next: Project,
	options: { resetRange: boolean; resetTime: boolean }
) {
	runtime.setProject(next);
	runtime.setSelected(null);
	resetHistory(runtime);
	if (options.resetTime) {
		runtime.setTime(0);
	}
	if (options.resetRange) {
		runtime.setRangeStart(0);
		runtime.setRangeEnd(1);
	}
	runtime.setRangeMarked(false);
}

/** Prepend `next` to the project list, replacing an older copy. */
export const withProject = (projects: Project[], next: Project) => [
	next,
	...projects.filter((item) => item.id !== next.id),
];
