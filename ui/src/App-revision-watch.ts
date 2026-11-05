import type { SetStateAction } from "react";
import type { Project } from "../../shared/project.ts";
import { recordHistory } from "./editor/history.ts";
import type { useStatusLine } from "./editor/status-notice.ts";
import type { createEditorStore } from "./editor/store.ts";
import { useRevisionWatch } from "./editor/use-revision-watch.ts";
import { studioFormat } from "./i18n/format.ts";

export interface StudioRevisionWatchOptions {
	busy: boolean;
	commitServerProjectRef: {
		current: (next: Project, previous?: Project, label?: string) => void;
	};
	dirtyRef: { current: boolean };
	latestProject: { current: Project | null };
	project: Project | null;
	setDirty: (next: boolean) => void;
	setProject: (next: SetStateAction<Project | null>) => void;
	setStatus: ReturnType<typeof useStatusLine>["setStatus"];
	store: ReturnType<typeof createEditorStore>;
}

// Edits an agent (or another window) saves appear live as undoable steps.
export function useStudioRevisionWatch({
	busy,
	commitServerProjectRef,
	dirtyRef,
	latestProject,
	project,
	setDirty,
	setProject,
	setStatus,
	store,
}: StudioRevisionWatchOptions): void {
	useRevisionWatch({
		busy,
		dirtyRef,
		latestProject,
		onConflict: (conflicts) => {
			const known = store.getState().mergeConflicts;
			if (JSON.stringify(known) !== JSON.stringify(conflicts)) {
				store.setState({ mergeConflicts: conflicts });
			}
		},
		onExternal: (next, previous) => {
			commitServerProjectRef.current(next, previous, "Agent edit");
			store.setState({ mergeConflicts: [] });
			setStatus(
				studioFormat(
					"Applied an edit saved outside this editor (revision {revision}). Undo reverts it.",
					{ revision: next.revision }
				)
			);
		},
		onMerge: (merged, previous) => {
			// The merged project carries the edit made elsewhere plus this
			// editor's unsaved edits; it stays unsaved, so autosave writes it on
			// the newer revision. Undo steps back to the pre-merge timeline.
			latestProject.current = merged;
			store.setState((state) => ({
				history: recordHistory(state.history, previous, "Agent edit"),
				mergeConflicts: [],
			}));
			setProject((current) => (current?.id === merged.id ? merged : current));
			setDirty(true);
			setStatus(
				studioFormat(
					"Merged an edit saved outside this editor (revision {revision}) under your unsaved edits.",
					{ revision: merged.revision }
				)
			);
		},
		projectId: project?.id ?? null,
	});
}
