import { describe, expect, test } from "bun:test";
import type { ProjectSummary } from "../../../shared/project-summary.ts";
import type { ViewerStorageArea } from "../editor/viewer-storage.ts";
import {
	DEFAULT_DASHBOARD_PREFERENCES,
	deleteConfirmation,
	formatProjectDuration,
	projectSubtitle,
	readDashboardPreferences,
	toggleSelected,
	visibleSelection,
	writeDashboardPreferences,
} from "./dashboard-model.ts";

function summary(id: string, title = id): ProjectSummary {
	return {
		createdAt: "2026-01-01T00:00:00.000Z",
		duration: 0,
		height: 1080,
		id,
		posterUrl: `/projects/${id}/poster`,
		revision: 0,
		segmentCount: 0,
		title,
		updatedAt: "2026-01-02T00:00:00.000Z",
		width: 1920,
	};
}

function memoryArea(): ViewerStorageArea & { values: Map<string, string> } {
	const values = new Map<string, string>();
	return {
		getItem: (key) => values.get(key) ?? null,
		removeItem: (key) => {
			values.delete(key);
		},
		setItem: (key, value) => {
			values.set(key, value);
		},
		values,
	};
}

describe("selection", () => {
	test("toggleSelected adds and removes ids", () => {
		expect(toggleSelected([], "a")).toEqual(["a"]);
		expect(toggleSelected(["a", "b"], "a")).toEqual(["b"]);
	});

	test("visibleSelection keeps listed ids in listing order", () => {
		const listed = [summary("c"), summary("a")];
		expect(visibleSelection(["a", "b", "c"], listed)).toEqual(["c", "a"]);
	});
});

describe("formatting", () => {
	test("durations use m:ss or h:mm:ss", () => {
		expect(formatProjectDuration(0)).toBe("0:00");
		expect(formatProjectDuration(65.4)).toBe("1:05");
		expect(formatProjectDuration(3725)).toBe("1:02:05");
		expect(formatProjectDuration(-3)).toBe("0:00");
	});

	test("subtitle shows duration and clip count", () => {
		const one = { ...summary("a"), duration: 20, segmentCount: 1 };
		expect(projectSubtitle(one).startsWith("0:20 · 1 clip · ")).toBe(true);
		const many = { ...summary("b"), segmentCount: 3 };
		expect(projectSubtitle(many)).toContain("3 clips");
	});

	test("delete confirmation names one project or counts several", () => {
		expect(deleteConfirmation(["Trip"])).toContain('Delete "Trip"?');
		expect(deleteConfirmation(["A", "B"])).toContain("Delete 2 projects?");
	});
});

describe("preferences", () => {
	test("round-trip and fall back when invalid or blocked", () => {
		const area = memoryArea();
		expect(readDashboardPreferences(area)).toEqual(
			DEFAULT_DASHBOARD_PREFERENCES
		);
		writeDashboardPreferences({ sort: "title", view: "list" }, area);
		expect(readDashboardPreferences(area)).toEqual({
			sort: "title",
			view: "list",
		});
		area.values.set(
			"ryu.video-studio.projects-dashboard",
			JSON.stringify({ sort: "size", view: "list" })
		);
		expect(readDashboardPreferences(area)).toEqual(
			DEFAULT_DASHBOARD_PREFERENCES
		);
		expect(readDashboardPreferences(null)).toEqual(
			DEFAULT_DASHBOARD_PREFERENCES
		);
	});
});
