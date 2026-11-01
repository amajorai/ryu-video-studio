import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { useLiteralMessages } from "@ryu/i18n/react";
import { ColorPickerPopover } from "@ryu/ui/components/color-picker.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import {
	type BackgroundType,
	backgroundForType,
	backgroundTypeLabels,
	type CanvasBackground,
	normalizeHexColor,
} from "../../../shared/background.ts";
import type { Asset } from "../../../shared/project.ts";
import { NumberField } from "../NumberField.tsx";

const NONE = "none";

export interface BackgroundFieldsProps {
	/** Fallback color when switching from blur or image to a color fill. */
	fallbackColor: string;
	/** Visual media an image background may use (empty disables Image). */
	imageAssets: readonly Asset[];
	/** Accessible name prefix, e.g. "Canvas" or "Clip". */
	label: string;
	/** Label of the "no explicit background" option. */
	noneLabel: string;
	onChange: (background: CanvasBackground | undefined) => void;
	types: readonly BackgroundType[];
	value: CanvasBackground | undefined;
}

const isBackgroundType = (
	types: readonly BackgroundType[],
	value: string
): value is BackgroundType => (types as readonly string[]).includes(value);

/**
 * Type picker plus the fields of one background (W2-V8), shared by the
 * project panel and the clip inspector. Every change emits a whole,
 * schema-valid background, or undefined for the "none" option.
 */
export function BackgroundFields({
	fallbackColor,
	imageAssets,
	label,
	noneLabel,
	onChange,
	types,
	value,
}: BackgroundFieldsProps) {
	const tl = useLiteralMessages();
	const current: CanvasBackground = value ?? {
		color: fallbackColor,
		type: "color",
	};
	const color = (
		name: string,
		hex: string,
		apply: (next: string) => CanvasBackground
	) => (
		<RyuAppField label={name}>
			<ColorPickerPopover
				onValueChange={(next) => {
					const normalized = normalizeHexColor(next);
					if (normalized) {
						onChange(apply(normalized));
					}
				}}
				triggerAriaLabel={`${label} ${name.toLowerCase()}`}
				triggerClassName="w-full justify-start"
				value={hex}
			/>
		</RyuAppField>
	);
	return (
		<>
			<RyuAppField label="Type">
				<NativeSelect
					aria-label={tl("{label} background", { label })}
					onChange={(event) => {
						const next = event.target.value;
						if (next === NONE) {
							onChange(undefined);
						} else if (isBackgroundType(types, next)) {
							const background = backgroundForType(next, current, {
								fallbackColor,
								imageAssetId: imageAssets[0]?.id,
							});
							if (background) {
								onChange(background);
							}
						}
					}}
					value={value?.type ?? NONE}
				>
					<NativeSelectOption value={NONE}>{noneLabel}</NativeSelectOption>
					{types.map((type) => (
						<NativeSelectOption
							disabled={type === "image" && imageAssets.length === 0}
							key={type}
							value={type}
						>
							{backgroundTypeLabels[type]}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			{value?.type === "color" &&
				color("Color", value.color, (next) => ({ ...value, color: next }))}
			{value?.type === "gradient" && (
				<>
					{color("Start color", value.color, (next) => ({
						...value,
						color: next,
					}))}
					{color("End color", value.color2, (next) => ({
						...value,
						color2: next,
					}))}
					<NumberField
						label={tl("{label} gradient angle (°)", { label })}
						max={360}
						min={0}
						onChange={(angle) => onChange({ ...value, angle })}
						step={1}
						value={value.angle}
					/>
				</>
			)}
			{value?.type === "blur" && (
				<div className="studio-inline-fields">
					<NumberField
						label={tl("{label} blur amount (%)", { label })}
						max={100}
						min={0}
						onChange={(amount) => onChange({ ...value, amount: amount / 100 })}
						step={1}
						value={value.amount * 100}
					/>
					<NumberField
						label={tl("{label} blur dim (%)", { label })}
						max={100}
						min={0}
						onChange={(dim) => onChange({ ...value, dim: dim / 100 })}
						step={1}
						value={value.dim * 100}
					/>
				</div>
			)}
			{value?.type === "image" && (
				<RyuAppField label="Image">
					<NativeSelect
						aria-label={tl("{label} background image", { label })}
						onChange={(event) =>
							onChange({ assetId: event.target.value, type: "image" })
						}
						value={value.assetId}
					>
						{imageAssets.map((asset) => (
							<NativeSelectOption key={asset.id} value={asset.id}>
								{asset.name}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</RyuAppField>
			)}
		</>
	);
}
