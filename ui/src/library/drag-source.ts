import type { DragEvent as ReactDragEvent } from "react";
import { z } from "zod";
import type { Asset } from "../../../shared/project.ts";

/** Drag data type for a library asset dragged onto the timeline. */
export const ASSET_DRAG_MIME = "application/x-ryu-asset";

const sourceTime = z.number().finite().min(0).max(7200);

/**
 * What a library tile or a search result puts on the drag: the asset and an
 * optional source range, which needs both ends and must not be empty.
 */
export const assetDragPayloadSchema = z
	.object({
		assetId: z.uuid(),
		sourceIn: sourceTime.optional(),
		sourceOut: sourceTime.optional(),
	})
	.strict()
	.refine(
		(drag) => (drag.sourceIn === undefined) === (drag.sourceOut === undefined),
		{ message: "A source range needs both an in and an out point." }
	)
	.refine(
		(drag) =>
			drag.sourceIn === undefined ||
			drag.sourceOut === undefined ||
			drag.sourceOut > drag.sourceIn,
		{ message: "A source range must end after it starts." }
	);
export type AssetDragPayload = z.infer<typeof assetDragPayloadSchema>;

/** A source in/out range marked in the library before dragging. */
export interface AssetSourceRange {
	end: number;
	start: number;
}

/** The drag in flight from this document; lanes read it during dragover. */
export interface ActiveAssetDrag {
	asset: Asset;
	payload: AssetDragPayload;
}

const TEXT_FIELD_SELECTOR = "input, textarea, select, [contenteditable='true']";

let active: ActiveAssetDrag | null = null;

const insideTextField = (target: EventTarget | null): boolean => {
	const origin = target as { closest?: unknown } | null;
	return (
		typeof origin?.closest === "function" &&
		Boolean((target as Element).closest(TEXT_FIELD_SELECTOR))
	);
};

/**
 * The asset drag started from this document, if any. Browsers hide drag data
 * until `drop`, so the drop preview reads the asset (and its length) here.
 */
export function activeAssetDrag(): ActiveAssetDrag | null {
	return active;
}

/**
 * Record a drag started outside a library tile (e.g. a search result) so the
 * timeline drop preview can show where it lands during `dragover`.
 */
export function setActiveAssetDrag(drag: ActiveAssetDrag) {
	active = drag;
}

/** Forget the active drag (the tile's `dragend`, or after a drop). */
export function clearActiveAssetDrag() {
	active = null;
}

/** The drag payload for an asset and an optional marked source range. */
export function assetDragPayload(
	asset: Asset,
	range?: AssetSourceRange
): AssetDragPayload {
	return range
		? { assetId: asset.id, sourceIn: range.start, sourceOut: range.end }
		: { assetId: asset.id };
}

/** Timeline length a dropped payload occupies at 1x speed. */
export function payloadDuration(
	asset: Asset,
	payload: Pick<AssetDragPayload, "sourceIn" | "sourceOut">
): number {
	const sourceDuration =
		asset.kind === "image" ? Math.max(5, asset.duration) : asset.duration;
	const fullOut = asset.kind === "image" ? 5 : sourceDuration;
	const sourceIn = payload.sourceIn ?? 0;
	const sourceOut = Math.min(sourceDuration, payload.sourceOut ?? fullOut);
	return Math.max(0, sourceOut - sourceIn);
}

/** Whether a drag carries a library asset (readable during dragover). */
export function hasAssetDrag(dataTransfer: DataTransfer | null): boolean {
	return Boolean(
		dataTransfer && [...dataTransfer.types].includes(ASSET_DRAG_MIME)
	);
}

/** Read the asset payload of a drop; `null` when absent or malformed. */
export function readAssetDrag(
	dataTransfer: DataTransfer | null
): AssetDragPayload | null {
	const raw = dataTransfer?.getData(ASSET_DRAG_MIME);
	if (!raw) {
		return null;
	}
	try {
		const parsed = assetDragPayloadSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export interface AssetDragProps {
	draggable: true;
	onDragEnd: () => void;
	onDragStart: (event: ReactDragEvent<HTMLElement>) => void;
}

/**
 * Drag payload props for a library tile: the tile drags as
 * `application/x-ryu-asset` (asset id plus the optional marked source range)
 * and as plain text (the asset name) for drops outside the editor.
 */
export function assetDragProps(
	asset: Asset,
	range?: AssetSourceRange
): AssetDragProps {
	return {
		draggable: true,
		onDragEnd: clearActiveAssetDrag,
		onDragStart: (event) => {
			// Text fields inside the tile keep their own text-selection drags.
			if (insideTextField(event.target)) {
				return;
			}
			const payload = assetDragPayload(asset, range);
			active = { asset, payload };
			event.dataTransfer.effectAllowed = "copy";
			event.dataTransfer.setData(ASSET_DRAG_MIME, JSON.stringify(payload));
			event.dataTransfer.setData("text/plain", asset.name);
		},
	};
}
