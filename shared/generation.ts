import { z } from "zod";
import {
	type GenerationTask,
	generationTaskSchema,
	TASK_BRIDGE,
	TASK_LABELS,
} from "./generation-models.ts";
import { type Asset, idSchema } from "./project.ts";

/** Library images a generation may take as visual references. */
export const MAX_REFERENCE_IMAGES = 4;

export const generationRouteSchema = z.enum([
	"node-default",
	"local",
	"managed",
	"byok",
]);
/**
 * Why a generation was requested. `ai-edit` edits an image clip's still,
 * `edit-frame` edits a freeze still taken from a video clip, and
 * `regenerate` re-runs the request that produced a clip's media.
 */
export const generationPurposeSchema = z.enum([
	"generate",
	"ai-edit",
	"edit-frame",
	"regenerate",
]);
export type GenerationPurpose = z.infer<typeof generationPurposeSchema>;

/** Notice a person must accept before footage of people is lip-synced or animated. */
export const LIKENESS_CONSENT_NOTICE =
	"Only use footage or photos of people who agreed to have their likeness and voice used this way.";
/** Recorded on requests whose sender accepted LIKENESS_CONSENT_NOTICE. */
export const likenessConsentSchema = z.literal("subjects-agreed");

/** Tasks that animate or re-voice a real person, so consent is required. */
export const LIKENESS_TASKS: ReadonlySet<GenerationTask> = new Set([
	"lipsync",
	"avatar",
]);

/** A source time range in seconds, used for clips sent to a model. */
export const sourceRangeSchema = z
	.object({
		start: z.number().finite().min(0),
		end: z.number().finite().min(0),
	})
	.strict()
	.refine((range) => range.end > range.start, {
		message: "The range must end after it starts.",
	});

export const generationRequestSchema = z
	.object({
		id: idSchema,
		projectId: idSchema,
		kind: z.enum(["image", "video", "audio"]),
		prompt: z.string().trim().min(1).max(8000),
		provider: z.string().trim().max(200).default(""),
		model: z.string().trim().max(200).default(""),
		voice: z.string().trim().max(100).default(""),
		language: z.string().trim().max(35).default(""),
		/**
		 * The speech engine the voice belongs to. Optional without a default so
		 * requests recorded before the voice picker round-trip unchanged.
		 */
		engine: z.string().trim().min(1).max(64).optional(),
		speed: z.number().finite().min(0.5).max(2).default(1),
		route: generationRouteSchema.default("node-default"),
		rationale: z.string().trim().max(1000).default(""),
		// Optional without defaults so requests recorded before AI edit
		// round-trip byte-identically through the idempotency check.
		purpose: generationPurposeSchema.optional(),
		/** The still being edited; sent first in `input_images`. */
		sourceAssetId: idSchema.optional(),
		/** Library image references, sent after the source still. */
		inputAssetIds: z.array(idSchema).max(MAX_REFERENCE_IMAGES).optional(),
		/** The library media a regeneration replaces on the timeline. */
		regeneratesAssetId: idSchema.optional(),
		/**
		 * A reference-input task (video-to-video, first/last-frame motion,
		 * lip-sync, avatar, matting, music, sound effects). Optional so plain
		 * prompts round-trip unchanged.
		 */
		task: generationTaskSchema.optional(),
		/** The preset (`provider:model`) the task's field map came from. */
		presetId: z.string().trim().min(1).max(300).optional(),
		/** The model-specific field map sent as `provider_input`. */
		providerInput: z
			.record(z.string().min(1).max(128), z.json())
			.refine((value) => Object.keys(value).length <= 64)
			.optional(),
		/** The source clip range sent as `input_video`. */
		sourceRange: sourceRangeSchema.optional(),
		/** The library audio sent as `input_audio` (lip-sync, avatars). */
		audioAssetId: idSchema.optional(),
		/** Seconds of media requested (music, sound effects, motion bridges). */
		durationSeconds: z.number().finite().positive().max(600).optional(),
		/** Recorded when the sender accepted LIKENESS_CONSENT_NOTICE. */
		consent: likenessConsentSchema.optional(),
	})
	.strict()
	.refine(
		(request) => (request.kind === "audio" && !request.task) || !request.engine,
		{
			message: "Only narration requests name a speech engine.",
			path: ["engine"],
		}
	)
	.refine(
		(request) =>
			request.kind === "image" ||
			request.task !== undefined ||
			!request.sourceAssetId,
		{
			message: "Only image generations can edit a source still.",
			path: ["sourceAssetId"],
		}
	)
	.refine(
		(request) =>
			request.kind === "image" ||
			request.task === "flf" ||
			!(request.inputAssetIds?.length ?? 0),
		{
			message: "Only image generations accept image references.",
			path: ["inputAssetIds"],
		}
	)
	.refine(
		(request) => !request.task || TASK_BRIDGE[request.task] === request.kind,
		{
			message: "The task does not produce this kind of media.",
			path: ["task"],
		}
	)
	.refine(
		(request) =>
			!(request.task && LIKENESS_TASKS.has(request.task)) ||
			request.consent === "subjects-agreed",
		{
			message: LIKENESS_CONSENT_NOTICE,
			path: ["consent"],
		}
	)
	.refine(
		(request) =>
			request.task !== undefined ||
			(request.providerInput === undefined &&
				request.sourceRange === undefined &&
				request.audioAssetId === undefined &&
				request.consent === undefined),
		{
			message: "Reference inputs need a generation task.",
			path: ["task"],
		}
	);
