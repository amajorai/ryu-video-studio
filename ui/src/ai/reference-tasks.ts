/**
 * Editor runners for reference-input generation (G46, G74, G76, G78, G79,
 * G80). Each prepares bounded inputs through the sidecar, runs the task on
 * the host bridge through `runTaskGeneration`, and hands the saved result to
 * a placement callback. Every step that can refuse predictably runs before
 * anything is recorded or sent.
 */
import { z } from "zod";
import {
	gapFillMotionRequest,
	gapFillNeighbors,
	localMotionGapRefusal,
	motionGapRefusal,
} from "../../../shared/gap-fill.ts";
import { LIKENESS_CONSENT_NOTICE } from "../../../shared/generation.ts";
import {
	type GenerationInput,
	generationInputSchema,
} from "../../../shared/generation-inputs.ts";
import {
	type GenerationTask,
	LOCAL_ENGINE_PROVIDER,
	presetFor,
	providerInputProblems,
} from "../../../shared/generation-models.ts";
import {
	type Asset,
	assetSchema,
	type Project,
	type Segment,
} from "../../../shared/project.ts";
import type { SfxKind } from "../../../shared/sfx.ts";
import { sfxGenerationPrompt } from "../../../shared/sfx.ts";
import {
	parseShotDescriptions,
	SHOT_DESCRIPTION_BATCH,
	shotDescriptionPrompt,
} from "../../../shared/shot-index.ts";
import {
	type SoundtrackMood,
	soundtrackGenerationPrompt,
} from "../../../shared/soundtrack.ts";
import { request } from "../bridge.ts";
import { timelineTimingKey } from "../editing-ui.ts";
import type { GenerationServices, SavedGeneration } from "./media-bridge.ts";
import {
	assertTaskChoice,
	LOCAL_ENGINE_CHOICE_ID,
	prepareGenerationInput,
	readGenerationInput,
	runTaskGeneration,
	type TaskModelChoice,
	taskGenerationRequest,
	taskUnavailableReason,
} from "./task-generation.ts";

const newId = () => crypto.randomUUID();

/**
 * Place library media over a timeline range (the overwrite edit). `sourceOut`
 * is in the placed media's own seconds; `speed` (default 1) sets how fast it
 * plays, so the take covers `sourceOut / speed` seconds of timeline.
 */
export type PlaceOver = (placement: {
	assetId: string;
	at: number;
	sourceOut: number;
	speed?: number;
	track: number;
	volume?: number;
}) => Promise<boolean>;

/**
 * The overwrite edit body and route options for a placement whose inputs
 * were prepared from `inputs` (a saved timeline). The plan stamp makes the
 * editor refuse the edit as a conflict when clips moved, were trimmed, or
 * changed speed while the model was working.
 */
export function overwritePlacementEdit(
	inputs: Pick<Project, "segments">,
	placement: Parameters<PlaceOver>[0]
): {
	body: { at: number; entries: Record<string, unknown>[]; track: number };
	options: { planStamp: string; refreshAssets: true };
} {
	const entry: Record<string, unknown> = {
		assetId: placement.assetId,
		sourceIn: 0,
		sourceOut: placement.sourceOut,
	};
	if (placement.speed !== undefined && placement.speed !== 1) {
		entry.speed = placement.speed;
	}
	if (placement.volume !== undefined) {
		entry.volume = placement.volume;
	}
	return {
		body: { at: placement.at, entries: [entry], track: placement.track },
		options: { planStamp: timelineTimingKey(inputs), refreshAssets: true },
	};
}

/** Speeds the overwrite edit accepts for a placed take. */
const TAKE_SPEED_RANGE = { max: 4, min: 0.25 } as const;

/**
 * The constant speed a take must play at to replace `segment` exactly: the
 * clip's own speed. A speed curve, or a speed the overwrite edit cannot
 * place, is refused before anything is sent, because the take would not line
 * up with the clip it replaces.
 */
