import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Textarea } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { ColorPickerPopover } from "@ryu/ui/components/color-picker.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useState } from "react";
import {
	isTitleKeyframeChannel,
	overlayKeyframeBounds,
	type TitleKeyframeChannel,
	titleChannelSample,
	titleKeyframeChannels,
} from "../../shared/overlay-keyframes.ts";
import type { Title } from "../../shared/project.ts";
import { titleSchema } from "../../shared/project.ts";
import { titleNarrationText } from "../../shared/title-narration.ts";
import { VoicePicker } from "./audio/VoicePicker.tsx";
import {
	readTitleNarrationVoice,
	type TitleNarrationVoice,
	writeTitleNarrationVoice,
} from "./editor/actions/title-narration.ts";
import { OverlayKeyframesEditor } from "./keyframes/OverlayKeyframesEditor.tsx";
import { NumberField } from "./NumberField.tsx";
import { TitleStyleControls } from "./TitleStyleControls.tsx";

const titleBounds = (property: TitleKeyframeChannel) =>
	overlayKeyframeBounds("title", property);

/** Voice, language, and rate used by "Text to speech" on every title. */
function TitleNarrationSettings({
	disabled,
	onChange,
	voice,
}: {
	disabled: boolean;
	onChange: (voice: TitleNarrationVoice) => void;
	voice: TitleNarrationVoice;
}) {
	return (
		<details className="studio-scene">
			<summary>Text to speech voice</summary>
			<VoicePicker
				disabled={disabled}
				languageAriaLabel="Title narration language"
				onChange={(choice) => onChange({ ...voice, ...choice })}
				value={voice}
				voiceAriaLabel="Title narration voice"
				voiceLabel="Voice (optional)"
			/>
			<NumberField
				ariaLabel="Title narration speaking rate"
				disabled={disabled}
				label="Speaking rate"
				max={2}
				min={0.5}
				onChange={(speed) => onChange({ ...voice, speed })}
				step={0.1}
				value={voice.speed}
			/>
			<small>
				Text to speech reads a title's text and places the audio on a free audio
				track at the title's start. The timeline menu on a title does the same
				with this voice.
			</small>
		</details>
	);
}