export type GenerationRequest = z.infer<typeof generationRequestSchema>;
export type GenerationRequestInput = z.input<typeof generationRequestSchema>;

export const generationOutcomeSchema = z
	.object({
		status: z.enum(["completed", "incomplete"]),
		assetIds: z.array(idSchema).max(16).default([]),
		message: z.string().max(1000).default(""),
	})
	.strict();
export type GenerationOutcomeInput = z.input<typeof generationOutcomeSchema>;
export const generationJobSchema = z
	.object({
		id: idSchema,
		request: generationRequestSchema,
		projectRevision: z.number().int().nonnegative(),
		status: z.enum(["requested", "completed", "incomplete", "interrupted"]),
		assetIds: z.array(idSchema).max(16),
		message: z.string().max(1000),
		createdAt: z.iso.datetime(),
		updatedAt: z.iso.datetime(),
	})
	.strict();
export type GenerationJob = z.infer<typeof generationJobSchema>;

/** Purpose of a recorded request; requests from before AI edit were plain generations. */
export function generationPurposeOf(
	request: Pick<GenerationRequest, "purpose">
): GenerationPurpose {
	return request.purpose ?? "generate";
}

const PURPOSE_LABELS: Record<GenerationPurpose, string> = {
	"ai-edit": "AI edit",
	"edit-frame": "Edited frame",
	generate: "Generated",
	regenerate: "Regenerated",
};

/** Short human label for a request, such as "AI edit · Image". */
export function generationRequestLabel(request: GenerationRequest): string {
	if (request.task) {
		return `${PURPOSE_LABELS[generationPurposeOf(request)]} · ${TASK_LABELS[request.task]}`;
	}
	const kind =
		request.kind === "audio"
			? "Narration"
			: request.kind === "image"
				? "Image"
				: "Video";
	return `${PURPOSE_LABELS[generationPurposeOf(request)]} · ${kind}`;
}

/**
 * Validate library image references: known image assets, de-duplicated in
 * the order given, never the edited still itself, and at most
 * MAX_REFERENCE_IMAGES.
 */
export function referenceImageIds(
	assets: readonly Pick<Asset, "id" | "kind">[],
	ids: readonly string[],
	sourceAssetId?: string
): string[] {
	const unique = [...new Set(ids)].filter((id) => id !== sourceAssetId);
	if (unique.length > MAX_REFERENCE_IMAGES) {
		throw new Error(`Choose at most ${MAX_REFERENCE_IMAGES} reference images.`);
	}
	for (const id of unique) {
		const asset = assets.find((candidate) => candidate.id === id);
		if (!asset) {
			throw new Error("A reference image is no longer in the library.");
		}
		if (asset.kind !== "image") {
			throw new Error("References must be still images from the library.");
		}
	}
	return unique;
}

