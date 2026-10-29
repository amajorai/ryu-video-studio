import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { ColorPickerPopover } from "@ryu/ui/components/color-picker.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import {
	AUDIO_EFFECT_CONTROLS,
	AUDIO_EFFECT_LABELS,
	AUDIO_EFFECT_PRESETS,
	AUDIO_EFFECT_TYPES,
	audioEffectPresetStack,
	displayedSemitones,
	PITCH_AUDIO_EFFECTS,
	RENDER_ONLY_AUDIO_EFFECTS,
	semitoneRange,
} from "../../../../shared/audio-effects.ts";
import { DUCK_LIMITS, resolveDuck } from "../../../../shared/ducking.ts";
import { type Segment, segmentSchema } from "../../../../shared/project.ts";
import {
	type AudioEffect,
	audioEffectTypeSchema,
	channelModeSchema,
	MAX_AUDIO_EFFECTS,
} from "../../../../shared/schema/audio-ext.ts";
import { audioCleanupOf } from "../../../../shared/schema/defaults.ts";
import {
	MISSING_VOICE_MODEL_NOTICE,
	useBundledAssets,
} from "../../bundled-assets.ts";
import { useEditorProject } from "../../editor/context.tsx";
import { NumberField } from "../../NumberField.tsx";
import type { ClipSectionProps } from "../section-props.ts";
import {
	type AudioFilterSupport,
	useAudioFilterSupport,
} from "./audio-capabilities.ts";
import {
	addEffect,
	CLEANUP_PRESETS,
	type CleanupPresetId,
	cleanupPatch,
	cleanupPresetPatch,
	moveEffect,
	removeEffect,
	updateEffect,
} from "./audio-stack.ts";

const CLEANUP_PRESET_LABELS: Record<CleanupPresetId, string> = {
	music: "Music (normalize only)",
	"noisy-room": "Noisy room",
	off: "Original audio",
	podcast: "Podcast voice",
};

const CHANNEL_MODE_LABELS: Record<Segment["channelMode"] & string, string> = {
	left: "Left channel to both",
	mono: "Mono (sum)",
	right: "Right channel to both",
	stereo: "Stereo",
	swap: "Swap left and right",
};

const percent = (value: number) => Math.round(value * 100);

function matchingCleanupPreset(segment: Segment): CleanupPresetId | "custom" {
	const cleanup = audioCleanupOf(segment);
	for (const [id, preset] of Object.entries(CLEANUP_PRESETS)) {
		if (
			preset.denoise === cleanup.denoise &&
			preset.enhance === cleanup.enhance &&
			preset.normalize === cleanup.normalize &&
			preset.voiceIsolation === cleanup.voiceIsolation
		) {
			return id as CleanupPresetId;
		}
	}
	return "custom";
}

