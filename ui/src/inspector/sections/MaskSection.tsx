import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button, Input } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { ColorPickerPopover } from "@ryu/ui/components/color-picker.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Toggle } from "@ryu/ui/components/toggle.tsx";
import { type ReactNode, useState } from "react";
import {
	addMask,
	isMaskShape,
	MAX_CLIP_MASKS,
	type Mask,
	type MaskShape,
	maskAnimated,
	maskShapeLabels,
	maskShapes,
	maskStrokeAlignLabels,
	maskStrokeAlignOf,
	maskStrokeColorOf,
	removeMaskPatch,
	updateMask,
} from "../../../../shared/masks.ts";
import {
	MAX_MASK_STROKE_WIDTH,
	maskStrokeAlignSchema,
} from "../../../../shared/schema/mask.ts";
import {
	type FontFamily,
	fontFamilySchema,
} from "../../../../shared/schema/text-style.ts";
import { NumberField } from "../../NumberField.tsx";
import type { ClipSectionProps } from "../section-props.ts";
import { setActiveMask, useActiveMaskId } from "./mask-selection.ts";

type MaskPatch = Partial<Omit<Mask, "id">>;

const fontLabels: Record<FontFamily, string> = {
	"system-sans": "System sans",
	inter: "Inter",
	roboto: "Roboto",
	montserrat: "Montserrat",
	poppins: "Poppins",
	oswald: "Oswald",
	"bebas-neue": "Bebas Neue",
	anton: "Anton",
	"playfair-display": "Playfair Display",
	merriweather: "Merriweather",
	"source-code-pro": "Source Code Pro",
	"permanent-marker": "Permanent Marker",
	lobster: "Lobster",
};

const isFontFamily = (value: string): value is FontFamily =>
	fontFamilySchema.safeParse(value).success;

