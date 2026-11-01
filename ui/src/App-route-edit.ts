import type { Dispatch, SetStateAction } from "react";
import {
	type Asset,
	type Project,
	projectSchema,
} from "../../shared/project.ts";
import {
	isRevisionConflict,
	loadAssets,
	request,
	studioResponseSchema,
} from "./bridge.ts";
import { planIsCurrent, projectEditResponse } from "./editing-ui.ts";
import { emptyHistory } from "./editor/history.ts";
import type { RouteEditOptions } from "./editor/runtime.ts";
import type { useStatusLine } from "./editor/status-notice.ts";
import {
	type createEditorStore,
	withPrimarySelection,
} from "./editor/store.ts";
import type { RouteEditOutcome } from "./SplitEditPanel.tsx";

export interface StudioRouteEditDeps {
	act: (operation: () => Promise<void>) => Promise<void>;
	commitServerProject: (
		next: Project,
		previous?: Project,
		label?: string
	) => void;
	ensureSaved: () => Promise<Project | undefined>;
	latestProject: { current: Project | null };
	setAssets: Dispatch<SetStateAction<Asset[]>>;
	setStatus: ReturnType<typeof useStatusLine>["setStatus"];
	store: ReturnType<typeof createEditorStore>;
}

/** Run a revision-checked sidecar edit; a stale revision reloads the project. */
export function createStudioRouteEdit({
	act,
	commitServerProject,
	ensureSaved,
	latestProject,
	setAssets,
	setStatus,
	store,
}: StudioRouteEditDeps) {
	const routeEdit = async (
		action: string,
		body: Record<string, unknown>,
		describe: (extras: Record<string, unknown>) => string,
		options: RouteEditOptions = {}
	): Promise<RouteEditOutcome> => {
		let outcome: RouteEditOutcome = { status: "error" };
		await act(async () => {
			const previous = latestProject.current;
			if (
				options.planStamp !== undefined &&
				previous &&
				!planIsCurrent(options.planStamp, previous)
			) {
				setStatus(
					"The timeline changed since this plan was made. Run the plan again before applying it."
				);
				outcome = { status: "conflict" };
				return;
			}
			const saved = await ensureSaved();
			if (!(previous && saved)) {
				return;
			}
			try {
				const result = projectEditResponse(
					await request(
						studioResponseSchema,
						`/projects/${saved.id}/${action}`,
						"POST",
						{ ...body, revision: saved.revision }
					)
				);
				commitServerProject(result.project, previous);
				if (options.refreshAssets) {
					setAssets(await loadAssets());
				}
				store.setState((state) => {
					const current = state.selection.primaryId;
					return {
						selection: withPrimarySelection(
							state.selection,
							current &&
								result.project.segments.some(
									(segment) => segment.id === current
								)
								? current
								: null
						),
					};
				});
				setStatus(describe(result.extras));
				outcome = { extras: result.extras, status: "ok" };
			} catch (error) {
				if (!isRevisionConflict(error)) {
					throw error;
				}
				commitServerProject(
					projectSchema.parse(
						await request(studioResponseSchema, `/projects/${saved.id}`)
					)
				);
				store.setState({ history: emptyHistory() });
				setStatus(
					"The project changed elsewhere, so its latest revision was reloaded. Review it and try again."
				);
				outcome = { status: "conflict" };
			}
		});
		return outcome;
	};
	return routeEdit;
}
