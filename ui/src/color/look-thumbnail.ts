/**
 * Look thumbnails (W2-V5): grade one small decoded frame on the CPU with
 * `compileGrade`, once per look, so the looks panel shows each look without
 * a render per look. The frame should be rendered with the target clip's
 * grade neutralized (`inspect-frame?ungraded=`), because applying a look
 * replaces that grade; only the clip's LUT carries over.
 */
import { compileGrade } from "../../../shared/color-advanced.ts";
import { gradeWithLook, type LookId } from "../../../shared/color-looks.ts";
import type { CubeLut } from "../../../shared/cube-lut.ts";
import type { ColorGrade } from "../../../shared/schema/color.ts";

/** The clip a look will replace the grade of: its grade (for its LUT reference) and the loaded LUT. */
export interface LookBase {
	grade: ColorGrade;
	lut: CubeLut | null;
}

const neutralBase: LookBase = {
	grade: { exposure: 0, temperature: 0, tint: 0, vibrance: 0 },
	lut: null,
};

/** Width of a look thumbnail in pixels (the height follows the frame). */
export const THUMBNAIL_WIDTH = 96;

/** Brightness offset matching the render's `eq` (exposure / 3). */
const exposureOffset = (exposure: number) => exposure / 3;

/**
 * Grade RGBA pixels with a look at `intensity`, as it would replace
 * `base.grade`. The basic grade is applied like the render's
 * `eq`/`colorbalance` (exposure, vibrance, temperature, tint), then the
 * advanced grade and the clip's LUT.
 */
export function gradePixels(
	pixels: Uint8ClampedArray,
	lookId: LookId,
	intensity = 1,
	base: LookBase = neutralBase
): Uint8ClampedArray<ArrayBuffer> {
	// Exactly what applying the look stores: the look's grade plus the
	// clip's LUT reference (graded with the LUT when it is loaded).
	const grade = gradeWithLook(base.grade, lookId, intensity);
	const advanced = compileGrade(grade, base.lut);
	const brightness = exposureOffset(grade.exposure);
	const saturation = 1 + grade.vibrance * 0.5;
	const out = new Uint8ClampedArray(new ArrayBuffer(pixels.length));
	for (let offset = 0; offset < pixels.length; offset += 4) {
		let r = (pixels[offset] ?? 0) / 255 + brightness;
		let g = (pixels[offset + 1] ?? 0) / 255 + brightness;
		let b = (pixels[offset + 2] ?? 0) / 255 + brightness;
		const luma = 0.299 * r + 0.587 * g + 0.114 * b;
		r = luma + (r - luma) * saturation + grade.temperature * 0.1;
		g = luma + (g - luma) * saturation + grade.tint * 0.1;
		b = luma + (b - luma) * saturation - grade.temperature * 0.1;
		const clamp = (value: number) => Math.min(1, Math.max(0, value));
		const [gr, gg, gb] = advanced([clamp(r), clamp(g), clamp(b)]);
		out[offset] = Math.round(gr * 255);
		out[offset + 1] = Math.round(gg * 255);
		out[offset + 2] = Math.round(gb * 255);
		out[offset + 3] = pixels[offset + 3] ?? 255;
	}
	return out;
}

function canvas(width: number, height: number) {
	if (typeof document === "undefined") {
		return null;
	}
	const element = document.createElement("canvas");
	element.width = width;
	element.height = height;
	const context = element.getContext("2d");
	return context ? { context, element } : null;
}

/**
 * Data URLs of a base64 PNG frame graded by each look, or null when this
 * webview cannot decode or draw images.
 */
export async function lookThumbnails(
	pngBase64: string,
	lookIds: readonly LookId[],
	intensity = 1,
	base: LookBase = neutralBase
): Promise<Map<LookId, string> | null> {
	if (typeof createImageBitmap !== "function") {
		return null;
	}
	const bytes = Uint8Array.from(atob(pngBase64), (char) => char.charCodeAt(0));
	const bitmap = await createImageBitmap(
		new Blob([bytes], { type: "image/png" })
	);
	try {
		const height = Math.max(
			1,
			Math.round((bitmap.height / bitmap.width) * THUMBNAIL_WIDTH)
		);
		const target = canvas(THUMBNAIL_WIDTH, height);
		if (!target) {
			return null;
		}
		target.context.drawImage(bitmap, 0, 0, THUMBNAIL_WIDTH, height);
		const source = target.context.getImageData(0, 0, THUMBNAIL_WIDTH, height);
		const thumbnails = new Map<LookId, string>();
		for (const id of lookIds) {
			const graded = new ImageData(
				gradePixels(source.data, id, intensity, base),
				THUMBNAIL_WIDTH,
				height
			);
			target.context.putImageData(graded, 0, 0);
			thumbnails.set(id, target.element.toDataURL("image/png"));
		}
		return thumbnails;
	} finally {
		bitmap.close();
	}
}
