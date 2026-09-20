import { describe, expect, test } from "bun:test";
import {
	newProject,
	newSegment,
	projectSchema,
	rippleDeleteRange,
	snapTimelineTime,
	validateProject,
} from "./project.ts";

describe("timeline markers", () => {
	test("keeps labeled playhead markers in the editable project", () => {
		const project = newProject("Marked edit");
		const marker = {
			color: "#22c55e",
			id: crypto.randomUUID(),
			label: "Hook",
			time: 1.5,
		};
		const parsed = projectSchema.parse({ ...project, markers: [marker] });
		expect(parsed.markers).toEqual([marker]);
		expect(validateProject(parsed, []).markers).toEqual([marker]);
	});

	test("keeps review notes and range duration on markers", () => {
		const project = newProject("Review markers");
		const marker = {
			comment: "Tighten the opening cut.",
			duration: 2,
			id: crypto.randomUUID(),
			label: "Opening review",
			status: "review" as const,
			time: 1,
		};
		const parsed = projectSchema.parse({ ...project, markers: [marker] });
		expect(parsed.markers).toEqual([marker]);
		expect(validateProject(parsed, []).markers).toEqual([marker]);
	});

	test("rejects duplicate marker positions or identifiers", () => {
		const project = newProject("Invalid markers");
		const id = crypto.randomUUID();
		const parsed = projectSchema.parse({
			...project,
			markers: [
				{ id, label: "Hook", time: 1 },
				{ id: crypto.randomUUID(), label: "Beat", time: 1 },
			],
		});
		expect(() => validateProject(parsed, [])).toThrow(
			"Invalid or duplicate timeline marker."
		);
		const duplicateId = projectSchema.parse({
			...project,
			markers: [
				{ id, label: "Hook", time: 1 },
				{ id, label: "Beat", time: 2 },
			],
		});
		expect(() => validateProject(duplicateId, [])).toThrow(
			"Invalid or duplicate timeline marker."
		);
		expect(() =>
			projectSchema.parse({
				...project,
				markers: [
					{ id: crypto.randomUUID(), label: "Bad", time: 1, color: "red" },
				],
			})
		).toThrow();
	});

	test("snaps clip movement to the nearest marker after frame quantization", () => {
		const markers = [
			{ id: crypto.randomUUID(), label: "Hook", time: 2 },
			{ id: crypto.randomUUID(), label: "End", time: 4.5 },
		];
		expect(snapTimelineTime(1.96, 30, markers)).toBe(2);
		expect(snapTimelineTime(4.43, 30, markers)).toBe(4.5);
		expect(snapTimelineTime(3.1, 30, markers)).toBeCloseTo(3.1, 6);
	});

	test("ripples range markers with the timeline interval", () => {
		const source = {
			createdAt: new Date().toISOString(),
			duration: 10,
			hasAudio: false,
			height: 180,
			id: crypto.randomUUID(),
			kind: "video" as const,
			name: "Footage",
			width: 320,
		};
		const project = newProject("Range marker ripple");
		project.segments = [newSegment(source)];
		project.markers = [
			{
				duration: 2,
				id: crypto.randomUUID(),
				label: "Review range",
				time: 4,
			},
		];
		const changed = rippleDeleteRange(project, [source], 2, 3);
		expect(changed.markers[0]).toMatchObject({ duration: 2, time: 3 });
	});
});
