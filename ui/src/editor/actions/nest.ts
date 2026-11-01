import { type Project, projectSchema } from "../../../../shared/project.ts";
import { openProject } from "../project-actions.ts";
import type { EditorRuntime } from "../runtime.ts";
import type { ActionHandler, ActionHandlers } from "./types.ts";

const clipCount = (count: number) => `${count} clip${count === 1 ? "" : "s"}`;

/** Selected timeline clip ids, primary first, ignoring overlay selections. */
export function selectedClipIds(
	runtime: Pick<EditorRuntime, "project" | "selectedId" | "selectedIds">
): string[] {
	const { project } = runtime;
	if (!project) {
		return [];
	}
	const ids = runtime.selectedIds.length
		? runtime.selectedIds
		: [runtime.selectedId].filter((id): id is string => Boolean(id));
	const clips = new Set(project.segments.map((segment) => segment.id));
	return [...new Set(ids)].filter((id) => clips.has(id));
}

/** The primary selected clip when it plays a nested sequence asset. */
export function selectedSequenceClipId(
	runtime: Pick<
		EditorRuntime,
		"assets" | "project" | "selectedId" | "selectedIds"
	>
): string | undefined {
	const [clipId] = selectedClipIds(runtime);
	const clip = runtime.project?.segments.find(
		(segment) => segment.id === clipId
	);
	const sequence = runtime.assets.find((asset) => asset.id === clip?.assetId);
	return clip && sequence?.sequenceProjectId ? clip.id : undefined;
}

/**
 * The nested project behind the primary selected clip, or `undefined` when
 * that clip is not a sequence clip (or its source project was deleted).
 */
export function nestedProjectOf(
	runtime: Pick<
		EditorRuntime,
		"assets" | "project" | "projects" | "selectedId" | "selectedIds"
	>
): Project | undefined {
	const [clipId] = selectedClipIds(runtime);
	const clip = runtime.project?.segments.find(
		(segment) => segment.id === clipId
	);
	const sequenceProjectId = runtime.assets.find(
		(asset) => asset.id === clip?.assetId
	)?.sequenceProjectId;
	return sequenceProjectId
		? runtime.projects.find((item) => item.id === sequenceProjectId)
		: undefined;
}

/**
 * Nest the selected clips into a new nested project (sidecar render), then
 * select the sequence clip that replaced them and list the new project.
 */
export async function nestClips(
	runtime: EditorRuntime,
	clipIds: string[],
	title?: string
) {
	const outcome = await runtime.routeEdit(
		"nest",
		title ? { clipIds, title } : { clipIds },
		(extras) => {
			const child = projectSchema.safeParse(extras.sequenceProject);
			return child.success
				? `Nested ${clipCount(clipIds.length)} into "${child.data.title}".`
				: `Nested ${clipCount(clipIds.length)}.`;
		},
		{ refreshAssets: true }
	);
	if (outcome.status !== "ok") {
		return outcome;
	}
	const child = projectSchema.safeParse(outcome.extras.sequenceProject);
	if (child.success) {
		runtime.setProjects((current) => [
			child.data,
			...current.filter((item) => item.id !== child.data.id),
		]);
	}
	if (typeof outcome.extras.clipId === "string") {
		runtime.setSelected(outcome.extras.clipId);
	}
	return outcome;
}

/** Expand a sequence clip back into its nested clips (sidecar edit). */
export async function decomposeClip(runtime: EditorRuntime, clipId: string) {
	const outcome = await runtime.routeEdit("decompose", { clipId }, (extras) => {
		const count = Array.isArray(extras.clipIds) ? extras.clipIds.length : 0;
		return `Decomposed the sequence into ${clipCount(count)}.`;
	});
	if (
		outcome.status === "ok" &&
		Array.isArray(outcome.extras.clipIds) &&
		typeof outcome.extras.clipIds[0] === "string"
	) {
		runtime.setSelected(outcome.extras.clipIds[0]);
	}
	return outcome;
}

/** Open the primary selected sequence clip's nested project in a tab. */
export function openNested(runtime: EditorRuntime): boolean {
	const nested = nestedProjectOf(runtime);
	if (!nested) {
		return false;
	}
	void openProject(runtime, nested.id);
	return true;
}

/** Cmd+Alt+G: nest the selection; declines with nothing selected. */
export const nestSelection: ActionHandler = (runtime) => {
	const clipIds = selectedClipIds(runtime);
	if (!(runtime.project && clipIds.length)) {
		return false;
	}
	if (runtime.busy) {
		return;
	}
	void nestClips(runtime, clipIds);
};

/** Cmd+Alt+Shift+G: decompose the selected sequence clip. */
export const decomposeSelection: ActionHandler = (runtime) => {
	const clipId = selectedSequenceClipId(runtime);
	if (!clipId) {
		return false;
	}
	if (runtime.busy) {
		return;
	}
	void decomposeClip(runtime, clipId);
};

/** Nest and decompose handlers (W4-N1). */
export const nestActions: ActionHandlers = {
	"nest.decompose": decomposeSelection,
	"nest.nest": nestSelection,
};
