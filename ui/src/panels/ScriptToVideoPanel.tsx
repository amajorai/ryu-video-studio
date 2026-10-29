import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Badge, Button, Input, Textarea } from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useRef, useState } from "react";
import { z } from "zod";
import { assetSchema } from "../../../shared/project.ts";
import {
	placeScriptMusic,
	type ScriptAvatarPreset,
	type ScriptMusic,
	scriptAvatarPresetSchema,
} from "../../../shared/script-extras.ts";
import {
	MAX_SCENE_NARRATION_CHARS,
	MAX_SCRIPT_CHARS,
	MAX_SCRIPT_TOPIC_CHARS,
	parseWrittenScript,
	type ScriptScene,
	scriptWriterRequest,
	storyboardScript,
} from "../../../shared/script-to-video.ts";
import {
	SOUNDTRACK_STYLES,
	type SoundtrackMood,
	soundtrackMoodSchema,
} from "../../../shared/soundtrack.ts";
import { MAX_SOUNDTRACK_DESCRIPTION } from "../../../shared/soundtrack-plan.ts";
import {
	type StockProvider,
	stockProviderSchema,
} from "../../../shared/stock.ts";
import {
	EMPTY_VOICE_CHOICE,
	type TtsVoiceChoice,
} from "../../../shared/tts-voices.ts";
import { hostGenerationServices } from "../ai/media-bridge.ts";
import { VoicePicker } from "../audio/VoicePicker.tsx";
import { request, studioResponseSchema } from "../bridge.ts";
import { useEditorProject } from "../editor/context.tsx";
import type { EditorRuntime } from "../editor/runtime.ts";
import { readViewerValue, writeViewerValue } from "../editor/viewer-storage.ts";
import { createSoundtrack } from "../SoundtrackPanel.tsx";
import {
	type AssembledSpan,
	assembleBody,
	assembledSpan,
	draftsFor,
	type ProductionOptions,
	planScript,
	produceScene,
	type SceneDraft,
	type ScriptPipelineServices,
	scoreAssembledScript,
	searchStockVisuals,
	transcribeNarration,
	type VisualSource,
} from "./script-to-video-pipeline.ts";
import type { PanelTab } from "./types.ts";

/**
 * Its own library tab while this is non-null; otherwise the panel mounts
 * inside its home category (Plan), next to the storyboard.
 */
export const scriptToVideoPanelTab: PanelTab | null = null;

type CaptionMode = "none" | "segments" | "words" | "single-word";

const captionModeSchema = z.enum(["none", "segments", "words", "single-word"]);
/** Music bed choice: none, a style picked from the description, or a style. */
type MusicChoice = "none" | "auto" | SoundtrackMood;
const musicChoiceSchema = z.union([
	z.enum(["none", "auto"]),
	soundtrackMoodSchema,
]);
const AVATAR_LABELS = {
	corner: "Small, bottom right corner",
	"presenter-left": "Presenter on the left",
	"presenter-right": "Presenter on the right",
} as const satisfies Record<ScriptAvatarPreset, string>;
const avatarChoiceSchema = z.union([
	z.literal("none"),
	scriptAvatarPresetSchema,
]);
const visualSourceSchema = z.enum(["stock", "generated"]);

const CAPTION_LABELS: Record<CaptionMode, string> = {
	none: "No captions",
	segments: "One caption per sentence group",
	"single-word": "One word at a time",
	words: "Short phrases",
};

const PROVIDER_LABELS: Record<StockProvider, string> = {
	"archive.org": "Archive.org",
	coverr: "Coverr (node-configured)",
	nasa: "NASA Images and Video",
	"openverse.audio": "Openverse audio",
	"openverse.image": "Openverse images",
	pexels: "Pexels (node-configured)",
	pixabay: "Pixabay (node-configured)",
	"unsplash.image": "Unsplash images (node-configured)",
	"wikimedia.commons": "Wikimedia Commons",
};

const VISUAL_PROVIDERS = stockProviderSchema.options.filter(
	(provider) => provider !== "openverse.audio"
);

