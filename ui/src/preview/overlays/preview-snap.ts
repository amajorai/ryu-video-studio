import type { EditorStore } from "../../editor/store.ts";

/**
 * Canvas snapping for direct manipulation in the preview. Boxes and lines
 * are in normalized canvas coordinates (0 = left/top, 1 = right/bottom), so
 * the math is independent of the preview's zoom; only the threshold is in
 * screen pixels. The transform handles (W2-P2) call `snapCanvasBox` while
 * dragging and publish the result's guides for `PreviewSnapGuides`.
 */

export interface CanvasBox {
	bottom: number;
	left: number;
	right: number;
	top: number;
}

/** Vertical (`x`) and horizontal (`y`) guide positions. */
export interface CanvasSnapLines {
	x: number[];
	y: number[];
}

export const EMPTY_CANVAS_GUIDES: CanvasSnapLines = Object.freeze({
	x: [],
	y: [],
}) as CanvasSnapLines;

const EPSILON = 1e-6;

const unique = (values: readonly number[]) =>
	[...new Set(values.map((value) => Number(value.toFixed(6))))].sort(
		(a, b) => a - b
	);

/** Canvas edges and center plus every other item's edges and center. */
export function canvasSnapLines(
	others: readonly CanvasBox[] = []
): CanvasSnapLines {
	return {
		x: unique([
			0,
			0.5,
			1,
			...others.flatMap((box) => [
				box.left,
				(box.left + box.right) / 2,
				box.right,
			]),
		]),
		y: unique([
			0,
			0.5,
			1,
			...others.flatMap((box) => [
				box.top,
				(box.top + box.bottom) / 2,
				box.bottom,
			]),
		]),
	};
}

function snapAxis(
	edges: readonly number[],
	lines: readonly number[],
	threshold: number
): { delta: number; guides: number[] } {
	let delta = 0;
	let best = Number.POSITIVE_INFINITY;
	for (const line of lines) {
		for (const edge of edges) {
			const distance = line - edge;
			if (
				Math.abs(distance) <= threshold + EPSILON &&
				Math.abs(distance) < best - EPSILON
			) {
				best = Math.abs(distance);
				delta = distance;
			}
		}
	}
	if (!Number.isFinite(best)) {
		return { delta: 0, guides: [] };
	}
	const guides = lines.filter((line) =>
		edges.some((edge) => Math.abs(edge + delta - line) <= EPSILON)
	);
	return { delta, guides };
}

export interface CanvasSnapOptions {
	/** Rendered canvas size in screen pixels. */
	heightPx: number;
	/** Pointer distance that captures a line (default 8 px). */
	thresholdPx?: number;
	widthPx: number;
}

export interface CanvasSnapResult {
	box: CanvasBox;
	dx: number;
	dy: number;
	guides: CanvasSnapLines;
}

/**
 * Snap a moving box's left/center/right and top/middle/bottom to the nearest
 * line on each axis within the threshold. Returns the shift, the shifted box,
 * and every line the shifted box now touches.
 */
export function snapCanvasBox(
	box: CanvasBox,
	lines: CanvasSnapLines,
	options: CanvasSnapOptions
): CanvasSnapResult {
	const thresholdPx = options.thresholdPx ?? 8;
	const x = snapAxis(
		[box.left, (box.left + box.right) / 2, box.right],
		lines.x,
		options.widthPx > 0 ? thresholdPx / options.widthPx : 0
	);
	const y = snapAxis(
		[box.top, (box.top + box.bottom) / 2, box.bottom],
		lines.y,
		options.heightPx > 0 ? thresholdPx / options.heightPx : 0
	);
	return {
		box: {
			bottom: box.bottom + y.delta,
			left: box.left + x.delta,
			right: box.right + x.delta,
			top: box.top + y.delta,
		},
		dx: x.delta,
		dy: y.delta,
		guides: { x: x.guides, y: y.guides },
	};
}

/** The visible canvas guides, shared by the drag handles and the overlay. */
export interface CanvasGuideStore {
	clear: () => void;
	get: () => CanvasSnapLines;
	set: (guides: CanvasSnapLines) => void;
	subscribe: (listener: () => void) => () => void;
}

export function createCanvasGuideStore(): CanvasGuideStore {
	let guides = EMPTY_CANVAS_GUIDES;
	const listeners = new Set<() => void>();
	const publish = (next: CanvasSnapLines) => {
		if (next === guides) {
			return;
		}
		guides = next;
		for (const listener of listeners) {
			listener();
		}
	};
	return {
		clear: () => publish(EMPTY_CANVAS_GUIDES),
		get: () => guides,
		set: (next) =>
			publish(next.x.length || next.y.length ? next : EMPTY_CANVAS_GUIDES),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

const guideStores = new WeakMap<EditorStore, CanvasGuideStore>();
const detachedGuideStore = createCanvasGuideStore();

/**
 * The canvas guide store of one editor (one per `EditorStore`). A preview
 * rendered outside an editor shares a detached store.
 */
export function canvasGuideStoreFor(
	store: EditorStore | null | undefined
): CanvasGuideStore {
	if (!store) {
		return detachedGuideStore;
	}
	let guides = guideStores.get(store);
	if (!guides) {
		guides = createCanvasGuideStore();
		guideStores.set(store, guides);
	}
	return guides;
}
