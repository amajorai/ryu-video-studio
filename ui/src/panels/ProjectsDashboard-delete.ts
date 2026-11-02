import { z } from "zod";
import type { Project } from "../../../shared/project.ts";
import { resetHistory } from "../editor/project-actions.ts";
import type { EditorRuntime } from "../editor/runtime.ts";

export const deleteResponseSchema = z.object({
	deleted: z.object({ id: z.string() }).passthrough(),
});

/**
 * Show `next` (or nothing) after the open project was deleted, with no
 * selection, history, or marked range carried over from the deleted one.
 */
export function replaceOpenProject(
	runtime: EditorRuntime,
	next: Project | null
) {
	runtime.setDirty(false);
	runtime.setSelected(null);
	resetHistory(runtime);
	runtime.setTime(0);
	runtime.setPlaying(false);
	runtime.setRangeStart(0);
	runtime.setRangeEnd(1);
	runtime.setRangeMarked(false);
	runtime.setProject(next);
}
