/**
 * Reference-input generation tasks on the host bridge: video-to-video,
 * first/last-frame motion, lip-sync, talking avatars, subject matting,
 * music and sound effects. Each run records the request first (the budget
 * gate), sends the prepared inputs with the task's `provider_input` field map,
 * saves the result to the library, and records the outcome. A refusal from
 * the host, Core or a provider is shown as it was given; nothing is faked
 * when a capability is missing.
 */
import { z } from "zod";
import type { GenerationRequest } from "../../../shared/generation.ts";
import { generationRequestSchema } from "../../../shared/generation.ts";
import {
	type GenerationInput,
	generationInputSchema,
} from "../../../shared/generation-inputs.ts";
import {
	type GenerationModelPreset,
	type GenerationTask,
	isLocalEngineProvider,
	LOCAL_ENGINE_PROVIDER,
	LOCAL_ENGINE_TASKS,
	type PresetJson,
	presetProviderInput,
	providerInputProblems,
	resolveImageProviderInput,
	TASK_BRIDGE,
	TASK_LABELS,
} from "../../../shared/generation-models.ts";
import {
	request,
	type StudioAudioInput,
	type StudioBridgeFeatures,
	type StudioRequestBody,
} from "../bridge.ts";
import { generatedDataUrl } from "../generation-response.ts";
import {
	bytesDataUrl,
	type GenerationServices,
	type MediaBridge,
	runRecordedGeneration,
	type SavedGeneration,
} from "./media-bridge.ts";

/** Inline reference inputs for one task request. */
export interface TaskInputs {
	audio?: string;
	images?: string[];
	video?: string;
}

/** The model a task runs on: a preset, optionally edited. */
export interface TaskModelChoice {
	model: string;
	presetId?: string;
	provider: string;
	providerInput: Record<string, PresetJson>;
}

/** A choice taken straight from a preset row. */
export function presetChoice(preset: GenerationModelPreset): TaskModelChoice {
	return {
		model: preset.model,
		presetId: preset.id,
		provider: preset.provider,
		providerInput: structuredClone(preset.providerInput),
	};
}

/** Preset id recorded for the local-engine choice. */
export const LOCAL_ENGINE_CHOICE_ID = "local:engine";

/**
 * The local-engine choice for `task`: no model id and no field map, since
 * Core maps the canonical inputs to the active local model itself.
 */
export function localEngineChoice(): TaskModelChoice {
	return {
		model: "",
		presetId: LOCAL_ENGINE_CHOICE_ID,
		provider: LOCAL_ENGINE_PROVIDER,
		providerInput: {},
	};
}

/**
 * Throws unless `choice` can run `task`: a local-engine choice needs a task
 * the local engine runs, and a cloud choice needs a provider and a model.
 * Returns whether the choice is the local engine.
 */
export function assertTaskChoice(
	task: GenerationTask,
	choice: Pick<TaskModelChoice, "model" | "provider">
): boolean {
	if (isLocalEngineProvider(choice.provider)) {
		if (!LOCAL_ENGINE_TASKS.has(task)) {
			throw new Error(
				`${TASK_LABELS[task]} has no local model: choose a cloud provider and a model.`
			);
		}
		return true;
	}
	if (!(choice.provider.trim() && choice.model.trim())) {
		throw new Error(
			`${TASK_LABELS[task]} runs on a cloud model: choose a provider and a model.`
		);
	}
	return false;
}

const usesDuration = (fields: Record<string, PresetJson>) =>
	JSON.stringify(fields).includes('"$duration_s"');

/**
 * A recorded request for `task` with the chosen model. Throws with the
 * field-map problems before anything is recorded or sent.
 */
