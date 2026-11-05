import {
	isViewVisible,
	subscribeViewVisibility,
} from "@ryu/ui/lib/view-visibility.ts";
import { type RefObject, useEffect, useRef } from "react";
import { type Project, projectSchema } from "../../../shared/project.ts";
import type { MergeConflict } from "../../../shared/project-merge.ts";
import { request, studioResponseSchema } from "../bridge.ts";
import { mergeRemoteRevision, recordSavedBase } from "./saved-base.ts";

/** How often the open project is checked for edits saved elsewhere. */
export const REVISION_POLL_MS = 2000;

/** The project without the fields every save changes. */
const content = (project: Project) => {
	const { revision: _revision, updatedAt: _updatedAt, ...rest } = project;
	return JSON.stringify(rest);
};

/**
 * What to do with the saved project when the editor polls it: adopt a newer
 * revision saved by someone else (an agent, another window) only while the
 * editor has nothing unsaved and no edit in flight. A newer revision with the
 * same content is the editor's own save finishing, so it is ignored.
 */
export function externalRevision(
	local: Project,
	remote: Project,
	state: { busy: boolean; dirty: boolean }
): Project | null {
	if (
		state.busy ||
		state.dirty ||
		remote.id !== local.id ||
		remote.revision <= local.revision ||
		content(remote) === content(local)
	) {
		return null;
	}
	return remote;
}

export type RevisionAction =
	| { kind: "adopt"; project: Project }
	| { kind: "merge"; project: Project; remote: Project }
	| { conflicts: MergeConflict[]; kind: "conflict"; remote: Project }
	| { kind: "none" };

/**
 * What a polled revision means for the editor: adopt it when nothing is
 * unsaved (`externalRevision`); with unsaved edits, three-way merge it under
 * them (base = the last saved revision) so they stay unsaved on top of the
 * newer revision, or report the conflicting items.
 */
export function revisionAction(
	local: Project,
	remote: Project,
	state: { busy: boolean; dirty: boolean }
): RevisionAction {
	const adopted = externalRevision(local, remote, state);
	if (adopted) {
		return { kind: "adopt", project: adopted };
	}
	if (
		state.busy ||
		!state.dirty ||
		remote.id !== local.id ||
		remote.revision <= local.revision
	) {
		return { kind: "none" };
	}
	const merged = mergeRemoteRevision(local, remote);
	if (merged.status === "clean") {
		return { kind: "merge", project: merged.project, remote };
	}
	if (merged.status === "conflict") {
		return { conflicts: merged.conflicts, kind: "conflict", remote };
	}
	return { kind: "none" };
}

/**
 * Watch the open project for revisions saved outside this editor (agent
 * routes, another tab) and apply them live: `onExternal` records the current
 * project as an undo step named "Agent edit", so Cmd+Z reverts the agent's
 * change like any other. While local edits are unsaved, the newer revision
 * is merged under them (`onMerge`, edits stay unsaved); when both sides
 * changed the same thing, `onConflict` lists it and the autosave conflict
 * banner handles the overlap.
 */
export function useRevisionWatch(input: {
	busy: boolean;
	latestProject: RefObject<Project | null>;
	onConflict?: (conflicts: MergeConflict[]) => void;
	onExternal: (next: Project, previous: Project) => void;
	onMerge?: (merged: Project, previous: Project) => void;
	dirtyRef: RefObject<boolean>;
	/** Poll interval; tests shorten it. */
	intervalMs?: number;
	projectId: string | null;
}) {
	const latest = useRef(input);
	useEffect(() => {
		latest.current = input;
	});
	const { intervalMs = REVISION_POLL_MS, projectId } = input;
	useEffect(() => {
		if (!projectId) {
			return;
		}
		let mounted = true;
		let pending = false;
		const poll = () => {
			const current = latest.current;
			const local = current.latestProject.current;
			if (
				!mounted ||
				pending ||
				!isViewVisible() ||
				current.busy ||
				local?.id !== projectId
			) {
				return;
			}
			pending = true;
			void request(studioResponseSchema, `/projects/${projectId}`)
				.then((value) => {
					const parsed = projectSchema.safeParse(value);
					const now = latest.current;
					const before = now.latestProject.current;
					if (!(mounted && parsed.success && before)) {
						return;
					}
					const action = revisionAction(before, parsed.data, {
						busy: now.busy,
						dirty: Boolean(now.dirtyRef.current),
					});
					if (action.kind === "adopt") {
						recordSavedBase(action.project);
						now.onExternal(action.project, before);
					} else if (action.kind === "merge") {
						recordSavedBase(action.remote);
						now.onMerge?.(action.project, before);
					} else if (action.kind === "conflict") {
						now.onConflict?.(action.conflicts);
					}
				})
				.catch(() => {
					// A missed poll is retried on the next tick.
				})
				.finally(() => {
					pending = false;
				});
		};
		const unsubscribe = subscribeViewVisibility(poll);
		const timer = setInterval(poll, intervalMs);
		return () => {
			mounted = false;
			unsubscribe();
			clearInterval(timer);
		};
	}, [intervalMs, projectId]);
}
