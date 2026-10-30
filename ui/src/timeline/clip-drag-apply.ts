import {
	type GroupEditResult,
	groupDuplicate,
	groupMove,
	groupTrim,
} from "../../../shared/group-edits.ts";
import type { Asset, Project } from "../../../shared/project.ts";
import { rippleMoveClips } from "../../../shared/ripple-edits.ts";
import { trimEdit } from "../../../shared/trim-modes.ts";
import { selectClips } from "../editor/actions/select.ts";
import { message } from "../editor/format.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import type { GroupDragPlan } from "./clip-drag-group.ts";

export interface AppliedGroupDrag {
	label: string;
	project: Project;
	/** Clips to select after the edit. */
	selection: string[];
	status: string;
}

const seconds = (value: number) =>
	`${value >= 0 ? "+" : ""}${value.toFixed(2)}s`;

/**
 * Apply a resolved plan through the shared group edits. Returns null when
 * the plan changes nothing (a click, or a drag clamped to zero).
 */
export function applyGroupDragPlan(
	project: Project,
	assets: readonly Asset[],
	plan: GroupDragPlan,
	directIds: readonly string[],
	options: { ripple?: boolean } = {}
): AppliedGroupDrag | null {
	if (plan.kind === "none") {
		return null;
	}
	if (options.ripple && (plan.kind === "trim" || plan.kind === "move")) {
		return applyRippleDragPlan(project, assets, plan, directIds);
	}
	if (plan.kind === "duplicate") {
		if (plan.delta === 0 && plan.trackDelta === 0) {
			// Dropped back where it started: nothing to copy to.
			return null;
		}
		const result = groupDuplicate(project, assets, {
			clipIds: [...directIds],
			delta: plan.delta,
			revision: project.revision,
			trackDelta: plan.trackDelta,
		});
		return {
			label: "Duplicate clips",
			project: result.project,
			selection: result.newIds,
			status: `Duplicated ${result.newIds.length} clip${result.newIds.length === 1 ? "" : "s"} · ${seconds(plan.delta)}.`,
		};
	}
	const count = plan.ids.length;
	const noun = `${count} clip${count === 1 ? "" : "s"}`;
	if (plan.kind === "trim") {
		const trimmed = groupTrim(project, assets, {
			clipIds: [...directIds],
			delta: plan.delta,
			edge: plan.edge,
			exact: plan.exact,
			linked: plan.linked,
			revision: project.revision,
		});
		return trimmed.project === project
			? null
			: {
					label: count === 1 ? "Trim clip" : "Trim clips",
					project: trimmed.project,
					selection: [...directIds],
					status: `Trimmed the ${plan.edge} of ${noun} ${seconds(trimmed.applied)}${plan.linked ? "" : " (unlinked)"}.`,
				};
	}
	const moved: GroupEditResult = groupMove(project, assets, {
		clipIds: [...directIds],
		delta: plan.delta,
		exact: plan.exact,
		revision: project.revision,
		trackDelta: plan.trackDelta,
	});
	if (moved.project === project) {
		return null;
	}
	const tracks = moved.trackApplied
		? ` · ${moved.trackApplied > 0 ? "+" : ""}${moved.trackApplied} track${Math.abs(moved.trackApplied) === 1 ? "" : "s"}`
		: "";
	return {
		label: count === 1 ? "Move clip" : "Move clips",
		project: moved.project,
		selection: [...directIds],
		status: `Moved ${noun} ${seconds(moved.applied)}${tracks}.`,
	};
}

/**
 * A pointer trim or move in ripple mode, as one edit. A trim goes through
 * the Ripple tool's trim (later clips on the track, linked partners and
 * sync-locked tracks shift by the change); a move extracts the clips,
 * closing the gap they leave, and inserts them at the nearest edit point.
 */
function applyRippleDragPlan(
	project: Project,
	assets: readonly Asset[],
	plan: Exclude<GroupDragPlan, { kind: "none" }>,
	directIds: readonly string[]
): AppliedGroupDrag | null {
	const count = directIds.length;
	const noun = `${count} clip${count === 1 ? "" : "s"}`;
	if (plan.kind === "trim") {
		if (Math.abs(plan.delta) < 1e-9) {
			return null;
		}
		let next = project;
		let applied = 0;
		for (const clipId of directIds) {
			const result = trimEdit(next, assets, {
				clipId,
				delta: plan.delta,
				edge: plan.edge,
				mode: "ripple",
				revision: next.revision,
			});
			next = result.project;
			applied = result.applied;
		}
		return next === project
			? null
			: {
					label: count === 1 ? "Ripple trim clip" : "Ripple trim clips",
					project: next,
					selection: [...directIds],
					status: `Ripple-trimmed the ${plan.edge} of ${noun} ${seconds(applied)}; later clips moved with it.`,
				};
	}
	if (
		plan.kind !== "move" ||
		(Math.abs(plan.delta) < 1e-9 && plan.trackDelta === 0)
	) {
		return null;
	}
	const moved = rippleMoveClips(project, assets, {
		clipIds: directIds,
		delta: plan.delta,
		trackDelta: plan.trackDelta,
	});
	return {
		label: count === 1 ? "Ripple move clip" : "Ripple move clips",
		project: moved.project,
		selection: [...directIds],
		status: `Ripple-moved ${noun} to ${moved.at.toFixed(2)}s; the gap it left closed.`,
	};
}

/** Apply a finished plan as one undoable edit and select the result. */
export function commitGroupDrag(
	runtime: EditorRuntime,
	plan: GroupDragPlan,
	directIds: readonly string[]
): boolean {
	const { project } = runtime;
	if (!project || plan.kind === "none") {
		return false;
	}
	try {
		const applied = applyGroupDragPlan(
			project,
			runtime.assets,
			plan,
			directIds,
			{ ripple: runtime.store.getState().rippleMode }
		);
		if (!applied) {
			return false;
		}
		runtime.edit(applied.project, applied.label);
		selectClips(runtime, applied.selection);
		runtime.setStatus(applied.status);
		return true;
	} catch (error) {
		runtime.setStatus(message(error));
		return false;
	}
}