/** What is needed to request the same media again. */
export interface GenerationProvenance {
	/** The speech engine a narration used, when it was chosen. */
	engine?: string;
	kind: GenerationRequest["kind"];
	language: string;
	model: string;
	prompt: string;
	provider: string;
	referenceAssetIds: string[];
	/** The request that produced the media, when known. */
	requestId?: string;
	sourceAssetId?: string;
	speed: number;
	/** Set for reference-input tasks, which are re-run from their panel. */
	task?: GenerationTask;
	voice: string;
}

function provenanceFromJob(
	request: GenerationRequest,
	requestId: string
): GenerationProvenance {
	const provenance: GenerationProvenance = {
		kind: request.kind,
		language: request.language,
		model: request.model,
		prompt: request.prompt,
		provider: request.provider,
		referenceAssetIds: [...(request.inputAssetIds ?? [])],
		requestId,
		speed: request.speed,
		voice: request.voice,
	};
	if (request.sourceAssetId) {
		provenance.sourceAssetId = request.sourceAssetId;
	}
	if (request.kind === "audio" && request.engine) {
		provenance.engine = request.engine;
	}
	if (request.task) {
		provenance.task = request.task;
	}
	return provenance;
}

function provenanceFromAsset(
	asset: Asset,
	generation: NonNullable<Asset["generation"]>
): GenerationProvenance {
	const inputs = generation.inputAssetIds ?? [];
	// An AI-edited asset lists its source still first among its inputs.
	const source =
		asset.derivation === "ai-edit" ? asset.derivedFromAssetId : undefined;
	const provenance: GenerationProvenance = {
		kind: generation.kind,
		language: "",
		model: generation.model ?? "",
		prompt: generation.prompt,
		provider: generation.provider ?? "",
		referenceAssetIds: inputs
			.filter((id) => id !== source)
			.slice(0, MAX_REFERENCE_IMAGES),
		speed: 1,
		voice: "",
	};
	if (source) {
		provenance.sourceAssetId = source;
	}
	if (generation.requestId) {
		provenance.requestId = generation.requestId;
	}
	if (generation.task) {
		provenance.task = generation.task;
	}
	return provenance;
}

/**
 * How an asset was generated: its own `generation` metadata when present,
 * otherwise the most recent completed request that saved it. Undefined for
 * media that was not generated.
 */
export function generationProvenance(
	asset: Asset,
	jobs: readonly GenerationJob[]
): GenerationProvenance | undefined {
	if (asset.generation?.prompt.trim()) {
		// The recorded request keeps voice, language, and speed, which asset
		// metadata does not, so it wins when the stamp names one still known.
		const requestId = asset.generation.requestId;
		const recorded = requestId
			? jobs.find((job) => job.id === requestId)
			: undefined;
		return recorded
			? provenanceFromJob(recorded.request, recorded.id)
			: provenanceFromAsset(asset, asset.generation);
	}
	let latest: GenerationJob | undefined;
	for (const job of jobs) {
		if (
			job.status === "completed" &&
			job.assetIds.includes(asset.id) &&
			(!latest || job.updatedAt > latest.updatedAt)
		) {
			latest = job;
		}
	}
	return latest ? provenanceFromJob(latest.request, latest.id) : undefined;
}

/** A request that re-runs `provenance` to replace `assetId`. */
export function regenerationRequest(
	provenance: GenerationProvenance,
	target: { assetId: string; id: string; projectId: string }
): GenerationRequest {
	if (provenance.task) {
		throw new Error(
			`${TASK_LABELS[provenance.task]} media is re-run from its own panel, which sends fresh source media.`
		);
	}
	const request: GenerationRequestInput = {
		id: target.id,
		projectId: target.projectId,
		kind: provenance.kind,
		prompt: provenance.prompt,
		provider: provenance.kind === "audio" ? "" : provenance.provider,
		model: provenance.kind === "audio" ? "" : provenance.model,
		voice: provenance.kind === "audio" ? provenance.voice : "",
		language: provenance.kind === "audio" ? provenance.language : "",
		speed: provenance.kind === "audio" ? provenance.speed : 1,
		purpose: "regenerate",
		regeneratesAssetId: target.assetId,
	};
	if (provenance.kind === "audio" && provenance.engine) {
		request.engine = provenance.engine;
	}
	if (provenance.kind === "image") {
		if (provenance.sourceAssetId) {
			request.sourceAssetId = provenance.sourceAssetId;
		}
		if (provenance.referenceAssetIds.length) {
			request.inputAssetIds = provenance.referenceAssetIds.slice(
				0,
				MAX_REFERENCE_IMAGES
			);
		}
	}
	return generationRequestSchema.parse(request);
}

