/**
 * Clip masks for the blend compositor, rasterized to canvases whose alpha is
 * the product of the clip's masks.
 *
 * Masks are SVG and SVG images decode asynchronously, so a mask the
 * compositor has not drawn before is not ready on the frame it is first
 * needed. An animated mask (keyframed position, size, feather) is a new SVG
 * on every playback frame, so waiting for the exact raster would never
 * draw. Each clip therefore keeps its last ready raster and draws with it
 * while the current one loads, with at most one load in flight per clip:
 * an animated mask trails the picture by the time an SVG takes to decode
 * while playing, and a paused frame redraws with the exact mask once it is
 * ready (`onReady`).
 */
import type { CompositorMask } from "./plan.ts";

/** Longest edge a mask is rasterized at. */
const MASK_RASTER_LIMIT = 1024;
/** Exact rasters kept for reuse (scrubbing back over the same frames). */
const MASK_CACHE_LIMIT = 32;

export interface MaskFrame {
	height: number;
	width: number;
}

/** Draws a clip's masks into one raster; rejects when one cannot be drawn. */
export type MaskRasterizer<Raster> = (
	frame: MaskFrame,
	masks: readonly CompositorMask[]
) => Promise<Raster>;

export interface MaskRaster<Raster> {
	/**
	 * How old the mask is: milliseconds since the frame that asked for it
	 * (zero when exact). An animated mask that keeps decoding stays a little
	 * behind but never old; a stalled load ages.
	 */
	age: number;
	/** False while the clip's current mask is still loading and this is its previous one. */
	exact: boolean;
	raster: Raster;
}

export class MaskRasters<Raster> {
	readonly #cache = new Map<string, Raster>();
	/** Per clip: the last raster that finished loading, and when it was asked for. */
	readonly #latest = new Map<string, { raster: Raster; requestedAt: number }>();
	/** Per clip: the key of the one raster loading now. */
	readonly #loading = new Map<string, string>();
	/** Keys whose masks failed to draw (not retried). */
	readonly #failed = new Set<string>();
	readonly #onReady: () => void;
	readonly #rasterize: MaskRasterizer<Raster>;

	constructor(onReady: () => void, rasterize: MaskRasterizer<Raster>) {
		this.#onReady = onReady;
		this.#rasterize = rasterize;
	}

	/**
	 * The clip's mask raster for `masks`: exact when it is ready, else the
	 * clip's previous raster while the new one loads, else null (the clip has
	 * never had a ready mask).
	 */
	get(
		segmentId: string,
		frame: MaskFrame,
		masks: readonly CompositorMask[],
		/** Clock for `age`, in milliseconds. */
		now: number
	): MaskRaster<Raster> | null {
		const key = JSON.stringify([frame, masks]);
		const ready = this.#cache.get(key);
		if (ready !== undefined) {
			// Refresh its place in the cache.
			this.#cache.delete(key);
			this.#cache.set(key, ready);
			this.#latest.set(segmentId, { raster: ready, requestedAt: now });
			return { age: 0, exact: true, raster: ready };
		}
		if (!(this.#loading.has(segmentId) || this.#failed.has(key))) {
			this.#load(segmentId, key, frame, masks, now);
		}
		const previous = this.#latest.get(segmentId);
		return previous === undefined
			? null
			: {
					age: now - previous.requestedAt,
					exact: false,
					raster: previous.raster,
				};
	}

	/** Forget the clips that left the frame. */
	retain(segmentIds: ReadonlySet<string>): void {
		for (const segmentId of this.#latest.keys()) {
			if (!segmentIds.has(segmentId)) {
				this.#latest.delete(segmentId);
			}
		}
	}

	#load(
		segmentId: string,
		key: string,
		frame: MaskFrame,
		masks: readonly CompositorMask[],
		requestedAt: number
	) {
		this.#loading.set(segmentId, key);
		this.#rasterize(frame, masks)
			.then((raster) => {
				if (this.#cache.size >= MASK_CACHE_LIMIT) {
					const oldest = this.#cache.keys().next().value;
					if (oldest !== undefined) {
						this.#cache.delete(oldest);
					}
				}
				this.#cache.set(key, raster);
				this.#latest.set(segmentId, { raster, requestedAt });
			})
			.catch(() => {
				this.#failed.add(key);
			})
			.finally(() => {
				this.#loading.delete(segmentId);
				// Draw again: with this raster, or to load the clip's newer mask.
				this.#onReady();
			});
	}
}

function loadSvg(svg: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error("A clip mask could not be drawn."));
		image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
	});
}

/** The browser rasterizer: every mask SVG drawn into one canvas, multiplied. */
export async function rasterizeMasks(
	frame: MaskFrame,
	masks: readonly CompositorMask[]
): Promise<HTMLCanvasElement> {
	const images = await Promise.all(masks.map((mask) => loadSvg(mask.svg)));
	const scale = Math.min(
		1,
		MASK_RASTER_LIMIT / Math.max(frame.width, frame.height)
	);
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(frame.width * scale));
	canvas.height = Math.max(1, Math.round(frame.height * scale));
	const context = canvas.getContext("2d");
	if (!context) {
		throw new Error("A clip mask could not be drawn.");
	}
	for (const [index, image] of images.entries()) {
		const pad = (masks[index]?.pad ?? 0) * scale;
		// Overlapping masks multiply, like the render.
		context.globalCompositeOperation =
			index === 0 ? "source-over" : "destination-in";
		context.drawImage(
			image,
			-pad,
			-pad,
			frame.width * scale + 2 * pad,
			frame.height * scale + 2 * pad
		);
	}
	return canvas;
}