export function takeSpeedFor(
	segment: Pick<Segment, "speed" | "speedCurve">,
	tool: string
): number {
	if (segment.speedCurve) {
		throw new Error(
			`${tool} cannot follow a speed ramp. Remove the clip's speed curve (or set a constant speed) first.`
		);
	}
	if (
		segment.speed < TAKE_SPEED_RANGE.min - 1e-9 ||
		segment.speed > TAKE_SPEED_RANGE.max + 1e-9
	) {
		throw new Error(
			`${tool} places its take at the clip's speed, between ${TAKE_SPEED_RANGE.min * 100}% and ${TAKE_SPEED_RANGE.max * 100}%. Change this clip's speed first.`
		);
	}
	return segment.speed;
}

export interface TaskRunResult extends SavedGeneration {
	/** The derivative or fitted asset the timeline uses, when not `asset`. */
	output?: Asset;
	placed: boolean;
	/** The input was shortened to the model's limit. */
	truncated: boolean;
}

function assertAvailable(services: GenerationServices, task: GenerationTask) {
	const reason = taskUnavailableReason(services.bridge, undefined, task);
	if (reason) {
		throw new Error(reason);
	}
}

/**
 * AI edit → Video (G78): send the clip's source range (at most 10 s, 720p,
 * H.264 CRF 28) to a video-to-video model and place the result as a take
 * over the clip's start.
 */
export async function runVideoToVideo(context: {
	asset: Asset;
	choice: TaskModelChoice;
	place?: PlaceOver;
	projectId: string;
	prompt: string;
	segment: Segment;
	services: GenerationServices;
}): Promise<TaskRunResult> {
	const { asset, segment, services } = context;
	if (asset.kind !== "video") {
		throw new Error(
			"AI edit → Video needs a video clip. Use Edit with AI for stills."
		);
	}
	assertAvailable(services, "v2v");
	const speed = takeSpeedFor(segment, "AI edit → Video");
	await services.admit(context.projectId, "video");
	const input = await prepareGenerationInput(asset.id, {
		audio: true,
		end: segment.sourceOut,
		kind: "clip",
		start: segment.sourceIn,
	});
	const generation = taskGenerationRequest({
		choice: context.choice,
		id: newId(),
		projectId: context.projectId,
		prompt: context.prompt,
		purpose: "ai-edit",
		sourceAssetId: asset.id,
		sourceRange: { end: input.end, start: input.start },
		task: "v2v",
	});
	const saved = await runTaskGeneration(services, generation, async () => ({
		video: await readGenerationInput(input),
	}));
	// The take's time 0 is `input.start`, so it covers the same source span
	// as the clip, played at the clip's speed.
	const placed = context.place
		? await context.place({
				assetId: saved.asset.id,
				at: segment.start,
				sourceOut: Math.min(saved.asset.duration, input.end - input.start),
				speed,
				track: segment.track,
			})
		: false;
	return { ...saved, placed, truncated: input.end < segment.sourceOut - 1e-6 };
}

const MATTE_PROMPT =
	"Separate the main subject from the background and return its matte.";

/**
 * AI matte (G46): ask a cloud segmentation model for the subject's matte,
 * save it, and apply it with the sidecar's alphamerge as a transparent
 * derivative. Stills keep their clip; clips get the matted range as a take.
 */
