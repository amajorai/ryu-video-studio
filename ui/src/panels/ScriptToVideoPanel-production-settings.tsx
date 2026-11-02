import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Textarea } from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import {
	type ScriptAvatarPreset,
	scriptAvatarPresetSchema,
} from "../../../shared/script-extras.ts";
import {
	SOUNDTRACK_STYLES,
	soundtrackMoodSchema,
} from "../../../shared/soundtrack.ts";
import { MAX_SOUNDTRACK_DESCRIPTION } from "../../../shared/soundtrack-plan.ts";
import {
	type StockProvider,
	stockProviderSchema,
} from "../../../shared/stock.ts";
import type { TtsVoiceChoice } from "../../../shared/tts-voices.ts";
import { VoicePicker } from "../audio/VoicePicker.tsx";
import {
	AVATAR_LABELS,
	avatarChoiceSchema,
	CAPTION_LABELS,
	type CaptionMode,
	captionModeSchema,
	type MusicChoice,
	musicChoiceSchema,
	PROVIDER_LABELS,
	VISUAL_PROVIDERS,
	visualSourceSchema,
} from "./ScriptToVideoPanel-model.ts";
import type { VisualSource } from "./script-to-video-pipeline.ts";

/** The production choices shown once scenes are planned. */
export function ProductionSettings({
	avatar,
	captions,
	gap,
	hasModel,
	music,
	musicDescription,
	provider,
	setAvatar,
	setCaptions,
	setGap,
	setMusic,
	setMusicDescription,
	setProvider,
	setVisualSource,
	setVoice,
	visualSource,
	voice,
	working,
}: {
	avatar: ScriptAvatarPreset | "none";
	captions: CaptionMode;
	gap: number;
	hasModel: boolean;
	music: MusicChoice;
	musicDescription: string;
	provider: StockProvider;
	setAvatar: (value: ScriptAvatarPreset | "none") => void;
	setCaptions: (value: CaptionMode) => void;
	setGap: (value: number) => void;
	setMusic: (value: MusicChoice) => void;
	setMusicDescription: (value: string) => void;
	setProvider: (value: StockProvider) => void;
	setVisualSource: (value: VisualSource) => void;
	setVoice: (value: TtsVoiceChoice) => void;
	visualSource: VisualSource;
	voice: TtsVoiceChoice;
	working: boolean;
}) {
	return (
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
		</>
	);
}
