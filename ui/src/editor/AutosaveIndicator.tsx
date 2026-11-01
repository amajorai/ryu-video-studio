import { Badge, Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { createContext, type ReactNode, useContext } from "react";
import {
	MERGE_COLLECTION_LABELS,
	type MergeConflict,
} from "../../../shared/project-merge.ts";
import { studioFormat, studioText, useStudioLocale } from "../i18n/format.ts";
import {
	AUTOSAVE_STATUS_LABELS,
	type AutosaveHandle,
	type AutosaveOptions,
	type AutosaveStatus,
	useAutosave,
} from "./autosave.ts";
import { useEditor } from "./context.tsx";
import { useEditorStore } from "./store.ts";

const BADGE_VARIANT: Record<
	AutosaveStatus,
	"destructive" | "outline" | "secondary"
> = {
	conflict: "destructive",
	error: "destructive",
	saved: "outline",
	saving: "secondary",
	unsaved: "secondary",
};

const AutosaveContext = createContext<AutosaveHandle | null>(null);

/**
 * Runs autosave for the open project and shares its state with the toolbar
 * chip (`AutosaveIndicator`), the reload banner (`AutosaveConflictBanner`)
 * and the Save button. Mount once, inside the editor provider.
 */
export function AutosaveProvider({
	children,
	timing,
}: {
	children: ReactNode;
	/** Test hook: quiet time and timers; production uses the defaults. */
	timing?: Pick<AutosaveOptions, "delayMs" | "scheduler">;
}) {
	const handle = useAutosave(useEditor(), timing);
	return (
		<AutosaveContext.Provider value={handle}>
			{children}
		</AutosaveContext.Provider>
	);
}

/** The autosave state from the nearest `AutosaveProvider`, if any. */
export function useAutosaveState(): AutosaveHandle | null {
	return useContext(AutosaveContext);
}

/**
 * The Saved, Saving, Unsaved, Changed elsewhere or Save failed chip. Small
 * enough for the toolbar actions row; the conflict notice is a separate
 * full-width banner (`AutosaveConflictBanner`).
 */
export function AutosaveIndicator() {
	const runtime = useEditor();
	const autosave = useAutosaveState();
	const tl = useLiteralMessages();
	if (!(runtime.project && autosave)) {
		return null;
	}
	const { status } = autosave;
	return (
		<Badge
			aria-label={tl("Autosave: {status}", {
				status: AUTOSAVE_STATUS_LABELS[status],
			})}
			className="shrink-0"
			data-autosave-status={status}
			variant={BADGE_VARIANT[status]}
		>
			{AUTOSAVE_STATUS_LABELS[status]}
		</Badge>
	);
}

/** Most conflicted items the banner lists by name. */
const LISTED_CONFLICTS = 6;

/** One line of the banner's conflict list, in the host language. */
export function describeMergeConflict(conflict: MergeConflict): string {
	const entity = studioText(MERGE_COLLECTION_LABELS[conflict.collection]);
	const name = conflict.name ?? conflict.id?.slice(0, 8) ?? "";
	switch (conflict.kind) {
		case "both-changed":
			return conflict.collection === "project" || !name
				? studioFormat("{entity}: {field} changed here and elsewhere", {
						entity,
						field: conflict.field ?? "",
					})
				: studioFormat(
						"{entity} “{name}”: {field} changed here and elsewhere",
						{
							entity,
							field: conflict.field ?? "",
							name,
						}
					);
		case "deleted-remotely":
			return studioFormat("{entity} “{name}”: edited here, deleted elsewhere", {
				entity,
				name,
			});
		case "deleted-locally":
			return studioFormat("{entity} “{name}”: deleted here, edited elsewhere", {
				entity,
				name,
			});
		case "overlap":
			return studioFormat(
				"{entity} “{name}”: overlaps a clip from the other edit",
				{ entity, name }
			);
		case "tracks":
			return studioText(
				"Tracks were added, removed or reordered elsewhere while you edited clips or tracks here."
			);
		default:
			return studioText("The merged project would not be valid.");
	}
}

/**
 * Full-width reload notice shown when the project was saved from somewhere
 * else and autosave paused. Edits that do not overlap are merged without it
 * (three-way, by clip, track, title, caption and marker); the banner lists
 * what both sides changed. Mount it in the app's banner region, not inside a
 * toolbar row.
 */
export function AutosaveConflictBanner() {
	const runtime = useEditor();
	const autosave = useAutosaveState();
	useStudioLocale();
	const conflicts = useEditorStore(
		runtime.store,
		(state) => state.mergeConflicts
	);
	if (!(runtime.project && autosave?.status === "conflict")) {
		return null;
	}
	return (
		<div
			className="flex flex-wrap items-center gap-2 rounded-md border border-destructive px-3 py-2 text-sm"
			data-autosave-conflict=""
			role="alert"
		>
			<span className="min-w-0 flex-1 basis-64">
				This project was saved from somewhere else, so autosave paused. Reload
				to continue from the latest revision; unsaved edits here will be
				discarded.
			</span>
			{conflicts.length ? (
				<div className="basis-full text-xs" data-merge-conflicts="">
					<p>Changed both here and elsewhere:</p>
					<ul className="list-disc ps-5">
						{conflicts.slice(0, LISTED_CONFLICTS).map((conflict) => (
							<li
								key={`${conflict.collection}:${conflict.id ?? ""}:${conflict.field ?? ""}:${conflict.kind}`}
							>
								{describeMergeConflict(conflict)}
							</li>
						))}
					</ul>
					{conflicts.length > LISTED_CONFLICTS ? (
						<p>
							{studioFormat(
								"{count, plural, one {# more item} other {# more items}}",
								{ count: conflicts.length - LISTED_CONFLICTS }
							)}
						</p>
					) : null}
				</div>
			) : null}
			<Button
				disabled={runtime.busy}
				onClick={() => void autosave.reload()}
				size="sm"
				variant="outline"
			>
				Reload project
			</Button>
		</div>
	);
}
