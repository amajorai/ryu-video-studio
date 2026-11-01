import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
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
import type { Segment } from "../../../../shared/project.ts";
import {
	type AudioEffect,
	audioEffectTypeSchema,
	MAX_AUDIO_EFFECTS,
} from "../../../../shared/schema/audio-ext.ts";
import { NumberField } from "../../NumberField.tsx";
import type { ClipSectionProps } from "../section-props.ts";
import { percent } from "./AudioSection-percent.ts";
import type { AudioFilterSupport } from "./audio-capabilities.ts";
import {
	addEffect,
	moveEffect,
	removeEffect,
	updateEffect,
} from "./audio-stack.ts";

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
	const tl = useLiteralMessages();
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
					label={tl("{label} amount (%)", { label })}
					max={100}
					min={0}
					onChange={(value) => change({ amount: value / 100 })}
					step={1}
					value={percent(effect.amount)}
				/>
			)}
			{controls.includes("semitones") && (
				<NumberField
					label={tl("{label} semitones", { label })}
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
					label={tl("{label} frequency (Hz)", { label })}
					max={20_000}
					min={20}
					onChange={(value) => change({ frequency: value })}
					step={10}
					value={effect.frequency ?? 1000}
				/>
			)}
			{controls.includes("gainDb") && (
				<NumberField
					label={tl("{label} gain (dB)", { label })}
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
					{tl("Bypass {label}", { label })}
				</Button>
				<Button
					aria-label={tl("Move {label} up", { label })}
					disabled={index === 0}
					onClick={() => onChange(moveEffect(segment, index, -1))}
					size="sm"
					variant="ghost"
				>
					Up
				</Button>
				<Button
					aria-label={tl("Move {label} down", { label })}
					disabled={index === count - 1}
					onClick={() => onChange(moveEffect(segment, index, 1))}
					size="sm"
					variant="ghost"
				>
					Down
				</Button>
				<Button
					aria-label={tl("Remove {label}", { label })}
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

export function EffectsControls({
	onChange,
	segment,
	support,
}: {
	onChange: ClipSectionProps["onChange"];
	segment: Segment;
	support: AudioFilterSupport;
}) {
	const tl = useLiteralMessages();
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
							? tl("Stack full ({MAX_AUDIO_EFFECTS})", { MAX_AUDIO_EFFECTS })
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
