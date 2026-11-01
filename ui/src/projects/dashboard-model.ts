/**
 * Pure helpers and per-viewer preferences for the projects dashboard.
 */
import { z } from "zod";
import {
	type ProjectSort,
	type ProjectSummary,
	projectSortSchema,
} from "../../../shared/project-summary.ts";
import {
	readViewerValue,
	type ViewerStorageArea,
	writeViewerValue,
} from "../editor/viewer-storage.ts";

export const PROJECTS_DASHBOARD_KEY = "projects-dashboard";

export const dashboardViewSchema = z.enum(["grid", "list"]);
export type DashboardView = z.infer<typeof dashboardViewSchema>;

const dashboardPreferencesSchema = z
	.object({ sort: projectSortSchema, view: dashboardViewSchema })
	.strict();
export type DashboardPreferences = z.infer<typeof dashboardPreferencesSchema>;

export const DEFAULT_DASHBOARD_PREFERENCES: DashboardPreferences = {
	sort: "modified",
	view: "grid",
};

export const SORT_LABELS: Record<ProjectSort, string> = {
	created: "Date created",
	modified: "Last modified",
	title: "Title",
};

export function readDashboardPreferences(
	area?: ViewerStorageArea | null
): DashboardPreferences {
	return readViewerValue(
		PROJECTS_DASHBOARD_KEY,
		dashboardPreferencesSchema,
		DEFAULT_DASHBOARD_PREFERENCES,
		area
	);
}

export function writeDashboardPreferences(
	preferences: DashboardPreferences,
	area?: ViewerStorageArea | null
): boolean {
	return writeViewerValue(PROJECTS_DASHBOARD_KEY, preferences, area);
}

/** Add `id` to the selection, or remove it when it is already selected. */
export function toggleSelected(
	selected: readonly string[],
	id: string
): string[] {
	return selected.includes(id)
		? selected.filter((value) => value !== id)
		: [...selected, id];
}

/** Keep only selected ids that are still listed, in listing order. */
export function visibleSelection(
	selected: readonly string[],
	listed: readonly ProjectSummary[]
): string[] {
	const chosen = new Set(selected);
	return listed.filter((item) => chosen.has(item.id)).map((item) => item.id);
}

/** `m:ss` or `h:mm:ss` for a duration in seconds. */
export function formatProjectDuration(seconds: number): string {
	const total = Math.max(0, Math.round(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const rest = String(total % 60).padStart(2, "0");
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
		: `${minutes}:${rest}`;
}

/** Locale date and time, or an empty string for an unreadable timestamp. */
export function formatProjectDate(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? ""
		: date.toLocaleString(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			});
}

/** One-line card subtitle: duration, clip count, and last-modified date. */
export function projectSubtitle(summary: ProjectSummary): string {
	const clips =
		summary.segmentCount === 1 ? "1 clip" : `${summary.segmentCount} clips`;
	return [
		formatProjectDuration(summary.duration),
		clips,
		formatProjectDate(summary.updatedAt),
	]
		.filter(Boolean)
		.join(" · ");
}

/** Confirmation text for deleting the listed projects. */
export function deleteConfirmation(titles: readonly string[]): string {
	if (titles.length === 1) {
		return `Delete "${titles[0]}"? Its saved history and exports are removed. Media stays in the library.`;
	}
	return `Delete ${titles.length} projects? Their saved history and exports are removed. Media stays in the library.`;
}