export async function runAiMatte(context: {
	asset: Asset;
	choice: TaskModelChoice;
	invert?: boolean;
	place?: PlaceOver;
	projectId: string;
	segment: Segment;
	services: GenerationServices;
	swapStill?: (clipId: string, asset: Asset) => Promise<boolean>;
}): Promise<TaskRunResult> {
	const { asset, segment, services } = context;
	if (asset.kind === "audio") {
		throw new Error("AI matting needs a picture clip.");
	}
	const task: GenerationTask =
		asset.kind === "image" ? "matte-image" : "matte-video";
	assertAvailable(services, task);
	const speed =
		asset.kind === "video" ? takeSpeedFor(segment, "AI matte") : undefined;
	await services.admit(context.projectId, asset.kind);
	let input: GenerationInput | undefined;
	if (asset.kind === "video") {
		input = await prepareGenerationInput(asset.id, {
			audio: false,
			end: segment.sourceOut,
			kind: "clip",
			start: segment.sourceIn,
		});
	}
	const generation = taskGenerationRequest({
		choice: context.choice,
		id: newId(),
		projectId: context.projectId,
		prompt: MATTE_PROMPT,
		sourceAssetId: asset.id,
		...(input ? { sourceRange: { end: input.end, start: input.start } } : {}),
		task,
	});
	const saved = await runTaskGeneration(services, generation, async () =>
		input
			? { video: await readGenerationInput(input) }
			: { images: [await services.readImage(asset)] }
	);
	const output = await request(
		assetSchema,
		`/assets/${asset.id}/ai-matte`,
		"POST",
		{
			invert: context.invert ?? false,
			matteAssetId: saved.asset.id,
			...(input ? { end: input.end, start: input.start } : {}),
		}
	);
	let placed = false;
	if (asset.kind === "image") {
		placed = (await context.swapStill?.(segment.id, output)) ?? false;
	} else if (context.place && input) {
		placed = await context.place({
			assetId: output.id,
			at: segment.start,
			sourceOut: Math.min(output.duration, input.end - input.start),
			speed: speed ?? 1,
			track: segment.track,
		});
	}
	return {
		...saved,
		output,
		placed,
		truncated: input ? input.end < segment.sourceOut - 1e-6 : false,
	};
}

const gapFramesSchema = z.object({
	gap: z.number(),
	motionSeconds: z.number(),
	next: z.object({
		assetId: z.string(),
		frame: z.number(),
		input: generationInputSchema,
	}),
	previous: z.object({
		assetId: z.string(),
		frame: z.number(),
		input: generationInputSchema,
	}),
});

/**
 * Generate motion (G79): extract the exact boundary frames, animate between
 * them with a first/last-frame model, and place the clip in the gap.
 */
export async function runGapFillMotion(context: {
	assets: readonly Asset[];
	choice: TaskModelChoice;
	clipId: string;
	direction?: string;
	place: (placement: {
		afterClipId: string;
		assetId: string;
	}) => Promise<string | undefined>;
	project: Project;
	services: GenerationServices;
}): Promise<SavedGeneration & { placedClipId?: string }> {
	const neighbors = gapFillNeighbors(
		context.project,
		context.assets,
		context.clipId
	);
	const refusal = motionGapRefusal(neighbors.gap, context.project.fps);
	if (refusal) {
		throw new Error(refusal);
	}
	assertAvailable(context.services, "flf");
	const local = assertTaskChoice("flf", context.choice);
	const localRefusal = local ? localMotionGapRefusal(neighbors.gap) : undefined;
	if (localRefusal) {
		throw new Error(localRefusal);
	}
	const problems = local
		? []
		: providerInputProblems("flf", context.choice.providerInput);
	if (problems.length) {
		throw new Error(problems.join(" "));
	}
	await context.services.admit(context.project.id, "video");
	const frames = gapFramesSchema.parse(
		await request(
			z.json(),
			`/projects/${context.project.id}/gap-fill-frames`,
			"POST",
			{
				afterClipId: context.clipId,
				revision: context.project.revision,
			}
		)
	);
	const generation = gapFillMotionRequest({
		direction: context.direction,
		durationSeconds: frames.motionSeconds,
		id: newId(),
		model: local ? "" : context.choice.model.trim(),
		nextAssetId: frames.next.assetId,
		presetId: local ? LOCAL_ENGINE_CHOICE_ID : context.choice.presetId,
		previousAssetId: frames.previous.assetId,
		projectId: context.project.id,
		provider: local ? LOCAL_ENGINE_PROVIDER : context.choice.provider.trim(),
		providerInput: local ? undefined : context.choice.providerInput,
		route: local ? "local" : undefined,
	});
	const saved = await runTaskGeneration(
		context.services,
		generation,
		async () => ({
			images: [
				await readGenerationInput(frames.previous.input),
				await readGenerationInput(frames.next.input),
			],
		})
	);
	const placedClipId = await context.place({
		afterClipId: context.clipId,
		assetId: saved.asset.id,
	});
	return placedClipId ? { ...saved, placedClipId } : saved;
}

