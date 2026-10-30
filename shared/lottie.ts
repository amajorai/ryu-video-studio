import { z } from "zod";
import { assetSchema } from "./project.ts";
import { idSchema } from "./schema/primitives.ts";

/**
 * Lottie import (G60). The editor renders a Lottie JSON frame by frame at the
 * project frame rate, uploads the PNG frames in ordered chunks, and the
 * sidecar encodes them into a ProRes 4444 video with alpha
 * (`derivation: "lottie"`). Everything here is pure so the editor and the
 * sidecar enforce the same bounds.
 */

/** Largest Lottie JSON the editor reads, in bytes. */
export const LOTTIE_MAX_JSON_BYTES = 5 * 1024 * 1024;
/** Most frames one import may produce. */
export const LOTTIE_MAX_FRAMES = 600;
/** Longest rendered edge, in pixels; larger animations are scaled down. */
export const LOTTIE_MAX_EDGE = 1920;
/** Most frames one upload request carries. */
export const LOTTIE_MAX_CHUNK_FRAMES = 50;
/**
 * Base64 characters one upload request may carry in total. The sidecar caps
 * request bodies at 2 MiB, so a chunk stays well under that with JSON framing.
 */
export const LOTTIE_MAX_CHUNK_CHARS = 1_500_000;
/** Largest decoded PNG frame, in bytes (one frame must fit one request). */
export const LOTTIE_MAX_FRAME_BYTES = Math.floor(
	(LOTTIE_MAX_CHUNK_CHARS * 3) / 4
);
/** Highest source frame rate accepted from a Lottie document. */
const MAX_SOURCE_FPS = 240;

const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;

const lottieImageAssetSchema = z.looseObject({
	e: z.union([z.literal(0), z.literal(1)]).optional(),
	p: z.string().optional(),
	u: z.string().optional(),
});

const lottieFontSchema = z.looseObject({
	fPath: z.string().optional(),
	origin: z.number().optional(),
});

/** The fields of a Lottie (Bodymovin) document the import relies on. */
export const lottieDocumentSchema = z.looseObject({
	assets: z.array(lottieImageAssetSchema).max(10_000).optional(),
	fonts: z
		.looseObject({ list: z.array(lottieFontSchema).max(1000).optional() })
		.optional(),
	fr: z.number().finite().positive().max(MAX_SOURCE_FPS),
	h: z.number().finite().positive().max(16_384),
	ip: z.number().finite(),
	layers: z.array(z.unknown()).max(10_000),
	op: z.number().finite(),
	v: z.string().max(40).optional(),
	w: z.number().finite().positive().max(16_384),
});
export type LottieDocument = z.infer<typeof lottieDocumentSchema>;

/** True when an image asset is embedded as a data URI. */
function embeddedImage(asset: z.infer<typeof lottieImageAssetSchema>): boolean {
	return asset.p === undefined || asset.p.startsWith("data:image/");
}

/**
 * Parse and check a Lottie JSON document. External image files and remote
 * fonts are refused: the import never fetches anything the user did not
 * pick, so every asset must be embedded in the JSON.
 */
export function parseLottieDocument(text: string): LottieDocument {
	if (new TextEncoder().encode(text).byteLength > LOTTIE_MAX_JSON_BYTES) {
		throw new Error("Lottie files must be 5 MB or smaller.");
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error("This file is not valid Lottie JSON.");
	}
	const parsed = lottieDocumentSchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(
			"This file is not a Lottie animation (it needs fr, ip, op, w, h and layers)."
		);
	}
	const document = parsed.data;
	if (document.op <= document.ip) {
		throw new Error("This Lottie animation has no frames.");
	}
	if (!(document.assets ?? []).every(embeddedImage)) {
		throw new Error(
			"This Lottie animation links external images. Export it with images embedded."
		);
	}
	if ((document.fonts?.list ?? []).some((font) => font.fPath?.trim())) {
		throw new Error(
			"This Lottie animation loads remote fonts. Convert its text to shapes first."
		);
	}
	return document;
}

export interface LottieImportPlan {
	/** Output duration in seconds (`frameCount / fps`). */
	duration: number;
	/** Output frame rate: the project frame rate. */
	fps: number;
	frameCount: number;
	/** Output height in pixels (even, at most 1920). */
	height: number;
	/** First Lottie frame. */
	inPoint: number;
	/** Lottie frame where the animation ends (exclusive). */
	outPoint: number;
	/** Lottie frames per second. */
	sourceFps: number;
	/** Output width in pixels (even, at most 1920). */
	width: number;
}

function evenEdge(value: number): number {
	return Math.max(2, Math.round(value / 2) * 2);
}

/** Output size: the Lottie canvas scaled to fit 1920 px, rounded to even pixels. */
export function lottieOutputSize(
	width: number,
	height: number
): { height: number; width: number } {
	const scale = Math.min(1, LOTTIE_MAX_EDGE / Math.max(width, height));
	return {
		height: Math.min(LOTTIE_MAX_EDGE, evenEdge(height * scale)),
		width: Math.min(LOTTIE_MAX_EDGE, evenEdge(width * scale)),
	};
}

/**
 * Plan an import at the project frame rate. Throws when the animation would
 * need more than 600 output frames.
 */
