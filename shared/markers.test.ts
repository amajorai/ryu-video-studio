import { describe, expect, test } from "bun:test";
import {
	adjacentMarker,
	clampMarkerTime,
	filterMarkers,
	MAX_MARKER_TIME,
	MAX_MARKERS,
	manageMarker,
	manageMarkerRequestSchema,
	markerHalfFrame,
	markerNear,
	markerStatusOf,
	markersAt,
} from "./markers.ts";
import {
	newProject,
	newSegment,
	type Project,
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

describe("manageMarker", () => {
	const fresh = (markers: Project["markers"] = []) => ({
		...newProject("Marker ops"),
		markers,
	});

	test("toggle adds a marker and toggling again at the same frame removes it", () => {
		const project = fresh();
		const added = manageMarker(project, [], {
			action: "toggle",
			revision: project.revision,
			time: 2.0004,
		});
		expect(added.marker).toMatchObject({ label: "Marker 1", time: 2 });
		expect(added.removed).toBeUndefined();
		// 30 fps: half a frame is 1/60 s, so a toggle 0.01 s away hits the marker.
		const removed = manageMarker(added.project, [], {
			action: "toggle",
			revision: added.project.revision,
			time: 2.01,
		});
		expect(removed.removed?.id).toBe(added.marker?.id);
		expect(removed.project.markers).toEqual(project.markers);
		const elsewhere = manageMarker(added.project, [], {
			action: "toggle",
			revision: added.project.revision,
			time: 2.02,
		});
		expect(elsewhere.project.markers.map((marker) => marker.time)).toEqual([
			2, 2.02,
		]);
	});

	test("toggle removes only the nearest marker inside the tolerance", () => {
		const a = { id: crypto.randomUUID(), label: "A", time: 1 };
		const b = { id: crypto.randomUUID(), label: "B", time: 1.01 };
		const project = fresh([a, b]);
		const result = manageMarker(project, [], {
			action: "toggle",
			revision: 0,
			time: 1.008,
		});
		expect(result.removed?.id).toBe(b.id);
		expect(result.project.markers).toEqual([a]);
	});

	test("move clamps the marker and its range onto the timeline", () => {
		const marker = {
			duration: 10,
			id: crypto.randomUUID(),
			label: "Range",
			time: 5,
		};
		const project = fresh([marker]);
		const early = manageMarker(project, [], {
			action: "move",
			markerId: marker.id,
			revision: 0,
			time: -3,
		});
		expect(early.marker?.time).toBe(0);
		const late = manageMarker(project, [], {
			action: "move",
			markerId: marker.id,
			revision: 0,
			time: 9000,
		});
		expect(late.marker?.time).toBe(MAX_MARKER_TIME - 10);
		expect(clampMarkerTime(4.123_45)).toBe(4.123);
		expect(clampMarkerTime(30, 5, 20)).toBe(15);
	});

	test("move refuses to land on another marker", () => {
		const a = { id: crypto.randomUUID(), label: "A", time: 1 };
		const b = { id: crypto.randomUUID(), label: "B", time: 2 };
		expect(() =>
			manageMarker(fresh([a, b]), [], {
				action: "move",
				markerId: a.id,
				revision: 0,
				time: 2,
			})
		).toThrow("already exists");
	});

	test("fromRange creates a range marker spanning the range", () => {
		const project = fresh();
		const result = manageMarker(project, [], {
			action: "fromRange",
			end: 4.75,
			revision: 0,
			start: 1.25,
			status: "review",
		});
		expect(result.marker).toMatchObject({
			duration: 3.5,
			label: "Range 1",
			status: "review",
			time: 1.25,
		});
		expect(() =>
			manageMarker(project, [], {
				action: "fromRange",
				end: 1,
				revision: 0,
				start: 1,
			})
		).toThrow();
	});

	test("update edits status and comment, and clears empty values", () => {
		const marker = {
			comment: "Old note",
			duration: 2,
			id: crypto.randomUUID(),
			label: "Cue",
			time: 1,
		};
		const project = fresh([marker]);
		const updated = manageMarker(project, [], {
			action: "update",
			comment: "Fix the jump cut",
			markerId: marker.id,
			revision: 0,
			status: "resolved",
		});
		expect(updated.marker).toMatchObject({
			comment: "Fix the jump cut",
			status: "resolved",
		});
		const cleared = manageMarker(updated.project, [], {
			action: "update",
			comment: "",
			duration: 0,
			markerId: marker.id,
			revision: 0,
		});
		expect(cleared.marker).toEqual({
			id: marker.id,
			label: "Cue",
			status: "resolved",
			time: 1,
		});
	});

	test("ripple writes false explicitly and drops the key for true", () => {
		const project = fresh();
		const off = manageMarker(project, [], {
			action: "ripple",
			revision: 0,
			rippleMarkers: false,
		});
		expect(off.project.rippleMarkers).toBe(false);
		const on = manageMarker(off.project, [], {
			action: "ripple",
			revision: 0,
			rippleMarkers: true,
		});
		expect("rippleMarkers" in on.project).toBe(false);
	});

	test("rejects requests missing their action's fields", () => {
		const parse = (input: Record<string, unknown>) =>
			manageMarkerRequestSchema.safeParse({ revision: 0, ...input }).success;
		expect(parse({ action: "toggle" })).toBe(false);
		expect(parse({ action: "move", time: 1 })).toBe(false);
		expect(parse({ action: "ripple" })).toBe(false);
		expect(parse({ action: "fromRange", end: 1, start: 2 })).toBe(false);
		expect(parse({ action: "create", label: "Late", time: 7201 })).toBe(false);
		expect(
			parse({ action: "move", markerId: crypto.randomUUID(), time: -1 })
		).toBe(true);
		expect(parse({ action: "toggle", extra: true, time: 1 })).toBe(false);
	});

	test("refuses to add past the marker limit", () => {
		const markers = Array.from({ length: MAX_MARKERS }, (_, index) => ({
			id: crypto.randomUUID(),
			label: `M${index}`,
			time: index,
		}));
		expect(() =>
			manageMarker(fresh(markers), [], {
				action: "toggle",
				revision: 0,
				time: 600.5,
			})
		).toThrow("marker limit");
	});
});

describe("marker queries", () => {
	const open = { id: crypto.randomUUID(), label: "Open", time: 3 };
	const review = {
		id: crypto.randomUUID(),
		label: "Review",
		status: "review" as const,
		time: 1,
	};
	const resolved = {
		id: crypto.randomUUID(),
		label: "Done",
		status: "resolved" as const,
		time: 2,
	};
	const markers = [open, review, resolved];

	test("status filter treats open as every unresolved marker", () => {
		const labels = (filter: Parameters<typeof filterMarkers>[1]) =>
			filterMarkers(markers, filter).map((marker) => marker.label);
		expect(labels("all")).toEqual(["Review", "Done", "Open"]);
		expect(labels("open")).toEqual(["Review", "Open"]);
		expect(labels("review")).toEqual(["Review"]);
		expect(labels("resolved")).toEqual(["Done"]);
		expect(markerStatusOf(open)).toBe("open");
	});

	test("adjacent marker wraps at both ends", () => {
		expect(adjacentMarker(markers, 1.5, 1)?.label).toBe("Done");
		expect(adjacentMarker(markers, 3, 1)?.label).toBe("Review");
		expect(adjacentMarker(markers, 1.5, -1)?.label).toBe("Review");
		expect(adjacentMarker(markers, 1, -1)?.label).toBe("Open");
		expect(adjacentMarker([], 1, 1)).toBeUndefined();
	});

	test("preview shows range markers inside their span and points briefly", () => {
		const range = {
			duration: 4,
			id: crypto.randomUUID(),
			label: "Range",
			time: 10,
		};
		expect(markersAt([open, range], 3.5).map((m) => m.label)).toEqual(["Open"]);
		expect(markersAt([open, range], 4.6)).toEqual([]);
		expect(markersAt([open, range], 13.9).map((m) => m.label)).toEqual([
			"Range",
		]);
		expect(markersAt([open, range], 14)).toEqual([]);
	});

	test("markerNear honours the half-frame tolerance", () => {
		expect(markerHalfFrame(25)).toBe(0.02);
		expect(markerNear(markers, 2.019, 0.02)?.id).toBe(resolved.id);
		expect(markerNear(markers, 2.03, 0.02)).toBeUndefined();
	});
});
