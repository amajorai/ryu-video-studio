import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import type { Segment } from "../../../../shared/project.ts";
import { channelModeSchema } from "../../../../shared/schema/audio-ext.ts";
import { audioCleanupOf } from "../../../../shared/schema/defaults.ts";
import {
	MISSING_VOICE_MODEL_NOTICE,
	useBundledAssets,
} from "../../bundled-assets.ts";
import { useEditorProject } from "../../editor/context.tsx";
import { NumberField } from "../../NumberField.tsx";
import type { ClipSectionProps } from "../section-props.ts";
import { EffectsControls } from "./AudioSection-effects.tsx";
import { AudioFileControls } from "./AudioSection-file-controls.tsx";
import { percent } from "./AudioSection-percent.ts";
import {
	type AudioFilterSupport,
	useAudioFilterSupport,
} from "./audio-capabilities.ts";
import {
	CLEANUP_PRESETS,
	type CleanupPresetId,
	cleanupPatch,
	cleanupPresetPatch,
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
