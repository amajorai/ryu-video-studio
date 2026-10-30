import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button, Checkbox, Label } from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useId, useState } from "react";
import type { z } from "zod";
import { effectiveCaptionStyle } from "../../../shared/caption-style.ts";
import {
	type CaptionStyle,
	captionWordAnimationSchema,
} from "../../../shared/schema/caption-style.ts";
import { fontFamilySchema } from "../../../shared/schema/text-style.ts";
import { TITLE_FONTS } from "../../../shared/text-style.ts";
import { ImportedFontField } from "../ImportedFontField.tsx";
import { ColorField, NumberField } from "./CaptionStylePanel-fields.tsx";
import {
	type Runtime,
	storedStyle,
	styleTargetTrackId,
} from "./CaptionStylePanel-model.ts";

const ANIMATION_LABELS: Record<
	z.infer<typeof captionWordAnimationSchema>,
	string
> = {
	bounce: "Bounce the spoken word",
	box: "Block behind the spoken word",
	highlight: "Highlight the spoken word",
	karaoke: "Karaoke fill",
	none: "None",
	pop: "Pop the spoken word",
	reveal: "Reveal words as spoken",
};

export function StyleForm({ runtime }: { runtime: Runtime }) {
	const { project } = runtime;
	const resolved = effectiveCaptionStyle(project);
	const [draft, setDraft] = useState<CaptionStyle>(
		() => storedStyle(project) ?? {}
	);
	const value = { ...resolved, ...draft };
	const change = (patch: CaptionStyle) =>
		setDraft((current) => ({ ...current, ...patch, presetId: undefined }));
	const trackId = styleTargetTrackId(project);
	const uppercaseId = useId();
	return (
		<>
			<RyuAppField label="Font">
				<NativeSelect
					aria-label="Caption font"
					onChange={(event) => {
						const parsed = fontFamilySchema.safeParse(event.target.value);
						if (parsed.success) {
							change({ fontFamily: parsed.data });
						}
					}}
					value={value.fontFamily}
				>
					{fontFamilySchema.options.map((family) => (
						<NativeSelectOption key={family} value={family}>
							{TITLE_FONTS[family].label}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<ImportedFontField
				label="Caption"
				onChange={(choice) =>
					change({
						customFont: choice.customFont,
						systemFont: choice.systemFont,
					})
				}
				value={{
					customFont: value.customFont ?? undefined,
					systemFont: value.systemFont ?? undefined,
				}}
			/>
			<NumberField
				label="Size (% of height)"
				max={12}
				min={2}
				onChange={(next) => change({ fontSize: next / 100 })}
				step={0.5}
				value={value.fontSize * 100}
			/>
			<RyuAppField label="Weight">
				<NativeSelect
					aria-label="Caption weight"
					onChange={(event) =>
						change({ fontWeight: Number(event.target.value) })
					}
					value={String(value.fontWeight)}
				>
					{[400, 500, 600, 700, 800, 900].map((weight) => (
						<NativeSelectOption key={weight} value={String(weight)}>
							{weight}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<div className="flex items-center gap-2">
				<Checkbox
					checked={value.uppercase}
					id={uppercaseId}
					onCheckedChange={(checked) => change({ uppercase: checked === true })}
				/>
				<Label htmlFor={uppercaseId}>Uppercase</Label>
			</div>
			<ColorField
				label="Text color"
				onChange={(color) => change({ color })}
				value={value.color}
			/>
			<ColorField
				label="Highlight color"
				onChange={(highlightColor) => change({ highlightColor })}
				value={value.highlightColor}
			/>
			<ColorField
				label="Outline color"
				onChange={(outlineColor) => change({ outlineColor })}
				value={value.outlineColor}
			/>
			<NumberField
				label="Outline (% of height)"
				max={2}
				min={0}
				onChange={(next) => change({ outlineWidth: next / 100 })}
				step={0.05}
				value={value.outlineWidth * 100}
			/>
			<NumberField
				label="Shadow (% of height)"
				max={2}
				min={0}
				onChange={(next) => change({ shadowDepth: next / 100 })}
				step={0.05}
				value={value.shadowDepth * 100}
			/>
			<ColorField
				label="Box color"
				onChange={(backgroundColor) => change({ backgroundColor })}
				value={value.backgroundColor}
			/>
			<NumberField
				label="Box opacity (%)"
				max={100}
				min={0}
				onChange={(next) => change({ backgroundOpacity: next / 100 })}
				step={5}
				value={value.backgroundOpacity * 100}
			/>
			<NumberField
				label="Horizontal position (%)"
				max={100}
				min={0}
				onChange={(next) => change({ positionX: next / 100 })}
				step={1}
				value={value.positionX * 100}
			/>
			<NumberField
				label="Vertical position (%)"
				max={100}
				min={0}
				onChange={(next) => change({ positionY: next / 100 })}
				step={1}
				value={value.positionY * 100}
			/>
			<NumberField
				label="Max lines"
				max={3}
				min={1}
				onChange={(next) => change({ maxLines: Math.round(next) })}
				step={1}
				value={value.maxLines}
			/>
			<RyuAppField label="Word animation">
				<NativeSelect
					aria-label="Caption word animation"
					onChange={(event) => {
						const parsed = captionWordAnimationSchema.safeParse(
							event.target.value
						);
						if (parsed.success) {
							change({ wordAnimation: parsed.data });
						}
					}}
					value={value.wordAnimation}
				>
					{captionWordAnimationSchema.options.map((option) => (
						<NativeSelectOption key={option} value={option}>
							{ANIMATION_LABELS[option]}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<RyuAppActions>
				<Button
					disabled={runtime.busy}
					onClick={() =>
						void runtime.routeEdit(
							"caption-style",
							{ mode: "replace", style: draft, trackId },
							() => "Caption style saved."
						)
					}
					size="sm"
				>
					Apply style
				</Button>
				<Button
					disabled={runtime.busy}
					onClick={() => {
						setDraft({});
						void runtime.routeEdit(
							"caption-style",
							{ mode: "replace", style: {}, trackId },
							() => "Captions use the default style again."
						);
					}}
					size="sm"
					variant="ghost"
				>
					Reset to default
				</Button>
			</RyuAppActions>
		</>
	);
}