const photorealSchema = z.object({
	audio: generationInputSchema,
	picture: generationInputSchema,
	plan: z.object({
		audio: z.object({
			assetId: z.string(),
			end: z.number(),
			start: z.number(),
		}),
		duration: z.number(),
		mode: z.enum(["lipsync", "avatar"]),
		picture: z.object({
			assetId: z.string(),
			end: z.number(),
			start: z.number(),
		}),
		start: z.number(),
		track: z.number(),
		truncated: z.boolean(),
	}),
});

/** Model-facing instructions (sent to the model, never shown as UI copy). */
const PHOTOREAL_PROMPTS: Record<"avatar" | "lipsync", string> = {
	avatar: [
		"Animate this portrait so the person speaks the audio naturally,",
		"keeping identity, framing and lighting.",
	].join(" "),
	lipsync: [
		"Re-time the speaker's mouth to the audio,",
		"keeping identity, framing and lighting.",
	].join(" "),
};

/**
 * Photoreal (cloud) lip-sync or talking avatar (G80). `consent` must be the
 * sender's confirmation that the people shown agreed; it is recorded in the
 * request and the result's provenance. The result is placed muted over the
 * picture clip, so the narration or TTS clip stays the audio.
 */
export async function runPhotoreal(context: {
	audioClipId: string;
	choice: TaskModelChoice;
	consent: boolean;
	mode: "lipsync" | "avatar";
	pictureClipId: string;
	place?: PlaceOver;
	project: Project;
	services: GenerationServices;
}): Promise<TaskRunResult> {
	if (!context.consent) {
		throw new Error(LIKENESS_CONSENT_NOTICE);
	}
	assertAvailable(context.services, context.mode);
	await context.services.admit(context.project.id, "video");
	const prepared = photorealSchema.parse(
		await request(
			z.json(),
			`/projects/${context.project.id}/avatars/photoreal-inputs`,
			"POST",
			{
				audioClipId: context.audioClipId,
				consent: "subjects-agreed",
				mode: context.mode,
				pictureClipId: context.pictureClipId,
				revision: context.project.revision,
			}
		)
	);
	const { plan } = prepared;
	const generation = taskGenerationRequest({
		audioAssetId: plan.audio.assetId,
		choice: context.choice,
		consent: "subjects-agreed",
		id: newId(),
		projectId: context.project.id,
		prompt: PHOTOREAL_PROMPTS[context.mode],
		sourceAssetId: plan.picture.assetId,
		...(context.mode === "lipsync"
			? { sourceRange: { end: plan.picture.end, start: plan.picture.start } }
			: {}),
		task: context.mode,
	});
	const saved = await runTaskGeneration(
		context.services,
		generation,
		async () => {
			const picture = await readGenerationInput(prepared.picture);
			const audio = await readGenerationInput(prepared.audio);
			return context.mode === "lipsync"
				? { audio, video: picture }
				: { audio, images: [picture] };
		}
	);
	const placed = context.place
		? await context.place({
				assetId: saved.asset.id,
				at: plan.start,
				sourceOut: Math.min(saved.asset.duration, plan.duration),
				track: plan.track,
				volume: 0,
			})
		: false;
	return { ...saved, placed, truncated: plan.truncated };
}

/**
 * Generated music or a sound effect (G74) from `media.audio`, fitted to
 * `duration` by the sidecar with the model provenance kept.
 */
