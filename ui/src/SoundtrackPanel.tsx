import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import {
	Button,
	Checkbox,
	Input,
	Textarea,
} from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useContext, useState } from "react";
import { z } from "zod";
import type { Asset, Project } from "../../shared/project.ts";
import { assetSchema, newSegment } from "../../shared/project.ts";
import {
	MAX_SFX_SECONDS,
	MAX_SFX_SEED,
	MIN_SFX_SECONDS,
	SFX_DEFAULT_DURATIONS,
	SFX_LABELS,
	type SfxKind,
	sfxKindSchema,
} from "../../shared/sfx.ts";
import {
	MAX_GENERATED_MUSIC_SECONDS,
	SOUNDTRACK_STYLES,
	type SoundtrackLayer,
	type SoundtrackMood,
	type SoundtrackSection,
	soundtrackJobSchema,
	soundtrackLayerSchema,
	soundtrackLayersOf,
	soundtrackMoodSchema,
} from "../../shared/soundtrack.ts";
import {
	clipSoundtrackSections,
	MAX_SOUNDTRACK_DESCRIPTION,
	planSoundtrack,
	type SoundtrackRange,
	soundtrackPlanInput,
} from "../../shared/soundtrack-plan.ts";
import { firstFreeTrack } from "../../shared/track-placement.ts";
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

const LAYER_LABELS = {
	pluck: "Pluck",
	pad: "Pad",
	bass: "Bass",
	arpeggio: "Arpeggio",
	kick: "Kick",
	hat: "Hi-hat",
	snare: "Snare",
} as const satisfies Record<SoundtrackLayer, string>;

/** A readable status line; schema errors never reach the user as raw JSON. */
export function errorMessage(error: unknown, fallback: string): string {
	if (error instanceof z.ZodError) {
		return fallback;
	}
	return error instanceof Error && error.message ? error.message : fallback;
}

const JOB_POLL_MS = 2000;
const soundtrackResponseSchema = z.union([
	z.object({ job: soundtrackJobSchema }).strict(),
	assetSchema,
]);

/**
 * Create a soundtrack: an inline 201 asset, or a background job (202) that
 * is polled until it finishes.
 */
