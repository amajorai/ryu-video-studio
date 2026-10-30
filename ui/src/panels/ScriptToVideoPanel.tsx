import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Input, Textarea } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useRef, useState } from "react";
import { z } from "zod";
import {
	placeScriptMusic,
	type ScriptAvatarPreset,
} from "../../../shared/script-extras.ts";
import {
	MAX_SCRIPT_CHARS,
	MAX_SCRIPT_TOPIC_CHARS,
	parseWrittenScript,
	scriptWriterRequest,
	storyboardScript,
} from "../../../shared/script-to-video.ts";
import type { StockProvider } from "../../../shared/stock.ts";
import {
	EMPTY_VOICE_CHOICE,
	type TtsVoiceChoice,
} from "../../../shared/tts-voices.ts";
import { useEditorProject } from "../editor/context.tsx";
import { readViewerValue, writeViewerValue } from "../editor/viewer-storage.ts";
import { createSoundtrack } from "../SoundtrackPanel.tsx";
import {
	assemblySummary,
	type CaptionMode,
	type MusicChoice,
	musicSettings,
	SCRIPT_KEY,
} from "./ScriptToVideoPanel-model.ts";
import { ProductionSettings } from "./ScriptToVideoPanel-production-settings.tsx";
import { SceneRow } from "./ScriptToVideoPanel-scene-row.tsx";
import { hostServices } from "./ScriptToVideoPanel-services.ts";
import {
	type AssembledSpan,
	assembleBody,
	assembledSpan,
	draftsFor,
	type ProductionOptions,
	planScript,
	produceScene,
	type SceneDraft,
	scoreAssembledScript,
	type VisualSource,
} from "./script-to-video-pipeline.ts";
import type { PanelTab } from "./types.ts";

export {
	assemblySummary,
	musicSettings,
	sceneStatusText,
} from "./ScriptToVideoPanel-model.ts";

/**
 * Its own library tab while this is non-null; otherwise the panel mounts
 * inside its home category (Plan), next to the storyboard.
 */
export const scriptToVideoPanelTab: PanelTab | null = null;

/**
 * Script to video: split a script into scenes with Ryu (or locally), make
 * narration and a stock or generated visual per scene through the budget and
 * approval gates, then assemble narration, visuals, and word-timed captions
 * into the timeline.
 */
export function ScriptToVideoPanel() {
	const tl = useLiteralMessages();
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
			tl(
				"Script filled from {count} storyboard {total, plural, one {scene} other {scenes}}.",
				{
					count: project.scenes.filter((scene) => scene.script.trim()).length,
					total: project.scenes.length,
				}
			)
		);
	};

	const plan = async () => {
		setPlanning(true);
		try {
			const services = hostServices(runtime);
			const result = await planScript(script, services.complete);
			setDrafts(draftsFor(result.scenes));
			setStatus(
				result.source === "model"
					? tl(
							"{count, plural, one {# scene} other {# scenes}} planned with Ryu. Review them before producing media.",
							{ count: result.scenes.length }
						)
					: tl(
							"{count, plural, one {# scene} other {# scenes}} planned locally (Ryu's model is unavailable). Review them before producing media.",
							{ count: result.scenes.length }
						)
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
				setStatus(
					tl("Producing scene {position} of {total}…", {
						position: position + 1,
						total: queue.length,
					})
				);
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
					? tl(
							"{failed, plural, one {# scene} other {# scenes}} failed. Retry them or edit their search words.",
							{ failed }
						)
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
				tl("The edit was assembled, but the music bed failed: {error}", {
					error: error instanceof Error ? error.message : "unknown error",
				})
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
					<ProductionSettings
						avatar={avatar}
						captions={captions}
						gap={gap}
						hasModel={hasModel}
						music={music}
						musicDescription={musicDescription}
						provider={provider}
						setAvatar={setAvatar}
						setCaptions={setCaptions}
						setGap={setGap}
						setMusic={setMusic}
						setMusicDescription={setMusicDescription}
						setProvider={setProvider}
						setVisualSource={setVisualSource}
						setVoice={setVoice}
						visualSource={visualSource}
						voice={voice}
						working={working}
					/>
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
