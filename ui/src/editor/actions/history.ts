import { z } from "zod";
import { type Project, projectSchema } from "../../../../shared/project.ts";
import {
	isRevisionConflict,
	request,
	studioResponseSchema,
} from "../../bridge.ts";
import type { AutosaveStatus } from "../autosave.ts";
import { autosaveFor } from "../autosave-registry.ts";
import { emptyHistory, jumpHistory } from "../history.ts";
import type { EditorRuntime } from "../runtime.ts";
import type { ActionHandlers } from "./types.ts";

/**
 * Show the history state at `index` (a position from `historySteps`). The
 * jump is one change: the project and both stacks update together, so the
 * panel can land on any step without replaying undo one press at a time.
 */
export function jumpToHistory(runtime: EditorRuntime, index: number): boolean {
	const { project } = runtime;
	if (!project) {
		return false;
	}
	const result = jumpHistory(runtime.store.getState().history, project, index);
	if (!result) {
		return false;
	}
	runtime.store.setState({ history: result.state });
	runtime.latestProject.current = result.project;
	runtime.setProject(result.project);
	runtime.setDirty(true);
	return true;
}

/** One saved revision from `GET /projects/:id/history?summary=1`. */
export const savedRevisionSchema = z
	.object({
		duration: z.number(),
		revision: z.number().int().nonnegative(),
		segmentCount: z.number().int().nonnegative(),
		title: z.string(),
		updatedAt: z.string(),
	})
	.strict();

export const savedHistorySchema = z
	.object({
		current: z
			.object({
				revision: z.number().int().nonnegative(),
				updatedAt: z.string(),
			})
			.strict(),
		revisions: z.array(savedRevisionSchema),
	})
	.strict();

export type SavedRevision = z.infer<typeof savedRevisionSchema>;
export type SavedHistory = z.infer<typeof savedHistorySchema>;

/** Saved revisions of `projectId` (newest first), kept across sessions. */
export function loadSavedHistory(projectId: string): Promise<SavedHistory> {
	return request(
		savedHistorySchema,
		`/projects/${projectId}/history?summary=1`
	);
}

/**
 * Restore a saved revision as a new revision. Pending edits are saved first;
 * the timeline before the restore stays an undo step. On a revision conflict
 * the latest saved project is reloaded and history is cleared.
 */
export const restoreSavedRevision = (
	runtime: EditorRuntime,
	historyRevision: number
) =>
	runtime.act(async () => {
		// An autosave already writing would race `ensureSaved` with the same
		// revision; let it land first.
		await autosaveFor(runtime.store)?.settled();
		const previous = runtime.latestProject.current ?? runtime.project;
		const saved = await runtime.ensureSaved();
		if (!(previous && saved)) {
			return;
		}
		try {
			const restored = projectSchema.parse(
				await request(
					studioResponseSchema,
					`/projects/${saved.id}/history`,
					"POST",
					{ historyRevision, revision: saved.revision }
				)
			);
			runtime.commitServerProject(restored, previous);
			runtime.setStatus(
				`Restored saved revision ${historyRevision} as revision ${restored.revision}.`
			);
		} catch (error) {
			if (!isRevisionConflict(error)) {
				throw error;
			}
			await reloadLatestProject(runtime, saved.id);
			runtime.setStatus(
				"The project changed elsewhere, so its latest revision was reloaded. Choose the revision to restore again."
			);
		}
	});

/**
 * Replace the open project with its latest saved revision, dropping unsaved
 * edits and undo history (they were made against an older revision).
 */
export async function reloadLatestProject(
	runtime: EditorRuntime,
	projectId: string
): Promise<Project> {
	const latest = projectSchema.parse(
		await request(studioResponseSchema, `/projects/${projectId}`)
	);
	runtime.commitServerProject(latest);
	runtime.setDirty(false);
	runtime.store.setState({
		history: emptyHistory(),
	});
	return latest;
}

/** Status line after a manual save that went through autosave. */
export const MANUAL_SAVE_STATUS: Record<AutosaveStatus, string | null> = {
	conflict:
		"This project changed in another editor. Reload it before saving again.",
	// The failure was already reported by autosave.
	error: null,
	saved: "Project saved.",
	saving: null,
	unsaved: "Project saved. Newer edits will be saved shortly.",
};

/**
 * Cmd+S. With autosave mounted, the save goes through it so it never races
 * an in-flight autosave with the same revision; otherwise it saves directly.
 */
export function saveProjectNow(runtime: EditorRuntime): Promise<void> {
	const autosave = autosaveFor(runtime.store);
	if (!autosave) {
		return runtime.act(async () => {
			await runtime.save();
		});
	}
	return autosave.saveNow().then((status) => {
		const text = MANUAL_SAVE_STATUS[status];
		if (text) {
			runtime.setStatus(text);
		}
	});
}

/**
 * Undo, redo (Cmd/Ctrl+Shift+Z), and save. Ctrl+Y (`history.redoAlt`) is
 * handled with the selection shortcuts in `select.ts`.
 */
export const historyActions: ActionHandlers = {
	"history.redo": (runtime) => {
		runtime.redo();
	},
	"history.undo": (runtime) => {
		runtime.undo();
	},
	"project.save": (runtime) => {
		void saveProjectNow(runtime);
	},
};
