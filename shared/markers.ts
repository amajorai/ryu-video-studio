import { z } from "zod";
import {
	type Asset,
	type Marker,
	markerSchema,
	type Project,
	validateProject,
} from "./project.ts";

/** Latest marker time (and range end) a project accepts, in seconds. */
export const MAX_MARKER_TIME = 7200;
/** Markers per project, matching `projectSchema`'s bound. */
export const MAX_MARKERS = 500;
/** How long a point marker's label stays on the preview, in seconds. */
export const POINT_MARKER_LABEL_SECONDS = 1.5;

export const markerStatusSchema = z.enum(["open", "review", "resolved"]);
export type MarkerStatus = z.infer<typeof markerStatusSchema>;

/**
 * Marker list filters. `open` means every unresolved marker (no status,
 * `open`, or `review`); `review` and `resolved` match that status only.
 */
export type MarkerFilter = "all" | MarkerStatus;

const markerActionSchema = z.enum([
	"create",
	"update",
	"delete",
	"toggle",
	"move",
	"fromRange",
	"ripple",
]);
export type MarkerAction = z.infer<typeof markerActionSchema>;

const boundedTime = z.number().finite().min(0).max(MAX_MARKER_TIME);

export const manageMarkerRequestSchema = z
	.object({
		action: markerActionSchema,
		color: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}$/)
			.optional(),
		/** An empty comment clears the marker's comment on update. */
		comment: z.string().max(2000).optional(),
		/** A zero duration turns a range marker back into a point on update. */
		duration: boundedTime.optional(),
		/** Range end for `fromRange`. */
		end: boundedTime.optional(),
		label: z.string().trim().min(1).max(120).optional(),
		markerId: z.uuid().optional(),
		revision: z.number().int().nonnegative(),
		/** Whether ripple edits shift markers, for `ripple`. */
		rippleMarkers: z.boolean().optional(),
		/** Range start for `fromRange`. */
		start: boundedTime.optional(),
		status: markerStatusSchema.optional(),
		/** Marker time; `move` accepts any finite time and clamps it. */
		time: z.number().finite().optional(),
	})
	.strict()
	.superRefine((input, context) => {
		const issue = (message: string, path: string) =>
			context.addIssue({ code: "custom", message, path: [path] });
		if (
			input.time !== undefined &&
			input.action !== "move" &&
			(input.time < 0 || input.time > MAX_MARKER_TIME)
		) {
			issue(`Marker time must be between 0 and ${MAX_MARKER_TIME}.`, "time");
		}
		switch (input.action) {
			case "create":
				if (!(input.label && input.time !== undefined)) {
					issue("Creating a marker requires label and time.", "label");
				}
				return;
			case "toggle":
				if (input.time === undefined) {
					issue("Toggling a marker requires time.", "time");
				}
				return;
			case "fromRange":
				if (
					input.start === undefined ||
					input.end === undefined ||
					input.end <= input.start
				) {
					issue("A marker from a range requires start before end.", "start");
				}
				return;
			case "ripple":
				if (input.rippleMarkers === undefined) {
					issue("Setting marker ripple requires rippleMarkers.", "action");
				}
				return;
			case "move":
				if (!input.markerId || input.time === undefined) {
					issue("Moving a marker requires markerId and time.", "markerId");
				}
				return;
			case "delete":
				if (!input.markerId) {
					issue("Deleting a marker requires markerId.", "markerId");
				}
				return;
			default:
				if (!input.markerId) {
					issue("Updating a marker requires markerId.", "markerId");
				}
				if (
					input.label === undefined &&
					input.time === undefined &&
					input.duration === undefined &&
					input.comment === undefined &&
					input.color === undefined &&
					input.status === undefined
				) {
					issue("Updating a marker requires at least one field.", "action");
				}
		}
	});
export type ManageMarkerRequest = z.infer<typeof manageMarkerRequestSchema>;
export type ManageMarkerInput = z.input<typeof manageMarkerRequestSchema>;

/** The outcome of a marker operation. */
export interface MarkerEditResult {
	/** The created, moved, or updated marker. */
	marker?: Marker;
	project: Project;
	/** The marker a delete or toggle removed. */
	removed?: Marker;
}

/** Round a marker time to the millisecond the editor stores. */
export const markerTime = (time: number) => Math.round(time * 1000) / 1000;

