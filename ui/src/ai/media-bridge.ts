import { z } from "zod";
import {
	type GenerationOutcomeInput,
	type GenerationRequest,
	type GenerationRequestInput,
	generatedMediaFileName,
	generationJobSchema,
	generationRequestSchema,
} from "../../../shared/generation.ts";
import {
	estimateForKind,
	type ProductionBudgetStatus,
	productionBudgetSchema,
	productionBudgetStatusSchema,
} from "../../../shared/production-budget.ts";
import type { Asset } from "../../../shared/project.ts";
import {
	isRevisionConflict,
	mediaBlob,
	mediaDataUrlBlob,
	request,
	StudioRequestError,
	studioResponseSchema,
	uploadMedia,
} from "../bridge.ts";
import {
	type GeneratedMediaResponse,
	generatedDataUrl,
	generatedMediaResponseSchema,
} from "../generation-response.ts";

/** The host media bridge (`window.ryu.media`), injectable for tests. */
export type MediaBridge = NonNullable<NonNullable<Window["ryu"]>["media"]>;
type ImageBridgeInput = Parameters<NonNullable<MediaBridge["image"]>>[0];

/** Largest library still sent to the host as an input image. */
export const MAX_INPUT_IMAGE_BYTES = 12 * 1024 * 1024;

/** The host's media bridge when Video Studio runs inside Ryu. */
export function hostMediaBridge(): MediaBridge | undefined {
	return window.ryu?.media;
}

/** Whether the host can run a request of this kind. */
export function bridgeSupports(
	bridge: MediaBridge | undefined,
	kind: GenerationRequest["kind"]
): boolean {
	return Boolean(kind === "audio" ? bridge?.tts : bridge?.[kind]);
}

/**
 * The `media.image` input for a request: provider and model only when set,
 * `input_images` only when there are images, always one output.
 */
export function imageBridgeInput(
	generation: GenerationRequest,
	inputImages: readonly string[]
): ImageBridgeInput {
	const input: ImageBridgeInput = {
		count: 1,
		project_id: generation.projectId,
		prompt: generation.prompt,
		request_id: generation.id,
	};
	if (generation.provider) {
		input.provider = generation.provider;
	}
	if (generation.model) {
		input.model = generation.model;
	}
	if (inputImages.length) {
		input.input_images = [...inputImages];
	}
	return input;
}

/** Run a recorded request on the host bridge and return its media as a data URL. */
export async function requestGeneratedMedia(
	bridge: MediaBridge | undefined,
	generation: GenerationRequest,
	inputImages: readonly string[] = []
): Promise<string> {
	let result: GeneratedMediaResponse;
	if (generation.kind === "audio") {
		if (!bridge?.tts) {
			throw new Error("Ryu narration is unavailable on this host.");
		}
		const narration: Parameters<NonNullable<MediaBridge["tts"]>>[0] & {
			project_id: string;
		} = {
			project_id: generation.projectId,
			request_id: generation.id,
			speed: generation.speed,
			text: generation.prompt,
		};
		if (generation.voice) {
			narration.voice = generation.voice;
		}
		if (generation.language) {
			narration.language = generation.language;
		}
		if (generation.engine) {
			narration.engine = generation.engine;
		}
		result = generatedMediaResponseSchema.parse(await bridge.tts(narration));
	} else if (generation.kind === "image") {
		if (!bridge?.image) {
			throw new Error("Ryu image generation is unavailable on this host.");
		}
		result = generatedMediaResponseSchema.parse(
			await bridge.image(imageBridgeInput(generation, inputImages))
		);
	} else {
		if (inputImages.length) {
			throw new Error("Video generation does not accept input images.");
		}
		if (!bridge?.video) {
			throw new Error("Ryu video generation is unavailable on this host.");
		}
		const input: Parameters<NonNullable<MediaBridge["video"]>>[0] = {
			project_id: generation.projectId,
			prompt: generation.prompt,
			request_id: generation.id,
		};
		if (generation.provider) {
			input.provider = generation.provider;
		}
		if (generation.model) {
			input.model = generation.model;
		}
		result = generatedMediaResponseSchema.parse(await bridge.video(input));
	}
	return generatedDataUrl(result, generation.kind);
}

/**
 * The image MIME type of `bytes` from its signature, or undefined when it is
 * not a PNG, JPEG, WebP, GIF, or BMP still.
 */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
	if (
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47
	) {
		return "image/png";
	}
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg";
	}
	if (
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return "image/webp";
	}
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
		return "image/gif";
	}
	if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
		return "image/bmp";
	}
	return undefined;
}

