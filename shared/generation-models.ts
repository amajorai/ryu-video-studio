/**
 * Editable model presets for reference-input generation tasks.
 *
 * Queue-based cloud providers (Fal, Replicate) name their input fields per
 * model, so a request carries the model-specific fields in `provider_input`.
 * Video and audio jobs reference the canonical inputs Core resolves:
 * `"$input_video"`, `"$input_audio"`, `"$input_images.0"`,
 * `"$input_images.1"` and `"$duration_s"`. Image jobs (`media.image`) have no
 * reference resolution, so the app inlines the still in place of
 * `"$input_images.0"` itself (see `resolveImageProviderInput`).
 *
 * Every row here is a PRESET: the model ids and field names come from the
 * providers' public model pages. They were not verified against a live
 * provider from this repository, so each preset is marked `verified: false`
 * and the editor lets the user replace the model id and the field map.
 */
import { z } from "zod";

export const generationTaskSchema = z.enum([
	"v2v",
	"flf",
	"lipsync",
	"avatar",
	"matte-image",
	"matte-video",
	"music",
	"sfx",
]);
export type GenerationTask = z.infer<typeof generationTaskSchema>;

/**
 * Provider id that runs a task on the node's own media engine instead of a
 * cloud model. It sends the canonical inputs with no `provider_input`; Core
 * maps them to the active local model or refuses with the reason.
 */
export const LOCAL_ENGINE_PROVIDER = "local";

/**
 * Tasks the local engine can run. First/last-frame motion runs on an
 * installed Wan first/last-frame model selected as the node's local diffusion
 * model; the other tasks have no local model, so they stay cloud-only.
 */
export const LOCAL_ENGINE_TASKS: ReadonlySet<GenerationTask> = new Set(["flf"]);

/** Whether `provider` selects the local engine. */
export function isLocalEngineProvider(provider: string): boolean {
	return provider.trim().toLowerCase() === LOCAL_ENGINE_PROVIDER;
}

/** Canonical inputs a video or audio job can reference from `provider_input`. */
export const PROVIDER_INPUT_REFERENCES = [
	"$input_images.0",
	"$input_images.1",
	"$input_video",
	"$input_audio",
	"$duration_s",
] as const;
export type ProviderInputReference = (typeof PROVIDER_INPUT_REFERENCES)[number];

/** JSON a preset may place in `provider_input`. */
export type PresetJson =
	| string
	| number
	| boolean
	| null
	| PresetJson[]
	| { [key: string]: PresetJson };

/** Bridge method each task runs on. */
export const TASK_BRIDGE: Record<GenerationTask, "image" | "video" | "audio"> =
	{
		avatar: "video",
		flf: "video",
		lipsync: "video",
		"matte-image": "image",
		"matte-video": "video",
		music: "audio",
		sfx: "audio",
		v2v: "video",
	};

/** Canonical inputs each task sends; a preset must reference each one once. */
export const TASK_INPUTS: Record<
	GenerationTask,
	readonly ProviderInputReference[]
> = {
	avatar: ["$input_images.0", "$input_audio"],
	flf: ["$input_images.0", "$input_images.1"],
	lipsync: ["$input_video", "$input_audio"],
	"matte-image": ["$input_images.0"],
	"matte-video": ["$input_video"],
	music: [],
	sfx: [],
	v2v: ["$input_video"],
};

export const TASK_LABELS: Record<GenerationTask, string> = {
	avatar: "Talking avatar",
	flf: "First/last-frame motion",
	lipsync: "Lip-sync",
	"matte-image": "Subject matte (still)",
	"matte-video": "Subject matte (video)",
	music: "Music",
	sfx: "Sound effect",
	v2v: "Video-to-video edit",
};

export interface GenerationModelPreset {
	/** Stable preset id, `<provider>:<model>`. */
	id: string;
	label: string;
	/** Provider-side model id passed as `model`. */
	model: string;
	/** Short reminder of what the model expects, shown in the picker. */
	note: string;
	/** Whether the prompt is also sent in a model-specific field. */
	promptField?: string;
	/** Cloud provider routed by Core and the Gateway. */
	provider: "fal" | "replicate";
	/**
	 * Model-specific fields merged into the provider body. References such as
	 * `"$input_video"` are resolved by Core (video and audio) or the app (image).
	 */
	providerInput: Record<string, PresetJson>;
	task: GenerationTask;
	/** Always false here: field names come from provider docs, not a live call. */
	verified: false;
}

const preset = (
	row: Omit<GenerationModelPreset, "id" | "verified">
): GenerationModelPreset => ({
	...row,
	id: `${row.provider}:${row.model}`,
	verified: false,
});

