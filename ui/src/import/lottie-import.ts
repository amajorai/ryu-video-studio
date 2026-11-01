import type { z } from "zod";
import {
	dotLottieJson,
	isDotLottieName,
	isLottieJsonName,
} from "../../../shared/dotlottie.ts";
import {
	LOTTIE_MAX_CHUNK_CHARS,
	LOTTIE_MAX_JSON_BYTES,
	type LottieDocument,
	type LottieFinishResponse,
	type LottieImportPlan,
	type LottieMeta,
	lottieChunkFull,
	lottieFinishResponseSchema,
	lottieFramesResponseSchema,
	lottiePlayerFrame,
	lottieSourceFrame,
	parseLottieDocument,
	planLottieImport,
} from "../../../shared/lottie.ts";
import { request, studioResponseSchema } from "../bridge.ts";

/**
 * Lottie import (G60): render a Lottie JSON frame by frame with lottie-web's
 * canvas renderer at the project frame rate, upload the PNG frames in ordered
 * chunks, and let the sidecar encode them as a ProRes 4444 video with alpha.
 * Frames are rendered and sent chunk by chunk, so memory stays bounded.
 */

/** Draws one Lottie frame and returns it as base64 PNG (no data-URI prefix). */
export interface LottieFrameRenderer {
	destroy: () => void;
	/** `sourceFrame` is an absolute Lottie frame (`ip` <= frame < `op`). */
	render: (sourceFrame: number) => Promise<string>;
}

export type LottieRendererFactory = (
	animation: LottieDocument,
	plan: LottieImportPlan
) => Promise<LottieFrameRenderer>;

/** The subset of the sidecar bridge the import uses (injectable for tests). */
export type LottieRequest = <T>(
	schema: z.ZodType<T>,
	path: string,
	method: "DELETE" | "POST",
	body?: Record<string, unknown>
) => Promise<T>;

export interface LottieImportOptions {
	animation: LottieDocument;
	createRenderer?: LottieRendererFactory;
	name: string;
	/**
	 * Called once every frame is uploaded, just before the encode request.
	 * The encode cannot be cancelled, so callers withdraw Cancel here.
	 */
	onEncoding?: () => void;
	/** Progress from 0 to 1 while frames render and upload. */
	onProgress?: (fraction: number) => void;
	projectFps: number;
	send?: LottieRequest;
	signal?: AbortSignal;
}

const LOAD_TIMEOUT_MS = 15_000;

/** Whether a file is a Lottie animation (`.json`, `.lottie.json`, `.lottie`). */
export function isLottieFile(file: Pick<File, "name" | "type">): boolean {
	return (
		isDotLottieName(file.name) ||
		isLottieJsonName(file.name) ||
		file.type === "application/json"
	);
}

/** ZIP archives start with "PK\x03\x04". */
const isZipBytes = (bytes: Uint8Array) =>
	bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;

/**
 * Read and check a picked Lottie file: `.json` / `.lottie.json` text, or a
 * `.lottie` (dotLottie) archive, whose first animation is unpacked with its
 * images inlined.
 */
export async function readLottieFile(
	file: Blob & { name?: string }
): Promise<LottieDocument> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (isDotLottieName(file.name ?? "") || isZipBytes(bytes)) {
		const json = await dotLottieJson(bytes);
		if (json.length > LOTTIE_MAX_JSON_BYTES) {
			throw new Error(
				"The animation inside this .lottie file is larger than 5 MB."
			);
		}
		return parseLottieDocument(json);
	}
	if (file.size > LOTTIE_MAX_JSON_BYTES) {
		throw new Error("Lottie files must be 5 MB or smaller.");
	}
	return parseLottieDocument(new TextDecoder().decode(bytes));
}

/** Library name for an imported file: its name without `.json` or `.lottie`. */
export function lottieAssetName(fileName: string): string {
	const base = fileName
		.replace(/\.json$/i, "")
		.replace(/\.lottie$/i, "")
		.trim();
	return (base || "Lottie animation").slice(0, 200);
}

/** The lottie-web animation surface the renderer drives. */
interface LottieAnimation {
	addEventListener: (
		name: "DOMLoaded" | "data_failed",
		callback: () => void
	) => unknown;
	destroy: () => void;
	goToAndStop: (value: number, isFrame?: boolean) => void;
	isLoaded: boolean;
	resize: (width?: number, height?: number) => void;
}

function whenLoaded(animation: LottieAnimation): Promise<void> {
	if (animation.isLoaded) {
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("The Lottie animation did not finish loading.")),
			LOAD_TIMEOUT_MS
		);
		animation.addEventListener("DOMLoaded", () => {
			clearTimeout(timer);
			resolve();
		});
		animation.addEventListener("data_failed", () => {
			clearTimeout(timer);
			reject(new Error("The Lottie animation could not be loaded."));
		});
	});
}

