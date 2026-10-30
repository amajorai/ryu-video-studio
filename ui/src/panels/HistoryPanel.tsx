import {
	RyuAppActions,
	RyuAppEmpty,
	RyuAppList,
	RyuAppListItem,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useState } from "react";
import {
	jumpToHistory,
	loadSavedHistory,
	restoreSavedRevision,
	type SavedHistory,
} from "../editor/actions/history.ts";
import { useEditor } from "../editor/context.tsx";
import { clock, message } from "../editor/format.ts";
import { type HistoryStep, historySteps } from "../editor/history.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { useEditorStore } from "../editor/store.ts";
import type { PanelTab } from "./types.ts";

/** The History panel has its own library tab. */
export const historyPanelTab: PanelTab | null = {
	label: "History",
	value: "history",
};

const TIME_FORMAT: Intl.DateTimeFormatOptions = {
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
};
const DATE_FORMAT: Intl.DateTimeFormatOptions = {
	day: "numeric",
	month: "short",
	year: "numeric",
};

function sameLocalDay(left: Date, right: Date): boolean {
	return (
		left.getFullYear() === right.getFullYear() &&
		left.getMonth() === right.getMonth() &&
		left.getDate() === right.getDate()
	);
}

/**
 * Wall-clock time of an edit or save, in the viewer's locale. A time from
 * another day than `now` (a save from an earlier session) also shows its
 * date, so restore points from different days are told apart.
 */
export function historyTime(
	at: number | string | null,
	now: Date = new Date()
): string {
	if (at === null) {
		return "Start of this session";
	}
	const date = new Date(at);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	return sameLocalDay(date, now)
		? date.toLocaleTimeString(undefined, TIME_FORMAT)
		: date.toLocaleString(undefined, { ...DATE_FORMAT, ...TIME_FORMAT });
}

const STEP_STATE_TEXT: Record<HistoryStep["state"], string> = {
	applied: "",
	current: "Current",
	undone: "Undone · redo available",
};

function stepSubtitle(step: HistoryStep): string {
	return [historyTime(step.at), STEP_STATE_TEXT[step.state]]
		.filter(Boolean)
		.join(" · ");
}

/** Undo steps recorded in this session; any step can be jumped to. */
function SessionHistory({ runtime }: { runtime: EditorRuntime }) {
	const tl = useLiteralMessages();
	const history = useEditorStore(runtime.store, (state) => state.history);
	const steps = historySteps(history);
	const canUndo = history.past.length > 0;
	const canRedo = history.future.length > 0;
	return (
		<RyuAppSection title="Edits this session">
			<RyuAppActions>
				<Button
					disabled={!canUndo || runtime.busy}
					onClick={() => runtime.undo()}
					variant="outline"
				>
					Undo
				</Button>
				<Button
					disabled={!canRedo || runtime.busy}
					onClick={() => runtime.redo()}
					variant="outline"
				>
					Redo
				</Button>
			</RyuAppActions>
			{steps.length > 1 ? (
				<RyuAppList aria-label="Edit history">
					{steps.toReversed().map((step) => (
						<RyuAppListItem
							aria-current={step.state === "current" ? "step" : undefined}
							className={step.state === "undone" ? "opacity-60" : undefined}
							data-history-index={step.index}
							disabled={runtime.busy}
							key={step.index}
							onClick={() => {
								if (jumpToHistory(runtime, step.index)) {
									runtime.setStatus(
										tl("Jumped to “{label}”.", { label: step.label })
									);
								}
							}}
							selected={step.state === "current"}
							subtitle={stepSubtitle(step)}
							title={step.label}
						/>
					))}
				</RyuAppList>
			) : (
				<p className="text-muted-foreground text-sm">
					Edits you make appear here. Select one to return to it; later edits
					stay available to redo until you make a new edit.
				</p>
			)}
		</RyuAppSection>
	);
}

type SavedState =
	| { status: "loading" }
	| { error: string; status: "error" }
	| { history: SavedHistory; status: "ready" };

/** Revisions saved on this node, including earlier sessions. */
function SavedRevisions({ runtime }: { runtime: EditorRuntime }) {
	const tl = useLiteralMessages();
	const projectId = runtime.project?.id;
	const revision = runtime.project?.revision;
	const [saved, setSaved] = useState<SavedState>({ status: "loading" });
	useEffect(() => {
		if (!projectId || revision === undefined) {
			return;
		}
		let active = true;
		setSaved({ status: "loading" });
		loadSavedHistory(projectId)
			.then((history) => {
				if (active) {
					setSaved({ history, status: "ready" });
				}
			})
			.catch((error: unknown) => {
				if (active) {
					setSaved({ error: message(error), status: "error" });
				}
			});
		return () => {
			active = false;
		};
	}, [projectId, revision]);
	return (
		<RyuAppSection title="Saved revisions">
			{saved.status === "loading" && (
				<p className="text-muted-foreground text-sm">Loading revisions…</p>
			)}
			{saved.status === "error" && (
				<p className="text-destructive text-sm">{saved.error}</p>
			)}
			{saved.status === "ready" &&
				(saved.history.revisions.length ? (
					<ul aria-label="Saved revisions" className="flex flex-col">
						{saved.history.revisions.map((item) => (
							<li
								className="flex items-center gap-2 border-border border-b py-2 last:border-b-0"
								data-revision={item.revision}
								key={item.revision}
							>
								<div className="flex min-w-0 flex-1 flex-col">
									<span className="truncate text-sm">
										{tl("Revision {revision} · {title}", {
											revision: String(item.revision),
											title: item.title,
										})}
									</span>
									<span className="text-muted-foreground text-xs">
										{tl(
											"{time} · {segmentCount, plural, one {{segmentLabel} clip} other {{segmentLabel} clips}} · {duration}",
											{
												duration: clock(item.duration),
												segmentCount: item.segmentCount,
												segmentLabel: String(item.segmentCount),
												time: historyTime(item.updatedAt),
											}
										)}
									</span>
								</div>
								<Button
									aria-label={tl("Restore revision {revision}", {
										revision: String(item.revision),
									})}
									disabled={runtime.busy}
									onClick={() =>
										void restoreSavedRevision(runtime, item.revision)
									}
									size="sm"
									variant="outline"
								>
									Restore
								</Button>
							</li>
						))}
					</ul>
				) : (
					<p className="text-muted-foreground text-sm">
						Earlier saves of this project appear here.
					</p>
				))}
		</RyuAppSection>
	);
}

/**
 * Labelled edit history with jump-to-step, plus saved revisions that can be
 * restored across sessions. Restoring saves a new revision, so it is undoable.
 */
export function HistoryPanel() {
	const runtime = useEditor();
	if (!runtime.project) {
		return (
			<RyuAppEmpty
				description="Open a project to see its edit history."
				title="No project open"
			/>
		);
	}
	return (
		<div className="flex flex-col gap-4">
			<SessionHistory runtime={runtime} />
			<SavedRevisions runtime={runtime} />
		</div>
	);
}