const SCRIPT_KEY = "script-to-video-script";

const STEP_LABELS: Record<NonNullable<SceneDraft["step"]>, string> = {
	narration: "Making narration",
	transcript: "Timing words",
	visual: "Finding visual",
};

/** The music bed request for the panel's choice and description. */
export function musicSettings(
	choice: Exclude<MusicChoice, "none">,
	description: string
): ScriptMusic {
	const settings: ScriptMusic = {};
	if (choice !== "auto") {
		settings.mood = choice;
	}
	if (description.trim()) {
		settings.description = description.trim();
	}
	return settings;
}

/** Short status for a scene row. */
export function sceneStatusText(draft: SceneDraft): string {
	if (draft.status === "working") {
		return draft.step ? `${STEP_LABELS[draft.step]}…` : "Working…";
	}
	if (draft.status === "failed") {
		return `Failed${draft.step ? ` while ${STEP_LABELS[draft.step].toLowerCase()}` : ""}: ${draft.error ?? "unknown error"}`;
	}
	if (draft.status === "ready") {
		return draft.transcribed
			? "Ready · word-timed"
			: "Ready · estimated caption timing";
	}
	return "Not produced yet";
}

/** Status line after assembly, from the route's extras. */
export function assemblySummary(extras: Record<string, unknown>): string {
	const scenes = Array.isArray(extras.scenes) ? extras.scenes.length : 0;
	const seconds = typeof extras.duration === "number" ? extras.duration : 0;
	const captions = typeof extras.captions === "number" ? extras.captions : 0;
	const replaced =
		typeof extras.replacedCaptions === "number" ? extras.replacedCaptions : 0;
	const avatars = Array.isArray(extras.avatars) ? extras.avatars.length : 0;
	const presenter = avatars
		? `, a presenter avatar in ${avatars} scene${avatars === 1 ? "" : "s"}`
		: "";
	return `Assembled ${scenes} scene${scenes === 1 ? "" : "s"} (${seconds.toFixed(1)} s) with ${captions} caption${captions === 1 ? "" : "s"}${presenter}${replaced ? `; replaced ${replaced} overlapping` : ""}. Review rights for stock media before publishing.`;
}

/** Host- and sidecar-backed pipeline services for the open editor. */
function hostServices(runtime: EditorRuntime): ScriptPipelineServices {
	const services: ScriptPipelineServices = {
		generation: hostGenerationServices(() => undefined),
		importStock: async (result) =>
			assetSchema.parse(
				await request(studioResponseSchema, "/stock", "POST", {
					identifier: result.identifier,
					provider: result.provider,
				})
			),
		onAsset: (asset) =>
			runtime.setAssets((current) =>
				current.some((item) => item.id === asset.id)
					? current
					: [...current, asset]
			),
		searchStock: searchStockVisuals,
	};
	const complete = window.ryu?.model?.complete;
	if (complete) {
		services.complete = (input) => complete(input);
	}
	if (window.ryu?.media?.transcribe) {
		services.transcribe = transcribeNarration;
	}
	return services;
}

