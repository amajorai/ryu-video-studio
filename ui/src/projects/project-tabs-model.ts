/**
 * Recently opened project tabs, kept per viewer. Pure list operations plus a
 * storage wrapper that degrades to an empty strip when storage is blocked.
 */
import { z } from "zod";
import {
	readViewerValue,
	type ViewerStorageArea,
	writeViewerValue,
} from "../editor/viewer-storage.ts";

/** Most tabs the strip keeps; opening another drops the least recent one. */
export const MAX_PROJECT_TABS = 8;

export const PROJECT_TABS_KEY = "project-tabs";

const storedTabsSchema = z.array(z.string().min(1).max(64)).max(64);

/**
 * Record that `id` was opened. A tab already in the strip keeps its place so
 * switching between open tabs does not reshuffle them; a new tab is added at
 * the front and the strip is capped at `max`, dropping the oldest tabs. When
 * `existing` is given, tabs of deleted projects are dropped before capping so
 * they never push out a live tab.
 */
export function openProjectTab(
	tabs: readonly string[],
	id: string,
	max = MAX_PROJECT_TABS,
	existing?: Iterable<string>
): string[] {
	const live = existing ? pruneProjectTabs(tabs, [...existing, id]) : tabs;
	if (live.includes(id)) {
		return [...live];
	}
	return [id, ...live].slice(0, Math.max(1, max));
}

/** Remove `id` from the strip. */
export function closeProjectTab(tabs: readonly string[], id: string): string[] {
	return tabs.filter((tab) => tab !== id);
}

/** Drop tabs of projects that no longer exist, and duplicates. */
export function pruneProjectTabs(
	tabs: readonly string[],
	existing: Iterable<string>
): string[] {
	const available = new Set(existing);
	return [...new Set(tabs)].filter((tab) => available.has(tab));
}

/**
 * The tab to show after closing `closing` while `current` is open: the
 * neighbour to its right, else to its left, else none. Closing a tab that is
 * not open keeps the current project.
 */
export function tabAfterClose(
	tabs: readonly string[],
	closing: string,
	current: string | null
): string | null {
	if (closing !== current) {
		return current;
	}
	const index = tabs.indexOf(closing);
	if (index < 0) {
		return current;
	}
	return tabs[index + 1] ?? tabs[index - 1] ?? null;
}

export function readProjectTabs(area?: ViewerStorageArea | null): string[] {
	return readViewerValue(PROJECT_TABS_KEY, storedTabsSchema, [], area);
}

export function writeProjectTabs(
	tabs: readonly string[],
	area?: ViewerStorageArea | null
): boolean {
	return writeViewerValue(PROJECT_TABS_KEY, tabs, area);
}

/** Remove every id in `ids` from the strip, such as deleted projects. */
export function forgetProjectTabs(
	tabs: readonly string[],
	ids: Iterable<string>
): string[] {
	const gone = new Set(ids);
	return tabs.filter((tab) => !gone.has(tab));
}

const sameTabs = (left: readonly string[], right: readonly string[]) =>
	left.length === right.length &&
	left.every((tab, index) => tab === right[index]);

/**
 * One shared copy of the strip for every mounted view (the dashboard, the
 * toolbar, and project deletes), so they never write over each other. Storage
 * is only the per-viewer backing; when it is blocked the strip still works
 * for this session.
 */
let sharedTabs: string[] | null = null;
const listeners = new Set<() => void>();

export function projectTabsSnapshot(): readonly string[] {
	sharedTabs ??= readProjectTabs();
	return sharedTabs;
}

export function subscribeProjectTabs(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Apply `change` to the shared strip, persist it, and notify views. */
export function updateProjectTabs(
	change: (tabs: readonly string[]) => string[]
): void {
	const current = projectTabsSnapshot();
	const next = change(current);
	if (sameTabs(current, next)) {
		return;
	}
	sharedTabs = next;
	writeProjectTabs(next);
	for (const listener of listeners) {
		listener();
	}
}

/** Drop the in-memory copy so the next read comes from storage (tests). */
export function reloadProjectTabs(): void {
	sharedTabs = null;
	for (const listener of listeners) {
		listener();
	}
}