/** Half a frame at `fps`: the tolerance for "a marker at this time". */
export const markerHalfFrame = (fps: number) => 0.5 / Math.max(1, fps);

/** A marker's review status; markers without one are open. */
export const markerStatusOf = (marker: Marker): MarkerStatus =>
	marker.status ?? "open";

/** Markers in timeline order (ties keep their stored order). */
export const sortedMarkers = (markers: readonly Marker[]): Marker[] =>
	[...markers].sort((a, b) => a.time - b.time);

/** Markers matching `filter`, in timeline order. */
export function filterMarkers(
	markers: readonly Marker[],
	filter: MarkerFilter
): Marker[] {
	const ordered = sortedMarkers(markers);
	if (filter === "all") {
		return ordered;
	}
	if (filter === "open") {
		return ordered.filter((marker) => markerStatusOf(marker) !== "resolved");
	}
	return ordered.filter((marker) => markerStatusOf(marker) === filter);
}

/** The marker nearest `time` within `tolerance` seconds, if any. */
export function markerNear(
	markers: readonly Marker[],
	time: number,
	tolerance: number
): Marker | undefined {
	let best: Marker | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const marker of markers) {
		const distance = Math.abs(marker.time - time);
		if (distance <= tolerance + 1e-9 && distance < bestDistance) {
			best = marker;
			bestDistance = distance;
		}
	}
	return best;
}

/**
 * The next (`1`) or previous (`-1`) marker from `time`, wrapping at either
 * end. Markers within a millisecond of `time` are skipped.
 */
export function adjacentMarker(
	markers: readonly Marker[],
	time: number,
	direction: -1 | 1
): Marker | undefined {
	const ordered = sortedMarkers(markers);
	if (direction > 0) {
		return ordered.find((marker) => marker.time > time + 0.001) ?? ordered[0];
	}
	return (
		ordered.findLast((marker) => marker.time < time - 0.001) ?? ordered.at(-1)
	);
}

/**
 * Markers to label on the preview at `time`: a range marker while the
 * playhead is inside it, a point marker for a moment after it passes.
 */
export function markersAt(markers: readonly Marker[], time: number): Marker[] {
	return sortedMarkers(markers).filter((marker) => {
		const span = marker.duration || POINT_MARKER_LABEL_SECONDS;
		return time >= marker.time - 1e-6 && time < marker.time + span;
	});
}

/** Clamp a moved marker so it (and its range) stays on the timeline. */
export function clampMarkerTime(
	time: number,
	duration = 0,
	maxTime = MAX_MARKER_TIME
): number {
	const limit = Math.max(0, Math.min(MAX_MARKER_TIME, maxTime) - duration);
	return markerTime(Math.min(limit, Math.max(0, time)));
}

/** `Prefix N`, numbered after the markers already in the project. */
const nextLabel = (markers: readonly Marker[], prefix: string) =>
	`${prefix} ${markers.length + 1}`;

function ensureUniqueTime(markers: readonly Marker[], marker: Marker) {
	if (
		markers.some(
			(candidate) =>
				candidate.id !== marker.id && candidate.time === marker.time
		)
	) {
		throw new Error("A timeline marker already exists at that time.");
	}
}

function ensureRoom(markers: readonly Marker[]) {
	if (markers.length >= MAX_MARKERS) {
		throw new Error(
			`This project already has the ${MAX_MARKERS}-marker limit.`
		);
	}
}

function findMarker(project: Project, markerId: string | undefined): Marker {
	const marker = project.markers.find((candidate) => candidate.id === markerId);
	if (!marker) {
		throw new Error("Timeline marker not found.");
	}
	return marker;
}

function withMarkers(
	project: Project,
	assets: readonly Asset[],
	markers: Marker[]
): Project {
	return validateProject({ ...project, markers }, [...assets]);
}

function addMarker(
	project: Project,
	assets: readonly Asset[],
	fields: Omit<Marker, "id">
): MarkerEditResult {
	ensureRoom(project.markers);
	const marker = markerSchema.parse({ ...fields, id: crypto.randomUUID() });
	ensureUniqueTime(project.markers, marker);
	return {
		marker,
		project: withMarkers(
			project,
			assets,
			sortedMarkers([...project.markers, marker])
		),
	};
}

