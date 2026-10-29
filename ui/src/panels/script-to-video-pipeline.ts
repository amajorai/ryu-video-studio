/**
 * The script-to-video production pipeline behind `ScriptToVideoPanel`:
 * plan scenes, then per scene make narration (Ryu narration), transcribe it
 * for word timing, and find (stock) or generate (image) a visual. Every
 * generation runs through `runGeneration`, so the project budget gate and
 * the host's own approval gate apply. Host and sidecar calls are injected so
 * the pipeline is tested without either.
 */
import { z } from "zod";
import type { Asset, Project } from "../../../shared/project.ts";
import type { CaptionChunking } from "../../../shared/schema/caption-style.ts";
import {
	type ScriptAvatarPreset,
	type ScriptMusic,
	scriptMusicRequest,
} from "../../../shared/script-extras.ts";
import {
	heuristicScriptScenes,
	parseScriptPlan,
	type ScriptScene,
	scriptSplitRequest,
} from "../../../shared/script-to-video.ts";
import type { SoundtrackRequest } from "../../../shared/soundtrack.ts";
import {
	planSoundtrack,
	soundtrackPlanInput,
	soundtrackRequestFromPlan,
} from "../../../shared/soundtrack-plan.ts";
import {
	type StockProvider,
	type StockSearchResult,
	stockSearchResponseSchema,
} from "../../../shared/stock.ts";
import {
	transcriptSchema,
	transcriptWindowCues,
	transcriptWindowInputSchema,
	transcriptWindowWords,
	transcriptWordsInputSchema,
} from "../../../shared/transcript.ts";
import { type GenerationServices, runGeneration } from "../ai/media-bridge.ts";
import { request, studioResponseSchema, transcribeInput } from "../bridge.ts";

export type VisualSource = "stock" | "generated";

/** One scene as it moves through production. */
export interface SceneDraft {
	error?: string;
	id: string;
	narrationAssetId?: string;
	scene: ScriptScene;
	status: "pending" | "working" | "ready" | "failed";
	/** The step running or last attempted. */
	step?: "narration" | "transcript" | "visual";
	/** Whether the narration has a saved transcript (word-timed captions). */
	transcribed?: boolean;
	/** Set when transcription was skipped or failed (captions use estimates). */
	transcriptNote?: string;
	visualAssetId?: string;
}

export interface ProductionOptions {
	/** Speech engine of `voice`; empty lets the host pick. */
	engine?: string;
	/** Narration language; empty lets the voice decide. */
	language?: string;
	/** Stock catalog searched when `visualSource` is stock. */
	provider: StockProvider;
	visualSource: VisualSource;
	/** Narration voice; empty lets the host pick. */
	voice: string;
}

export interface ScriptPipelineServices {
	/** Ryu's model (`model.complete`); absent splits the script locally. */
	complete?: (input: { prompt: string; system: string }) => Promise<string>;
	generation: GenerationServices;
	importStock: (result: StockSearchResult) => Promise<Asset>;
	/** Library media added by the pipeline, as soon as it exists. */
	onAsset?: (asset: Asset) => void;
	searchStock: (
		provider: StockProvider,
		query: string
	) => Promise<StockSearchResult[]>;
	/** Save a word transcript for an asset; absent skips word timing. */
	transcribe?: (assetId: string) => Promise<void>;
}

/** Fresh drafts for planned scenes. */
export function draftsFor(
	scenes: readonly ScriptScene[],
	newId: () => string = () => crypto.randomUUID()
): SceneDraft[] {
	return scenes.map((scene) => ({ id: newId(), scene, status: "pending" }));
}

/**
 * Split `script` into scenes with Ryu's model, or locally when the model is
 * unavailable. `source` says which planner produced them.
 */
export async function planScript(
	script: string,
	complete: ScriptPipelineServices["complete"],
	maxScenes?: number
): Promise<{ scenes: ScriptScene[]; source: "model" | "local" }> {
	if (!complete) {
		return {
			scenes: heuristicScriptScenes(script, { maxScenes }),
			source: "local",
		};
	}
	const reply = await complete(scriptSplitRequest(script, { maxScenes }));
	return { scenes: parseScriptPlan(reply), source: "model" };
}

/** Stock formats the assembler can place as a visual. */
export function isVisualStockResult(result: StockSearchResult): boolean {
	const format = result.format.toLowerCase();
	return !/(audio|mp3|wav|ogg|flac|aac|m4a|opus)/.test(format);
}