/** The preset table. Edit a row (or pick "Custom") to match a provider change. */
export const GENERATION_MODEL_PRESETS: readonly GenerationModelPreset[] = [
	preset({
		label: "Wan VACE 14B",
		model: "fal-ai/wan-vace-14b",
		note: "Restyles or edits a source clip following the prompt.",
		provider: "fal",
		providerInput: { video_url: "$input_video" },
		task: "v2v",
	}),
	preset({
		label: "Luma Ray 2 Modify",
		model: "fal-ai/luma-dream-machine/ray-2/modify",
		note: "Changes the look of a source clip while keeping its motion.",
		provider: "fal",
		providerInput: { video_url: "$input_video" },
		task: "v2v",
	}),
	preset({
		label: "Wan first/last frame",
		model: "fal-ai/wan-flf2v",
		note: "Animates from a start frame to an end frame.",
		provider: "fal",
		providerInput: {
			end_image_url: "$input_images.1",
			start_image_url: "$input_images.0",
		},
		task: "flf",
	}),
	preset({
		label: "Kling image-to-video (tail frame)",
		model: "fal-ai/kling-video/v1.6/pro/image-to-video",
		note: "Animates from a start image toward a tail image.",
		provider: "fal",
		providerInput: {
			image_url: "$input_images.0",
			tail_image_url: "$input_images.1",
		},
		task: "flf",
	}),
	preset({
		label: "Sync Lipsync",
		model: "fal-ai/sync-lipsync",
		note: "Re-times the mouth in a clip to a new audio track.",
		provider: "fal",
		providerInput: { audio_url: "$input_audio", video_url: "$input_video" },
		task: "lipsync",
	}),
	preset({
		label: "LatentSync (Fal)",
		model: "fal-ai/latentsync",
		note: "Lip-syncs a face clip to an audio track.",
		provider: "fal",
		providerInput: { audio_url: "$input_audio", video_url: "$input_video" },
		task: "lipsync",
	}),
	preset({
		label: "LatentSync (Replicate)",
		model: "bytedance/latentsync",
		note: "Lip-syncs a face clip to an audio track.",
		provider: "replicate",
		providerInput: { audio: "$input_audio", video: "$input_video" },
		task: "lipsync",
	}),
	preset({
		label: "SadTalker",
		model: "fal-ai/sadtalker",
		note: "Animates a portrait still to speak an audio track.",
		provider: "fal",
		providerInput: {
			driven_audio_url: "$input_audio",
			source_image_url: "$input_images.0",
		},
		task: "avatar",
	}),
	preset({
		label: "Kling AI avatar",
		model: "fal-ai/kling-video/v1/pro/ai-avatar",
		note: "Animates a portrait still to speak an audio track.",
		provider: "fal",
		providerInput: { audio_url: "$input_audio", image_url: "$input_images.0" },
		task: "avatar",
	}),
	preset({
		label: "BiRefNet v2",
		model: "fal-ai/birefnet/v2",
		note: "Separates the subject of a still; returns a PNG with alpha.",
		provider: "fal",
		providerInput: { image_url: "$input_images.0" },
		task: "matte-image",
	}),
	preset({
		label: "BiRefNet v2 video",
		model: "fal-ai/birefnet/v2/video",
		note: "Separates the subject of a clip; returns a matte video.",
		provider: "fal",
		providerInput: { video_url: "$input_video" },
		task: "matte-video",
	}),
	preset({
		label: "Stable Audio",
		model: "fal-ai/stable-audio",
		note: "Instrumental music from a text prompt.",
		provider: "fal",
		providerInput: { seconds_total: "$duration_s" },
		task: "music",
	}),
	preset({
		label: "MusicGen",
		model: "meta/musicgen",
		note: "Instrumental music from a text prompt.",
		provider: "replicate",
		providerInput: { duration: "$duration_s" },
		task: "music",
	}),
	preset({
		label: "ElevenLabs sound effects",
		model: "fal-ai/elevenlabs/sound-effects",
		note: "A sound effect from a text description.",
		promptField: "text",
		provider: "fal",
		providerInput: { duration_seconds: "$duration_s" },
		task: "sfx",
	}),
];

/** Presets for one task, in table order. */
export function presetsForTask(
	task: GenerationTask,
	table: readonly GenerationModelPreset[] = GENERATION_MODEL_PRESETS
): GenerationModelPreset[] {
	return table.filter((row) => row.task === task);
}