export async function createSoundtrack(
	body: ReturnType<typeof soundtrackBody>,
	options: {
		onBackground?: () => void;
		wait?: (milliseconds: number) => Promise<void>;
	} = {}
): Promise<Asset> {
	const wait =
		options.wait ??
		((milliseconds: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
	const result = await request(
		soundtrackResponseSchema,
		"/soundtrack",
		"POST",
		body
	);
	if (!("job" in result)) {
		return result;
	}
	options.onBackground?.();
	let job = result.job;
	while (job.status === "running") {
		await wait(JOB_POLL_MS);
		job = await request(
			soundtrackJobSchema,
			`/soundtrack-jobs?id=${encodeURIComponent(job.id)}`
		);
	}
	if (job.status === "failed") {
		throw new Error(job.error?.message ?? "Soundtrack generation failed.");
	}
	return assetSchema.parse(job.asset);
}

const formatSeconds = (value: number) => `${value.toFixed(1)} s`;

/**
 * Place a scored soundtrack at `range.start` on the first audio-compatible
 * track that is free for the whole range (audio tracks start at 1).
 */
export function placeAtRange(
	project: Project,
	assets: readonly Asset[],
	asset: Asset,
	range: SoundtrackRange
): Project {
	const end = range.start + asset.duration;
	const track = firstFreeTrack(project, range.start, end, {
		assets: [...assets, asset],
		from: 1,
		kind: "audio",
	});
	if (track === undefined) {
		throw new Error("No free audio track covers the marked range.");
	}
	return {
		...project,
		segments: [...project.segments, newSegment(asset, range.start, track)],
	};
}

/** The `POST /soundtrack` body for the panel's current settings. */
export function soundtrackBody(settings: {
	bpm: number;
	downbeatOffset?: number;
	duration: number;
	layers?: SoundtrackLayer[];
	mood: SoundtrackMood;
	sections: SoundtrackSection[];
}) {
	const sections = clipSoundtrackSections(settings.sections, settings.duration);
	return {
		bpm: settings.bpm,
		...(settings.downbeatOffset === undefined
			? {}
			: { downbeatOffset: settings.downbeatOffset }),
		duration: settings.duration,
		mood: settings.mood,
		...(settings.layers ? { layers: settings.layers } : {}),
		...(sections.length ? { sections } : {}),
	};
}

/** Toggle one layer, starting from the style's default band. */
export function toggleLayer(
	mood: SoundtrackMood,
	layers: SoundtrackLayer[] | undefined,
	layer: SoundtrackLayer,
	enabled: boolean
): SoundtrackLayer[] | undefined {
	const current = new Set(soundtrackLayersOf({ layers, mood }));
	if (enabled) {
		current.add(layer);
	} else {
		current.delete(layer);
	}
	const next = soundtrackLayerSchema.options.filter((item) =>
		current.has(item)
	);
	// The sidecar needs at least one layer; keep the last one playing.
	return next.length ? next : layers;
}

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
				`Planned ${result.sections.length} soundtrack section${result.sections.length === 1 ? "" : "s"} aligned to cuts and downbeats. Review, then create the soundtrack.`
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
					`Soundtrack saved and placed at ${formatSeconds(range.start)} for the marked range.`
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
			`Generating ${task === "music" ? "music" : "a sound effect"} with the selected cloud model through Ryu…`
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
					`Generated ${task === "music" ? "music" : "sound effect"} fitted to ${formatSeconds(result.output.duration)} and saved to the library. The provider and model are recorded in the credits.`
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
		onStatus(`Creating a ${SFX_LABELS[sfxKind].toLowerCase()} sound effect…`);
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
							The marked range ({formatSeconds(markedRange.start)} –{" "}
							{formatSeconds(markedRange.end)}), placed there
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
			<fieldset className="flex flex-wrap gap-3" disabled={busy}>
				<legend className="mb-1 text-muted-foreground text-xs">
					Instrument layers
				</legend>
				{soundtrackLayerSchema.options.map((layer) => (
					<label className="flex items-center gap-1.5 text-sm" key={layer}>
						<Checkbox
							aria-label={`${LAYER_LABELS[layer]} layer`}
							checked={activeLayers.includes(layer)}
							onCheckedChange={(checked) =>
								setLayers(toggleLayer(mood, layers, layer, checked === true))
							}
						/>
						{LAYER_LABELS[layer]}
					</label>
				))}
			</fieldset>
			{sections.length > 0 && (
				<div>
					<p className="text-muted-foreground text-xs">
						Planned sections (quieter sections drop drums and arpeggio)
					</p>
					<ol aria-label="Planned soundtrack sections" className="text-sm">
						{sections.map((section) => (
							<li key={`${section.start}-${section.end}`}>
								{formatSeconds(section.start)} – {formatSeconds(section.end)} ·
								intensity {Math.round(section.intensity * 100)}%
							</li>
						))}
					</ol>
				</div>
			)}
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
			<RyuAppField label="Sound effect source">
				<NativeSelect
					aria-label="Sound effect source"
					disabled={busy}
					onChange={(event) =>
						setSfxSource(
							event.target.value === "generate" ? "generate" : "procedural"
						)
					}
					value={sfxSource}
				>
					<NativeSelectOption value="procedural">
						Local synthesizer
					</NativeSelectOption>
					<NativeSelectOption value="generate">
						Generate (cloud model)
					</NativeSelectOption>
				</NativeSelect>
			</RyuAppField>
			{sfxSource === "generate" && (
				<>
					<RyuAppField label="Describe the sound">
						<Textarea
							aria-label="Describe the sound effect"
							disabled={busy}
							maxLength={2000}
							onChange={(event) => setSfxDescription(event.target.value)}
							placeholder="For example: a heavy wooden door slamming shut"
							rows={2}
							value={sfxDescription}
						/>
					</RyuAppField>
					<TaskModelFields
						choice={sfxChoice}
						disabled={busy}
						onChange={setSfxChoice}
						task="sfx"
					/>
					{generatedReason("sfx") && (
						<p className="text-xs">{generatedReason("sfx")}</p>
					)}
				</>
			)}
			<RyuAppField label="Sound effect">
				<NativeSelect
					aria-label="Sound effect kind"
					disabled={busy}
					onChange={(event) => {
						setSfxKind(sfxKindSchema.parse(event.target.value));
						setSfxDuration(undefined);
					}}
					value={sfxKind}
				>
					{sfxKindSchema.options.map((kind) => (
						<NativeSelectOption key={kind} value={kind}>
							{SFX_LABELS[kind]}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<div className="studio-inline-fields">
				<Input
					aria-label="Sound effect duration"
					disabled={busy}
					max={MAX_SFX_SECONDS}
					min={MIN_SFX_SECONDS}
					onChange={(event) =>
						setSfxDuration(
							event.target.value === "" ? undefined : Number(event.target.value)
						)
					}
					placeholder={`${SFX_DEFAULT_DURATIONS[sfxKind]} s`}
					step={0.01}
					type="number"
					value={sfxDuration ?? ""}
				/>
				<Input
					aria-label="Sound effect seed"
					disabled={busy}
					max={MAX_SFX_SEED}
					min={0}
					onChange={(event) =>
						setSfxSeed(Math.max(0, Math.trunc(Number(event.target.value))))
					}
					step={1}
					type="number"
					value={sfxSeed}
				/>
				<Button
					disabled={busy}
					onClick={() => setSfxSeed(Math.floor(Math.random() * 10_000))}
					variant="ghost"
				>
					Vary
				</Button>
			</div>
			<RyuAppActions>
				{sfxSource === "generate" ? (
					<Button
						disabled={busy || Boolean(generatedReason("sfx"))}
						onClick={() => void generateWithModel("sfx")}
						variant="outline"
					>
						{working ? "Generating…" : "Generate sound effect"}
					</Button>
				) : (
					<Button
						disabled={busy}
						onClick={() => void generateSfx()}
						variant="outline"
					>
						{working ? "Generating…" : "Create sound effect"}
					</Button>
				)}
			</RyuAppActions>
		</RyuAppSection>
	);
}