export async function runGeneratedAudio(context: {
	choice: TaskModelChoice;
	description?: string;
	duration: number;
	music?: { bpm: number; mood: SoundtrackMood };
	projectId: string;
	services: GenerationServices;
	sfxKind?: SfxKind;
}): Promise<SavedGeneration & { output: Asset }> {
	const task: GenerationTask = context.music ? "music" : "sfx";
	assertAvailable(context.services, task);
	const prompt = context.music
		? soundtrackGenerationPrompt({
				bpm: context.music.bpm,
				description: context.description,
				duration: context.duration,
				mood: context.music.mood,
			})
		: sfxGenerationPrompt({
				description: context.description,
				duration: context.duration,
				kind: context.sfxKind ?? "whoosh",
			});
	const preset = presetFor(task, context.choice.presetId);
	const generation = taskGenerationRequest({
		choice: context.choice,
		durationSeconds: context.duration,
		id: newId(),
		projectId: context.projectId,
		prompt,
		promptField:
			preset && preset.id === context.choice.presetId
				? preset.promptField
				: undefined,
		task,
	});
	const saved = await runTaskGeneration(context.services, generation);
	const output = await request(
		assetSchema,
		task === "music" ? "/soundtrack-conform" : "/sfx-conform",
		"POST",
		{ assetId: saved.asset.id, duration: context.duration }
	);
	return { ...saved, output };
}

const keyframesSchema = z.object({
	analysisCreatedAt: z.string(),
	keyframes: z.array(
		z.object({
			end: z.number(),
			frame: z.number(),
			image: z.string(),
			index: z.number(),
			start: z.number(),
		})
	),
	revision: z.number(),
	total: z.number(),
});

/** Model-facing instruction for shot descriptions (never shown as UI copy). */
const VISION_SYSTEM_PROMPT = [
	"You describe video keyframes for a media search index.",
	"Answer with JSON only.",
].join(" ");

/** Vision batches stay under `model.complete`'s 1.5 MiB image budget. */
const MAX_BATCH_IMAGE_CHARS = 1_400_000;

/**
 * Describe an analyzed source's shots with a vision model (G76): keyframes
 * in batches of at most six go to `model.complete` with a JSON schema, and
 * the captions and tags are stored on the shot index. Returns how many
 * shots were described. A model that cannot read images is reported as such.
 */
export async function describeShotsWithVision(context: {
	assetId: string;
	complete: NonNullable<NonNullable<Window["ryu"]>["model"]>["complete"];
	model?: string;
	onProgress?: (done: number, total: number) => void;
	provider?: string;
	signal?: AbortSignal;
}): Promise<number> {
	let offset = 0;
	let described = 0;
	for (;;) {
		context.signal?.throwIfAborted();
		const batch = keyframesSchema.parse(
			await request(
				z.json(),
				`/assets/${context.assetId}/shots/keyframes`,
				"POST",
				{
					limit: SHOT_DESCRIPTION_BATCH,
					offset,
				}
			)
		);
		if (!batch.keyframes.length) {
			break;
		}
		const frames: typeof batch.keyframes = [];
		let chars = 0;
		for (const frame of batch.keyframes) {
			if (frames.length && chars + frame.image.length > MAX_BATCH_IMAGE_CHARS) {
				break;
			}
			frames.push(frame);
			chars += frame.image.length;
		}
		const indices = frames.map((frame) => frame.index);
		const input: Parameters<typeof context.complete>[0] = {
			images: frames.map((frame) => frame.image),
			prompt: shotDescriptionPrompt(indices),
			system: VISION_SYSTEM_PROMPT,
		};
		if (context.provider) {
			input.provider = context.provider;
		}
		if (context.model) {
			input.model = context.model;
		}
		const answer = await context.complete(input);
		const shots = parseShotDescriptions(answer, indices);
		await request(
			z.json(),
			`/assets/${context.assetId}/shots/descriptions`,
			"POST",
			{
				analysisCreatedAt: batch.analysisCreatedAt,
				model: context.model ?? "",
				provider: context.provider ?? "",
				revision: batch.revision,
				shots,
			}
		);
		described += shots.length;
		offset += frames.length;
		context.onProgress?.(Math.min(offset, batch.total), batch.total);
		if (offset >= batch.total) {
			break;
		}
	}
	return described;
}
