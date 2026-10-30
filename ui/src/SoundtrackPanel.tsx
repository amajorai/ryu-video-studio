import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Input, Textarea } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useContext, useState } from "react";
import type { Asset } from "../../shared/project.ts";
import { assetSchema } from "../../shared/project.ts";
import {
	SFX_DEFAULT_DURATIONS,
	SFX_LABELS,
	type SfxKind,
} from "../../shared/sfx.ts";
import {
	MAX_GENERATED_MUSIC_SECONDS,
	SOUNDTRACK_STYLES,
	type SoundtrackLayer,
	type SoundtrackMood,
	type SoundtrackSection,
	soundtrackLayersOf,
	soundtrackMoodSchema,
} from "../../shared/soundtrack.ts";
import {
	MAX_SOUNDTRACK_DESCRIPTION,
	planSoundtrack,
	soundtrackPlanInput,
} from "../../shared/soundtrack-plan.ts";
import { useBridgeFeatures } from "./ai/AiVideoTools.tsx";
import { hostGenerationServices, hostMediaBridge } from "./ai/media-bridge.ts";
import { runGeneratedAudio } from "./ai/reference-tasks.ts";
import { initialTaskChoice, TaskModelFields } from "./ai/TaskModelFields.tsx";
import {
	type TaskModelChoice,
	taskUnavailableReason,
} from "./ai/task-generation.ts";
import { request } from "./bridge.ts";
import { EditorContext } from "./editor/context.tsx";
import { SoundtrackLayerFields } from "./SoundtrackPanel-layer-fields.tsx";
import { SoundtrackSfxSection } from "./SoundtrackPanel-sfx-section.tsx";
import {
	createSoundtrack,
	errorMessage,
	formatSeconds,
	placeAtRange,
	soundtrackBody,
} from "./SoundtrackPanel-soundtrack-requests.ts";

export {
	createSoundtrack,
	errorMessage,
	placeAtRange,
	soundtrackBody,
	toggleLayer,
} from "./SoundtrackPanel-soundtrack-requests.ts";