export function TitlesPanel({
	titles,
	time,
	onChange,
	onNarrate,
	narrationAvailable = Boolean(window.ryu?.media?.tts),
}: {
	titles: Title[];
	time: number;
	onChange: (titles: Title[]) => void;
	/** Speak a title with text to speech and place it at the title's start. */
	onNarrate?: (titleId: string, voice: TitleNarrationVoice) => Promise<unknown>;
	narrationAvailable?: boolean;
}) {
	const tl = useLiteralMessages();
	const [voice, setVoice] = useState(readTitleNarrationVoice);
	const [speaking, setSpeaking] = useState<string | null>(null);
	const changeVoice = (next: TitleNarrationVoice) => {
		setVoice(next);
		writeTitleNarrationVoice(next);
	};
	const narrate = async (title: Title) => {
		if (!onNarrate || speaking) {
			return;
		}
		setSpeaking(title.id);
		try {
			await onNarrate(title.id, voice);
		} finally {
			setSpeaking(null);
		}
	};
	const canNarrate = Boolean(onNarrate) && narrationAvailable;
	const add = (lower: boolean) =>
		onChange([
			...titles,
			{
				id: crypto.randomUUID(),
				start: time,
				end: Math.min(7200, time + 3),
				text: lower ? "Name · Role" : "Your title",
				x: 0.5,
				y: lower ? 0.8 : 0.5,
				fontSize: lower ? 0.045 : 0.08,
				color: "#ffffff",
				fadeIn: 0.2,
				fadeOut: 0.2,
				animation: "fade",
			},
		]);
	const change = (id: string, patch: Partial<Title>) =>
		onChange(
			titles.map((title) => (title.id === id ? { ...title, ...patch } : title))
		);
	return (
		<RyuAppSection title="Titles and lower thirds">
			<RyuAppActions>
				<Button
					disabled={time > 7199}
					onClick={() => add(false)}
					size="sm"
					variant="outline"
				>
					Add title
				</Button>
				<Button
					disabled={time > 7199}
					onClick={() => add(true)}
					size="sm"
					variant="ghost"
				>
					Add lower third
				</Button>
			</RyuAppActions>
			{canNarrate && titles.length > 0 && (
				<TitleNarrationSettings
					disabled={speaking !== null}
					onChange={changeVoice}
					voice={voice}
				/>
			)}
			{titles.map((title, index) => (
				<div className="studio-scene" key={title.id}>
					<Textarea
						aria-label={tl("Title {number} text", { number: index + 1 })}
						maxLength={500}
						onChange={(event) => change(title.id, { text: event.target.value })}
						value={title.text}
					/>
					{(
						[
							["start", "Start", 0, 7200],
							["end", "End", 0, 7200],
							["x", "Horizontal position", 0, 1],
							["y", "Vertical position", 0, 1],
							["fontSize", "Text size", 0.02, 0.2],
							["fadeIn", "Fade in", 0, 10],
							["fadeOut", "Fade out", 0, 10],
						] as const
					).map(([key, label, min, max]) => (
						<NumberField
							ariaLabel={tl("Title {number} {field}", {
								field: tl(label),
								number: index + 1,
							})}
							key={key}
							label={label}
							max={max}
							min={min}
							onChange={(value) => change(title.id, { [key]: value })}
							step={0.01}
							value={title[key]}
						/>
					))}
					<RyuAppField label="Text color">
						<ColorPickerPopover
							onValueChange={(value) => change(title.id, { color: value })}
							triggerAriaLabel={tl("Title {number} color", {
								number: index + 1,
							})}
							triggerClassName="w-full justify-start"
							value={title.color}
						/>
					</RyuAppField>
					<RyuAppField label="Entry animation">
						<NativeSelect
							aria-label={tl("Title {number} entry animation", {
								number: index + 1,
							})}
							onChange={(event) =>
								change(title.id, {
									animation: titleSchema.shape.animation.parse(
										event.target.value
									),
								})
							}
							value={title.animation}
						>
							<NativeSelectOption value="fade">Fade</NativeSelectOption>
							<NativeSelectOption value="slide-up">Slide up</NativeSelectOption>
							<NativeSelectOption value="slide-down">
								Slide down
							</NativeSelectOption>
							<NativeSelectOption value="slide-left">
								Slide left
							</NativeSelectOption>
							<NativeSelectOption value="slide-right">
								Slide right
							</NativeSelectOption>
						</NativeSelect>
					</RyuAppField>
					<TitleStyleControls
						index={index}
						onChange={(next) =>
							onChange(
								titles.map((item) => (item.id === next.id ? next : item))
							)
						}
						title={title}
					/>
					<OverlayKeyframesEditor
						boundsOf={titleBounds}
						channels={titleKeyframeChannels}
						insideHint="Records the value at the playhead. Keyframe times are relative to the title's start."
						isChannel={isTitleKeyframeChannel}
						item={title}
						name={`Title ${index + 1}`}
						onChange={(next) =>
							onChange(
								titles.map((item) => (item.id === next.id ? next : item))
							)
						}
						outsideHint="Move the playhead inside this title to add keyframes."
						sampleAt={(property, elapsed) =>
							titleChannelSample(title, property, elapsed)
						}
						time={time}
					/>
					<RyuAppActions>
						{canNarrate && (
							<Button
								aria-label={tl("Text to speech for title {number}", {
									number: index + 1,
								})}
								disabled={speaking !== null || !titleNarrationText(title.text)}
								onClick={() => void narrate(title)}
								size="sm"
								variant="outline"
							>
								{speaking === title.id ? "Speaking…" : "Text to speech"}
							</Button>
						)}
						<Button
							onClick={() =>
								onChange(titles.filter((item) => item.id !== title.id))
							}
							size="sm"
							variant="ghost"
						>
							Remove title
						</Button>
					</RyuAppActions>
				</div>
			))}
		</RyuAppSection>
	);
}
