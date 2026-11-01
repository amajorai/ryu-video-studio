/**
 * AI subject matting (G46). A cloud segmentation model returns a matte for a
 * still or a clip; the sidecar keeps it as library media and applies it to
 * the source with FFmpeg `alphamerge`, writing a transparent derivative
 * (`derivation: "ai-matte"`) that clips can swap onto. The matte is read as
 * a luma matte (white keeps, black removes), or from its alpha channel when
 * the model returned a cutout with transparency, so either provider output
 * works. Clip masks (G44) still apply on top of the derivative.
 *
 * Body effects that need pose tracking stay out of scope: no provider in
 * Ryu offers pose data.
 */
import { z } from "zod";
import type { Asset } from "./project.ts";
import { idSchema } from "./project.ts";

export const aiMatteRequestSchema = z
	.object({
		/** The model's matte (an image for stills, a video for clips). */
		matteAssetId: idSchema,
		/**
		 * Source seconds the matte covers, for video. The model only saw this
		 * range (input clips are capped at 10 s), so the derivative covers it.
		 */
		start: z.number().finite().min(0).default(0),
		end: z.number().finite().positive().optional(),
		/** Keep the background instead of the subject. */
		invert: z.boolean().default(false),
		name: z.string().trim().min(1).max(200).optional(),
	})
	.strict();
export type AiMatteRequest = z.infer<typeof aiMatteRequestSchema>;
export type AiMatteInput = z.input<typeof aiMatteRequestSchema>;

/** How the matte's coverage is read. */
export type MatteSource = "alpha" | "luma";

/** Pixel formats whose alpha channel carries the matte. */
export function pixelFormatHasAlpha(pixelFormat: string): boolean {
	const format = pixelFormat.trim().toLowerCase();
	return (
		/^(?:rgba|bgra|argb|abgr|ya8|ya16|yuva|gbrap|rgba64|bgra64)/.test(format) ||
		format.startsWith("pal8")
	);
}

/** Refuse source and matte pairs that cannot be combined. */
export function assertAiMattePair(
	source: Pick<Asset, "derivation" | "duration" | "kind" | "sequenceProjectId">,
	matte: Pick<Asset, "duration" | "kind">,
	request: Pick<AiMatteRequest, "end" | "start">
): { end: number; start: number } {
	if (source.sequenceProjectId) {
		throw new Error("Refresh nested sequences as media before matting them.");
	}
	if (source.kind === "audio") {
		throw new Error("AI matting needs a picture clip.");
	}
	if (source.derivation === "ai-matte") {
		throw new Error("This media is already matted.");
	}
	if (source.kind === "image") {
		if (matte.kind !== "image") {
			throw new Error("A still needs a still matte.");
		}
		return { end: 0, start: 0 };
	}
	if (matte.kind !== "video") {
		throw new Error(
			"A video clip needs a matte video from a video matting model."
		);
	}
	const start = Math.min(request.start, source.duration);
	const end = Math.min(
		request.end ?? start + matte.duration,
		start + matte.duration,
		source.duration
	);
	if (!(end - start >= 0.04)) {
		throw new Error("The matte does not cover any of this clip.");
	}
	return { end, start };
}

/**
 * Filtergraph that turns the matte (input 1) into a grey coverage plane the
 * size of the source (input 0) and merges it as the source's alpha.
 */
export function aiMatteFilterGraph(input: {
	height: number;
	invert: boolean;
	source: MatteSource;
	video: boolean;
	width: number;
}): string {
	const coverage = [
		input.source === "alpha" ? "format=rgba,alphaextract" : "format=gray",
		`scale=${input.width}:${input.height}:flags=bicubic`,
		...(input.invert ? ["negate"] : []),
		"format=gray",
		...(input.video ? ["setpts=PTS-STARTPTS"] : []),
	].join(",");
	const base = input.video
		? "setpts=PTS-STARTPTS,format=yuva444p"
		: "format=rgba";
	return [
		`[0:v]${base}[base]`,
		`[1:v]${coverage}[matte]`,
		`[base][matte]alphamerge${input.video ? ",format=yuva444p10le" : ""}[out]`,
	].join(";");
}
