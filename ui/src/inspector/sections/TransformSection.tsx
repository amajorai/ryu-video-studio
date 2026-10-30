import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Toggle } from "@ryu/ui/components/toggle.tsx";
import { MAX_CLIP_OFFSET } from "../../../../shared/limits.ts";
import { scaleXOf, scaleYOf } from "../../../../shared/schema/defaults.ts";
import {
	type FitMode,
	fitModeOf,
	fitModes,
	flipOf,
} from "../../../../shared/transform.ts";
import { NumberField } from "../../NumberField.tsx";
import type { ClipSectionProps } from "../section-props.ts";

/**
 * Tracks the inspector offers. The schema allows more; adding lanes beyond
 * the timeline's 16 is the tracks work's job, so the inspector keeps 16.
 */
export const INSPECTOR_TRACK_COUNT = 16;

const TIMELINE_LIMIT = 7200;

/**
 * Clip speed is not here: `SpeedSection` owns it (0.1-100x, linked clips and
 * clip-length limits through `changeClipSpeed`).
 */

const FIELDS = [
	["start", "Timeline start", 0, TIMELINE_LIMIT],
	["sourceIn", "Source in", 0, TIMELINE_LIMIT],
	["sourceOut", "Source out", 0, TIMELINE_LIMIT],
	["track", "Track", 0, INSPECTOR_TRACK_COUNT - 1],
	["volume", "Volume", 0, 4],
	["scale", "Scale", 0.1, 4],
	["x", "Horizontal position", -MAX_CLIP_OFFSET, MAX_CLIP_OFFSET],
	["y", "Vertical position", -MAX_CLIP_OFFSET, MAX_CLIP_OFFSET],
	["opacity", "Opacity", 0, 1],
	["brightness", "Brightness", -1, 1],
	["contrast", "Contrast", 0, 3],
	["saturation", "Saturation", 0, 3],
	["rotation", "Rotation", -180, 180],
	["fadeIn", "Fade in", 0, TIMELINE_LIMIT],
	["fadeOut", "Fade out", 0, TIMELINE_LIMIT],
] as const;

/** Fields an audio clip without a visualization still shows. */
const AUDIO_FIELDS = new Set<string>([
	"start",
	"sourceIn",
	"sourceOut",
	"track",
	"volume",
	"fadeIn",
	"fadeOut",
]);

const FIT_LABELS: Record<FitMode, string> = {
	fill: "Fill (crop to cover)",
	fit: "Fit (letterbox)",
	stretch: "Stretch",
};

const isFitMode = (value: string): value is FitMode =>
	(fitModes as readonly string[]).includes(value);

/**
 * Flips, the box's horizontal and vertical scale, and how the media sits in
 * the box (W2-V2). Every control patches an optional clip field, which agents
 * reach through `clip-properties`.
 */
export function FlipScaleFitFields({
	onChange,
	segment,
}: Pick<ClipSectionProps, "onChange" | "segment">) {
	const flip = flipOf(segment);
	return (
		<>
			<RyuAppField label="Flip">
				<div className="flex flex-wrap gap-1.5">
					<Toggle
						aria-label="Flip horizontally"
						onPressedChange={(pressed) => onChange({ flipH: pressed })}
						pressed={flip.horizontal}
						size="sm"
						variant="outline"
					>
						Horizontal
					</Toggle>
					<Toggle
						aria-label="Flip vertically"
						onPressedChange={(pressed) => onChange({ flipV: pressed })}
						pressed={flip.vertical}
						size="sm"
						variant="outline"
					>
						Vertical
					</Toggle>
				</div>
			</RyuAppField>
			<RyuAppField label="Box scale">
				<div className="studio-inline-fields">
					<NumberField
						label="Scale X"
						max={4}
						min={0.1}
						onChange={(value) => onChange({ scaleX: value })}
						step={0.05}
						value={scaleXOf(segment)}
					/>
					<NumberField
						label="Scale Y"
						max={4}
						min={0.1}
						onChange={(value) => onChange({ scaleY: value })}
						step={0.05}
						value={scaleYOf(segment)}
					/>
				</div>
			</RyuAppField>
			<RyuAppField label="Fit">
				<NativeSelect
					aria-label="Fit"
					onChange={(event) => {
						const { value } = event.target;
						if (isFitMode(value)) {
							onChange({ fit: value });
						}
					}}
					value={fitModeOf(segment)}
				>
					{fitModes.map((mode) => (
						<NativeSelectOption key={mode} value={mode}>
							{FIT_LABELS[mode]}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
		</>
	);
}

/** Timing, placement, transform, and basic picture fields, plus crop and edge shape. */
export function TransformSection({
	onChange,
	segment,
	visualControls,
}: ClipSectionProps) {
	return (
		<>
			{FIELDS.filter(([key]) => visualControls || AUDIO_FIELDS.has(key)).map(
				([key, label, min, max]) => (
					<NumberField
						key={key}
						label={label}
						max={key === "track" ? INSPECTOR_TRACK_COUNT : max}
						min={key === "track" ? 1 : min}
						onChange={(value) =>
							onChange({ [key]: key === "track" ? value - 1 : value })
						}
						step={key === "track" ? 1 : 0.05}
						value={key === "track" ? segment.track + 1 : segment[key]}
					/>
				)
			)}
			{visualControls && (
				<>
					<FlipScaleFitFields onChange={onChange} segment={segment} />
					<RyuAppField label="Crop edges">
						<div className="studio-inline-fields">
							{(["top", "right", "bottom", "left"] as const).map((edge) => (
								<NumberField
									key={edge}
									label={edge}
									max={0.9}
									min={0}
									onChange={(value) =>
										onChange({ crop: { ...segment.crop, [edge]: value } })
									}
									step={0.01}
									value={segment.crop[edge]}
								/>
							))}
						</div>
					</RyuAppField>
					<RyuAppField label="Edge shape">
						<div className="studio-inline-fields">
							<NumberField
								label="Rounding (%)"
								max={50}
								min={0}
								onChange={(value) => onChange({ edgeRounding: value / 100 })}
								step={1}
								value={segment.edgeRounding * 100}
							/>
							<NumberField
								label="Softness (px)"
								max={80}
								min={0}
								onChange={(value) => onChange({ edgeSoftness: value })}
								step={1}
								value={segment.edgeSoftness}
							/>
						</div>
					</RyuAppField>
				</>
			)}
		</>
	);
}