/** A request that edits `sourceAssetId` (an image) following `prompt`. */
export function aiEditRequest(input: {
	id: string;
	model?: string;
	projectId: string;
	prompt: string;
	provider?: string;
	purpose: "ai-edit" | "edit-frame";
	referenceAssetIds?: readonly string[];
	sourceAssetId: string;
}): GenerationRequest {
	const request: GenerationRequestInput = {
		id: input.id,
		projectId: input.projectId,
		kind: "image",
		prompt: input.prompt,
		provider: input.provider ?? "",
		model: input.model ?? "",
		purpose: input.purpose,
		sourceAssetId: input.sourceAssetId,
	};
	if (input.referenceAssetIds?.length) {
		request.inputAssetIds = [...input.referenceAssetIds];
	}
	return generationRequestSchema.parse(request);
}

/** Library image ids sent as `input_images`, in order: source still, then references. */
export function requestInputImageIds(request: GenerationRequest): string[] {
	return [
		...(request.sourceAssetId ? [request.sourceAssetId] : []),
		...(request.inputAssetIds ?? []),
	];
}

const EXTENSIONS: Record<GenerationRequest["kind"], string> = {
	audio: "wav",
	image: "png",
	video: "mp4",
};

/** Library file name for generated media: purpose, a prompt excerpt, extension. */
export function generatedMediaFileName(request: GenerationRequest): string {
	const purpose = generationPurposeOf(request);
	const lead = request.task
		? TASK_LABELS[request.task]
		: purpose === "generate"
			? `Generated ${request.kind}`
			: PURPOSE_LABELS[purpose];
	const excerpt = request.prompt.replace(/\s+/g, " ").trim().slice(0, 60);
	return `${lead} — ${excerpt}.${EXTENSIONS[request.kind]}`;
}

/** Asset fields that record how generated media was produced. */
export type GeneratedAssetStamp = Pick<
	Asset,
	"derivation" | "derivedFromAssetId" | "generation"
>;

/**
 * Provenance to stamp on media a request saved: `generation` metadata
 * (inputs listed source still first) and, for AI edits of a still,
 * `derivation: "ai-edit"` with the edited still as `derivedFromAssetId`.
 * A regeneration of an AI edit keeps the edit derivation.
 */
export function generatedAssetStamp(
	request: GenerationRequest
): GeneratedAssetStamp {
	const generation: NonNullable<Asset["generation"]> = {
		kind: request.kind,
		prompt: request.prompt,
		requestId: request.id,
	};
	if (request.provider) {
		generation.provider = request.provider;
	}
	if (request.model) {
		generation.model = request.model;
	}
	const inputs = [
		...requestInputImageIds(request),
		...(request.audioAssetId ? [request.audioAssetId] : []),
	];
	if (inputs.length) {
		generation.inputAssetIds = [...new Set(inputs)].slice(0, 8);
	}
	if (request.task) {
		generation.task = request.task;
	}
	if (request.consent) {
		generation.consent = request.consent;
	}
	const stamp: GeneratedAssetStamp = { generation };
	if (request.kind === "image" && request.sourceAssetId && !request.task) {
		stamp.derivation = "ai-edit";
		stamp.derivedFromAssetId = request.sourceAssetId;
	}
	if (
		request.sourceAssetId &&
		(request.task === "v2v" || request.task === "lipsync")
	) {
		stamp.derivation = request.task === "v2v" ? "ai-edit" : "lipsync";
		stamp.derivedFromAssetId = request.sourceAssetId;
	}
	return stamp;
}

/**
 * `asset` with the provenance of the request that saved it. Media that
 * already carries a derivation of its own (a cutout, a proxy) keeps it.
 */
export function stampGeneratedAsset(
	asset: Asset,
	request: GenerationRequest
): Asset {
	const stamp = generatedAssetStamp(request);
	if (
		asset.derivation &&
		asset.derivation !== "ai-edit" &&
		asset.derivation !== "lipsync"
	) {
		return { ...asset, generation: stamp.generation };
	}
	return { ...asset, ...stamp };
}