export function SoundtrackPanel({
	onAsset,
	onStatus,
}: {
	onAsset: (asset: Asset) => void;
	onStatus: (message: string) => void;
}) {
	// Planning reads the open edit when the panel is mounted inside the editor.
	const editor = useContext(EditorContext);
	const [duration, setDuration] = useState(15);
	const [bpm, setBpm] = useState(96);
	const [mood, setMood] = useState<SoundtrackMood>("warm");
	const [layers, setLayers] = useState<SoundtrackLayer[] | undefined>();
	const [sections, setSections] = useState<SoundtrackSection[]>([]);
	const [downbeatOffset, setDownbeatOffset] = useState<number | undefined>();
	const [working, setWorking] = useState(false);
	const [planning, setPlanning] = useState(false);
	const [sfxKind, setSfxKind] = useState<SfxKind>("whoosh");
	const [sfxDuration, setSfxDuration] = useState<number | undefined>();
	const [sfxSeed, setSfxSeed] = useState(1);
	const [description, setDescription] = useState("");
	const [scoreRange, setScoreRange] = useState(false);
	// Generate (G74): music and sound effects from a cloud model through
	// `media.audio`. The local score stays the default and the fallback.
	const [musicSource, setMusicSource] = useState<"procedural" | "generate">(
		"procedural"
	);
	const [sfxSource, setSfxSource] = useState<"procedural" | "generate">(
		"procedural"
	);
	const [musicChoice, setMusicChoice] = useState<TaskModelChoice>(() =>
		initialTaskChoice("music")
	);
	const [sfxChoice, setSfxChoice] = useState<TaskModelChoice>(() =>
		initialTaskChoice("sfx")
	);
	const [sfxDescription, setSfxDescription] = useState("");
	const features = useBridgeFeatures();
	const tl = useLiteralMessages();
	const busy = working || planning;
	const markedRange =
		editor?.rangeMarked && editor.range.end - editor.range.start >= 0.5
			? editor.range
			: undefined;
	const range = scoreRange ? markedRange : undefined;
	const activeLayers = soundtrackLayersOf({ layers, mood });
	const project = editor?.project;
	const complete = window.ryu?.model?.complete;

	const chooseStyle = (next: SoundtrackMood) => {
		setMood(next);
		setBpm(SOUNDTRACK_STYLES[next].bpm);
		setLayers(undefined);
		setDownbeatOffset(undefined);
	};

	const plan = async () => {
		if (busy || !project || !complete) {
			return;
		}
		setPlanning(true);
		onStatus("Planning a soundtrack for this edit with Ryu…");
		try {
			const result = await planSoundtrack(
				soundtrackPlanInput(project, editor.assets, range, description),
				complete
			);
			setMood(result.style);
			// Keep the measured tempo and bar phase so changes land on downbeats.
			setBpm(result.bpm);
			setDownbeatOffset(result.downbeatOffset);
			setLayers(result.layers);
			setSections(result.sections);
			setDuration(result.sections.at(-1)?.end ?? duration);
			onStatus(
				tl(
					"Planned {count, plural, one {# soundtrack section} other {# soundtrack sections}} aligned to cuts and downbeats. Review, then create the soundtrack.",
					{ count: result.sections.length }
				)
			);
		} catch (error) {
			onStatus(errorMessage(error, "Soundtrack planning failed."));
		} finally {
			setPlanning(false);
		}
	};

	const generate = async () => {
		if (busy) {
			return;
		}
		setWorking(true);
		onStatus("Creating a local soundtrack on the node…");
		try {
			const asset = await createSoundtrack(
				soundtrackBody({
					bpm,
					downbeatOffset,
					duration: range ? range.end - range.start : duration,
					layers,
					mood: soundtrackMoodSchema.parse(mood),
					sections,
				}),
				{
					onBackground: () =>
						onStatus(
							"Composing a long soundtrack in the background on the node…"
						),
				}
			);
			onAsset(asset);
			if (range && editor) {
				editor.latestEdit(
					(current) => placeAtRange(current, editor.assets, asset, range),
					() =>
						`Score ${formatSeconds(range.start)} – ${formatSeconds(range.end)}`
				);
				onStatus(
					tl("Soundtrack saved and placed at {start} for the marked range.", {
						start: formatSeconds(range.start),
					})
				);
				return;
			}
			onStatus("Local soundtrack saved to the media library.");
		} catch (error) {
			onStatus(errorMessage(error, "Soundtrack generation failed."));
		} finally {
			setWorking(false);
		}
	};

	const generatedReason = (task: "music" | "sfx") =>
		taskUnavailableReason(hostMediaBridge(), features, task) ??
		(project ? undefined : "Open a project to generate audio for it.");

	const generateWithModel = async (task: "music" | "sfx") => {
		if (busy || !project || generatedReason(task)) {
			return;
		}
		setWorking(true);
		const length =
			task === "music"
				? Math.min(
						MAX_GENERATED_MUSIC_SECONDS,
						range ? range.end - range.start : duration
					)
				: (sfxDuration ?? SFX_DEFAULT_DURATIONS[sfxKind]);
		onStatus(
			task === "music"
				? tl("Generating music with the selected cloud model through Ryu…")
				: tl(
						"Generating a sound effect with the selected cloud model through Ryu…"
					)
		);
		try {
			const result = await runGeneratedAudio({
				choice: task === "music" ? musicChoice : sfxChoice,
				description: task === "music" ? description : sfxDescription,
				duration: length,
				...(task === "music"
					? { music: { bpm, mood: soundtrackMoodSchema.parse(mood) } }
					: { sfxKind }),
				projectId: project.id,
				services: hostGenerationServices(() => undefined),
			});
			onAsset(result.asset);
			onAsset(result.output);
			if (task === "music" && range && editor) {
				editor.latestEdit(
					(current) =>
						placeAtRange(current, editor.assets, result.output, range),
					() =>
						`Score ${formatSeconds(range.start)} – ${formatSeconds(range.end)}`
				);
			}
			onStatus(
				result.historyWarning ??
					(task === "music"
						? tl(
								"Generated music fitted to {duration} and saved to the library. The provider and model are recorded in the credits.",
								{ duration: formatSeconds(result.output.duration) }
							)
						: tl(
								"Generated sound effect fitted to {duration} and saved to the library. The provider and model are recorded in the credits.",
								{ duration: formatSeconds(result.output.duration) }
							))
			);
		} catch (error) {
			onStatus(
				errorMessage(
					error,
					task === "music"
						? "Music generation failed."
						: "Sound effect generation failed."
				)
			);
		} finally {
			setWorking(false);
		}
	};

	const generateSfx = async () => {
		if (busy) {
			return;
		}
		setWorking(true);
		onStatus(
			tl("Creating a {kind} sound effect…", {
				kind: SFX_LABELS[sfxKind].toLowerCase(),
			})
		);
		try {
			const asset = await request(assetSchema, "/sfx", "POST", {
				kind: sfxKind,
				seed: sfxSeed,
				...(sfxDuration === undefined ? {} : { duration: sfxDuration }),
			});
			onAsset(asset);
			onStatus("Sound effect saved to the media library.");
		} catch (error) {
			onStatus(errorMessage(error, "Sound effect generation failed."));
		} finally {
			setWorking(false);
		}
	};

	return (
		<RyuAppSection title="Local soundtrack">
			<p className="text-muted-foreground">
				Create a bounded offline score and add it to the timeline or a
				production recipe. This does not call a cloud provider.
			</p>
			<RyuAppField
				description="Generate asks the selected cloud music model instead of the local score."
				label="Music source"
			>
				<NativeSelect
					aria-label="Music source"
					disabled={busy}
					onChange={(event) =>
						setMusicSource(
							event.target.value === "generate" ? "generate" : "procedural"
						)
					}
					value={musicSource}
				>
					<NativeSelectOption value="procedural">
						Local score
					</NativeSelectOption>
					<NativeSelectOption value="generate">
						Generate (cloud model)
					</NativeSelectOption>
				</NativeSelect>
			</RyuAppField>
			{musicSource === "generate" && (
				<>
					<TaskModelFields
						choice={musicChoice}
						disabled={busy}
						onChange={setMusicChoice}
						task="music"
					/>
					{generatedReason("music") && (
						<p className="text-xs">{generatedReason("music")}</p>
					)}
				</>
			)}
			<RyuAppField label="Style">
				<NativeSelect
					aria-label="Soundtrack style"
					disabled={busy}
					onChange={(event) =>
						chooseStyle(soundtrackMoodSchema.parse(event.target.value))
					}
					value={mood}
				>
					{soundtrackMoodSchema.options.map((style) => (
						<NativeSelectOption key={style} value={style}>
							{SOUNDTRACK_STYLES[style].label}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<RyuAppField
				description="Optional. Ryu maps it to the style, tempo, instrument layers and section energy when you plan."
				label="Describe the music"
			>
				<Textarea
					aria-label="Describe the music"
					disabled={busy}
					maxLength={MAX_SOUNDTRACK_DESCRIPTION}
					onChange={(event) => setDescription(event.target.value)}
					placeholder="For example: slow lo-fi piano that builds into warm drums"
					rows={2}
					value={description}
				/>
			</RyuAppField>
			{markedRange && (
				<RyuAppField label="Score">
					<NativeSelect
						aria-label="Soundtrack span"
						disabled={busy}
						onChange={(event) => {
							setScoreRange(event.target.value === "range");
							setSections([]);
							setDownbeatOffset(undefined);
						}}
						value={scoreRange ? "range" : "timeline"}
					>
						<NativeSelectOption value="timeline">
							The whole timeline
						</NativeSelectOption>
						<NativeSelectOption value="range">
							{tl("The marked range ({start} – {end}), placed there", {
								end: formatSeconds(markedRange.end),
								start: formatSeconds(markedRange.start),
							})}
						</NativeSelectOption>
					</NativeSelect>
				</RyuAppField>
			)}
			<RyuAppField label="Duration (seconds)">
				<Input
					aria-label="Soundtrack duration"
					disabled={busy || Boolean(range)}
					max={7200}
					min={0.5}
					onChange={(event) => setDuration(Number(event.target.value))}
					step={0.5}
					type="number"
					value={
						range ? Number((range.end - range.start).toFixed(3)) : duration
					}
				/>
			</RyuAppField>
			<RyuAppField label="Tempo (BPM)">
				<Input
					aria-label="Soundtrack tempo"
					disabled={busy}
					max={180}
					min={60}
					onChange={(event) => setBpm(Number(event.target.value))}
					step={0.1}
					type="number"
					value={bpm}
				/>
			</RyuAppField>
			<SoundtrackLayerFields
				activeLayers={activeLayers}
				busy={busy}
				layers={layers}
				mood={mood}
				sections={sections}
				setLayers={setLayers}
			/>
			<RyuAppActions>
				<Button
					disabled={busy || !project || !complete}
					onClick={() => void plan()}
					title={
						complete
							? "Ask Ryu to plan style, tempo, layers and sections from the timeline and your description"
							: "Ryu's model service is unavailable"
					}
					variant="outline"
				>
					{planning
						? "Planning…"
						: range
							? "Plan for the range"
							: "Plan from timeline"}
				</Button>
				{sections.length > 0 && (
					<Button
						disabled={busy}
						onClick={() => {
							setSections([]);
							setDownbeatOffset(undefined);
						}}
						variant="ghost"
					>
						Clear plan
					</Button>
				)}
				{musicSource === "generate" ? (
					<Button
						disabled={busy || Boolean(generatedReason("music"))}
						onClick={() => void generateWithModel("music")}
						variant="outline"
					>
						{working ? "Generating…" : "Generate music"}
					</Button>
				) : (
					<Button
						disabled={busy}
						onClick={() => void generate()}
						variant="outline"
					>
						{working ? "Generating…" : "Create soundtrack"}
					</Button>
				)}
			</RyuAppActions>
			<SoundtrackSfxSection
				busy={busy}
				generatedReason={generatedReason}
				generateSfx={generateSfx}
				generateWithModel={generateWithModel}
				setSfxChoice={setSfxChoice}
				setSfxDescription={setSfxDescription}
				setSfxDuration={setSfxDuration}
				setSfxKind={setSfxKind}
				setSfxSeed={setSfxSeed}
				setSfxSource={setSfxSource}
				sfxChoice={sfxChoice}
				sfxDescription={sfxDescription}
				sfxDuration={sfxDuration}
				sfxKind={sfxKind}
				sfxSeed={sfxSeed}
				sfxSource={sfxSource}
				working={working}
			/>
		</RyuAppSection>
	);
}