/** Image formats image models accept as `input_images` without conversion. */
const MODEL_IMAGE_MIMES = new Set([
	"image/gif",
	"image/jpeg",
	"image/png",
	"image/webp",
]);

/** Re-encodes still bytes of `mime` as PNG bytes. */
export type PngTranscoder = (
	bytes: Uint8Array,
	mime: string
) => Promise<Uint8Array>;

/** Decode a still with the browser and re-encode it as PNG. */
export async function browserPngTranscoder(
	bytes: Uint8Array,
	mime: string
): Promise<Uint8Array> {
	if (
		typeof createImageBitmap !== "function" ||
		typeof OffscreenCanvas !== "function"
	) {
		throw new Error("This host cannot convert images for image models.");
	}
	const bitmap = await createImageBitmap(
		new Blob([new Uint8Array(bytes)], { type: mime })
	);
	try {
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const context = canvas.getContext("2d");
		if (!context) {
			throw new Error("This host cannot convert images for image models.");
		}
		context.drawImage(bitmap, 0, 0);
		const png = await canvas.convertToBlob({ type: "image/png" });
		return new Uint8Array(await png.arrayBuffer());
	} finally {
		bitmap.close();
	}
}

/**
 * A library still as an `input_images` data URL labelled with its real
 * type. Formats models do not take (BMP) are converted to PNG first;
 * unrecognised bytes are refused rather than mislabelled.
 */
export async function inputImageDataUrl(
	bytes: Uint8Array,
	name: string,
	transcode: PngTranscoder = browserPngTranscoder
): Promise<string> {
	const mime = sniffImageMime(bytes);
	if (!mime) {
		throw new Error(
			`“${name}” is not a PNG, JPEG, WebP, GIF, or BMP image, so it cannot be sent to an image model.`
		);
	}
	if (MODEL_IMAGE_MIMES.has(mime)) {
		return bytesDataUrl(bytes, mime);
	}
	const png = await transcode(bytes, mime);
	if (sniffImageMime(png) !== "image/png") {
		throw new Error(`“${name}” could not be converted to PNG.`);
	}
	return bytesDataUrl(png, "image/png");
}

/** Base64 data URL for `bytes`, encoded in chunks to stay within call limits. */
export function bytesDataUrl(bytes: Uint8Array, mime: string): string {
	let binary = "";
	const step = 0x80_00;
	for (let offset = 0; offset < bytes.length; offset += step) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
	}
	return `data:${mime};base64,${btoa(binary)}`;
}

/** Message shown when the project budget cannot admit another request. */
export const BUDGET_EXCEEDED_MESSAGE =
	"This project's generation budget cannot admit another request. Raise the budget or review pending generations first.";

/**
 * Whether a budget with `status` admits one more request of `kind`: the same
 * rule the sidecar applies when the request is recorded.
 */
export function budgetAdmits(
	status: Pick<
		ProductionBudgetStatus,
		"atRiskMicroUsd" | "reservedMicroUsd" | "spentMicroUsd"
	>,
	productionBudget: unknown,
	kind: GenerationRequest["kind"]
): boolean {
	const budget = productionBudgetSchema.parse(productionBudget);
	return (
		budget.limitMicroUsd === 0 ||
		status.spentMicroUsd +
			status.reservedMicroUsd +
			status.atRiskMicroUsd +
			estimateForKind(budget, kind) <=
			budget.limitMicroUsd
	);
}

const projectBudgetSchema = z.looseObject({
	productionBudget: z.unknown().optional(),
});

/** Everything an AI generation needs from the sidecar and host. */
export interface GenerationServices {
	/**
	 * Preflight the project budget for one more request of `kind`, throwing
	 * when it cannot be admitted. Used before edits that change the timeline
	 * ahead of recording the request (Edit frame as still).
	 */
	admit: (projectId: string, kind: GenerationRequest["kind"]) => Promise<void>;
	bridge: MediaBridge | undefined;
	/** Record the outcome of a request. */
	finish: (id: string, outcome: GenerationOutcomeInput) => Promise<void>;
	/** A library image as a data URL for `input_images`. */
	readImage: (asset: Asset) => Promise<string>;
	/**
	 * Record intent before the host call. The sidecar refuses requests the
	 * project budget cannot admit, so a refusal stops before any charge.
	 */
	record: (generation: GenerationRequest) => Promise<void>;
	/** Save generated media to the library. */
	upload: (file: File) => Promise<Asset>;
}