export function planLottieImport(
	document: Pick<LottieDocument, "fr" | "h" | "ip" | "op" | "w">,
	projectFps: number
): LottieImportPlan {
	if (!(Number.isFinite(projectFps) && projectFps > 0)) {
		throw new Error("The project frame rate is invalid.");
	}
	const seconds = (document.op - document.ip) / document.fr;
	const frameCount = Math.max(1, Math.round(seconds * projectFps));
	if (frameCount > LOTTIE_MAX_FRAMES) {
		throw new Error(
			`This Lottie animation needs ${frameCount} frames at ${projectFps} fps; the limit is ${LOTTIE_MAX_FRAMES}.`
		);
	}
	return {
		...lottieOutputSize(document.w, document.h),
		duration: frameCount / projectFps,
		fps: projectFps,
		frameCount,
		inPoint: document.ip,
		outPoint: document.op,
		sourceFps: document.fr,
	};
}

/** The Lottie frame shown at output frame `index`, never past the out point. */
export function lottieSourceFrame(
	plan: Pick<LottieImportPlan, "fps" | "inPoint" | "outPoint" | "sourceFps">,
	index: number
): number {
	const frame = plan.inPoint + (index * plan.sourceFps) / plan.fps;
	return Math.min(frame, Math.max(plan.inPoint, plan.outPoint - 1));
}

/**
 * The frame value lottie-web's `goToAndStop(value, true)` needs to draw the
 * absolute Lottie frame `sourceFrame`. lottie-web counts frames from the
 * animation's in point (it draws `value + round(ip)`), so an absolute frame
 * passed straight through would be offset by `ip`.
 */
export function lottiePlayerFrame(
	inPoint: number,
	sourceFrame: number
): number {
	return Math.max(0, sourceFrame - Math.round(inPoint));
}

/**
 * Whether adding a frame of `nextChars` base64 characters to a pending chunk
 * of `frames` frames and `chars` characters would exceed a request's limits.
 */
export function lottieChunkFull(
	pending: { chars: number; frames: number },
	nextChars: number
): boolean {
	return (
		pending.frames > 0 &&
		(pending.frames + 1 > LOTTIE_MAX_CHUNK_FRAMES ||
			pending.chars + nextChars > LOTTIE_MAX_CHUNK_CHARS)
	);
}

/** FFmpeg `-framerate` value: integers verbatim, NTSC rates as `N/1001`. */
export function lottieFrameRateArgument(fps: number): string {
	if (Number.isInteger(fps)) {
		return String(fps);
	}
	return `${Math.round(fps * 1001)}/1001`;
}

export const lottieMetaSchema = z
	.object({
		fps: z.number().finite().positive().max(120),
		frameCount: z.number().int().min(1).max(LOTTIE_MAX_FRAMES),
		height: z.number().int().min(2).max(LOTTIE_MAX_EDGE).multipleOf(2),
		name: z.string().trim().min(1).max(200),
		width: z.number().int().min(2).max(LOTTIE_MAX_EDGE).multipleOf(2),
	})
	.strict();
export type LottieMeta = z.infer<typeof lottieMetaSchema>;

/**
 * One ordered chunk of PNG frames. The first chunk (`index` 0) carries
 * `meta` and opens the session; later chunks must continue exactly where
 * the previous one ended.
 */
export const lottieFramesRequestSchema = z
	.object({
		frames: z
			.array(z.string().min(1).max(LOTTIE_MAX_CHUNK_CHARS).regex(base64Pattern))
			.min(1)
			.max(LOTTIE_MAX_CHUNK_FRAMES),
		index: z
			.number()
			.int()
			.min(0)
			.max(LOTTIE_MAX_FRAMES - 1),
		meta: lottieMetaSchema.optional(),
		sessionId: idSchema,
	})
	.strict()
	.superRefine((input, context) => {
		if (
			input.frames.reduce((total, frame) => total + frame.length, 0) >
			LOTTIE_MAX_CHUNK_CHARS
		) {
			context.addIssue({
				code: "custom",
				message: "The frame chunk is too large.",
				path: ["frames"],
			});
		}
		if (input.index + input.frames.length > LOTTIE_MAX_FRAMES) {
			context.addIssue({
				code: "custom",
				message: "Too many frames.",
				path: ["frames"],
			});
		}
		if ((input.index === 0) !== (input.meta !== undefined)) {
			context.addIssue({
				code: "custom",
				message: "Only the first chunk carries meta, and it must.",
				path: ["meta"],
			});
		}
	});
export type LottieFramesRequest = z.infer<typeof lottieFramesRequestSchema>;

export const lottieSessionRequestSchema = z
	.object({ sessionId: idSchema })
	.strict();

export const lottieFramesResponseSchema = z
	.object({
		frameCount: z.number().int(),
		received: z.number().int(),
		sessionId: idSchema,
	})
	.strict();
export type LottieFramesResponse = z.infer<typeof lottieFramesResponseSchema>;

/**
 * `POST /lottie-frames-finish`: the ProRes 4444 master (`derivation:
 * "lottie"`, what timelines reference and the render reads) and, when the
 * FFmpeg build has `libvpx-vp9`, a VP9 WebM preview copy with alpha
 * (`derivation: "proxy"`, `derivedFromAssetId` = the master) that browsers
 * can play.
 */
export const lottieFinishResponseSchema = z
	.object({ asset: assetSchema, preview: assetSchema.optional() })
	.strict();
export type LottieFinishResponse = z.infer<typeof lottieFinishResponseSchema>;