function SceneRow({
	disabled,
	draft,
	index,
	onChange,
	onRemove,
	onRetry,
}: {
	disabled: boolean;
	draft: SceneDraft;
	index: number;
	onChange: (scene: ScriptScene, reset: Partial<SceneDraft>) => void;
	onRemove: () => void;
	onRetry: () => void;
}) {
	const label = `Scene ${index + 1}`;
	return (
		<div className="studio-scene" data-script-scene={draft.id}>
			<div className="flex items-center justify-between gap-2">
				<strong>{label}</strong>
				<Badge
					variant={draft.status === "failed" ? "destructive" : "secondary"}
				>
					{draft.status}
				</Badge>
			</div>
			<RyuAppField label="Narration">
				<Textarea
					aria-label={`${label} narration`}
					disabled={disabled}
					maxLength={MAX_SCENE_NARRATION_CHARS}
					onChange={(event) =>
						onChange(
							{ ...draft.scene, narration: event.target.value },
							// New words need new narration and timing.
							{
								narrationAssetId: undefined,
								status: "pending",
								transcribed: false,
								transcriptNote: undefined,
							}
						)
					}
					value={draft.scene.narration}
				/>
			</RyuAppField>
			<RyuAppField label="Stock search">
				<Input
					aria-label={`${label} stock search`}
					disabled={disabled}
					maxLength={200}
					onChange={(event) =>
						onChange(
							{ ...draft.scene, visualQuery: event.target.value },
							{ status: "pending", visualAssetId: undefined }
						)
					}
					value={draft.scene.visualQuery}
				/>
			</RyuAppField>
			<RyuAppField label="Image prompt">
				<Textarea
					aria-label={`${label} image prompt`}
					disabled={disabled}
					maxLength={2000}
					onChange={(event) =>
						onChange(
							{ ...draft.scene, imagePrompt: event.target.value },
							{ status: "pending", visualAssetId: undefined }
						)
					}
					value={draft.scene.imagePrompt}
				/>
			</RyuAppField>
			<small aria-live="polite">{sceneStatusText(draft)}</small>
			{draft.transcriptNote && <small>{draft.transcriptNote}</small>}
			<RyuAppActions>
				{draft.status === "failed" && (
					<Button
						disabled={disabled}
						onClick={onRetry}
						size="sm"
						variant="outline"
					>
						Retry {label.toLowerCase()}
					</Button>
				)}
				<Button
					disabled={disabled}
					onClick={onRemove}
					size="sm"
					variant="ghost"
				>
					Remove
				</Button>
			</RyuAppActions>
		</div>
	);
}

/**
 * Script to video: split a script into scenes with Ryu (or locally), make
 * narration and a stock or generated visual per scene through the budget and
 * approval gates, then assemble narration, visuals, and word-timed captions
 * into the timeline.
 */