/** The preset with `id` for `task`, or the task's first preset. */
export function presetFor(
	task: GenerationTask,
	id?: string,
	table: readonly GenerationModelPreset[] = GENERATION_MODEL_PRESETS
): GenerationModelPreset | undefined {
	const rows = presetsForTask(task, table);
	return rows.find((row) => row.id === id) ?? rows[0];
}

/** Keys the host bridge refuses inside `provider_input`. */
const RESERVED_KEYS = new Set([
	"model",
	"provider",
	"prompt",
	"request_id",
	"n",
	"project_id",
	"input_images",
	"input_video",
	"input_audio",
	"input_mask",
	"provider_input",
	"duration_s",
	"kind",
]);

function collectReferences(value: PresetJson, found: string[]): void {
	if (typeof value === "string") {
		if (value.startsWith("$")) {
			found.push(value);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			collectReferences(item, found);
		}
		return;
	}
	if (value && typeof value === "object") {
		for (const item of Object.values(value)) {
			collectReferences(item, found);
		}
	}
}

/**
 * Check a (possibly user-edited) field map for `task`: no reserved keys, only
 * known references, and each input the task sends referenced exactly once.
 * Returns the problems found; an empty list means the map is usable.
 */
export function providerInputProblems(
	task: GenerationTask,
	providerInput: Record<string, PresetJson>,
	options: { duration: boolean } = { duration: false }
): string[] {
	const problems: string[] = [];
	for (const key of Object.keys(providerInput)) {
		if (RESERVED_KEYS.has(key)) {
			problems.push(`“${key}” is set by Ryu and cannot be a model field.`);
		}
	}
	const references: string[] = [];
	for (const value of Object.values(providerInput)) {
		collectReferences(value, references);
	}
	const known = new Set<string>(PROVIDER_INPUT_REFERENCES);
	for (const reference of references) {
		if (!known.has(reference)) {
			problems.push(`“${reference}” is not an input Ryu can send.`);
		}
	}
	const required = [
		...TASK_INPUTS[task],
		...(options.duration ? (["$duration_s"] as const) : []),
	];
	for (const input of required) {
		const count = references.filter((reference) => reference === input).length;
		if (count === 0) {
			problems.push(`Map ${input} to the model's field for it.`);
		} else if (count > 1) {
			problems.push(`${input} is mapped more than once.`);
		}
	}
	for (const reference of new Set(references)) {
		if (
			known.has(reference) &&
			!required.includes(reference as ProviderInputReference)
		) {
			problems.push(`${reference} is not sent for this task.`);
		}
	}
	return problems;
}

/** Parse an edited field map; throws with an editor-facing reason. */
export function parseProviderInput(text: string): Record<string, PresetJson> {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("Model fields must be a JSON object.");
	}
	const parsed = z
		.record(z.string().min(1).max(128), z.json())
		.safeParse(value);
	if (!parsed.success || Array.isArray(value)) {
		throw new Error("Model fields must be a JSON object.");
	}
	if (Object.keys(parsed.data).length > 64) {
		throw new Error("Model fields take at most 64 entries.");
	}
	return parsed.data as Record<string, PresetJson>;
}

/**
 * The `provider_input` for one request: the preset's field map plus the
 * prompt in the model's own prompt field when the model names one.
 */
export function presetProviderInput(
	row: Pick<GenerationModelPreset, "promptField" | "providerInput">,
	prompt: string
): Record<string, PresetJson> {
	const fields: Record<string, PresetJson> = structuredClone(row.providerInput);
	if (row.promptField && !(row.promptField in fields)) {
		fields[row.promptField] = prompt;
	}
	return fields;
}

function replaceReference(
	value: PresetJson,
	reference: string,
	replacement: string
): PresetJson {
	if (value === reference) {
		return replacement;
	}
	if (Array.isArray(value)) {
		return value.map((item) => replaceReference(item, reference, replacement));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				replaceReference(item, reference, replacement),
			])
		);
	}
	return value;
}

/**
 * `media.image` does not resolve references, so an image task inlines the
 * still where the preset names `"$input_images.0"`.
 */
export function resolveImageProviderInput(
	fields: Record<string, PresetJson>,
	imageDataUrl: string
): Record<string, PresetJson> {
	const references: string[] = [];
	for (const value of Object.values(fields)) {
		collectReferences(value, references);
	}
	if (references.filter((item) => item === "$input_images.0").length !== 1) {
		throw new Error("Map $input_images.0 to the model's image field once.");
	}
	return Object.fromEntries(
		Object.entries(fields).map(([key, value]) => [
			key,
			replaceReference(value, "$input_images.0", imageDataUrl),
		])
	);
}
