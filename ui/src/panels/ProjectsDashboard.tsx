import {
	RyuAppActions,
	RyuAppEmpty,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Checkbox, Input } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { type FormEvent, useEffect, useState } from "react";
import { projectSchema } from "../../../shared/project.ts";
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
import { openProject } from "../editor/project-actions.ts";
import {
	type DashboardPreferences,
	deleteConfirmation,
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
import {
	deleteResponseSchema,
	replaceOpenProject,
} from "./ProjectsDashboard-delete.ts";
import { ProjectsDashboardInfo } from "./ProjectsDashboard-info.tsx";
import { posterKey, usePosters } from "./ProjectsDashboard-posters.ts";
import type { PanelTab } from "./types.ts";

/** The projects dashboard has its own library tab. */
export const projectsDashboardTab: PanelTab | null = {
	label: "Projects",
	value: "projects",
};

interface RenameState {
	id: string;
	title: string;
}

/** Projects dashboard with search, sort, rename, info, and multi-delete. */
export function ProjectsDashboard() {
	const tl = useLiteralMessages();
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
		const summary = tl(
			"Deleted {count, plural, one {{countText} project} other {{countText} projects}}.",
			{ count: removed.length, countText: String(removed.length) }
		);
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
			runtime.setStatus(tl('Renamed to "{title}".', { title: saved.title }));
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
						{tl("{count} selected", { count: String(chosen.length) })}
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
											aria-label={tl("Select {title}", {
												title: summary.title,
											})}
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
												aria-label={tl("New title for {title}", {
													title: summary.title,
												})}
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
			{info && <ProjectsDashboardInfo info={info} />}
		</RyuAppSection>
	);
}
