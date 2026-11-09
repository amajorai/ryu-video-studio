import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button, Input, Textarea } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { type FormEvent, useId, useState } from "react";
import {
	MAX_MARKER_TIME,
	type MarkerStatus,
	markerStatusOf,
	markerStatusSchema,
} from "../../../shared/markers.ts";
import type { Marker } from "../../../shared/project.ts";
import type { MarkerPatch } from "../editor/actions/markers.ts";
import { defaultMarkerColor } from "../editor/format.ts";

/** Marker review statuses with their display names. */
export const MARKER_STATUS_LABELS: Record<MarkerStatus, string> = {
	open: "Open",
	resolved: "Resolved",
	review: "In review",
};

/** What the editor form holds while the viewer types. */
export interface MarkerDraft {
	color: string;
	comment: string;
	/** Range length in seconds as typed; empty or 0 makes a point marker. */
	duration: string;
	label: string;
	status: MarkerStatus;
}

export const markerDraftOf = (marker: Marker): MarkerDraft => ({
	color: marker.color ?? defaultMarkerColor,
	comment: marker.comment ?? "",
	duration: marker.duration ? String(marker.duration) : "",
	label: marker.label,
	status: markerStatusOf(marker),
});

/**
 * The fields a draft changes, or a reason it cannot be saved. Unchanged
 * fields are left out so an untouched marker gains no explicit defaults.
 */
export function markerPatch(
	marker: Marker,
	draft: MarkerDraft
): { error: string } | { patch: MarkerPatch } {
	const label = draft.label.trim();
	if (!label) {
		return { error: "Give the marker a label." };
	}
	const duration = draft.duration.trim() ? Number(draft.duration) : 0;
	if (!Number.isFinite(duration) || duration < 0) {
		return { error: "Duration must be zero or more seconds." };
	}
	if (marker.time + duration > MAX_MARKER_TIME) {
		return { error: "The range would run past the timeline limit." };
	}
	const patch: MarkerPatch = {};
	if (label !== marker.label) {
		patch.label = label;
	}
	if (draft.color !== (marker.color ?? defaultMarkerColor)) {
		patch.color = draft.color;
	}
	if (draft.comment !== (marker.comment ?? "")) {
		patch.comment = draft.comment;
	}
	if (duration !== (marker.duration ?? 0)) {
		patch.duration = duration;
	}
	if (draft.status !== markerStatusOf(marker)) {
		patch.status = draft.status;
	}
	return { patch };
}

/**
 * The marker form shown in the ruler popover: label, color, status, range
 * length, and review comment.
 */
export function MarkerEditor({
	marker,
	onAskAgent,
	onCancel,
	onDelete,
	onSave,
}: {
	marker: Marker;
	/** Hand this marker to the agent; omitted when no handoff surface is mounted. */
	onAskAgent?: () => void;
	onCancel: () => void;
	onDelete: () => void;
	onSave: (patch: MarkerPatch) => void;
}) {
	const tl = useLiteralMessages();
	const [draft, setDraft] = useState(() => markerDraftOf(marker));
	const [error, setError] = useState<string | null>(null);
	const errorId = useId();
	const change = (fields: Partial<MarkerDraft>) => {
		setError(null);
		setDraft((current) => ({ ...current, ...fields }));
	};
	const submit = (event: FormEvent) => {
		event.preventDefault();
		const result = markerPatch(marker, draft);
		if ("error" in result) {
			setError(result.error);
			return;
		}
		if (Object.keys(result.patch).length) {
			onSave(result.patch);
		}
		onCancel();
	};
	return (
		<form
			aria-describedby={error ? errorId : undefined}
			aria-label={tl("Edit marker {label}", { label: marker.label })}
			className="flex flex-col gap-2"
			data-testid="marker-editor"
			onSubmit={submit}
		>
			<RyuAppField label="Label">
				<Input
					aria-label="Marker label"
					maxLength={120}
					onChange={(event) => change({ label: event.target.value })}
					value={draft.label}
				/>
			</RyuAppField>
			<div className="flex gap-2">
				<RyuAppField className="flex-1" label="Status">
					<NativeSelect
						aria-label="Marker status"
						onChange={(event) =>
							change({ status: markerStatusSchema.parse(event.target.value) })
						}
						value={draft.status}
					>
						{markerStatusSchema.options.map((status) => (
							<NativeSelectOption key={status} value={status}>
								{MARKER_STATUS_LABELS[status]}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</RyuAppField>
				<RyuAppField label="Color">
					<Input
						aria-label="Marker color"
						className="h-8 w-12 p-0.5"
						onChange={(event) => change({ color: event.target.value })}
						type="color"
						value={draft.color}
					/>
				</RyuAppField>
			</div>
			<RyuAppField label="Range length (seconds)">
				<Input
					aria-label="Marker range length"
					inputMode="decimal"
					min={0}
					onChange={(event) => change({ duration: event.target.value })}
					placeholder="Point marker"
					step={0.1}
					type="number"
					value={draft.duration}
				/>
			</RyuAppField>
			<RyuAppField label="Comment">
				<Textarea
					aria-label="Marker comment"
					maxLength={2000}
					onChange={(event) => change({ comment: event.target.value })}
					rows={3}
					value={draft.comment}
				/>
			</RyuAppField>
			{error ? (
				<p className="text-destructive text-xs" id={errorId} role="alert">
					{error}
				</p>
			) : null}
			<RyuAppActions>
				<Button size="sm" type="submit">
					Save
				</Button>
				<Button onClick={onCancel} size="sm" type="button" variant="ghost">
					Cancel
				</Button>
				{onAskAgent ? (
					<Button onClick={onAskAgent} size="sm" type="button" variant="ghost">
						Ask agent about this marker
					</Button>
				) : null}
				<Button
					className="ms-auto"
					onClick={onDelete}
					size="sm"
					type="button"
					variant="destructive"
				>
					Delete
				</Button>
			</RyuAppActions>
		</form>
	);
}
