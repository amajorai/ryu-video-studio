import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	type KeyboardEvent,
	useEffect,
	useRef,
	useSyncExternalStore,
} from "react";
import { useEditor } from "../editor/context.tsx";
import { openProject } from "../editor/project-actions.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import {
	closeProjectTab,
	MAX_PROJECT_TABS,
	openProjectTab,
	projectTabsSnapshot,
	subscribeProjectTabs,
	tabAfterClose,
	updateProjectTabs,
} from "./project-tabs-model.ts";

/**
 * Keep the shared recent-projects list in step with the editor: the open
 * project joins the strip, and once the project list is loaded (it contains
 * the open project) ids of deleted projects are dropped before capping, so
 * they never push out a live tab. Any mounted strip runs this, so mounting
 * one in the toolbar records every project opened from anywhere.
 */
export function useRecentProjectTabs(
	runtime: Pick<EditorRuntime, "project" | "projects">
): readonly string[] {
	const tabs = useSyncExternalStore(
		subscribeProjectTabs,
		projectTabsSnapshot,
		projectTabsSnapshot
	);
	const currentId = runtime.project?.id ?? null;
	const ids = runtime.projects.map((item) => item.id);
	const loaded = currentId !== null && ids.includes(currentId);
	const idsKey = loaded ? ids.join(",") : "";

	useEffect(() => {
		if (!currentId) {
			return;
		}
		const existing = idsKey ? idsKey.split(",") : undefined;
		updateProjectTabs((current) =>
			openProjectTab(current, currentId, MAX_PROJECT_TABS, existing)
		);
	}, [currentId, idsKey]);

	return tabs;
}

/**
 * A strip of recently opened projects, remembered for this viewer. Selecting
 * a project opens it (saving pending edits first); closing the open project
 * switches to its neighbour. It is a labelled list of buttons with
 * `aria-current` on the open project, so the close buttons are ordinary
 * controls rather than invalid children of an ARIA tablist.
 */
export function ProjectTabs() {
	const tl = useLiteralMessages();
	const runtime = useEditor();
	const { busy, project, projects } = runtime;
	const tabs = useRecentProjectTabs(runtime);
	const strip = useRef<HTMLElement>(null);
	const currentId = project?.id ?? null;

	const titles = new Map(projects.map((item) => [item.id, item.title]));
	const visible = tabs.filter((id) => titles.has(id));
	if (visible.length === 0) {
		return null;
	}

	const select = (id: string) => {
		if (!busy && id !== currentId) {
			void openProject(runtime, id);
		}
	};
	const close = (id: string) => {
		const next = tabAfterClose(visible, id, currentId);
		updateProjectTabs((current) => closeProjectTab(current, id));
		if (next && next !== currentId) {
			void openProject(runtime, next);
		}
	};
	const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
		const index = visible.indexOf(id);
		const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };
		const offset = offsets[event.key];
		let target: number | undefined;
		if (offset !== undefined) {
			target = (index + offset + visible.length) % visible.length;
		} else if (event.key === "Home") {
			target = 0;
		} else if (event.key === "End") {
			target = visible.length - 1;
		}
		if (target === undefined) {
			return;
		}
		event.preventDefault();
		strip.current
			?.querySelector<HTMLButtonElement>(
				`[data-project-tab="${visible[target]}"]`
			)
			?.focus();
	};

	return (
		<nav aria-label="Open projects" className="min-w-0 max-w-full" ref={strip}>
			<ul className="flex min-w-0 max-w-full gap-1 overflow-x-auto">
				{visible.map((id) => {
					const selected = id === currentId;
					const title = titles.get(id) ?? "";
					// The open project cannot be closed when it is the only one,
					// since there is no other project to switch to.
					const closable = !selected || visible.length > 1;
					return (
						<li
							className="flex min-w-0 shrink-0 items-center rounded-md border data-[selected=true]:bg-muted"
							data-selected={selected ? "true" : "false"}
							key={id}
						>
							{/* aria-disabled keeps a busy strip focusable. */}
							<button
								aria-current={selected ? "true" : undefined}
								aria-disabled={busy || undefined}
								className="max-w-[12rem] truncate px-2 py-1 text-sm aria-disabled:opacity-50"
								data-project-tab={id}
								onClick={() => select(id)}
								onKeyDown={(event) => moveFocus(event, id)}
								title={title}
								type="button"
							>
								{title}
							</button>
							{closable && (
								<Button
									aria-label={tl("Close {title}", { title })}
									className="shrink-0"
									disabled={busy}
									onClick={() => close(id)}
									size="icon-sm"
									title={tl("Close {title}", { title })}
									variant="ghost"
								>
									<HugeiconsIcon
										aria-hidden="true"
										className="size-3.5"
										icon={Cancel01Icon}
										strokeWidth={2}
									/>
								</Button>
							)}
						</li>
					);
				})}
			</ul>
		</nav>
	);
}
