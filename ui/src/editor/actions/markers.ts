import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	adjacentMarker,
	clampMarkerTime,
	MAX_MARKERS,
	type ManageMarkerInput,
	type MarkerEditResult,
	manageMarker,
} from "../../../../shared/markers.ts";
import type { Marker } from "../../../../shared/project.ts";
import { studioFormat } from "../../i18n/format.ts";
import { clock } from "../format.ts";
import type { EditorRuntime } from "../runtime.ts";
import type { ActionHandlers } from "./types.ts";

/** Markers per project, matching the sidecar's schema bound. */
const MARKER_LIMIT = MAX_MARKERS;

/** English fallback until a caller passes the Companion's `tl`. */
const englishMessages: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

/** A marker operation without the revision, which comes from the open project. */
export type MarkerOperation = Omit<ManageMarkerInput, "revision">;

/**
 * Apply a marker operation to the open project as one undoable edit. Invalid
 * operations (a taken time, the marker limit) report a status instead.
 */
export function editMarkers(
	runtime: EditorRuntime,
	operation: MarkerOperation,
	label: string
): MarkerEditResult | undefined {
	const { assets, project } = runtime;
	if (!project) {
		return;
	}
	try {
		const result = manageMarker(project, assets, {
			...operation,
			revision: project.revision,
		});
		runtime.edit(result.project, label);
		return result;
	} catch (error) {
		runtime.setStatus(
			error instanceof Error ? error.message : "That marker edit failed."
		);
		return;
	}
}

/** M: add a marker at the playhead, or remove the one within half a frame. */
export function toggleMarker(
	runtime: EditorRuntime,
	time = runtime.time,
	tl: LiteralMessage = englishMessages
) {
	const label = runtime.markerLabel.trim();
	const result = editMarkers(
		runtime,
		{
			action: "toggle",
			color: runtime.markerColor,
			...(label ? { label } : {}),
			time: Math.max(0, time),
		},
		"Toggle marker"
	);
	if (result?.removed) {
		runtime.setStatus(
			tl("Removed marker {label}.", { label: result.removed.label })
		);
	} else if (result?.marker) {
		runtime.setMarkerLabel("");
		runtime.setStatus(
			tl("Marker added at {time}.", { time: clock(result.marker.time) })
		);
	}
}

/** Alt+M: mark the in/out range as a range marker. */
export function markerFromRange(runtime: EditorRuntime) {
	const { end, start } = runtime.range;
	if (!(end > start)) {
		runtime.setStatus("Set an in and out range before marking it.");
		return;
	}
	const label = runtime.markerLabel.trim();
	const result = editMarkers(
		runtime,
		{
			action: "fromRange",
			color: runtime.markerColor,
			end,
			...(label ? { label } : {}),
			start,
		},
		"Mark range"
	);
	if (result?.marker) {
		runtime.setMarkerLabel("");
		runtime.setStatus(
			studioFormat("Marked {range}.", {
				range: `${clock(result.marker.time)}–${clock(result.marker.time + (result.marker.duration ?? 0))}`,
			})
		);
	}
}

/**
 * Where a dragged marker lands: on the timeline (or where it already was,
 * if that is later), with its range inside it.
 */
export function draggedMarkerTime(
	marker: Marker,
	time: number,
	duration: number
): number {
	const span = marker.duration ?? 0;
	return clampMarkerTime(
		time,
		span,
		Math.max(duration, marker.time + span, span)
	);
}

/** Move a marker (ruler drag, panel nudge). */
export function moveMarker(
	runtime: EditorRuntime,
	id: string,
	time: number,
	tl: LiteralMessage = englishMessages
) {
	const result = editMarkers(
		runtime,
		{ action: "move", markerId: id, time },
		"Move marker"
	);
	if (result?.marker) {
		runtime.setStatus(
			tl("Marker {label} moved to {time}.", {
				label: result.marker.label,
				time: clock(result.marker.time),
			})
		);
	}
	return result;
}

/** The marker fields the editor popover and the panel change. */
export type MarkerPatch = Pick<
	MarkerOperation,
	"color" | "comment" | "duration" | "label" | "status"
>;

/** Update a marker's label, comment, color, status, or duration. */
export function updateMarker(
	runtime: EditorRuntime,
	id: string,
	patch: MarkerPatch
) {
	return editMarkers(
		runtime,
		{ action: "update", markerId: id, ...patch },
		"Edit marker"
	);
}

/** Whether ripple edits shift markers (absent means they do). */
export function setRippleMarkers(runtime: EditorRuntime, enabled: boolean) {
	const result = editMarkers(
		runtime,
		{ action: "ripple", rippleMarkers: enabled },
		enabled ? "Ripple markers" : "Pin markers"
	);
	if (result) {
		runtime.setStatus(
			enabled
				? "Ripple edits now move markers."
				: "Markers stay put during ripple edits."
		);
	}
}