function replaceMarker(
	project: Project,
	assets: readonly Asset[],
	next: Marker
): MarkerEditResult {
	const marker = markerSchema.parse(next);
	ensureUniqueTime(project.markers, marker);
	return {
		marker,
		project: withMarkers(
			project,
			assets,
			project.markers.map((candidate) =>
				candidate.id === marker.id ? marker : candidate
			)
		),
	};
}

function updatedMarker(current: Marker, request: ManageMarkerRequest): Marker {
	// An empty comment or a zero duration clears that field.
	const { comment, duration, ...rest } = current;
	const nextComment = request.comment ?? comment;
	const nextDuration = request.duration ?? duration;
	const next: Marker = {
		...rest,
		...(nextComment?.trim() ? { comment: nextComment } : {}),
		...(nextDuration ? { duration: nextDuration } : {}),
	};
	if (request.color !== undefined) {
		next.color = request.color;
	}
	if (request.label !== undefined) {
		next.label = request.label;
	}
	if (request.status !== undefined) {
		next.status = request.status;
	}
	if (request.time !== undefined) {
		next.time = request.time;
	}
	return next;
}

/** Optional marker fields from a request, without undefined keys. */
function styleFields(request: ManageMarkerRequest) {
	return {
		...(request.color === undefined ? {} : { color: request.color }),
		...(request.comment?.trim() ? { comment: request.comment } : {}),
		...(request.status === undefined ? {} : { status: request.status }),
	};
}

/**
 * Apply a revisioned marker operation:
 * - `create` adds a labelled point or range marker;
 * - `toggle` removes the marker within half a frame of `time`, or adds one;
 * - `move` puts a marker at `time`, clamped so its range stays on the timeline;
 * - `fromRange` adds a range marker spanning `start`..`end`;
 * - `update` edits label, comment, color, status, time, or duration;
 * - `delete` removes a marker;
 * - `ripple` sets whether ripple edits shift markers.
 */
export function manageMarker(
	project: Project,
	assets: readonly Asset[],
	input: ManageMarkerInput
): MarkerEditResult {
	const request = manageMarkerRequestSchema.parse(input);
	switch (request.action) {
		case "create":
			return addMarker(project, assets, {
				...styleFields(request),
				...(request.duration ? { duration: request.duration } : {}),
				label: request.label ?? nextLabel(project.markers, "Marker"),
				time: request.time ?? 0,
			});
		case "toggle": {
			const time = request.time ?? 0;
			const existing = markerNear(
				project.markers,
				time,
				markerHalfFrame(project.fps)
			);
			if (existing) {
				return {
					project: withMarkers(
						project,
						assets,
						project.markers.filter((marker) => marker.id !== existing.id)
					),
					removed: existing,
				};
			}
			return addMarker(project, assets, {
				...styleFields(request),
				label: request.label ?? nextLabel(project.markers, "Marker"),
				time: markerTime(time),
			});
		}
		case "fromRange": {
			const start = markerTime(request.start ?? 0);
			const end = markerTime(request.end ?? 0);
			if (end <= start) {
				throw new Error("A marker range must be at least a millisecond long.");
			}
			return addMarker(project, assets, {
				...styleFields(request),
				duration: markerTime(end - start),
				label: request.label ?? nextLabel(project.markers, "Range"),
				time: start,
			});
		}
		case "move": {
			const current = findMarker(project, request.markerId);
			return replaceMarker(project, assets, {
				...current,
				time: clampMarkerTime(request.time ?? current.time, current.duration),
			});
		}
		case "delete": {
			const removed = findMarker(project, request.markerId);
			return {
				project: withMarkers(
					project,
					assets,
					project.markers.filter((marker) => marker.id !== removed.id)
				),
				removed,
			};
		}
		case "ripple": {
			// Absent means "ripple markers", so legacy projects stay unchanged.
			const { rippleMarkers: _previous, ...rest } = project;
			const next: Project =
				request.rippleMarkers === false
					? { ...rest, rippleMarkers: false }
					: rest;
			return { project: validateProject(next, [...assets]) };
		}
		default:
			return replaceMarker(
				project,
				assets,
				updatedMarker(findMarker(project, request.markerId), request)
			);
	}
}