/** Fields only some shapes use. */
function ShapeFields({
	mask,
	onPatch,
}: {
	mask: Mask;
	onPatch: (patch: MaskPatch) => void;
}) {
	const tl = useLiteralMessages();
	switch (mask.shape) {
		case "rectangle":
			return (
				<NumberField
					label="Corner radius"
					max={0.5}
					min={0}
					onChange={(value) => onPatch({ cornerRadius: value })}
					step={0.05}
					value={mask.cornerRadius ?? 0}
				/>
			);
		case "polygon":
			return (
				<NumberField
					label="Sides"
					max={12}
					min={3}
					onChange={(value) => onPatch({ sides: Math.round(value) })}
					step={1}
					value={mask.sides ?? 6}
				/>
			);
		case "star":
			return (
				<div className="studio-inline-fields">
					<NumberField
						label="Points"
						max={12}
						min={3}
						onChange={(value) => onPatch({ points: Math.round(value) })}
						step={1}
						value={mask.points ?? 5}
					/>
					<NumberField
						label="Inner radius"
						max={0.95}
						min={0.1}
						onChange={(value) => onPatch({ innerRadius: value })}
						step={0.05}
						value={mask.innerRadius ?? 0.5}
					/>
				</div>
			);
		case "text":
			return (
				<>
					<RyuAppField label="Mask text">
						<Input
							aria-label="Mask text"
							defaultValue={mask.text}
							key={mask.text}
							maxLength={80}
							onBlur={(event) => {
								const text = event.target.value.trim();
								if (text && text !== mask.text) {
									onPatch({ text });
								} else {
									event.target.value = mask.text ?? "";
								}
							}}
						/>
					</RyuAppField>
					<RyuAppField label="Mask font">
						<NativeSelect
							aria-label="Mask font"
							onChange={(event) => {
								const { value } = event.target;
								if (isFontFamily(value)) {
									onPatch({ fontFamily: value });
								}
							}}
							value={mask.fontFamily ?? "system-sans"}
						>
							{fontFamilySchema.options.map((font) => (
								<NativeSelectOption key={font} value={font}>
									{fontLabels[font]}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</RyuAppField>
				</>
			);
		case "freeform":
			return (
				<small>
					{tl(
						"{count} points. Drag the points on the preview to reshape the path.",
						{ count: mask.path?.length ?? 0 }
					)}
				</small>
			);
		default:
			return null;
	}
}

/**
 * The mask's outline stroke: width (a fraction of the clip's height; 0 is
 * off), color and alignment. Text masks have no stroke.
 */
function StrokeFields({
	mask,
	onPatch,
}: {
	mask: Mask;
	onPatch: (patch: MaskPatch) => void;
}) {
	if (mask.shape === "text") {
		return <small>Text masks have no outline stroke.</small>;
	}
	const width = mask.strokeWidth ?? 0;
	return (
		<div className="studio-inline-fields">
			<NumberField
				label="Mask stroke width"
				max={MAX_MASK_STROKE_WIDTH}
				min={0}
				onChange={(value) => onPatch({ strokeWidth: value })}
				step={0.005}
				value={width}
			/>
			<RyuAppField label="Mask stroke color">
				<ColorPickerPopover
					onValueChange={(value) => onPatch({ strokeColor: value })}
					triggerAriaLabel="Mask stroke color"
					triggerClassName="w-full justify-start"
					value={maskStrokeColorOf(mask)}
				/>
			</RyuAppField>
			<RyuAppField label="Mask stroke alignment">
				<NativeSelect
					aria-label="Mask stroke alignment"
					disabled={width <= 0}
					onChange={(event) => {
						const align = maskStrokeAlignSchema.safeParse(event.target.value);
						if (align.success) {
							onPatch({ strokeAlign: align.data });
						}
					}}
					value={maskStrokeAlignOf(mask)}
				>
					{maskStrokeAlignSchema.options.map((align) => (
						<NativeSelectOption key={align} value={align}>
							{maskStrokeAlignLabels[align]}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
		</div>
	);
}

function MaskFields({
	animated,
	mask,
	onPatch,
	onRemove,
	shapes,
}: {
	animated: boolean;
	mask: Mask;
	onPatch: (patch: MaskPatch) => void;
	onRemove: () => void;
	shapes: readonly MaskShape[];
}) {
	return (
		<>
			<RyuAppField label="Mask shape">
				<NativeSelect
					aria-label="Mask shape"
					onChange={(event) => {
						const { value } = event.target;
						if (isMaskShape(value)) {
							onPatch({ shape: value });
						}
					}}
					value={mask.shape}
				>
					{shapes.map((shape) => (
						<NativeSelectOption key={shape} value={shape}>
							{maskShapeLabels[shape]}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			{animated && (
				<small data-testid="mask-animated">
					Keyframes animate this mask; the fields show its resting values.
				</small>
			)}
			<div className="studio-inline-fields">
				<NumberField
					label="Mask center X"
					max={1}
					min={-1}
					onChange={(value) => onPatch({ x: value })}
					step={0.05}
					value={mask.x}
				/>
				<NumberField
					label="Mask center Y"
					max={1}
					min={-1}
					onChange={(value) => onPatch({ y: value })}
					step={0.05}
					value={mask.y}
				/>
			</div>
			<div className="studio-inline-fields">
				<NumberField
					label="Mask width"
					max={2}
					min={0}
					onChange={(value) => onPatch({ width: value })}
					step={0.05}
					value={mask.width}
				/>
				<NumberField
					label="Mask height"
					max={2}
					min={0}
					onChange={(value) => onPatch({ height: value })}
					step={0.05}
					value={mask.height}
				/>
			</div>
			<div className="studio-inline-fields">
				<NumberField
					label="Mask rotation"
					max={180}
					min={-180}
					onChange={(value) => onPatch({ rotation: value })}
					step={1}
					value={mask.rotation}
				/>
				<NumberField
					label="Mask feather"
					max={1}
					min={0}
					onChange={(value) => onPatch({ feather: value })}
					step={0.05}
					value={mask.feather}
				/>
				<NumberField
					label="Mask opacity"
					max={1}
					min={0}
					onChange={(value) => onPatch({ opacity: value })}
					step={0.05}
					value={mask.opacity}
				/>
			</div>
			<ShapeFields mask={mask} onPatch={onPatch} />
			<StrokeFields mask={mask} onPatch={onPatch} />
			<div className="flex flex-wrap gap-1.5">
				<Toggle
					aria-label="Invert mask"
					onPressedChange={(pressed) => onPatch({ invert: pressed })}
					pressed={mask.invert}
					size="sm"
					variant="outline"
				>
					Invert
				</Toggle>
				<Button
					aria-label="Remove mask"
					onClick={onRemove}
					size="sm"
					variant="ghost"
				>
					Remove
				</Button>
			</div>
		</>
	);
}

export interface MaskListEditorProps {
	/** The mask being edited, if any. */
	activeId: string | undefined;
	/** Whether keyframes drive a mask (its fields then show resting values). */
	animated?: (mask: Mask) => boolean;
	/** Field label for the whole editor. */
	label: string;
	/** Shown once the owner has the most masks it can hold. */
	limitNotice: ReactNode;
	/** Accessible name of the mask toggles' group. */
	listLabel: string;
	masks: readonly Mask[];
	onAdd: (shape: MaskShape) => void;
	onPatch: (id: string, patch: MaskPatch) => void;
	onRemove: (id: string) => void;
	onSelect: (id: string) => void;
	/** Shapes the owner accepts. */
	shapes: readonly MaskShape[];
}

/**
 * A mask list: toggles to pick the mask being edited, an add control with the
 * shape picker, and the selected mask's fields. Clip and graphic masks share it.
 */
export function MaskListEditor({
	activeId,
	animated = () => false,
	label,
	limitNotice,
	listLabel,
	masks,
	onAdd,
	onPatch,
	onRemove,
	onSelect,
	shapes,
}: MaskListEditorProps) {
	const tl = useLiteralMessages();
	const [shape, setShape] = useState<MaskShape>("ellipse");
	const active = masks.find((mask) => mask.id === activeId);
	return (
		<RyuAppField label={label}>
			{masks.length > 0 && (
				<div
					aria-label={listLabel}
					className="flex flex-wrap gap-1.5"
					role="group"
				>
					{masks.map((mask, index) => (
						<Toggle
							aria-label={tl("Edit mask {maskNumber}: {shapeName}", {
								maskNumber: String(index + 1),
								shapeName: maskShapeLabels[mask.shape],
							})}
							key={mask.id}
							onPressedChange={() => onSelect(mask.id)}
							pressed={mask.id === activeId}
							size="sm"
							variant="outline"
						>
							{`${index + 1}. ${maskShapeLabels[mask.shape]}`}
						</Toggle>
					))}
				</div>
			)}
			<div className="studio-inline-fields">
				<NativeSelect
					aria-label="New mask shape"
					onChange={(event) => {
						const { value } = event.target;
						if (isMaskShape(value)) {
							setShape(value);
						}
					}}
					value={shape}
				>
					{shapes.map((option) => (
						<NativeSelectOption key={option} value={option}>
							{maskShapeLabels[option]}
						</NativeSelectOption>
					))}
				</NativeSelect>
				<Button
					disabled={masks.length >= MAX_CLIP_MASKS}
					onClick={() => onAdd(shape)}
					size="sm"
					variant="outline"
				>
					Add mask
				</Button>
			</div>
			{masks.length >= MAX_CLIP_MASKS && limitNotice}
			{active && (
				<MaskFields
					animated={animated(active)}
					mask={active}
					onPatch={(patch) => onPatch(active.id, patch)}
					onRemove={() => onRemove(active.id)}
					shapes={shapes}
				/>
			)}
		</RyuAppField>
	);
}

/**
 * Up to four masks per clip (W2-V3) through `MaskListEditor`. The preview
 * draws handles for the active mask. Agents set `masks` through
 * `clip-properties`.
 */
export function MaskSection({
	onChange,
	segment,
	visualControls,
}: ClipSectionProps) {
	const tl = useLiteralMessages();
	const masks = segment.masks ?? [];
	const activeId = useActiveMaskId(
		segment.id,
		masks.map((mask) => mask.id)
	);
	if (!visualControls) {
		return null;
	}
	const limitText = tl("A clip can have up to {maxMasks} masks.", {
		maxMasks: MAX_CLIP_MASKS,
	});
	const select = (maskId: string) =>
		setActiveMask({ maskId, segmentId: segment.id });
	return (
		<MaskListEditor
			activeId={activeId}
			animated={(mask) => maskAnimated(segment, mask)}
			label="Masks"
			limitNotice={<small>{limitText}</small>}
			listLabel="Clip masks"
			masks={masks}
			onAdd={(shape) => {
				const id = crypto.randomUUID();
				onChange({ masks: addMask(masks, shape, id) });
				select(id);
			}}
			onPatch={(id, patch) => {
				try {
					onChange({ masks: updateMask(masks, id, patch) });
				} catch {
					// Out-of-range values are refused; the field resets to the stored value.
				}
			}}
			onRemove={(id) => onChange(removeMaskPatch(segment, id))}
			onSelect={select}
			shapes={maskShapes}
		/>
	);
}