/** Add a marker at the playhead with the drafted label and color. */
export function addMarker(
	runtime: EditorRuntime,
	tl: LiteralMessage = englishMessages
) {
	const { duration, markerColor, markerLabel, project, time } = runtime;
	if (!project) {
		return;
	}
	const markerTime = Number(Math.max(0, Math.min(duration, time)).toFixed(3));
	if (project.markers.some((marker) => marker.time === markerTime)) {
		runtime.setStatus(
			"Move the playhead before adding another marker at this time."
		);
		return;
	}
	const label = markerLabel.trim() || `Marker ${project.markers.length + 1}`;
	runtime.edit(
		{
			...project,
			markers: [
				...project.markers,
				{
					color: markerColor,
					id: crypto.randomUUID(),
					label,
					time: markerTime,
				},
			].sort((a, b) => a.time - b.time),
		},
		"Add marker"
	);
	runtime.setMarkerLabel("");
	runtime.setStatus(tl("Marker added at {time}.", { time: clock(markerTime) }));
}

/** Which analysis produced a batch of markers. */
export type AnalysisMarkerKind = "bar" | "beat" | "loudness";

/** Add numbered analysis markers (loudness peaks, beats), skipping duplicates. */
export function addAnalysisMarkers(
	runtime: EditorRuntime,
	times: readonly number[],
	options: {
		assetName: string;
		color: string;
		description: string;
		kind: AnalysisMarkerKind;
		prefix: string;
	},
	tl: LiteralMessage = englishMessages
) {
	const { duration, project } = runtime;
	if (!project) {
		return;
	}
	const { assetName, color, description, kind, prefix } = options;
	const existing = new Set(project.markers.map((marker) => marker.time));
	let sequence = project.markers.length + 1;
	const available = Math.max(0, MARKER_LIMIT - project.markers.length);
	if (available === 0) {
		runtime.setStatus(
			tl("This project already has the {limit}-marker limit.", {
				limit: String(MARKER_LIMIT),
			})
		);
		return;
	}
	const next = times.flatMap((time) => {
		const markerTime = Number(Math.max(0, Math.min(duration, time)).toFixed(3));
		if (existing.has(markerTime)) {
			return [];
		}
		existing.add(markerTime);
		return [
			{
				color,
				id: crypto.randomUUID(),
				label: `${prefix} ${sequence++}`,
				time: markerTime,
			},
		];
	});
	if (!next.length) {
		runtime.setStatus(
			tl(
				"{kind, select, loudness {These loudness markers are already marked.} beat {These beat markers are already marked.} other {These bar start markers are already marked.}}",
				{ kind }
			)
		);
		return;
	}
	const added = next.slice(0, available);
	runtime.edit(
		{
			...project,
			markers: [...project.markers, ...added].sort((a, b) => a.time - b.time),
		},
		`Add ${description}s`
	);
	runtime.setStatus(
		tl(
			"{kind, select, loudness {Added {count, plural, one {# loudness marker} other {# loudness markers}} from {assetName}.} beat {Added {count, plural, one {# beat marker} other {# beat markers}} from {assetName}.} other {Added {count, plural, one {# bar start marker} other {# bar start markers}} from {assetName}.}}",
			{ assetName, count: added.length, kind }
		)
	);
}

export const addLoudnessMarkers = (
	runtime: EditorRuntime,
	times: readonly number[],
	assetName: string
) =>
	addAnalysisMarkers(runtime, times, {
		assetName,
		color: "#38bdf8",
		description: "loudness marker",
		kind: "loudness",
		prefix: "Peak",
	});

export const addBeatMarkers = (
	runtime: EditorRuntime,
	times: readonly number[],
	assetName: string
) =>
	addAnalysisMarkers(runtime, times, {
		assetName,
		color: "#f97316",
		description: "beat marker",
		kind: "beat",
		prefix: "Beat",
	});

/** Bar-start (downbeat) markers from beat analysis, coloured apart from beats. */
export const addBarMarkers = (
	runtime: EditorRuntime,
	times: readonly number[],
	assetName: string
) =>
	addAnalysisMarkers(runtime, times, {
		assetName,
		color: "#a855f7",
		description: "bar start marker",
		kind: "bar",
		prefix: "Bar",
	});

export function removeMarker(runtime: EditorRuntime, id: string) {
	const { project } = runtime;
	if (!project) {
		return;
	}
	runtime.edit(
		{
			...project,
			markers: project.markers.filter((marker) => marker.id !== id),
		},
		"Remove marker"
	);
}

/** Jump to the previous or next marker, wrapping at either end. */
export function navigateMarker(runtime: EditorRuntime, direction: -1 | 1) {
	const { project, time } = runtime;
	if (!project?.markers.length) {
		runtime.setStatus("Add a timeline marker before navigating markers.");
		return;
	}
	const target = adjacentMarker(project.markers, time, direction);
	if (target) {
		runtime.setPlaying(false);
		runtime.setTime(target.time);
		runtime.setStatus(`Marker ${target.label} · ${clock(target.time)}.`);
	}
}

/** Marker handlers: add, toggle (M), from range (Alt+M), and `[`/`]` navigation. */
export const markerActions: ActionHandlers = {
	"markers.add": (runtime) => {
		addMarker(runtime);
	},
	"markers.fromRange": (runtime) => {
		markerFromRange(runtime);
	},
	"markers.next": (runtime) => {
		navigateMarker(runtime, 1);
	},
	"markers.previous": (runtime) => {
		navigateMarker(runtime, -1);
	},
	"markers.toggle": (runtime) => {
		toggleMarker(runtime);
	},
};
