import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button, Input, Switch } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import {
	type AdjustmentLayer,
	type AdjustmentLayerPatch,
	adjustmentPresets,
	NEUTRAL_GRADE,
} from "../../../shared/adjustment.ts";
import {
	blendModeLabels,
	blendModes,
	isBlendMode,
} from "../../../shared/blend.ts";
import {
	type EffectType,
	effectLabels,
	effectTypeSchema,
	MAX_EFFECT_STACK,
} from "../../../shared/effects.ts";
import { MAX_TRACK_INDEX } from "../../../shared/limits.ts";
import {
	isMaskShape,
	MAX_CLIP_MASKS,
	type MaskShape,
	maskShapeLabels,
	maskShapes,
} from "../../../shared/masks.ts";
import { defaultMask } from "../../../shared/schema/mask.ts";
import { LutField } from "../inspector/sections/ColorAdvancedSection.tsx";
import { NumberField } from "../NumberField.tsx";

export const MAX_TIME = 7200;
/** Mask shapes the panel adds; freeform paths are drawn on clips only. */
const panelMaskShapes = maskShapes.filter((shape) => shape !== "freeform");
const effectTypes = effectTypeSchema.options;
const isEffectType = (value: string): value is EffectType =>
	(effectTypes as readonly string[]).includes(value);

