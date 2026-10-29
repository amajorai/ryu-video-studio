import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button, Input, Switch } from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import {
	type AdjustmentLayer,
	type AdjustmentLayerPatch,
	adjustmentPresets,
	adjustmentPreviewApproximate,
	DEFAULT_ADJUSTMENT_DURATION,
	MAX_ADJUSTMENT_LAYERS,
	NEUTRAL_GRADE,
	neutralAdjustmentPatch,
	orderedAdjustmentLayers,
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
import { timelineClock } from "../editing-ui.ts";
import { useEditor } from "../editor/context.tsx";
import type { EditorRuntime } from "../editor/runtime.ts";
import { useEditorStore } from "../editor/store.ts";
import { LutField } from "../inspector/sections/ColorAdvancedSection.tsx";
import { NumberField } from "../NumberField.tsx";
import type { PanelTab } from "./types.ts";

/** Adjustment layers have their own library tab. */
export const adjustmentLayerPanelTab: PanelTab | null = {
	label: "Adjustments",
	value: "adjustments",
};

const MAX_TIME = 7200;
/** Mask shapes the panel adds; freeform paths are drawn on clips only. */
const panelMaskShapes = maskShapes.filter((shape) => shape !== "freeform");
const effectTypes = effectTypeSchema.options;
const isEffectType = (value: string): value is EffectType =>
	(effectTypes as readonly string[]).includes(value);

const ADJUSTMENT_ROUTE = "adjustment-layers";

function selectLayer(runtime: EditorRuntime, id: string | null) {
	runtime.store.setState((state) => ({
		selection: {
			...state.selection,
			overlayIds: id ? [{ id, kind: "adjustmentLayers" }] : [],
		},
	}));
}

function layerSummary(layer: AdjustmentLayer): string {
	return `${timelineClock(layer.start)}–${timelineClock(layer.end)} · tracks 1–${layer.track + 1}`;
}

function LayerEditor({
	disabled,
	layer,
	update,
}: {
	disabled: boolean;
	layer: AdjustmentLayer;
	update: (patch: AdjustmentLayerPatch, message: string) => void;
}) {
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
								aria-label={`Enable ${effectLabels[effect.type]}`}
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
								label={`${effectLabels[effect.type]} amount`}
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
								aria-label={`Remove ${effectLabels[effect.type]}`}
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
								aria-label={`Invert ${maskShapeLabels[mask.shape]} mask`}
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
								label={`${maskShapeLabels[mask.shape]} feather`}
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
								aria-label={`Remove ${maskShapeLabels[mask.shape]} mask`}
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

/**
 * Adjustment layers: a timed grade, effect stack and masks over every clip
 * on the chosen track and below. Every edit is a revisioned
 * `POST /projects/:id/adjustment-layers`, so the agent has the same API.
 */
export function AdjustmentLayerPanel() {
	const runtime = useEditor();
	const overlayIds = useEditorStore(
		runtime.store,
		(state) => state.selection.overlayIds
	);
	const { busy, project, time } = runtime;
	if (!project) {
		return null;
	}
	const layers = orderedAdjustmentLayers(project.adjustmentLayers);
	const selectedId =
		overlayIds.find((overlay) => overlay.kind === "adjustmentLayers")?.id ??
		layers[0]?.id;
	const selected = layers.find((layer) => layer.id === selectedId);
	const edit = async (body: Record<string, unknown>, message: string) => {
		const outcome = await runtime.routeEdit(
			ADJUSTMENT_ROUTE,
			body,
			() => message
		);
		const created = outcome.status === "ok" ? outcome.extras?.layer : undefined;
		if (
			created &&
			typeof created === "object" &&
			"id" in created &&
			typeof created.id === "string"
		) {
			selectLayer(runtime, created.id);
		}
		return outcome;
	};
	const create = () => {
		const start = Math.min(time, MAX_TIME - 0.1);
		void edit(
			{
				action: "create",
				layer: {
					end: Math.min(MAX_TIME, start + DEFAULT_ADJUSTMENT_DURATION),
					start,
				},
			},
			"Added an adjustment layer at the playhead."
		);
	};
	const update = (patch: AdjustmentLayerPatch, message: string) => {
		if (selected) {
			void runtime.routeEdit(
				ADJUSTMENT_ROUTE,
				{ action: "update", layer: patch, layerId: selected.id },
				() => message
			);
		}
	};
	return (
		<RyuAppField
			description="Grade and effects over every clip on the chosen track and below, for a time range."
			label="Adjustment layers"
		>
			<RyuAppActions>
				<Button
					disabled={busy || layers.length >= MAX_ADJUSTMENT_LAYERS}
					onClick={create}
					size="sm"
				>
					Add adjustment layer
				</Button>
			</RyuAppActions>
			{layers.length === 0 ? (
				<small>
					No adjustment layers yet. Add one at the playhead to grade everything
					below it.
				</small>
			) : (
				<ul className="flex flex-col gap-1" data-testid="adjustment-layers">
					{layers.map((layer) => (
						<li key={layer.id}>
							<button
								aria-pressed={layer.id === selected?.id}
								className="flex w-full flex-col items-start rounded-md border px-2 py-1 text-left text-xs hover:bg-muted aria-pressed:bg-muted"
								onClick={() => selectLayer(runtime, layer.id)}
								type="button"
							>
								<span className="font-medium">{layer.label}</span>
								<span className="text-muted-foreground">
									{layerSummary(layer)}
									{adjustmentPreviewApproximate(layer)
										? " · approximate preview while playing"
										: ""}
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
			{selected ? (
				<>
					<LayerEditor
						disabled={busy}
						key={selected.id}
						layer={selected}
						update={update}
					/>
					<RyuAppActions>
						<Button
							disabled={busy}
							onClick={() =>
								update(neutralAdjustmentPatch, "Reset the adjustment layer.")
							}
							size="sm"
							variant="outline"
						>
							Reset grade
						</Button>
						<Button
							disabled={busy || layers.length >= MAX_ADJUSTMENT_LAYERS}
							onClick={() =>
								void edit(
									{ action: "duplicate", layerId: selected.id },
									"Duplicated the adjustment layer after itself."
								)
							}
							size="sm"
							variant="outline"
						>
							Duplicate
						</Button>
						<Button
							disabled={busy}
							onClick={() => {
								selectLayer(runtime, null);
								void runtime.routeEdit(
									ADJUSTMENT_ROUTE,
									{ action: "delete", layerId: selected.id },
									() => "Deleted the adjustment layer."
								);
							}}
							size="sm"
							variant="destructive"
						>
							Delete
						</Button>
					</RyuAppActions>
				</>
			) : null}
		</RyuAppField>
	);
}
