/**
 * Preview eyedropper (W2-V4): pick a key colour by clicking the preview.
 *
 * The colour comes from the clip's *source* frame (before keying), so a
 * keyed clip can be re-picked. A click is mapped onto the clicked media
 * element's `object-fit: contain` box (clip transforms are included through
 * the element's bounding box; rotation is approximated by that box), the
 * current `<video>`/`<img>` frame is drawn into a 2D canvas and a 3×3 average
 * around the point is read. When the frame cannot be read (no 2D canvas or a
 * tainted cross-origin frame) the caller's `inspectFrame` fallback renders
 * the composite through `inspect-frame` and samples it at the same place on
 * the preview frame.
 */
import { type Rgb, rgbToHex } from "../../../shared/keying.ts";

export interface NormalizedPoint {
	x: number;
	y: number;
}

export interface Box {
	height: number;
	left: number;
	top: number;
	width: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** The box an `object-fit: contain` medium of `width`×`height` fills in `box`. */
export function containBox(box: Box, width: number, height: number): Box {
	if (!(width > 0 && height > 0 && box.width > 0 && box.height > 0)) {
		return box;
	}
	const scale = Math.min(box.width / width, box.height / height);
	const fitted = { height: height * scale, width: width * scale };
	return {
		height: fitted.height,
		left: box.left + (box.width - fitted.width) / 2,
		top: box.top + (box.height - fitted.height) / 2,
		width: fitted.width,
	};
}

/** `clientX/Y` as 0..1 coordinates inside `box`, or null when outside it. */
export function normalizedPoint(
	box: Box,
	clientX: number,
	clientY: number
): NormalizedPoint | null {
	if (!(box.width > 0 && box.height > 0)) {
		return null;
	}
	const x = (clientX - box.left) / box.width;
	const y = (clientY - box.top) / box.height;
	if (x < 0 || x > 1 || y < 0 || y > 1) {
		return null;
	}
	return { x, y };
}

/**
 * Average RGBA `data` (row-major, 4 bytes per pixel) over a square of
 * `radius` pixels around a normalized point, ignoring transparent pixels
 * unless every sampled pixel is transparent.
 */
export function averagePixel(
	data: ArrayLike<number>,
	width: number,
	height: number,
	point: NormalizedPoint,
	radius = 1
): Rgb {
	const centerX = Math.min(width - 1, Math.floor(clamp01(point.x) * width));
	const centerY = Math.min(height - 1, Math.floor(clamp01(point.y) * height));
	const totals = [0, 0, 0];
	let count = 0;
	const fallback = [0, 0, 0];
	let fallbackCount = 0;
	for (let y = centerY - radius; y <= centerY + radius; y++) {
		for (let x = centerX - radius; x <= centerX + radius; x++) {
			if (x < 0 || y < 0 || x >= width || y >= height) {
				continue;
			}
			const offset = (y * width + x) * 4;
			const channels = [
				data[offset] ?? 0,
				data[offset + 1] ?? 0,
				data[offset + 2] ?? 0,
			];
			const opaque = (data[offset + 3] ?? 255) > 0;
			const target = opaque ? totals : fallback;
			for (const [index, value] of channels.entries()) {
				target[index] = (target[index] ?? 0) + value;
			}
			if (opaque) {
				count++;
			} else {
				fallbackCount++;
			}
		}
	}
	const [sums, samples] =
		count > 0 ? [totals, count] : [fallback, fallbackCount];
	if (samples === 0) {
		return [0, 0, 0];
	}
	return [
		Math.round((sums[0] ?? 0) / samples),
		Math.round((sums[1] ?? 0) / samples),
		Math.round((sums[2] ?? 0) / samples),
	];
}

export type EyedropperMedia = HTMLVideoElement | HTMLImageElement;

const isMedia = (element: Element | null): element is EyedropperMedia =>
	element instanceof HTMLVideoElement || element instanceof HTMLImageElement;

/**
 * The media element behind a clicked preview layer: the `<video>`/`<img>`
 * itself, or for a WebGL canvas (which hides its media while it draws) the
 * nearest preceding media sibling it draws from.
 */
export function eyedropperSource(
	element: Element | null
): EyedropperMedia | null {
	if (isMedia(element)) {
		return element;
	}
	if (!(element instanceof HTMLCanvasElement)) {
		return null;
	}
	let sibling = element.previousElementSibling;
	while (sibling) {
		if (isMedia(sibling)) {
			return sibling;
		}
		sibling = sibling.previousElementSibling;
	}
	return null;
}

/** Accessible name the preview gives a clip's media, canvas or image. */
function layerLabel(element: Element): string | null {
	return element instanceof HTMLImageElement
		? element.alt
		: element.getAttribute("aria-label");
}

export interface MediaHit {
	/** The clicked layer (media or WebGL canvas) whose box maps the point. */
	layer: Element;
	source: EyedropperMedia;
}

/**
 * The topmost preview media layer under a point, preferring the layer whose
 * label is `label` (the inspected clip's asset name) so a clip below other
 * layers can still be sampled.
 */
export function hitMediaLayer(
	elements: readonly Element[],
	label?: string
): MediaHit | null {
	let first: MediaHit | null = null;
	for (const element of elements) {
		if (!element.classList.contains("studio-media-layer")) {
			continue;
		}
		const source = eyedropperSource(element);
		if (!source) {
			continue;
		}
		const hit = { layer: element, source };
		if (label === undefined || layerLabel(element) === label) {
			return hit;
		}
		first ??= hit;
	}
	return first;
}

/** Intrinsic pixel size of a media element (0×0 before it has a frame). */
export function mediaSize(source: EyedropperMedia): {
	height: number;
	width: number;
} {
	return source instanceof HTMLVideoElement
		? { height: source.videoHeight, width: source.videoWidth }
		: { height: source.naturalHeight, width: source.naturalWidth };
}

function context2d(width: number, height: number) {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	return canvas.getContext("2d", { willReadFrequently: true });
}

/**
 * Read the source frame of a media element at a normalized point. Throws
 * when the frame cannot be read (no frame yet, no 2D canvas, or a tainted
 * cross-origin frame).
 */
export function sampleMedia(
	source: EyedropperMedia,
	point: NormalizedPoint
): Rgb {
	const { height, width } = mediaSize(source);
	if (!(width > 0 && height > 0)) {
		throw new Error("The clip has no frame to sample yet.");
	}
	const context = context2d(width, height);
	if (!context) {
		throw new Error("This preview cannot read pixels.");
	}
	context.drawImage(source, 0, 0, width, height);
	const x = Math.min(width - 1, Math.floor(point.x * width));
	const y = Math.min(height - 1, Math.floor(point.y * height));
	const left = Math.max(0, x - 1);
	const top = Math.max(0, y - 1);
	const right = Math.min(width, x + 2);
	const bottom = Math.min(height, y + 2);
	const region = context.getImageData(left, top, right - left, bottom - top);
	return averagePixel(
		region.data,
		region.width,
		region.height,
		{
			x: (x - left + 0.5) / region.width,
			y: (y - top + 0.5) / region.height,
		},
		1
	);
}

/** A base64 PNG frame, as `GET /projects/:id/inspect-frame` returns it. */
export interface InspectedFrame {
	data: string;
	height: number;
	width: number;
}

/** Sample a rendered PNG frame at a normalized point. */
export async function sampleFrame(
	frame: InspectedFrame,
	point: NormalizedPoint
): Promise<Rgb> {
	const bytes = Uint8Array.from(atob(frame.data), (char) => char.charCodeAt(0));
	const bitmap = await createImageBitmap(
		new Blob([bytes], { type: "image/png" })
	);
	try {
		const context = context2d(bitmap.width, bitmap.height);
		if (!context) {
			throw new Error("This preview cannot read pixels.");
		}
		context.drawImage(bitmap, 0, 0);
		const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
		return averagePixel(pixels.data, pixels.width, pixels.height, point);
	} finally {
		bitmap.close();
	}
}

export interface PickOptions {
	clientX: number;
	clientY: number;
	/** Elements under the point, topmost first (`document.elementsFromPoint`). */
	elements: readonly Element[];
	/** Render the composite frame when the source cannot be read. */
	inspectFrame?: () => Promise<InspectedFrame>;
	/** Label of the inspected clip's layers (its asset name). */
	label?: string;
}

/**
 * The `#rrggbb` colour under a preview click. Tries the clip's source frame
 * first, then the `inspectFrame` fallback mapped through the preview frame.
 */
export async function pickPreviewColor(options: PickOptions): Promise<string> {
	const { clientX, clientY, elements, inspectFrame, label } = options;
	const hit = hitMediaLayer(elements, label);
	let failure: unknown;
	if (hit) {
		const size = mediaSize(hit.source);
		const point = normalizedPoint(
			containBox(hit.layer.getBoundingClientRect(), size.width, size.height),
			clientX,
			clientY
		);
		if (point) {
			try {
				return rgbToHex(sampleMedia(hit.source, point));
			} catch (error) {
				failure = error;
			}
		}
	}
	const frame = elements.find((element) =>
		element.classList.contains("studio-preview-frame")
	);
	const framePoint = frame
		? normalizedPoint(frame.getBoundingClientRect(), clientX, clientY)
		: null;
	if (inspectFrame && framePoint) {
		return rgbToHex(await sampleFrame(await inspectFrame(), framePoint));
	}
	if (failure instanceof Error) {
		throw failure;
	}
	throw new Error("Click the clip in the preview to pick a key color.");
}

/**
 * Arm a one-shot eyedropper: the next primary click on the preview frame is
 * captured (so it does not also select or drag) and resolved to a colour;
 * Escape or a click elsewhere cancels. Returns a disarm function.
 */
/**
 * Mark the button that arms and cancels the eyedropper with this attribute:
 * presses on it are left to its own click handler instead of cancelling.
 */
export const EYEDROPPER_TOGGLE_ATTRIBUTE = "data-eyedropper-toggle";

export function armEyedropper(
	handlers: {
		inspectFrame?: () => Promise<InspectedFrame>;
		label?: string;
		onCancel: () => void;
		onError: (message: string) => void;
		onPick: (hex: string) => void;
	},
	target: Document = document
): () => void {
	let armed = true;
	const disarm = () => {
		if (!armed) {
			return;
		}
		armed = false;
		target.removeEventListener("pointerdown", pointer, true);
		target.removeEventListener("keydown", key, true);
	};
	function key(event: KeyboardEvent) {
		if (event.key === "Escape") {
			event.preventDefault();
			disarm();
			handlers.onCancel();
		}
	}
	function pointer(event: PointerEvent) {
		if (event.button !== 0) {
			return;
		}
		// The control that armed the eyedropper toggles it itself; treating
		// its press as a cancel would let the following click re-arm it.
		const origin = event.target;
		if (
			origin instanceof Element &&
			origin.closest(`[${EYEDROPPER_TOGGLE_ATTRIBUTE}]`)
		) {
			return;
		}
		const elements = target.elementsFromPoint(event.clientX, event.clientY);
		disarm();
		if (
			!elements.some((element) =>
				element.classList.contains("studio-preview-frame")
			)
		) {
			handlers.onCancel();
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		pickPreviewColor({
			clientX: event.clientX,
			clientY: event.clientY,
			elements,
			inspectFrame: handlers.inspectFrame,
			label: handlers.label,
		})
			.then(handlers.onPick)
			.catch((error: unknown) =>
				handlers.onError(
					error instanceof Error
						? error.message
						: "The color could not be read."
				)
			);
	}
	target.addEventListener("pointerdown", pointer, true);
	target.addEventListener("keydown", key, true);
	return disarm;
}