export function LayerEditor({
	disabled,
	layer,
	update,
}: {
	disabled: boolean;
	layer: AdjustmentLayer;
	update: (patch: AdjustmentLayerPatch, message: string) => void;
}) {
	const tl = useLiteralMessages();
	const grade = layer.colorGrade ?? NEUTRAL_GRADE;
	const effects = layer.effects ?? [];
	const masks = layer.masks ?? [];
	const setGrade = (field: "exposure" | "temperature", value: number) =>
		update(
			{ colorGrade: { ...NEUTRAL_GRADE, ...layer.colorGrade, [field]: value } },
			`Set the adjustment ${field}.`
		);
	return (
		<div className="flex flex-col gap-3" data-testid="adjustment-layer-editor">
			<RyuAppField label="Layer name">
				<Input
					aria-label="Layer name"
					defaultValue={layer.label}
					disabled={disabled}
					key={layer.label}
					maxLength={80}
					onBlur={(event) => {
						const label = event.target.value.trim();
						if (label && label !== layer.label) {
							update({ label }, "Renamed the adjustment layer.");
						} else {
							event.target.value = layer.label;
						}
					}}
				/>
			</RyuAppField>
			<div className="studio-inline-fields">
				<NumberField
					label="Start (s)"
					max={Math.max(0, layer.end - 0.01)}
					min={0}
					onChange={(start) => update({ start }, "Moved the layer start.")}
					step={0.1}
					value={layer.start}
				/>
				<NumberField
					label="End (s)"
					max={MAX_TIME}
					min={layer.start + 0.01}
					onChange={(end) => update({ end }, "Moved the layer end.")}
					step={0.1}
					value={layer.end}
				/>
				<NumberField
					label="Applies through track"
					max={MAX_TRACK_INDEX + 1}
					min={1}
					onChange={(track) =>
						update(
							{ track: Math.round(track) - 1 },
							`The layer now grades tracks 1–${Math.round(track)}.`
						)
					}
					step={1}
					value={layer.track + 1}
				/>
				<NumberField
					label="Opacity"
					max={1}
					min={0}
					onChange={(opacity) => update({ opacity }, "Set the layer opacity.")}
					step={0.05}
					value={layer.opacity}
				/>
			</div>
			<div className="studio-inline-fields">
				<NumberField
					label="Brightness"
					max={1}
					min={-1}
					onChange={(brightness) =>
						update({ brightness }, "Set the adjustment brightness.")
					}
					step={0.05}
					value={layer.brightness ?? 0}
				/>
				<NumberField
					label="Contrast"
					max={3}
					min={0}
					onChange={(contrast) =>
						update({ contrast }, "Set the adjustment contrast.")
					}
					step={0.05}
					value={layer.contrast ?? 1}
				/>
				<NumberField
					label="Saturation"
					max={3}
					min={0}
					onChange={(saturation) =>
						update({ saturation }, "Set the adjustment saturation.")
					}
					step={0.05}
					value={layer.saturation ?? 1}
				/>
				<NumberField
					label="Exposure"
					max={3}
					min={-3}
					onChange={(value) => setGrade("exposure", value)}
					step={0.1}
					value={grade.exposure}
				/>
				<NumberField
					label="Temperature"
					max={1}
					min={-1}
					onChange={(value) => setGrade("temperature", value)}
					step={0.05}
					value={grade.temperature}
				/>
			</div>
			<LutField
				grade={grade}
				onGrade={(next) =>
					update(
						{ colorGrade: next },
						next.lut
							? "Applied the LUT to the adjustment layer."
							: "Removed the adjustment layer's LUT."
					)
				}
			/>
			<RyuAppField label="Presets">
				<RyuAppActions>
					{adjustmentPresets.map((preset) => (
						<Button
							disabled={disabled}
							key={preset.id}
							onClick={() =>
								update(preset.patch, `Applied the ${preset.label} preset.`)
							}
							size="sm"
							variant="outline"
						>
							{preset.label}
						</Button>
					))}
				</RyuAppActions>
			</RyuAppField>
			<RyuAppField label="Layer blend mode">
				<NativeSelect
					aria-label="Layer blend mode"
					disabled={disabled}
					onChange={(event) => {
						const { value } = event.target;
						if (isBlendMode(value)) {
							update(
								{ blendMode: value === "normal" ? null : value },
								`Set the layer blend mode to ${blendModeLabels[value]}.`
							);
						}
					}}
					value={layer.blendMode ?? "normal"}
				>
					{blendModes.map((mode) => (
						<NativeSelectOption key={mode} value={mode}>
							{blendModeLabels[mode]}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<RyuAppField label="Effects">
				<ul className="flex flex-col gap-2">
					{effects.map((effect, index) => (
						<li
							className="studio-inline-fields"
							key={effect.id ?? `${effect.type}-${index}`}
						>
							<Switch
								aria-label={tl("Enable {effect}", {
									effect: effectLabels[effect.type],
								})}
								checked={effect.enabled}
								disabled={disabled}
								onCheckedChange={(enabled) =>
									update(
										{
											effects: effects.map((candidate, at) =>
												at === index ? { ...candidate, enabled } : candidate
											),
										},
										`${enabled ? "Enabled" : "Disabled"} ${effectLabels[effect.type]}.`
									)
								}
							/>
							<NumberField
								label={tl("{effect} amount", {
									effect: effectLabels[effect.type],
								})}
								max={1}
								min={0}
								onChange={(amount) =>
									update(
										{
											effects: effects.map((candidate, at) =>
												at === index ? { ...candidate, amount } : candidate
											),
										},
										`Set the ${effectLabels[effect.type]} amount.`
									)
								}
								step={0.05}
								value={effect.amount}
							/>
							<Button
								aria-label={tl("Remove {effect}", {
									effect: effectLabels[effect.type],
								})}
								disabled={disabled}
								onClick={() =>
									update(
										{
											effects:
												effects.length > 1
													? effects.filter((_, at) => at !== index)
													: null,
										},
										`Removed ${effectLabels[effect.type]}.`
									)
								}
								size="sm"
								variant="ghost"
							>
								Remove
							</Button>
						</li>
					))}
				</ul>
				<NativeSelect
					aria-label="Add effect"
					disabled={disabled || effects.length >= MAX_EFFECT_STACK}
					onChange={(event) => {
						const { value } = event.target;
						event.target.value = "";
						if (isEffectType(value)) {
							update(
								{
									effects: [
										...effects,
										{
											amount: 0.5,
											enabled: true,
											id: crypto.randomUUID(),
											type: value,
										},
									],
								},
								`Added ${effectLabels[value]}.`
							);
						}
					}}
					value=""
				>
					<NativeSelectOption value="">Add effect…</NativeSelectOption>
					{effectTypes.map((type) => (
						<NativeSelectOption key={type} value={type}>
							{effectLabels[type]}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<RyuAppField
				description="Masks limit the grade to part of the frame."
				label="Masks"
			>
				<ul className="flex flex-col gap-2">
					{masks.map((mask, index) => (
						<li className="studio-inline-fields" key={mask.id}>
							<span>{maskShapeLabels[mask.shape]}</span>
							<Switch
								aria-label={tl("Invert {shape} mask", {
									shape: maskShapeLabels[mask.shape],
								})}
								checked={mask.invert}
								disabled={disabled}
								onCheckedChange={(invert) =>
									update(
										{
											masks: masks.map((candidate, at) =>
												at === index ? { ...candidate, invert } : candidate
											),
										},
										invert ? "Inverted the mask." : "Un-inverted the mask."
									)
								}
							/>
							<NumberField
								label={tl("{shape} feather", {
									shape: maskShapeLabels[mask.shape],
								})}
								max={1}
								min={0}
								onChange={(feather) =>
									update(
										{
											masks: masks.map((candidate, at) =>
												at === index ? { ...candidate, feather } : candidate
											),
										},
										"Set the mask feather."
									)
								}
								step={0.05}
								value={mask.feather}
							/>
							<Button
								aria-label={tl("Remove {shape} mask", {
									shape: maskShapeLabels[mask.shape],
								})}
								disabled={disabled}
								onClick={() =>
									update(
										{
											// The edit drops keyframes that target the removed
											// mask (and likewise for a removed effect).
											masks:
												masks.length > 1
													? masks.filter((_, at) => at !== index)
													: null,
										},
										"Removed the mask."
									)
								}
								size="sm"
								variant="ghost"
							>
								Remove
							</Button>
						</li>
					))}
				</ul>
				<NativeSelect
					aria-label="Add mask"
					disabled={disabled || masks.length >= MAX_CLIP_MASKS}
					onChange={(event) => {
						const { value } = event.target;
						event.target.value = "";
						if (isMaskShape(value)) {
							update(
								{
									masks: [
										...masks,
										{
											...defaultMask(value as MaskShape, crypto.randomUUID()),
											height: 0.6,
											width: 0.6,
										},
									],
								},
								`Added a ${maskShapeLabels[value].toLowerCase()} mask.`
							);
						}
					}}
					value=""
				>
					<NativeSelectOption value="">Add mask…</NativeSelectOption>
					{panelMaskShapes.map((shape) => (
						<NativeSelectOption key={shape} value={shape}>
							{maskShapeLabels[shape]}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
		</div>
	);
}