export function taskGenerationRequest(input: {
	audioAssetId?: string;
	choice: TaskModelChoice;
	consent?: "subjects-agreed";
	durationSeconds?: number;
	id: string;
	inputAssetIds?: string[];
	projectId: string;
	prompt: string;
	promptField?: string;
	purpose?: "generate" | "ai-edit";
	sourceAssetId?: string;
	sourceRange?: { end: number; start: number };
	task: GenerationTask;
}): GenerationRequest {
	if (assertTaskChoice(input.task, input.choice)) {
		return generationRequestSchema.parse({
			durationSeconds: input.durationSeconds,
			id: input.id,
			inputAssetIds: input.inputAssetIds,
			kind: TASK_BRIDGE[input.task],
			presetId: LOCAL_ENGINE_CHOICE_ID,
			projectId: input.projectId,
			prompt: input.prompt,
			provider: LOCAL_ENGINE_PROVIDER,
			purpose: input.purpose ?? "generate",
			route: "local",
			task: input.task,
		});
	}
	const fields = presetProviderInput(
		{
			promptField: input.promptField,
			providerInput: input.choice.providerInput,
		},
		input.prompt
	);
	const problems = providerInputProblems(input.task, fields, {
		duration: input.task === "music" || input.task === "sfx",
	});
	if (problems.length) {
		throw new Error(problems.join(" "));
	}
	return generationRequestSchema.parse({
		audioAssetId: input.audioAssetId,
		consent: input.consent,
		durationSeconds: input.durationSeconds,
		id: input.id,
		inputAssetIds: input.inputAssetIds,
		kind: TASK_BRIDGE[input.task],
		model: input.choice.model.trim(),
		presetId: input.choice.presetId,
		projectId: input.projectId,
		prompt: input.prompt,
		provider: input.choice.provider.trim(),
		providerInput: fields,
		purpose: input.purpose ?? "generate",
		sourceAssetId: input.sourceAssetId,
		sourceRange: input.sourceRange,
		task: input.task,
	});
}

type VideoBridgeInput = Parameters<NonNullable<MediaBridge["video"]>>[0];
type ImageBridgeInput = Parameters<NonNullable<MediaBridge["image"]>>[0];

/** The `media.video` input for a video task. */
export function videoTaskInput(
	generation: GenerationRequest,
	inputs: TaskInputs
): VideoBridgeInput {
	const fields = generation.providerInput ?? {};
	const input: VideoBridgeInput = {
		project_id: generation.projectId,
		prompt: generation.prompt,
		provider: generation.provider,
		request_id: generation.id,
	};
	if (generation.model) {
		input.model = generation.model;
	}
	// The local engine takes no model-specific fields and Core refuses any
	// `provider_input` sent to it, so a local request carries none.
	if (!isLocalEngineProvider(generation.provider)) {
		input.provider_input = fields as VideoBridgeInput["provider_input"];
	}
	if (inputs.images?.length) {
		input.input_images = [...inputs.images];
	}
	if (inputs.video) {
		input.input_video = inputs.video;
	}
	if (inputs.audio) {
		input.input_audio = inputs.audio;
	}
	if (generation.durationSeconds !== undefined && usesDuration(fields)) {
		input.duration_s = generation.durationSeconds;
	}
	return input;
}

/** The `media.image` input for an image task (matting a still). */
export function imageTaskInput(
	generation: GenerationRequest,
	inputs: TaskInputs
): ImageBridgeInput {
	const image = inputs.images?.[0];
	if (!image) {
		throw new Error("This task needs a still to send.");
	}
	return {
		count: 1,
		model: generation.model,
		project_id: generation.projectId,
		prompt: generation.prompt,
		provider: generation.provider,
		// `media.image` has no reference resolution, so the still is inlined
		// where the field map names it instead of sent as `input_images`.
		provider_input: resolveImageProviderInput(
			generation.providerInput ?? {},
			image
		) as ImageBridgeInput["provider_input"],
		request_id: generation.id,
	};
}

/** The `media.audio` input for a music or sound-effect task. */
export function audioTaskInput(
	generation: GenerationRequest
): StudioAudioInput {
	const fields = generation.providerInput ?? {};
	const input: StudioAudioInput = {
		kind: generation.task === "sfx" ? "sfx" : "music",
		model: generation.model,
		project_id: generation.projectId,
		prompt: generation.prompt,
		provider: generation.provider,
		provider_input: fields as StudioAudioInput["provider_input"],
		request_id: generation.id,
	};
	if (generation.durationSeconds !== undefined && usesDuration(fields)) {
		input.duration_s = generation.durationSeconds;
	}
	return input;
}

