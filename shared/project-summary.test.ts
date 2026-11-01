import { describe, expect, test } from "bun:test";
import { type Asset, newProject, newSegment, type Project } from "./project.ts";
import {
	filterProjectSummaries,
	type ProjectSummary,
	posterTime,
	projectSummarySchema,
	sortProjectSummaries,
	summarizeProject,
} from "./project-summary.ts";

function asset(kind: Asset["kind"]): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration: 10,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : 360,
		id: crypto.randomUUID(),
		kind,
		name: kind,
		width: kind === "audio" ? 0 : 640,
	};
}

function summary(
	title: string,
	createdAt: string,
	updatedAt: string,
	id = crypto.randomUUID()
): ProjectSummary {
	return {
		createdAt,
		duration: 0,
		height: 1080,
		id,
		posterUrl: `/projects/${id}/poster`,
		revision: 0,
		segmentCount: 0,
		title,
		updatedAt,
		width: 1920,
	};
}

describe("summarizeProject", () => {
	test("reports duration, segment count, times, and the poster path", () => {
		const media = asset("video");
		const project: Project = {
			...newProject("Cut"),
			segments: [newSegment(media, 0), newSegment(media, 10)],
		};
		const result = summarizeProject(project, "2026-01-01T00:00:00.000Z");
		expect(projectSummarySchema.parse(result)).toEqual(result);
		expect(result.duration).toBe(20);
		expect(result.segmentCount).toBe(2);
		expect(result.createdAt).toBe("2026-01-01T00:00:00.000Z");
		expect(result.updatedAt).toBe(project.updatedAt);
		expect(result.posterUrl).toBe(`/projects/${project.id}/poster`);
	});

	test("the summary schema is strict", () => {
		const value = summary(
			"A",
			new Date(0).toISOString(),
			new Date(0).toISOString()
		);
		expect(
			projectSummarySchema.safeParse({ ...value, extra: true }).success
		).toBe(false);
	});
});

describe("posterTime", () => {
	test("is null without visual content", () => {
		const audio = asset("audio");
		expect(posterTime(newProject(), [])).toBeNull();
		expect(
			posterTime({ ...newProject(), segments: [newSegment(audio, 0)] }, [audio])
		).toBeNull();
	});

	test("is 0 when content starts at 0, otherwise the first visual start", () => {
		const media = asset("video");
		const audio = asset("audio");
		const atZero = { ...newProject(), segments: [newSegment(media, 0)] };
		expect(posterTime(atZero, [media])).toBe(0);
		const late = {
			...newProject(),
			segments: [newSegment(audio, 0), newSegment(media, 4)],
			titles: [
				{
					color: "#ffffff",
					end: 9,
					fadeIn: 0,
					fadeOut: 0,
					fontSize: 0.05,
					id: crypto.randomUUID(),
					start: 2.5,
					text: "Title",
					x: 0.5,
					y: 0.5,
					animation: "fade" as const,
				},
			],
		};
		expect(posterTime(late, [media, audio])).toBe(2.5);
	});

	test("skips hidden clips and clips on hidden tracks", () => {
		const media = asset("video");
		const hiddenAtZero = { ...newSegment(media, 0), hidden: true };
		const visibleLater = { ...newSegment(media, 0), start: 5, track: 1 };
		expect(
			posterTime({ ...newProject(), segments: [hiddenAtZero, visibleLater] }, [
				media,
			])
		).toBe(5);
		expect(
			posterTime({ ...newProject(), segments: [hiddenAtZero] }, [media])
		).toBeNull();
		const onHiddenTrack = { ...newSegment(media, 0), track: 2 };
		expect(
			posterTime(
				{
					...newProject(),
					segments: [onHiddenTrack, visibleLater],
					trackSettings: [
						{
							hidden: true,
							locked: false,
							muted: false,
							name: "V3",
							solo: false,
							track: 2,
						},
					],
				},
				[media]
			)
		).toBe(5);
	});

	test("counts an audio clip shown as a waveform", () => {
		const audio = asset("audio");
		const waveform = {
			...newSegment(audio, 0),
			visualization: "waveform" as const,
		};
		expect(posterTime({ ...newProject(), segments: [waveform] }, [audio])).toBe(
			0
		);
	});
});

describe("filterProjectSummaries", () => {
	const items = [
		summary(
			"Summer trip",
			"2026-01-01T00:00:00.000Z",
			"2026-01-02T00:00:00.000Z"
		),
		summary(
			"Winter Trip cut",
			"2026-01-01T00:00:00.000Z",
			"2026-01-02T00:00:00.000Z"
		),
		summary(
			"Interview",
			"2026-01-01T00:00:00.000Z",
			"2026-01-02T00:00:00.000Z"
		),
	];

	test("matches every term case-insensitively", () => {
		expect(filterProjectSummaries(items, "TRIP").map((s) => s.title)).toEqual([
			"Summer trip",
			"Winter Trip cut",
		]);
		expect(
			filterProjectSummaries(items, " trip  cut ").map((s) => s.title)
		).toEqual(["Winter Trip cut"]);
	});

	test("an empty query keeps everything without aliasing the input", () => {
		const result = filterProjectSummaries(items, "   ");
		expect(result).toEqual(items);
		expect(result).not.toBe(items);
	});
});

describe("sortProjectSummaries", () => {
	const a = summary(
		"Cut 10",
		"2026-01-03T00:00:00.000Z",
		"2026-01-04T00:00:00.000Z",
		"00000000-0000-4000-8000-000000000001"
	);
	const b = summary(
		"cut 2",
		"2026-01-01T00:00:00.000Z",
		"2026-01-05T00:00:00.000Z",
		"00000000-0000-4000-8000-000000000002"
	);
	const c = summary(
		"Alpha",
		"2026-01-02T00:00:00.000Z",
		"2026-01-04T00:00:00.000Z",
		"00000000-0000-4000-8000-000000000003"
	);
	const items = [a, b, c];

	test("modified puts the newest update first, ties by title", () => {
		expect(sortProjectSummaries(items, "modified")).toEqual([b, c, a]);
	});

	test("created puts the newest project first", () => {
		expect(sortProjectSummaries(items, "created")).toEqual([a, c, b]);
	});

	test("title sorts naturally and ignores case", () => {
		expect(sortProjectSummaries(items, "title")).toEqual([c, b, a]);
	});

	test("does not mutate the input", () => {
		const before = [...items];
		sortProjectSummaries(items, "title");
		expect(items).toEqual(before);
	});
});
