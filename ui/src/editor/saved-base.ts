import type { Project } from "../../../shared/project.ts";
import {
	type MergeConflict,
	mergeProjects,
} from "../../../shared/project-merge.ts";

/**
 * The last revision of each open project as the sidecar saved it: the common
 * ancestor of the editor's unsaved edits and a revision saved elsewhere.
 * Recorded when the editor loads, saves or adopts a revision, so a
 * three-way merge always has the matching base.
 */
const savedBases = new Map<string, Project>();

/** Remember `project` as the saved copy of its revision. */
export function recordSavedBase(project: Project): void {
	const known = savedBases.get(project.id);
	if (known && known.revision > project.revision) {
		return;
	}
	savedBases.set(project.id, project);
}

/** The saved copy of `revision` of project `id`, when it is the one recorded. */
export function savedBaseFor(id: string, revision: number): Project | null {
	const base = savedBases.get(id);
	return base?.revision === revision ? base : null;
}

/** Forget every recorded base (tests). */
export function clearSavedBases(): void {
	savedBases.clear();
}

export type RemoteMerge =
	| { project: Project; status: "clean" }
	| { conflicts: MergeConflict[]; status: "conflict" }
	/** No saved copy of the editor's revision is known: nothing to merge from. */
	| { status: "no-base" };

/**
 * Merge a newer `remote` revision under the editor's unsaved `local` edits.
 * A clean merge is the project to show (at the remote revision, still
 * unsaved); a conflict lists what both sides changed.
 */
export function mergeRemoteRevision(
	local: Project,
	remote: Project
): RemoteMerge {
	const base = savedBaseFor(local.id, local.revision);
	if (!base) {
		return { status: "no-base" };
	}
	const result = mergeProjects(base, local, remote);
	return result.status === "clean"
		? { project: result.project, status: "clean" }
		: { conflicts: result.conflicts, status: "conflict" };
}