function CleanupControls({
	onChange,
	segment,
	support,
}: {
	onChange: ClipSectionProps["onChange"];
	segment: Segment;
	support: AudioFilterSupport;
}) {
	const cleanup = audioCleanupOf(segment);
	const preset = matchingCleanupPreset(segment);
	const bundled = useBundledAssets();
	let isolationNotice: string | null = null;
	if (support.arnndn === false) {
		isolationNotice =
			"Voice isolation is unavailable: this renderer's FFmpeg lacks the arnndn filter.";
	} else if (bundled.voiceIsolationModel === false) {
		isolationNotice = MISSING_VOICE_MODEL_NOTICE;
	}
	return (
		<>
			<RyuAppField label="Audio cleanup">
				<NativeSelect
					aria-label="Audio cleanup"
					onChange={(event) => {
						const id = event.target.value;
						if (id in CLEANUP_PRESETS) {
							onChange(cleanupPresetPatch(id as CleanupPresetId));
						}
					}}
					value={preset}
				>
					{Object.entries(CLEANUP_PRESET_LABELS).map(([id, label]) => (
						<NativeSelectOption key={id} value={id}>
							{label}
						</NativeSelectOption>
					))}
					{preset === "custom" && (
						<NativeSelectOption value="custom">Custom</NativeSelectOption>
					)}
				</NativeSelect>
			</RyuAppField>
			<NumberField
				label="Denoise (%)"
				max={100}
				min={0}
				onChange={(value) =>
					onChange(cleanupPatch(segment, { denoise: value / 100 }))
				}
				step={1}
				value={percent(cleanup.denoise)}
			/>
			<NumberField
				label="Voice enhance (%)"
				max={100}
				min={0}
				onChange={(value) =>
					onChange(cleanupPatch(segment, { enhance: value / 100 }))
				}
				step={1}
				value={percent(cleanup.enhance)}
			/>
			{isolationNotice ? (
				<small>{isolationNotice}</small>
			) : (
				<NumberField
					label="Voice isolation (%)"
					max={100}
					min={0}
					onChange={(value) =>
						onChange(cleanupPatch(segment, { voiceIsolation: value / 100 }))
					}
					step={1}
					value={percent(cleanup.voiceIsolation)}
				/>
			)}
			<RyuAppField label="Normalize loudness">
				<NativeSelect
					aria-label="Normalize loudness"
					onChange={(event) =>
						onChange(
							cleanupPatch(segment, { normalize: event.target.value === "on" })
						)
					}
					value={cleanup.normalize ? "on" : "off"}
				>
					<NativeSelectOption value="off">Off</NativeSelectOption>
					<NativeSelectOption value="on">On (-16 LUFS)</NativeSelectOption>
				</NativeSelect>
			</RyuAppField>
			{segment.audioCleanup && (
				<small>Graded cleanup is applied on render.</small>
			)}
		</>
	);
}

function effectNote(
	effect: AudioEffect,
	support: AudioFilterSupport
): string | null {
	if (PITCH_AUDIO_EFFECTS.has(effect.type) && support.rubberband === false) {
		return "Render only · tape-style shift (FFmpeg lacks rubberband).";
	}
	return RENDER_ONLY_AUDIO_EFFECTS.has(effect.type) ? "Render only." : null;
}

function EffectRow({
	count,
	effect,
	index,
	onChange,
	segment,
	support,
}: {
	count: number;
	effect: AudioEffect;
	index: number;
	onChange: ClipSectionProps["onChange"];
	segment: Segment;
	support: AudioFilterSupport;
}) {
	const label = AUDIO_EFFECT_LABELS[effect.type];
	const controls = AUDIO_EFFECT_CONTROLS[effect.type];
	const semitones = semitoneRange(effect.type);
	const note = effectNote(effect, support);
	const change = (patch: Partial<AudioEffect>) =>
		onChange(updateEffect(segment, index, patch));
	return (
		<li className="flex flex-col gap-1 rounded-md border border-border p-2">
			<strong>
				{index + 1}. {label}
				{effect.enabled ? "" : " (bypassed)"}
			</strong>
			{controls.includes("amount") && (
				<NumberField
					label={`${label} amount (%)`}
					max={100}
					min={0}
					onChange={(value) => change({ amount: value / 100 })}
					step={1}
					value={percent(effect.amount)}
				/>
			)}
			{controls.includes("semitones") && (
				<NumberField
					label={`${label} semitones`}
					max={semitones.max}
					min={semitones.min}
					onChange={(value) =>
						change({
							semitones: Math.min(
								semitones.max,
								Math.max(semitones.min, value)
							),
						})
					}
					step={1}
					value={displayedSemitones(effect)}
				/>
			)}
			{controls.includes("frequency") && (
				<NumberField
					label={`${label} frequency (Hz)`}
					max={20_000}
					min={20}
					onChange={(value) => change({ frequency: value })}
					step={10}
					value={effect.frequency ?? 1000}
				/>
			)}
			{controls.includes("gainDb") && (
				<NumberField
					label={`${label} gain (dB)`}
					max={24}
					min={-24}
					onChange={(value) => change({ gainDb: value })}
					step={0.5}
					value={effect.gainDb ?? effect.amount * 12}
				/>
			)}
			{note && <small>{note}</small>}
			<RyuAppActions>
				<Button
					aria-pressed={!effect.enabled}
					onClick={() => change({ enabled: !effect.enabled })}
					size="sm"
					variant="outline"
				>
					{`Bypass ${label}`}
				</Button>
				<Button
					aria-label={`Move ${label} up`}
					disabled={index === 0}
					onClick={() => onChange(moveEffect(segment, index, -1))}
					size="sm"
					variant="ghost"
				>
					Up
				</Button>
				<Button
					aria-label={`Move ${label} down`}
					disabled={index === count - 1}
					onClick={() => onChange(moveEffect(segment, index, 1))}
					size="sm"
					variant="ghost"
				>
					Down
				</Button>
				<Button
					aria-label={`Remove ${label}`}
					onClick={() => onChange(removeEffect(segment, index))}
					size="sm"
					variant="ghost"
				>
					Remove
				</Button>
			</RyuAppActions>
		</li>
	);
}

