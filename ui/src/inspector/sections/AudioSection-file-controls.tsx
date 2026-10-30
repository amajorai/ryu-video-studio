import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { ColorPickerPopover } from "@ryu/ui/components/color-picker.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { DUCK_LIMITS, resolveDuck } from "../../../../shared/ducking.ts";
import { type Segment, segmentSchema } from "../../../../shared/project.ts";
import { NumberField } from "../../NumberField.tsx";
import type { ClipSectionProps } from "../section-props.ts";

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
export function AudioFileControls({ onChange, segment }: ClipSectionProps) {
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