/** Explain a refused generation record in editor terms. */
export function recordFailureMessage(error: unknown): string {
	if (error instanceof StudioRequestError && error.code === "BUDGET_EXCEEDED") {
		return BUDGET_EXCEEDED_MESSAGE;
	}
	if (isRevisionConflict(error)) {
		return "This request was already recorded. Review generation history before retrying.";
	}
	return error instanceof Error ? error.message : "Generation failed.";
}

const recordResponseSchema = z.object({ job: z.json(), created: z.boolean() });

/** Sidecar- and host-backed generation services. */
export function hostGenerationServices(
	onProgress: (fraction: number) => void
): GenerationServices {
	return {
		admit: async (projectId, kind) => {
			const [status, project] = await Promise.all([
				request(productionBudgetStatusSchema, `/projects/${projectId}/budget`),
				request(projectBudgetSchema, `/projects/${projectId}`),
			]);
			if (!budgetAdmits(status, project.productionBudget ?? {}, kind)) {
				throw new Error(BUDGET_EXCEEDED_MESSAGE);
			}
		},
		bridge: hostMediaBridge(),
		finish: async (id, outcome) => {
			await request(studioResponseSchema, `/generations/${id}`, "PUT", outcome);
		},
		readImage: async (asset) => {
			if (asset.kind !== "image") {
				throw new Error("Only still images can be sent to image models.");
			}
			const blob = await mediaBlob(`/assets/${asset.id}/data`, "image/png");
			if (blob.size > MAX_INPUT_IMAGE_BYTES) {
				throw new Error(
					`“${asset.name}” is too large to send as an input image.`
				);
			}
			return await inputImageDataUrl(
				new Uint8Array(await blob.arrayBuffer()),
				asset.name
			);
		},
		record: async (generation) => {
			const tracked = await request(
				recordResponseSchema,
				"/generations",
				"POST",
				generation
			);
			if (!tracked.created) {
				throw new Error(
					"This request was already recorded. Review generation history before retrying."
				);
			}
			generationJobSchema.parse(tracked.job);
		},
		upload: (file) => uploadMedia(file, onProgress),
	};
}

/** Result of running and saving one generation. */
export interface SavedGeneration {
	asset: Asset;
	/** Set when the media was saved but its history outcome was not. */
	historyWarning?: string;
}

/**
 * Record a request (budget gate), run it on the host (whose own approval
 * and policy gates apply), save the media to the library, and record the
 * outcome. Input images are read from the library in request order.
 */
export async function runGeneration(
	services: GenerationServices,
	input: GenerationRequestInput,
	inputImages: readonly Asset[] = []
): Promise<SavedGeneration> {
	const generation = generationRequestSchema.parse(input);
	if (!bridgeSupports(services.bridge, generation.kind)) {
		throw new Error(
			"Generation is unavailable in this host. Open the app in Ryu with media permissions and a configured model."
		);
	}
	return await runRecordedGeneration(services, generation, async () => {
		const images: string[] = [];
		for (const image of inputImages) {
			images.push(await services.readImage(image));
		}
		return await requestGeneratedMedia(services.bridge, generation, images);
	});
}

/**
 * The record → produce → save → outcome sequence every generation shares.
 * `produce` returns the generated media as a data URL; a failure records the
 * request as incomplete with the reason and rethrows it unchanged, so a
 * refusal (budget, policy, a provider or a local engine that cannot take the
 * inputs) reaches the editor as it was given.
 */
export async function runRecordedGeneration(
	services: GenerationServices,
	generation: GenerationRequest,
	produce: () => Promise<string>
): Promise<SavedGeneration> {
	try {
		await services.record(generation);
	} catch (error) {
		throw new Error(recordFailureMessage(error));
	}
	let asset: Asset | undefined;
	try {
		const data = await produce();
		const blob = mediaDataUrlBlob(data);
		asset = await services.upload(
			new File([blob], generatedMediaFileName(generation), {
				type: blob.type,
			})
		);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Generation failed.";
		await services
			.finish(generation.id, {
				assetIds: [],
				message: message.slice(0, 1000),
				status: "incomplete",
			})
			.catch(() => undefined);
		throw error;
	}
	try {
		await services.finish(generation.id, {
			assetIds: [asset.id],
			message: "",
			status: "completed",
		});
		return { asset };
	} catch (error) {
		return {
			asset,
			historyWarning: `Media was saved, but its history update failed: ${error instanceof Error ? error.message : "unknown error"}`,
		};
	}
}
