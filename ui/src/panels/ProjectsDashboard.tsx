import {
	RyuAppActions,
	RyuAppEmpty,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Checkbox, Input } from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { type Project, projectSchema } from "../../../shared/project.ts";
import {
	filterProjectSummaries,
	type ProjectSummary,
	projectSortSchema,
	projectSummariesResponseSchema,
	sortProjectSummaries,
} from "../../../shared/project-summary.ts";
import {
	isRevisionConflict,
	request,
	studioResponseSchema,
} from "../bridge.ts";
import { useEditor } from "../editor/context.tsx";
import { message } from "../editor/format.ts";
import { openProject, resetHistory } from "../editor/project-actions.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import {
	type DashboardPreferences,
	deleteConfirmation,
	formatProjectDate,
	formatProjectDuration,
	projectSubtitle,
	readDashboardPreferences,
	SORT_LABELS,
	toggleSelected,
	visibleSelection,
	writeDashboardPreferences,
} from "../projects/dashboard-model.ts";
import {
	forgetProjectTabs,
	updateProjectTabs,
} from "../projects/project-tabs-model.ts";
import type { PanelTab } from "./types.ts";

/** The projects dashboard has its own library tab. */
export const projectsDashboardTab: PanelTab | null = {
	label: "Projects",
	value: "projects",
};

const posterSchema = z.object({ data: z.string().max(40_000_000) });
const deleteResponseSchema = z.object({
	deleted: z.object({ id: z.string() }).passthrough(),
});

/** Poster cache key: a new revision gets a new poster. */
const posterKey = (summary: ProjectSummary) =>
	`${summary.id}:${summary.revision}`;

/**
 * Load posters one at a time so a large library never queues more than one
 * timeline frame render on the sidecar. Missing posters resolve to `null`.
 */
function usePosters(summaries: readonly ProjectSummary[]) {
	const [posters, setPosters] = useState<Record<string, string | null>>({});
	const attempted = useRef(new Set<string>());
	const wanted = summaries.map(posterKey).join(",");
	useEffect(() => {
		let mounted = true;
		const queue = summaries.filter(
			(summary) => !attempted.current.has(posterKey(summary))
		);
		const next = async () => {
			const summary = queue.shift();
			if (!(summary && mounted)) {
				return;
			}
			const key = posterKey(summary);
			attempted.current.add(key);
			let poster: string | null = null;
			try {
				const result = posterSchema.safeParse(
					await request(studioResponseSchema, summary.posterUrl)
				);
				poster = result.success
					? `data:image/png;base64,${result.data.data}`
					: null;
			} catch {
				// No visual content yet, or media is busy: show the placeholder.
				poster = null;
			}
			if (mounted) {
				setPosters((current) => ({ ...current, [key]: poster }));
				await next();
			} else {
				attempted.current.delete(key);
			}
		};
		void next();
		return () => {
			mounted = false;
		};
		// `wanted` captures the identity of every summary in the list.
	}, [wanted]);
	return posters;
}

/**
 * Show `next` (or nothing) after the open project was deleted, with no
 * selection, history, or marked range carried over from the deleted one.
 */
function replaceOpenProject(runtime: EditorRuntime, next: Project | null) {
	runtime.setDirty(false);
	runtime.setSelected(null);
	resetHistory(runtime);
	runtime.setTime(0);
	runtime.setPlaying(false);
	runtime.setRangeStart(0);
	runtime.setRangeEnd(1);
	runtime.setRangeMarked(false);
	runtime.setProject(next);
}

interface RenameState {
	id: string;
	title: string;
}