/** Why the host cannot run `task`, or undefined when it can. */
export function taskUnavailableReason(
	bridge: MediaBridge | undefined,
	features: Partial<StudioBridgeFeatures> | undefined,
	task: GenerationTask
): string | undefined {
	const kind = TASK_BRIDGE[task];
	const label = TASK_LABELS[task];
	if (kind === "audio") {
		return bridge?.audio && features?.["media.audio"] !== false
			? undefined
			: `${label} generation is unavailable in this host. Open the app in Ryu with media permissions; the local score stays available.`;
	}
	if (kind === "image") {
		return bridge?.image
			? undefined
			: `${label} is unavailable in this host. Open the app in Ryu with media permissions and an image model configured.`;
	}
	if (!bridge?.video) {
		return `${label} is unavailable in this host. Open the app in Ryu with media permissions and a video model configured.`;
	}
	if (features && features["media.video.inputs"] === false) {
		return `${label} needs a host that forwards reference inputs to video models. Update Ryu to use it.`;
	}
	return undefined;
}

/** Run one task request on the host bridge and return its media. */
export async function requestTaskMedia(
	bridge: MediaBridge | undefined,
	generation: GenerationRequest,
	inputs: TaskInputs
): Promise<string> {
	const task = generation.task;
	if (!task) {
		throw new Error("This request has no generation task.");
	}
	const reason = taskUnavailableReason(bridge, undefined, task);
	if (reason) {
		throw new Error(reason);
	}
	const kind = TASK_BRIDGE[task];
	if (kind === "audio" && bridge?.audio) {
		return generatedDataUrl(
			await bridge.audio(audioTaskInput(generation)),
			"audio"
		);
	}
	if (kind === "image" && bridge?.image) {
		return generatedDataUrl(
			await bridge.image(imageTaskInput(generation, inputs)),
			"image"
		);
	}
	if (bridge?.video) {
		return generatedDataUrl(
			await bridge.video(videoTaskInput(generation, inputs)),
			"video"
		);
	}
	throw new Error(`${TASK_LABELS[task]} is unavailable in this host.`);
}

/**
 * Record, run and save one task. `readInputs` runs after the request is
 * recorded, so a refused budget never reads media.
 */
export async function runTaskGeneration(
	services: GenerationServices,
	generation: GenerationRequest,
	readInputs: () => Promise<TaskInputs> = async () => ({})
): Promise<SavedGeneration> {
	const task = generation.task;
	if (!task) {
		throw new Error("This request has no generation task.");
	}
	const reason = taskUnavailableReason(services.bridge, undefined, task);
	if (reason) {
		throw new Error(reason);
	}
	return await runRecordedGeneration(services, generation, async () =>
		requestTaskMedia(services.bridge, generation, await readInputs())
	);
}

const chunkSchema = z.object({
	data: z.string(),
	done: z.boolean(),
});

/** Read a prepared generation input from the sidecar as a `data:` URI. */
export async function readGenerationInput(
	input: GenerationInput
): Promise<string> {
	const bytes = new Uint8Array(input.size);
	let offset = 0;
	for (;;) {
		const chunk = await request(
			chunkSchema,
			`/generation-inputs/${input.id}/data?offset=${offset}`
		);
		const part = Uint8Array.from(atob(chunk.data), (character) =>
			character.charCodeAt(0)
		);
		if (offset + part.length > bytes.length) {
			throw new Error("The model input is larger than prepared.");
		}
		bytes.set(part, offset);
		offset += part.length;
		if (chunk.done) {
			break;
		}
		if (!part.length) {
			throw new Error("The model input stream ended early.");
		}
	}
	if (offset !== bytes.length) {
		throw new Error("The model input stream ended early.");
	}
	return bytesDataUrl(bytes, input.mediaType);
}

/** Prepare a bounded extract of library media for a model. */
export async function prepareGenerationInput(
	assetId: string,
	body: StudioRequestBody
): Promise<GenerationInput> {
	return await request(
		generationInputSchema,
		`/assets/${assetId}/generation-input`,
		"POST",
		body
	);
}

/** Bridge feature flags from `host.capabilities`, when the host reports them. */
export async function hostBridgeFeatures(): Promise<
	Partial<StudioBridgeFeatures> | undefined
> {
	try {
		const capabilities = await window.ryu?.host?.capabilities?.();
		return capabilities?.bridge;
	} catch {
		return undefined;
	}
}

/** Editor-facing wording for a vision-model failure. */
export function visionErrorMessage(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	if (
		/image|vision|multimodal|image_url|content part|modalit/i.test(text) &&
		/not support|unsupported|cannot|does not|invalid|only text|text-only/i.test(
			text
		)
	) {
		return `The selected model cannot read images. Choose a vision model. (${text})`;
	}
	return text;
}
