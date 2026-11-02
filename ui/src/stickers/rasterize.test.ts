import { describe, expect, test } from "bun:test";
import {
	rasterSize,
	STICKER_RASTER_EDGE,
} from "../../../shared/stickers/catalog.ts";
import {
	blobToBase64,
	type RasterCanvas,
	rasterizeSticker,
	sizedSvgDataUrl,
} from "./rasterize.ts";

function fakeCanvas(output: Blob | null) {
	const draws: number[][] = [];
	const canvas: RasterCanvas & { draws: number[][]; type?: string } = {
		draws,
		getContext: () => ({
			clearRect: () => undefined,
			drawImage: (...args: unknown[]) => {
				draws.push(args.slice(1).map(Number));
			},
		}),
		height: 0,
		toBlob(callback, type) {
			canvas.type = type;
			callback(output);
		},
		width: 0,
	};
	return canvas;
}

const image = {} as CanvasImageSource;

describe("rasterSize", () => {
	test("square artwork rasterizes to 1024 x 1024", () => {
		expect(STICKER_RASTER_EDGE).toBe(1024);
		expect(rasterSize(1)).toEqual({ height: 1024, width: 1024 });
	});

	test("the longest edge is 1024 and the aspect is kept", () => {
		expect(rasterSize(4 / 3)).toEqual({ height: 768, width: 1024 });
		expect(rasterSize(0.5)).toEqual({ height: 1024, width: 512 });
		expect(rasterSize(180 / 56)).toEqual({ height: 319, width: 1024 });
	});

	test("invalid aspects fall back to square, tiny edges to 1 px", () => {
		expect(rasterSize(Number.NaN)).toEqual({ height: 1024, width: 1024 });
		expect(rasterSize(0)).toEqual({ height: 1024, width: 1024 });
		expect(rasterSize(1000, 4)).toEqual({ height: 1, width: 4 });
	});
});

describe("rasterizeSticker", () => {
	test("draws the SVG scaled to the raster size and encodes PNG", async () => {
		const png = new Blob([new Uint8Array([137, 80, 78, 71])], {
			type: "image/png",
		});
		const canvas = fakeCanvas(png);
		const loaded: string[] = [];
		const fetched: string[] = [];
		const result = await rasterizeSticker("bundled.svg", 4 / 3, {
			createCanvas: () => canvas,
			fetchSvg: (url) => {
				fetched.push(url);
				return Promise.resolve('<svg viewBox="0 0 640 480"><path/></svg>');
			},
			loadImage: (url) => {
				loaded.push(url);
				return Promise.resolve(image);
			},
		});
		expect(fetched).toEqual(["bundled.svg"]);
		expect(loaded).toEqual([
			sizedSvgDataUrl('<svg viewBox="0 0 640 480"><path/></svg>', {
				height: 768,
				width: 1024,
			}),
		]);
		expect(result.size).toEqual({ height: 768, width: 1024 });
		expect(canvas.width).toBe(1024);
		expect(canvas.height).toBe(768);
		expect(canvas.draws).toEqual([[0, 0, 1024, 768]]);
		expect(canvas.type).toBe("image/png");
		expect(result.blob).toBe(png);
	});

	test("fails clearly when encoding or the 2D context is unavailable", async () => {
		await expect(
			rasterizeSticker("u", 1, {
				createCanvas: () => fakeCanvas(null),
				fetchSvg: () => Promise.resolve("<svg/>"),
				loadImage: () => Promise.resolve(image),
			})
		).rejects.toThrow("could not be encoded");
		await expect(
			rasterizeSticker("u", 1, {
				createCanvas: () => ({ ...fakeCanvas(null), getContext: () => null }),
				fetchSvg: () => Promise.resolve("<svg/>"),
				loadImage: () => Promise.resolve(image),
			})
		).rejects.toThrow("no 2D canvas");
	});
});

describe("sizedSvgDataUrl", () => {
	const decode = (url: string) =>
		decodeURIComponent(url.replace("data:image/svg+xml;charset=utf-8,", ""));

	test("stamps the raster size on a view-box-only root", () => {
		expect(
			decode(
				sizedSvgDataUrl(
					'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><circle r="1"/></svg>',
					{ height: 1024, width: 1024 }
				)
			)
		).toBe(
			'<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><circle r="1"/></svg>'
		);
	});

	test("replaces existing root sizes but leaves children alone", () => {
		expect(
			decode(
				sizedSvgDataUrl(
					'<svg width=\'10\' height="5" viewBox="0 0 2 1"><rect width="2" height="1"/></svg>',
					{ height: 512, width: 1024 }
				)
			)
		).toBe(
			'<svg width="1024" height="512" viewBox="0 0 2 1"><rect width="2" height="1"/></svg>'
		);
	});

	test("rejects non-SVG input", () => {
		expect(() => sizedSvgDataUrl("<html/>", { height: 1, width: 1 })).toThrow(
			"not an SVG"
		);
	});
});

test("blobToBase64 encodes bytes, including large blobs", async () => {
	expect(await blobToBase64(new Blob([new Uint8Array([0, 255, 16])]))).toBe(
		"AP8Q"
	);
	const large = new Uint8Array(100_000).map((_, index) => index % 251);
	const encoded = await blobToBase64(new Blob([large]));
	expect(Buffer.from(encoded, "base64").equals(Buffer.from(large))).toBe(true);
});
