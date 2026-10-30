import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Input } from "@ryu/blocks/companion/controls";
import { ColorPickerPopover } from "@ryu/ui/components/color-picker.tsx";
import { useState } from "react";
import {
	CAPTION_PRESETS,
	type CaptionPreset,
} from "../../../shared/caption-style.ts";
import { TITLE_FONTS } from "../../../shared/text-style.ts";
import {
	numberFieldText,
	parseNumberField,
} from "./CaptionStylePanel-model.ts";

/** The preset's caption box as a CSS color, or transparent without one. */
function presetBoxColor(preset: CaptionPreset): string {
	const { backgroundColor, backgroundOpacity } = preset.style;
	if (!(backgroundColor && backgroundOpacity)) {
		return "transparent";
	}
	return `color-mix(in srgb, ${backgroundColor} ${Math.round(backgroundOpacity * 100)}%, transparent)`;
}

export function PresetGallery({
	onApply,
	selected,
	disabled,
}: {
	disabled: boolean;
	onApply: (preset: CaptionPreset) => void;
	selected: string | undefined;
}) {
	return (
		<ul aria-label="Caption presets" className="grid grid-cols-2 gap-2">
			{CAPTION_PRESETS.map((preset) => (
				<li key={preset.id}>
					<button
						aria-pressed={selected === preset.id}
						className="flex flex-col items-start gap-0.5 rounded-md border border-border p-2 text-left text-xs hover:bg-muted aria-pressed:border-primary"
						data-caption-preset={preset.id}
						disabled={disabled}
						onClick={() => onApply(preset)}
						type="button"
					>
						<span
							aria-hidden="true"
							className="w-full truncate rounded bg-neutral-700 px-2 py-2 text-center text-sm"
						>
							<span
								className="rounded-sm px-1"
								style={{
									backgroundColor: presetBoxColor(preset),
									color: preset.style.color,
									fontFamily:
										TITLE_FONTS[preset.style.fontFamily ?? "system-sans"].css,
									fontWeight: preset.style.fontWeight ?? 700,
									textShadow: "0 0 2px rgb(0 0 0 / 0.9)",
								}}
							>
								{preset.style.uppercase
									? preset.label.toUpperCase()
									: preset.label}
							</span>
						</span>
						<span className="font-medium text-foreground">{preset.label}</span>
						<span className="text-muted-foreground">{preset.description}</span>
					</button>
				</li>
			))}
		</ul>
	);
}

/**
 * A number input that keeps the typed text as a local draft, so intermediate
 * input ("", "0", "0.") stays visible. In-range values apply as they are
 * typed; on blur or Enter the draft is clamped into range, or cleared through
 * `onClear` when the field allows an unset value.
 */
export function NumberField({
	label,
	max,
	min,
	onChange,
	onClear,
	placeholder,
	step,
	value,
}: {
	label: string;
	max: number;
	min: number;
	onChange: (value: number) => void;
	onClear?: () => void;
	placeholder?: string;
	step: number;
	value: number | undefined;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const commit = () => {
		if (draft === null) {
			return;
		}
		setDraft(null);
		const next = parseNumberField(draft, min, max);
		if (next === null) {
			onClear?.();
		} else if (next !== undefined) {
			onChange(next);
		}
	};
	return (
		<RyuAppField label={label}>
			<Input
				aria-label={label}
				max={max}
				min={min}
				onBlur={commit}
				onChange={(event) => {
					const text = event.target.value;
					setDraft(text);
					const next = Number(text);
					if (
						text.trim() &&
						Number.isFinite(next) &&
						next >= min &&
						next <= max
					) {
						onChange(next);
					}
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						commit();
					}
				}}
				placeholder={placeholder}
				step={step}
				type="number"
				value={draft ?? numberFieldText(value)}
			/>
		</RyuAppField>
	);
}

export function ColorField({
	label,
	onChange,
	value,
}: {
	label: string;
	onChange: (value: string) => void;
	value: string;
}) {
	return (
		<RyuAppField label={label}>
			<ColorPickerPopover
				onValueChange={onChange}
				triggerAriaLabel={label}
				triggerClassName="w-full justify-start"
				value={value}
			/>
		</RyuAppField>
	);
}