function EffectsControls({
	onChange,
	segment,
	support,
}: {
	onChange: ClipSectionProps["onChange"];
	segment: Segment;
	support: AudioFilterSupport;
}) {
	const stack = segment.audioEffects ?? [];
	return (
		<>
			<RyuAppField label="Voice and audio effects">
				<NativeSelect
					aria-label="Audio effect preset"
					onChange={(event) => {
						const effects =
							event.target.value === "none"
								? []
								: audioEffectPresetStack(event.target.value);
						if (effects) {
							onChange({ audioEffects: effects });
						}
					}}
					value=""
				>
					<NativeSelectOption disabled value="">
						Apply a preset…
					</NativeSelectOption>
					{AUDIO_EFFECT_PRESETS.map((preset) => (
						<NativeSelectOption key={preset.id} value={preset.id}>
							{preset.label}
						</NativeSelectOption>
					))}
					<NativeSelectOption value="none">Clear effects</NativeSelectOption>
				</NativeSelect>
			</RyuAppField>
			{stack.length > 0 && (
				<ol aria-label="Audio effect stack" className="flex flex-col gap-2">
					{stack.map((effect, index) => (
						<EffectRow
							count={stack.length}
							effect={effect}
							index={index}
							// Effects have no required id; position is their identity in the stack.
							key={effect.id ?? `${index}-${effect.type}`}
							onChange={onChange}
							segment={segment}
							support={support}
						/>
					))}
				</ol>
			)}
			<RyuAppField label="Add audio effect">
				<NativeSelect
					aria-label="Add audio effect"
					disabled={stack.length >= MAX_AUDIO_EFFECTS}
					onChange={(event) => {
						const type = audioEffectTypeSchema.safeParse(event.target.value);
						const patch = type.success ? addEffect(segment, type.data) : null;
						if (patch) {
							onChange(patch);
						}
					}}
					value=""
				>
					<NativeSelectOption disabled value="">
						{stack.length >= MAX_AUDIO_EFFECTS
							? `Stack full (${MAX_AUDIO_EFFECTS})`
							: "Choose an effect…"}
					</NativeSelectOption>
					{AUDIO_EFFECT_TYPES.map((type) => (
						<NativeSelectOption key={type} value={type}>
							{AUDIO_EFFECT_LABELS[type]}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
		</>
	);
}

function PanControls({
	onChange,
	segment,
}: {
	onChange: ClipSectionProps["onChange"];
	segment: Segment;
}) {
	return (
		<>
			<NumberField
				label="Pan (L -100 … R +100)"
				max={100}
				min={-100}
				onChange={(value) => onChange({ pan: value / 100 })}
				step={1}
				value={percent(segment.pan ?? 0)}
			/>
			<RyuAppField label="Channels">
				<NativeSelect
					aria-label="Channels"
					onChange={(event) =>
						onChange({
							channelMode: channelModeSchema.parse(event.target.value),
						})
					}
					value={segment.channelMode ?? "stereo"}
				>
					{channelModeSchema.options.map((mode) => (
						<NativeSelectOption key={mode} value={mode}>
							{CHANNEL_MODE_LABELS[mode]}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
		</>
	);
}

/**
 * How far the clip dips under the other audio and how fast it goes down and
 * comes back; the preview and the export share these values.
 */
function DuckControls({
	onChange,
	segment,
}: Pick<ClipSectionProps, "onChange" | "segment">) {
	const duck = resolveDuck(segment.ducking);
	const patch = (next: Partial<typeof duck>) =>
		onChange({ ducking: { ...duck, ...next } });
	return (
		<>
			<NumberField
				label="Duck amount (dB)"
				max={DUCK_LIMITS.amountDb.max}
				min={DUCK_LIMITS.amountDb.min}
				onChange={(amountDb) => patch({ amountDb })}
				step={0.5}
				value={duck.amountDb}
			/>
			<NumberField
				label="Duck attack (ms)"
				max={DUCK_LIMITS.attackMs.max}
				min={DUCK_LIMITS.attackMs.min}
				onChange={(attackMs) => patch({ attackMs })}
				step={5}
				value={duck.attackMs}
			/>
			<NumberField
				label="Duck release (ms)"
				max={DUCK_LIMITS.releaseMs.max}
				min={DUCK_LIMITS.releaseMs.min}
				onChange={(releaseMs) => patch({ releaseMs })}
				step={10}
				value={duck.releaseMs}
			/>
		</>
	);
}

/** Visualization and ducking controls that only apply to audio-file clips. */
function AudioFileControls({ onChange, segment }: ClipSectionProps) {
	return (
		<>
			<RyuAppField label="Duck under other audio">
				<NativeSelect
					aria-label="Duck under other audio"
					onChange={(event) =>
						onChange({ duckUnderVoice: event.target.value === "yes" })
					}
					value={segment.duckUnderVoice ? "yes" : "no"}
				>
					<NativeSelectOption value="no">Keep full mix</NativeSelectOption>
					<NativeSelectOption value="yes">Duck under voice</NativeSelectOption>
				</NativeSelect>
			</RyuAppField>
			{segment.duckUnderVoice && (
				<DuckControls onChange={onChange} segment={segment} />
			)}
			<RyuAppField label="Audio visualization">
				<NativeSelect
					aria-label="Audio visualization"
					onChange={(event) => {
						const patch: Partial<Segment> = {
							visualization: segmentSchema.shape.visualization.parse(
								event.target.value
							),
						};
						// Lift a newly shown waveform off the frame's centre line.
						if (
							event.target.value === "waveform" &&
							segment.visualization === "none" &&
							segment.y === 0
						) {
							patch.y = 0.35;
						}
						onChange(patch);
					}}
					value={segment.visualization}
				>
					<NativeSelectOption value="none">None</NativeSelectOption>
					<NativeSelectOption value="waveform">Waveform</NativeSelectOption>
				</NativeSelect>
			</RyuAppField>
			{segment.visualization === "waveform" && (
				<>
					<RyuAppField label="Waveform color">
						<ColorPickerPopover
							onValueChange={(value) => onChange({ waveformColor: value })}
							triggerAriaLabel="Waveform color"
							triggerClassName="w-full justify-start"
							value={segment.waveformColor}
						/>
					</RyuAppField>
					<NumberField
						label="Waveform height (%)"
						max={100}
						min={5}
						onChange={(value) => onChange({ waveformHeight: value / 100 })}
						step={1}
						value={segment.waveformHeight * 100}
					/>
				</>
			)}
		</>
	);
}

/**
 * Clip audio: graded cleanup, the voice and effects stack, pan and channels,
 * plus ducking and waveform visualization for audio-file clips.
 */
export function AudioSection(props: ClipSectionProps) {
	const { isAudio, onChange, segment } = props;
	const { assets } = useEditorProject();
	const support = useAudioFilterSupport();
	const hasAudio =
		isAudio ||
		assets.find((asset) => asset.id === segment.assetId)?.hasAudio === true;
	if (!hasAudio) {
		return null;
	}
	return (
		<>
			<CleanupControls
				onChange={onChange}
				segment={segment}
				support={support}
			/>
			<EffectsControls
				onChange={onChange}
				segment={segment}
				support={support}
			/>
			<PanControls onChange={onChange} segment={segment} />
			<small>
				To change the voice itself, dub the clip's captions with text to speech
				from the Captions panel.
			</small>
			{isAudio && <AudioFileControls {...props} />}
		</>
	);
}