export function ScriptToVideoPanel() {
	const runtime = useEditorProject();
	const { busy, project, routeEdit, setStatus } = runtime;
	const [script, setScript] = useState(() =>
		readViewerValue(
			`${SCRIPT_KEY}:${project.id}`,
			z.string().max(MAX_SCRIPT_CHARS),
			""
		)
	);
	const [drafts, setDrafts] = useState<SceneDraft[]>([]);
	const [planning, setPlanning] = useState(false);
	const [producing, setProducing] = useState(false);
	const [visualSource, setVisualSource] = useState<VisualSource>("stock");
	const [provider, setProvider] = useState<StockProvider>("openverse.image");
	const [voice, setVoice] = useState<TtsVoiceChoice>(EMPTY_VOICE_CHOICE);
	const [captions, setCaptions] = useState<CaptionMode>("words");
	const [gap, setGap] = useState(0);
	const [music, setMusic] = useState<MusicChoice>("none");
	const [musicDescription, setMusicDescription] = useState("");
	const [avatar, setAvatar] = useState<ScriptAvatarPreset | "none">("none");
	const [scoring, setScoring] = useState(false);
	const [topic, setTopic] = useState("");
	const [targetSeconds, setTargetSeconds] = useState(60);
	const [writing, setWriting] = useState(false);
	const cancel = useRef(false);
	const working = planning || producing || writing || scoring || busy;
	const storyboard = storyboardScript(project.scenes);
	const options: ProductionOptions = {
		engine: voice.voice.trim() ? voice.engine : "",
		language: voice.language,
		provider,
		visualSource,
		voice: voice.voice,
	};

	const changeScript = (value: string) => {
		setScript(value);
		writeViewerValue(`${SCRIPT_KEY}:${project.id}`, value);
	};
	const replaceDraft = (next: SceneDraft) =>
		setDrafts((current) =>
			current.map((item) => (item.id === next.id ? next : item))
		);

	const writeScript = async () => {
		const complete = window.ryu?.model?.complete;
		if (!complete) {
			setStatus("Ryu's model service is unavailable on this surface.");
			return;
		}
		setWriting(true);
		setStatus("Writing a script with Ryu…");
		try {
			const written = parseWrittenScript(
				await complete(
					scriptWriterRequest(topic, {
						brief: project.brief,
						seconds: targetSeconds,
						title: project.title,
					})
				)
			);
			changeScript(written);
			setDrafts([]);
			setStatus("Script written. Edit it if you like, then plan the scenes.");
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Writing failed.");
		} finally {
			setWriting(false);
		}
	};

	const applyStoryboard = () => {
		changeScript(storyboard);
		setDrafts([]);
		setStatus(
			`Script filled from ${project.scenes.filter((scene) => scene.script.trim()).length} storyboard scene${project.scenes.length === 1 ? "" : "s"}.`
		);
	};

	const plan = async () => {
		setPlanning(true);
		try {
			const services = hostServices(runtime);
			const result = await planScript(script, services.complete);
			setDrafts(draftsFor(result.scenes));
			setStatus(
				`${result.scenes.length} scene${result.scenes.length === 1 ? "" : "s"} planned ${result.source === "model" ? "with Ryu" : "locally (Ryu's model is unavailable)"}. Review them before producing media.`
			);
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Planning failed.");
		} finally {
			setPlanning(false);
		}
	};

	const produce = async (only?: string) => {
		setProducing(true);
		cancel.current = false;
		const services = hostServices(runtime);
		let failed = 0;
		try {
			const queue = drafts.filter((draft) =>
				only ? draft.id === only : draft.status !== "ready"
			);
			for (const [position, draft] of queue.entries()) {
				if (cancel.current) {
					setStatus("Production stopped. Finished scenes are kept.");
					return;
				}
				setStatus(`Producing scene ${position + 1} of ${queue.length}…`);
				const result = await produceScene(
					project.id,
					draft,
					options,
					services,
					replaceDraft
				);
				if (result.status === "failed") {
					failed += 1;
				}
			}
			setStatus(
				failed
					? `${failed} scene${failed === 1 ? "" : "s"} failed. Retry them or edit their search words.`
					: "Scenes are ready to assemble."
			);
		} finally {
			setProducing(false);
		}
	};

	/** Score a music bed over the assembled span and place it, ducked. */
	const addMusic = async (span: AssembledSpan | undefined) => {
		const current = runtime.latestProject.current;
		if (music === "none" || !(span && current)) {
			return;
		}
		setScoring(true);
		setStatus("Scoring a music bed for the assembly on the node…");
		try {
			const scored = await scoreAssembledScript({
				assets: runtime.assets,
				complete: hostServices(runtime).complete,
				create: (body) =>
					createSoundtrack(body, {
						onBackground: () =>
							setStatus("Composing a long music bed in the background…"),
					}),
				music: musicSettings(music, musicDescription),
				project: current,
				span,
			});
			runtime.setAssets((items) =>
				items.some((item) => item.id === scored.asset.id)
					? items
					: [...items, scored.asset]
			);
			const placement = {
				duration: span.duration,
				start: span.scenes[0]?.start ?? 0,
			};
			const latest = runtime.latestProject.current ?? current;
			// Throws here, before the edit, when no audio track is free.
			placeScriptMusic(latest, runtime.assets, scored.asset, placement);
			runtime.latestEdit(
				(project) =>
					placeScriptMusic(project, runtime.assets, scored.asset, placement)
						.project,
				() =>
					[
						`Added a ${scored.planner === "model" ? "Ryu-planned" : "local"} music bed under the narration, ducked while it speaks.`,
						scored.note,
					]
						.filter(Boolean)
						.join(" ")
			);
		} catch (error) {
			setStatus(
				`The edit was assembled, but the music bed failed: ${error instanceof Error ? error.message : "unknown error"}`
			);
		} finally {
			setScoring(false);
		}
	};

	const assemble = async () => {
		try {
			const body = assembleBody(drafts, {
				avatar: avatar === "none" ? undefined : avatar,
				captions,
				chunking: project.captionChunking,
				gap,
			});
			const outcome = await routeEdit(
				"script-assemble",
				body,
				assemblySummary,
				{ refreshAssets: true }
			);
			if (outcome.status === "ok") {
				await addMusic(assembledSpan(outcome.extras));
			}
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Assembly failed.");
		}
	};

	const ready =
		drafts.length > 0 && drafts.every((draft) => draft.status === "ready");
	const hasModel = Boolean(window.ryu?.model?.complete);
	return (
		<RyuAppSection title="Script to video">
			<p className="text-muted-foreground">
				Paste a script, have Ryu write one from a topic, or use the storyboard's
				scene scripts. Ryu splits it into scenes, narrates each one, finds or
				generates a visual, and assembles the edit with captions timed to the
				narration. Every generation uses the project budget and Ryu's approval
				prompts.
			</p>
			<RyuAppField
				description="What the video is about, who it is for, and the tone."
				label="Topic"
			>
				<Textarea
					aria-label="Script topic"
					disabled={working}
					maxLength={MAX_SCRIPT_TOPIC_CHARS}
					onChange={(event) => setTopic(event.target.value)}
					placeholder="For example: a friendly one-minute explainer on how tides work"
					rows={2}
					value={topic}
				/>
			</RyuAppField>
			<RyuAppField label="Script length (seconds)">
				<Input
					aria-label="Script length"
					disabled={working}
					max={600}
					min={10}
					onChange={(event) => setTargetSeconds(Number(event.target.value))}
					step={5}
					type="number"
					value={targetSeconds}
				/>
			</RyuAppField>
			<RyuAppActions>
				<Button
					disabled={working || !topic.trim() || !hasModel}
					onClick={() => void writeScript()}
					title={hasModel ? undefined : "Ryu's model service is unavailable"}
					variant="outline"
				>
					{writing ? "Writing…" : "Write script with Ryu"}
				</Button>
				<Button
					disabled={working || !storyboard}
					onClick={applyStoryboard}
					title={
						storyboard
							? "Replace the script with the storyboard's scene scripts"
							: "The storyboard has no scene scripts yet (Plan tab)"
					}
					variant="ghost"
				>
					Use storyboard scripts
				</Button>
			</RyuAppActions>
			<RyuAppField label="Script">
				<Textarea
					aria-label="Script"
					disabled={working}
					maxLength={MAX_SCRIPT_CHARS}
					onChange={(event) => changeScript(event.target.value)}
					placeholder="The words your narrator should say, in order."
					value={script}
				/>
			</RyuAppField>
			<RyuAppActions>
				<Button
					disabled={working || !script.trim()}
					onClick={() => void plan()}
					variant="outline"
				>
					{planning
						? "Planning scenes…"
						: hasModel
							? "Plan scenes with Ryu"
							: "Split into scenes"}
				</Button>
			</RyuAppActions>
			{drafts.length > 0 && (
				<>
					<RyuAppField label="Visuals">
						<NativeSelect
							aria-label="Scene visuals"
							disabled={working}
							onChange={(event) => {
								setVisualSource(visualSourceSchema.parse(event.target.value));
							}}
							value={visualSource}
						>
							<NativeSelectOption value="stock">
								Open stock media
							</NativeSelectOption>
							<NativeSelectOption value="generated">
								Generated images
							</NativeSelectOption>
						</NativeSelect>
					</RyuAppField>
					{visualSource === "stock" && (
						<RyuAppField label="Stock catalog">
							<NativeSelect
								aria-label="Stock catalog"
								disabled={working}
								onChange={(event) =>
									setProvider(stockProviderSchema.parse(event.target.value))
								}
								value={provider}
							>
								{VISUAL_PROVIDERS.map((value) => (
									<NativeSelectOption key={value} value={value}>
										{PROVIDER_LABELS[value]}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</RyuAppField>
					)}
					<VoicePicker
						disabled={working}
						onChange={setVoice}
						value={voice}
						voiceAriaLabel="Narration voice"
						voiceLabel="Narration voice (optional)"
					/>
					<RyuAppField label="Captions">
						<NativeSelect
							aria-label="Caption style"
							disabled={working}
							onChange={(event) =>
								setCaptions(captionModeSchema.parse(event.target.value))
							}
							value={captions}
						>
							{captionModeSchema.options.map((value) => (
								<NativeSelectOption key={value} value={value}>
									{CAPTION_LABELS[value]}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</RyuAppField>
					<RyuAppField label="Pause between scenes">
						<NativeSelect
							aria-label="Pause between scenes"
							disabled={working}
							onChange={(event) => setGap(Number(event.target.value))}
							value={String(gap)}
						>
							<NativeSelectOption value="0">None</NativeSelectOption>
							<NativeSelectOption value="0.25">0.25 s</NativeSelectOption>
							<NativeSelectOption value="0.5">0.5 s</NativeSelectOption>
							<NativeSelectOption value="1">1 s</NativeSelectOption>
						</NativeSelect>
					</RyuAppField>
					<RyuAppField
						description="A local soundtrack scored over the assembly, ducked under the narration."
						label="Music bed"
					>
						<NativeSelect
							aria-label="Music bed"
							disabled={working}
							onChange={(event) =>
								setMusic(musicChoiceSchema.parse(event.target.value))
							}
							value={music}
						>
							<NativeSelectOption value="none">No music</NativeSelectOption>
							<NativeSelectOption value="auto">
								Match the description
							</NativeSelectOption>
							{soundtrackMoodSchema.options.map((mood) => (
								<NativeSelectOption key={mood} value={mood}>
									{SOUNDTRACK_STYLES[mood].label}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</RyuAppField>
					{music !== "none" && (
						<RyuAppField
							description={
								hasModel
									? "Optional. Ryu plans style, tempo, layers and energy from it and the assembled scenes."
									: "Optional. Style words such as calm, epic, lo-fi or upbeat pick the style."
							}
							label="Describe the music"
						>
							<Textarea
								aria-label="Music bed description"
								disabled={working}
								maxLength={MAX_SOUNDTRACK_DESCRIPTION}
								onChange={(event) => setMusicDescription(event.target.value)}
								placeholder="For example: calm piano that builds to warm drums"
								rows={2}
								value={musicDescription}
							/>
						</RyuAppField>
					)}
					<RyuAppField
						description="A 2.5D presenter for each scene, lip-synced to its narration."
						label="Presenter avatar"
					>
						<NativeSelect
							aria-label="Presenter avatar"
							disabled={working}
							onChange={(event) =>
								setAvatar(avatarChoiceSchema.parse(event.target.value))
							}
							value={avatar}
						>
							<NativeSelectOption value="none">No avatar</NativeSelectOption>
							{scriptAvatarPresetSchema.options.map((preset) => (
								<NativeSelectOption key={preset} value={preset}>
									{AVATAR_LABELS[preset]}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</RyuAppField>
					{drafts.map((draft, index) => (
						<SceneRow
							disabled={working}
							draft={draft}
							index={index}
							key={draft.id}
							onChange={(scene, reset) =>
								replaceDraft({ ...draft, ...reset, error: undefined, scene })
							}
							onRemove={() =>
								setDrafts((current) =>
									current.filter((item) => item.id !== draft.id)
								)
							}
							onRetry={() => void produce(draft.id)}
						/>
					))}
					<RyuAppActions>
						{producing ? (
							<Button
								onClick={() => {
									cancel.current = true;
								}}
								variant="outline"
							>
								Stop after this scene
							</Button>
						) : (
							<Button
								disabled={working || ready}
								onClick={() => void produce()}
								variant="outline"
							>
								Produce narration and visuals
							</Button>
						)}
						<Button
							disabled={working || !ready}
							onClick={() => void assemble()}
						>
							Assemble timeline
						</Button>
					</RyuAppActions>
				</>
			)}
		</RyuAppSection>
	);
}
