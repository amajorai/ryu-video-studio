import { activeLocale, numberFormatter, translate as tl } from "@ryu/i18n/core";
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

/** A signed offset in seconds, "+1.25s", in the language the Companion shows. */
const seconds = (value: number) =>
	numberFormatter(activeLocale(), {
		maximumFractionDigits: 2,
		minimumFractionDigits: 2,
		signDisplay: "always",
		style: "unit",
		unit: "second",
		unitDisplay: "narrow",
	}).format(value);

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
			label: tl("Duplicate clips"),
			project: result.project,
			selection: result.newIds,
			status: tl(
				"Duplicated {count, plural, one {# clip} other {# clips}} · {offset}.",
				{
					count: result.newIds.length,
					offset: seconds(plan.delta),
				}
			),
		};
	}
	const count = plan.ids.length;
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
					label: count === 1 ? tl("Trim clip") : tl("Trim clips"),
					project: trimmed.project,
					selection: [...directIds],
					status: plan.linked
						? tl(
								"Trimmed the {edge, select, start {start} end {end} other {{edge}}} of {count, plural, one {# clip} other {# clips}} {offset}.",
								{
									count,
									edge: plan.edge,
									offset: seconds(trimmed.applied),
								}
							)
						: tl(
								"Trimmed the {edge, select, start {start} end {end} other {{edge}}} of {count, plural, one {# clip} other {# clips}} {offset} (unlinked).",
								{
									count,
									edge: plan.edge,
									offset: seconds(trimmed.applied),
								}
							),
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
	const values = {
		count,
		offset: seconds(moved.applied),
		tracks: numberFormatter(activeLocale(), { signDisplay: "always" }).format(
			moved.trackApplied
		),
		trackCount: Math.abs(moved.trackApplied),
	};
	return {
		label: count === 1 ? tl("Move clip") : tl("Move clips"),
		project: moved.project,
		selection: [...directIds],
		status: moved.trackApplied
			? tl(
					"Moved {count, plural, one {# clip} other {# clips}} {offset} · {trackCount, plural, one {{tracks} track} other {{tracks} tracks}}.",
					values
				)
			: tl(
					"Moved {count, plural, one {# clip} other {# clips}} {offset}.",
					values
				),
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
					label: count === 1 ? tl("Ripple trim clip") : tl("Ripple trim clips"),
					project: next,
					selection: [...directIds],
					status: tl(
						"Ripple-trimmed the {edge, select, start {start} end {end} other {{edge}}} of {count, plural, one {# clip} other {# clips}} {offset}; later clips moved with it.",
						{ count, edge: plan.edge, offset: seconds(applied) }
					),
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
		label: count === 1 ? tl("Ripple move clip") : tl("Ripple move clips"),
		project: moved.project,
		selection: [...directIds],
		status: tl(
			"Ripple-moved {count, plural, one {# clip} other {# clips}} to {time}; the gap it left closed.",
			{
				count,
				time: numberFormatter(activeLocale(), {
					maximumFractionDigits: 2,
					minimumFractionDigits: 2,
					style: "unit",
					unit: "second",
					unitDisplay: "narrow",
				}).format(moved.at),
			}
		),
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