/** Projects dashboard with search, sort, rename, info, and multi-delete. */
export function ProjectsDashboard() {
	const runtime = useEditor();
	const { busy, project, projects } = runtime;
	const [summaries, setSummaries] = useState<ProjectSummary[] | null>(null);
	const [error, setError] = useState("");
	const [query, setQuery] = useState("");
	const [preferences, setPreferences] = useState<DashboardPreferences>(() =>
		readDashboardPreferences()
	);
	const [selected, setSelected] = useState<string[]>([]);
	const [confirming, setConfirming] = useState(false);
	const [working, setWorking] = useState(false);
	const [renaming, setRenaming] = useState<RenameState | null>(null);
	const [infoId, setInfoId] = useState<string | null>(null);
	const libraryStamp = projects
		.map((item) => `${item.id}:${item.revision}:${item.title}`)
		.join(",");

	useEffect(() => {
		let mounted = true;
		request(projectSummariesResponseSchema, "/project-summaries")
			.then((result) => {
				if (mounted) {
					setSummaries(result.projects);
					setError("");
				}
			})
			.catch((reason: unknown) => {
				if (mounted) {
					setError(message(reason));
				}
			});
		return () => {
			mounted = false;
		};
		// Reload whenever the editor's project list changes.
	}, [libraryStamp]);

	const listed = sortProjectSummaries(
		filterProjectSummaries(summaries ?? [], query),
		preferences.sort
	);
	const posters = usePosters(listed);
	const chosen = visibleSelection(selected, listed);
	const disabled = busy || working;

	const updatePreferences = (patch: Partial<DashboardPreferences>) => {
		const next = { ...preferences, ...patch };
		setPreferences(next);
		writeDashboardPreferences(next);
	};

	const deleteChosen = async () => {
		const targets = listed.filter((item) => chosen.includes(item.id));
		setWorking(true);
		const removed: string[] = [];
		const failures: string[] = [];
		for (const target of targets) {
			try {
				deleteResponseSchema.parse(
					await request(
						studioResponseSchema,
						`/projects/${target.id}/delete?revision=${target.revision}`,
						"DELETE"
					)
				);
				removed.push(target.id);
			} catch (reason) {
				failures.push(
					isRevisionConflict(reason)
						? `"${target.title}" changed in another editor. Reload before deleting it.`
						: `"${target.title}": ${message(reason)}`
				);
			}
		}
		const gone = new Set(removed);
		const remaining = projects.filter((item) => !gone.has(item.id));
		setSummaries((current) =>
			(current ?? []).filter((item) => !gone.has(item.id))
		);
		setSelected((current) => current.filter((id) => !gone.has(id)));
		updateProjectTabs((current) => forgetProjectTabs(current, gone));
		runtime.setProjects(remaining);
		if (project && gone.has(project.id)) {
			const fallback = remaining[0];
			try {
				replaceOpenProject(
					runtime,
					fallback
						? projectSchema.parse(
								await request(studioResponseSchema, `/projects/${fallback.id}`)
							)
						: null
				);
			} catch (reason) {
				replaceOpenProject(runtime, null);
				failures.push(message(reason));
			}
		}
		setConfirming(false);
		setWorking(false);
		const summary =
			removed.length === 1
				? "Deleted 1 project."
				: `Deleted ${removed.length} projects.`;
		runtime.setStatus(
			failures.length ? `${summary} ${failures.join(" ")}` : summary
		);
	};

	const rename = async (event: FormEvent) => {
		event.preventDefault();
		if (!renaming) {
			return;
		}
		const title = renaming.title.trim();
		if (!title || title.length > 200) {
			runtime.setStatus("Project titles need 1 to 200 characters.");
			return;
		}
		if (project && renaming.id === project.id) {
			runtime.edit((current) => ({ ...current, title }), "Rename project");
			setRenaming(null);
			return;
		}
		const expected = summaries?.find((item) => item.id === renaming.id);
		setWorking(true);
		try {
			const current = projectSchema.parse(
				await request(studioResponseSchema, `/projects/${renaming.id}`)
			);
			if (expected && current.revision !== expected.revision) {
				throw new Error(
					"This project changed in another editor. Reload before renaming it."
				);
			}
			const saved = projectSchema.parse(
				await request(studioResponseSchema, `/projects/${current.id}`, "PUT", {
					...current,
					title,
				})
			);
			runtime.setProjects((list) =>
				list.map((item) => (item.id === saved.id ? saved : item))
			);
			setRenaming(null);
			runtime.setStatus(`Renamed to "${saved.title}".`);
		} catch (reason) {
			runtime.setStatus(message(reason));
		} finally {
			setWorking(false);
		}
	};

	const info = listed.find((item) => item.id === infoId);

	return (
		<RyuAppSection title="Projects">
			<div className="flex flex-wrap items-center gap-2">
				<Input
					aria-label="Search projects"
					className="min-w-0 flex-1 basis-40"
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Search by title"
					type="search"
					value={query}
				/>
				<NativeSelect
					aria-label="Sort projects"
					onChange={(event) =>
						updatePreferences({
							sort: projectSortSchema.parse(event.target.value),
						})
					}
					value={preferences.sort}
				>
					{projectSortSchema.options.map((sort) => (
						<NativeSelectOption key={sort} value={sort}>
							{SORT_LABELS[sort]}
						</NativeSelectOption>
					))}
				</NativeSelect>
				<Button
					aria-pressed={preferences.view === "grid"}
					onClick={() => updatePreferences({ view: "grid" })}
					size="sm"
					variant={preferences.view === "grid" ? "secondary" : "ghost"}
				>
					Grid
				</Button>
				<Button
					aria-pressed={preferences.view === "list"}
					onClick={() => updatePreferences({ view: "list" })}
					size="sm"
					variant={preferences.view === "list" ? "secondary" : "ghost"}
				>
					List
				</Button>
			</div>
			{chosen.length > 0 && !confirming && (
				<RyuAppActions>
					<span className="text-muted-foreground text-sm">
						{chosen.length} selected
					</span>
					<Button
						disabled={disabled}
						onClick={() => setConfirming(true)}
						variant="destructive"
					>
						Delete selected
					</Button>
					<Button onClick={() => setSelected([])} variant="ghost">
						Clear selection
					</Button>
				</RyuAppActions>
			)}
			{confirming && chosen.length > 0 && (
				<div
					className="flex flex-col gap-2 rounded-md border border-destructive px-3 py-2"
					role="alert"
				>
					<p>
						{deleteConfirmation(
							listed
								.filter((item) => chosen.includes(item.id))
								.map((item) => item.title)
						)}
					</p>
					<RyuAppActions>
						<Button
							disabled={disabled}
							onClick={() => void deleteChosen()}
							variant="destructive"
						>
							Delete permanently
						</Button>
						<Button
							disabled={working}
							onClick={() => setConfirming(false)}
							variant="ghost"
						>
							Cancel
						</Button>
					</RyuAppActions>
				</div>
			)}
			{error && (
				<p className="text-destructive text-sm" role="status">
					{error}
				</p>
			)}
			{summaries === null && !error && (
				<p className="text-muted-foreground text-sm">Loading projects…</p>
			)}
			{summaries !== null && listed.length === 0 && (
				<RyuAppEmpty
					description={
						query.trim()
							? "No project title matches this search."
							: "Create a project to start editing."
					}
					title={query.trim() ? "No matches" : "No projects yet"}
				/>
			)}
			{listed.length > 0 && (
				<ul
					aria-label="Projects"
					className={
						preferences.view === "grid"
							? "grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3"
							: "flex flex-col gap-2"
					}
					data-view={preferences.view}
				>
					{listed.map((summary) => {
						const poster = posters[posterKey(summary)];
						const isOpen = summary.id === project?.id;
						const isChosen = chosen.includes(summary.id);
						return (
							<li
								className={
									preferences.view === "grid"
										? "flex min-w-0 flex-col gap-1 rounded-md border p-2"
										: "flex min-w-0 items-center gap-3 rounded-md border p-2"
								}
								data-project-id={summary.id}
								key={summary.id}
							>
								<div
									className={
										preferences.view === "grid"
											? "aspect-video w-full overflow-hidden rounded bg-muted"
											: "aspect-video w-24 shrink-0 overflow-hidden rounded bg-muted"
									}
								>
									{poster ? (
										<img
											alt=""
											className="h-full w-full object-cover"
											height={summary.height || undefined}
											src={poster}
											width={summary.width || undefined}
										/>
									) : null}
								</div>
								<div className="flex min-w-0 flex-1 flex-col gap-1">
									<div className="flex min-w-0 items-center gap-2">
										<Checkbox
											aria-label={`Select ${summary.title}`}
											checked={isChosen}
											disabled={disabled}
											onCheckedChange={() =>
												setSelected((current) =>
													toggleSelected(current, summary.id)
												)
											}
										/>
										<span className="truncate font-medium" data-project-title>
											{summary.title}
										</span>
										{isOpen && (
											<span className="text-muted-foreground text-xs">
												Open
											</span>
										)}
									</div>
									<span className="text-muted-foreground text-xs">
										{projectSubtitle(summary)}
									</span>
									{renaming?.id === summary.id ? (
										<form
											className="flex min-w-0 gap-1"
											onSubmit={(event) => void rename(event)}
										>
											<Input
												aria-label={`New title for ${summary.title}`}
												autoFocus
												className="min-w-0 flex-1"
												maxLength={200}
												onChange={(event) =>
													setRenaming({
														id: summary.id,
														title: event.target.value,
													})
												}
												onKeyDown={(event) => {
													if (event.key === "Escape") {
														setRenaming(null);
													}
												}}
												value={renaming.title}
											/>
											<Button disabled={disabled} size="sm" type="submit">
												Save
											</Button>
										</form>
									) : (
										<RyuAppActions>
											<Button
												disabled={disabled || isOpen}
												onClick={() => void openProject(runtime, summary.id)}
												size="sm"
												variant="outline"
											>
												Open
											</Button>
											<Button
												disabled={disabled}
												onClick={() =>
													setRenaming({ id: summary.id, title: summary.title })
												}
												size="sm"
												variant="ghost"
											>
												Rename
											</Button>
											<Button
												aria-expanded={infoId === summary.id}
												onClick={() =>
													setInfoId((current) =>
														current === summary.id ? null : summary.id
													)
												}
												size="sm"
												variant="ghost"
											>
												Info
											</Button>
										</RyuAppActions>
									)}
								</div>
							</li>
						);
					})}
				</ul>
			)}
			{info && (
				<dl
					aria-label={`About ${info.title}`}
					className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm"
				>
					<dt className="text-muted-foreground">Title</dt>
					<dd className="min-w-0 truncate">{info.title}</dd>
					<dt className="text-muted-foreground">Duration</dt>
					<dd>{formatProjectDuration(info.duration)}</dd>
					<dt className="text-muted-foreground">Clips</dt>
					<dd>{info.segmentCount}</dd>
					<dt className="text-muted-foreground">Canvas</dt>
					<dd>
						{info.width} × {info.height}
					</dd>
					<dt className="text-muted-foreground">Created</dt>
					<dd>{formatProjectDate(info.createdAt)}</dd>
					<dt className="text-muted-foreground">Modified</dt>
					<dd>{formatProjectDate(info.updatedAt)}</dd>
					<dt className="text-muted-foreground">Revision</dt>
					<dd>{info.revision}</dd>
				</dl>
			)}
		</RyuAppSection>
	);
}