/**
 * The browser renderer: lottie-web's light canvas build (no expression
 * engine, so animations never evaluate embedded scripts) drawing into a
 * detached canvas at the planned output size.
 */
export const createCanvasLottieRenderer: LottieRendererFactory = async (
	animation,
	plan
) => {
	const { default: lottie } = await import(
		"lottie-web/build/player/lottie_light_canvas"
	);
	// A detached wrapper: lottie-web adds its own canvas inside it. The
	// explicit resize below fixes that canvas to the output size, and a
	// device pixel ratio of 1 keeps frames exactly `plan.width` wide.
	const wrapper = document.createElement("div");
	const item: LottieAnimation = lottie.loadAnimation({
		animationData: structuredClone(animation),
		autoplay: false,
		container: wrapper,
		loop: false,
		renderer: "canvas",
		rendererSettings: {
			clearCanvas: true,
			dpr: 1,
			preserveAspectRatio: "xMidYMid meet",
		},
	});
	let canvas: HTMLCanvasElement | null = null;
	try {
		await whenLoaded(item);
		item.resize(plan.width, plan.height);
		canvas = wrapper.querySelector("canvas");
		if (!canvas) {
			throw new Error("This browser cannot draw Lottie frames.");
		}
	} catch (error) {
		item.destroy();
		throw error;
	}
	const frameCanvas = canvas;
	return {
		destroy: () => item.destroy(),
		render: (sourceFrame) => {
			item.goToAndStop(lottiePlayerFrame(plan.inPoint, sourceFrame), true);
			const url = frameCanvas.toDataURL("image/png");
			const comma = url.indexOf(",");
			if (!url.startsWith("data:image/png;base64,") || comma < 0) {
				throw new Error("This browser cannot export PNG frames.");
			}
			return Promise.resolve(url.slice(comma + 1));
		},
	};
};

const defaultSend: LottieRequest = (schema, path, method, body) =>
	request(schema, path, method, body);

/**
 * Render, upload and encode a Lottie animation. Resolves to the new
 * `derivation: "lottie"` video asset and, when the sidecar could make one,
 * its browser-playable preview proxy. On failure or abort after the first
 * chunk the sidecar session is cancelled so no frames are left behind.
 */
export async function importLottie(
	options: LottieImportOptions
): Promise<LottieFinishResponse> {
	const send = options.send ?? defaultSend;
	const createRenderer = options.createRenderer ?? createCanvasLottieRenderer;
	const plan = planLottieImport(options.animation, options.projectFps);
	const meta: LottieMeta = {
		fps: plan.fps,
		frameCount: plan.frameCount,
		height: plan.height,
		name: options.name,
		width: plan.width,
	};
	const sessionId = crypto.randomUUID();
	let opened = false;
	let pending: string[] = [];
	let pendingChars = 0;
	let sent = 0;
	const flush = async () => {
		if (!pending.length) {
			return;
		}
		const body: Record<string, unknown> = {
			frames: pending,
			index: sent,
			sessionId,
		};
		if (sent === 0) {
			body.meta = meta;
		}
		opened = true;
		const result = await send(
			lottieFramesResponseSchema,
			"/lottie-frames",
			"POST",
			body
		);
		sent += pending.length;
		if (result.received !== sent) {
			throw new Error("The Lottie upload lost its place. Try again.");
		}
		pending = [];
		pendingChars = 0;
		options.onProgress?.(sent / plan.frameCount);
		options.signal?.throwIfAborted();
	};
	const renderer = await createRenderer(options.animation, plan);
	try {
		for (let index = 0; index < plan.frameCount; index++) {
			options.signal?.throwIfAborted();
			const frame = await renderer.render(lottieSourceFrame(plan, index));
			if (frame.length > LOTTIE_MAX_CHUNK_CHARS) {
				throw new Error(
					"A Lottie frame is too detailed to upload. Use a smaller animation."
				);
			}
			if (
				lottieChunkFull(
					{ chars: pendingChars, frames: pending.length },
					frame.length
				)
			) {
				await flush();
			}
			pending.push(frame);
			pendingChars += frame.length;
		}
		await flush();
		options.signal?.throwIfAborted();
		// Past this point the session is consumed by the encode, which the
		// host bridge cannot interrupt: the import either completes or fails.
		options.onEncoding?.();
		return await send(
			lottieFinishResponseSchema,
			"/lottie-frames-finish",
			"POST",
			{ sessionId }
		);
	} catch (error) {
		if (opened) {
			await send(
				studioResponseSchema,
				`/lottie-frames?sessionId=${sessionId}`,
				"DELETE"
			).catch(() => undefined);
		}
		throw error;
	} finally {
		renderer.destroy();
	}
}
