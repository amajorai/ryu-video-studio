import {
	type RasterSize,
	rasterSize,
	STICKER_RASTER_EDGE,
} from "../../../shared/stickers/catalog.ts";

/** The 2D drawing surface rasterization needs (a canvas in the browser). */
export interface RasterCanvas {
	getContext(
		kind: "2d"
	): Pick<CanvasRenderingContext2D, "clearRect" | "drawImage"> | null;
	height: number;
	toBlob(callback: (blob: Blob | null) => void, type?: string): void;
	width: number;
}

export interface RasterizeDependencies {
	createCanvas: () => RasterCanvas;
	/** Read the SVG source behind a bundled sticker URL. */
	fetchSvg: (url: string) => Promise<string>;
	loadImage: (url: string) => Promise<CanvasImageSource>;
}

const ROOT_SVG = /<svg\b[^>]*>/i;
const SIZE_ATTRIBUTE = /\s(width|height)\s*=\s*(["'])[^"']*\2/gi;

/**
 * A data URL of `svg` whose root element has explicit pixel `width` and
 * `height`. Browsers disagree on the intrinsic size of an SVG that only has
 * a view box (some refuse to draw it on a canvas), so the raster size is
 * stamped on before loading. Throws when there is no `<svg>` root.
 */
export function sizedSvgDataUrl(svg: string, size: RasterSize): string {
	const root = svg.match(ROOT_SVG)?.[0];
	if (!root) {
		throw new Error("The sticker artwork is not an SVG.");
	}
	const sizedRoot = root
		.replace(SIZE_ATTRIBUTE, "")
		.replace(/^<svg\b/i, `<svg width="${size.width}" height="${size.height}"`);
	const sized = svg.replace(root, sizedRoot);
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
}

async function browserFetchSvg(url: string): Promise<string> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error("The sticker artwork could not be loaded.");
	}
	return response.text();
}

function browserLoadImage(url: string): Promise<CanvasImageSource> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.decoding = "async";
		image.onload = () => resolve(image);
		image.onerror = () =>
			reject(new Error("The sticker artwork could not be loaded."));
		image.src = url;
	});
}

const browserDependencies: RasterizeDependencies = {
	createCanvas: () => document.createElement("canvas"),
	fetchSvg: browserFetchSvg,
	loadImage: browserLoadImage,
};

/**
 * Draw an SVG sticker onto a transparent canvas at `rasterSize` and encode it
 * as PNG. The vector artwork is scaled by the canvas, so edges stay sharp at
 * 1024 px regardless of the SVG's own view box.
 */
export async function rasterizeSticker(
	url: string,
	aspect: number,
	dependencies: RasterizeDependencies = browserDependencies,
	edge: number = STICKER_RASTER_EDGE
): Promise<{ blob: Blob; size: RasterSize }> {
	const size = rasterSize(aspect, edge);
	const svg = await dependencies.fetchSvg(url);
	const image = await dependencies.loadImage(sizedSvgDataUrl(svg, size));
	const canvas = dependencies.createCanvas();
	canvas.width = size.width;
	canvas.height = size.height;
	const context = canvas.getContext("2d");
	if (!context) {
		throw new Error("This browser cannot draw stickers (no 2D canvas).");
	}
	context.clearRect(0, 0, size.width, size.height);
	context.drawImage(image, 0, 0, size.width, size.height);
	const blob = await new Promise<Blob | null>((resolve) =>
		canvas.toBlob(resolve, "image/png")
	);
	if (!blob || blob.size === 0) {
		throw new Error("The sticker could not be encoded as PNG.");
	}
	return { blob, size };
}

/** Base64 of a blob's bytes, as `/assets/import` inline sources expect. */
export async function blobToBase64(blob: Blob): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	const chunk = 0x80_00;
	for (let offset = 0; offset < bytes.length; offset += chunk) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
	}
	return btoa(binary);
}