const MAX_STOCK_ATTEMPTS = 3;

async function stockVisual(
	scene: ScriptScene,
	options: ProductionOptions,
	services: ScriptPipelineServices
): Promise<Asset> {
	const results = (
		await services.searchStock(options.provider, scene.visualQuery)
	).filter(isVisualStockResult);
	if (!results.length) {
		throw new Error(
			`No stock visuals matched “${scene.visualQuery}”. Edit the search words or switch to generated images.`
		);
	}
	let lastError: unknown;
	for (const result of results.slice(0, MAX_STOCK_ATTEMPTS)) {
		try {
			const asset = await services.importStock(result);
			if (asset.kind === "audio") {
				lastError = new Error("The stock result was audio.");
				continue;
			}
			return asset;
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("Stock import failed.");
}

const errorText = (error: unknown, fallback: string) =>
	error instanceof Error ? error.message : fallback;

/**
 * Produce what `draft` still lacks: narration, its transcript, then a
 * visual. Finished steps are kept, so calling it again retries only the
 * failed step. `onChange` receives every intermediate draft.
 */
export async function produceScene(
	projectId: string,
	draft: SceneDraft,
	options: ProductionOptions,
	services: ScriptPipelineServices,
	onChange: (draft: SceneDraft) => void = () => undefined
): Promise<SceneDraft> {
	let current: SceneDraft = { ...draft, error: undefined, status: "working" };
	const update = (patch: Partial<SceneDraft>) => {
		current = { ...current, ...patch };
		onChange(current);
	};
	update({});
	try {
		if (!current.narrationAssetId) {
			update({ step: "narration" });
			const narration = await runGeneration(services.generation, {
				id: crypto.randomUUID(),
				kind: "audio",
				projectId,
				prompt: current.scene.narration,
				rationale: "Script to video narration",
				voice: options.voice,
				language: options.language ?? "",
				...(options.engine && options.voice ? { engine: options.engine } : {}),
			});
			services.onAsset?.(narration.asset);
			update({ narrationAssetId: narration.asset.id, transcribed: false });
		}
		if (
			!(current.transcribed || current.transcriptNote) &&
			services.transcribe
		) {
			update({ step: "transcript" });
			try {
				await services.transcribe(current.narrationAssetId ?? "");
				update({ transcribed: true });
			} catch (error) {
				// Captions fall back to estimated timing; production continues.
				update({
					transcriptNote: `Captions use estimated timing: ${errorText(error, "transcription failed.")}`,
				});
			}
		}
		if (!current.visualAssetId) {
			update({ step: "visual" });
			const visual =
				options.visualSource === "stock"
					? await stockVisual(current.scene, options, services)
					: (
							await runGeneration(services.generation, {
								id: crypto.randomUUID(),
								kind: "image",
								projectId,
								prompt: current.scene.imagePrompt,
								rationale: "Script to video scene still",
							})
						).asset;
			services.onAsset?.(visual);
			update({ visualAssetId: visual.id });
		}
		update({ status: "ready", step: undefined });
	} catch (error) {
		update({
			error: errorText(error, "Scene production failed."),
			status: "failed",
		});
	}
	return current;
}

/** Body for `POST /projects/:id/script-assemble` (the revision is added by the caller). */
export function assembleBody(
	drafts: readonly SceneDraft[],
	settings: {
		/** A presenter avatar per scene, lip-synced to its narration. */
		avatar?: ScriptAvatarPreset;
		captions: "none" | "segments" | "words" | "single-word";
		/** The project's saved chunking; its limits and filters are kept. */
		chunking?: CaptionChunking;
		gap: number;
	}
): Record<string, unknown> {
	const scenes = drafts.map((draft, index) => {
		if (!(draft.narrationAssetId && draft.visualAssetId)) {
			throw new Error(`Scene ${index + 1} still needs narration and a visual.`);
		}
		return {
			narrationAssetId: draft.narrationAssetId,
			text: draft.scene.narration,
			visualAssetId: draft.visualAssetId,
		};
	});
	const body: Record<string, unknown> = { gap: settings.gap, scenes };
	if (settings.avatar) {
		body.avatar = { preset: settings.avatar };
	}
	if (settings.captions === "none") {
		body.captions = false;
	} else {
		body.captionChunking = { ...settings.chunking, mode: settings.captions };
	}
	return body;
}

const assembledSpanSchema = z.object({
	duration: z.number().positive(),
	scenes: z.array(z.object({ end: z.number(), start: z.number() })).min(1),
});

/** Where an assembly landed, from the `script-assemble` route's extras. */
export type AssembledSpan = z.infer<typeof assembledSpanSchema>;
export const assembledSpan = (
	extras: Record<string, unknown>
): AssembledSpan | undefined => {
	const parsed = assembledSpanSchema.safeParse(extras);
	return parsed.success ? parsed.data : undefined;
};

type SoundtrackBody = Pick<SoundtrackRequest, "bpm" | "duration" | "mood"> &
	Partial<Pick<SoundtrackRequest, "downbeatOffset" | "layers" | "sections">>;

export interface ScoredMusic {
	asset: Asset;
	/** Set when the model plan failed and the local plan was used instead. */
	note?: string;
	planner: "model" | "local";
}

/**
 * Score a music bed for an assembled script. With a description and Ryu's
 * model, the soundtrack planner reads the assembled span (cuts, markers) and
 * picks style, tempo, layers and sections; an explicit mood still wins.
 * Otherwise (or when planning fails) the local plan picks the style by
 * keyword and changes sections at scene starts. `create` renders the body
 * (`createSoundtrack`, which waits for a background job).
 */
export async function scoreAssembledScript(input: {
	assets: readonly Asset[];
	complete?: ScriptPipelineServices["complete"];
	create: (body: SoundtrackBody) => Promise<Asset>;
	music: ScriptMusic;
	project: Project;
	span: AssembledSpan;
}): Promise<ScoredMusic> {
	const { music, span } = input;
	const start = span.scenes[0]?.start ?? 0;
	let note: string | undefined;
	let planned: SoundtrackBody | undefined;
	if (music.description?.trim() && input.complete) {
		try {
			const plan = await planSoundtrack(
				soundtrackPlanInput(
					input.project,
					input.assets,
					{ end: start + span.duration, start },
					music.description
				),
				input.complete
			);
			const body = soundtrackRequestFromPlan(plan, span.duration);
			planned = music.mood ? { ...body, mood: music.mood } : body;
		} catch (error) {
			note = `Ryu's music plan failed (${errorText(error, "no plan")}), so a local plan was used.`;
		}
	}
	const scored: ScoredMusic = {
		asset: await input.create(planned ?? scriptMusicRequest(span, music)),
		planner: planned ? "model" : "local",
	};
	if (note) {
		scored.note = note;
	}
	return scored;
}

/** The host media bridge transcription, saved window by window like the Transcript panel. */
export async function transcribeNarration(assetId: string): Promise<void> {
	const service = window.ryu?.media?.transcribe;
	if (!service) {
		throw new Error("transcription is unavailable on this host.");
	}
	let current = transcriptSchema.parse(
		await request(
			studioResponseSchema,
			`/assets/${assetId}/transcript`,
			"POST",
			{
				language: "auto",
			}
		)
	);
	while (current.status === "running") {
		const audio = await request(
			z.object({
				dataUrl: z.string(),
				duration: z.number(),
				start: z.number(),
			}),
			`/assets/${assetId}/audio-window`,
			"POST",
			{ start: current.nextOffset }
		);
		const result = await service(transcribeInput(audio.dataUrl, "auto"));
		const cueInput = transcriptWindowInputSchema.safeParse(result);
		const wordInput = transcriptWordsInputSchema.safeParse(result);
		current = transcriptSchema.parse(
			await request(
				studioResponseSchema,
				`/assets/${assetId}/transcript`,
				"PUT",
				{
					cues: transcriptWindowCues(
						cueInput.success ? cueInput.data : "",
						audio.start,
						audio.duration
					),
					offset: current.nextOffset,
					revision: current.revision,
					timing:
						cueInput.success && cueInput.data.segments?.length
							? "segments"
							: "windows",
					words: transcriptWindowWords(
						wordInput.success ? wordInput.data : undefined,
						audio.start,
						audio.duration
					),
				}
			)
		);
	}
	if (current.status !== "completed") {
		throw new Error(current.error ?? "transcription stopped.");
	}
}

/** Stock search through the sidecar. */
export async function searchStockVisuals(
	provider: StockProvider,
	query: string
): Promise<StockSearchResult[]> {
	const value = await request(
		z.json(),
		`/stock/search?provider=${encodeURIComponent(provider)}&q=${encodeURIComponent(query.trim())}&limit=8`
	);
	return stockSearchResponseSchema.parse(value).results;
}
