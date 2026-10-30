import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Checkbox, Label } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { ColorPickerPopover } from "@ryu/ui/components/color-picker.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useId } from "react";
import type { Title } from "../../shared/project.ts";
import {
	fontFamilySchema,
	textAlignSchema,
	titleAnimationInSchema,
	titleAnimationLoopSchema,
	titleAnimationOutSchema,
} from "../../shared/schema/text-style.ts";
import {
	DEFAULT_GRADIENT_END,
	TITLE_FONTS,
	titleStyleOf,
} from "../../shared/text-style.ts";
import { MISSING_FONTS_NOTICE, useBundledAssets } from "./bundled-assets.ts";
import { ImportedFontField } from "./ImportedFontField.tsx";
import { NumberField } from "./NumberField.tsx";

type OptionalKey = Exclude<
	keyof Title,
	| "animation"
	| "color"
	| "end"
	| "fadeIn"
	| "fadeOut"
	| "fontSize"
	| "id"
	| "start"
	| "text"
	| "x"
	| "y"
>;

/** `title` with optional field `key` set, or removed when `value` is undefined. */
export function withTitleField<K extends OptionalKey>(
	title: Title,
	key: K,
	value: Title[K] | undefined
): Title {
	const next = { ...title };
	if (value === undefined) {
		delete next[key];
	} else {
		next[key] = value;
	}
	return next;
}

const label = (value: string) =>
	value
		.split("-")
		.map((word) => word[0]?.toUpperCase() + word.slice(1))
		.join(" ");

const WEIGHTS = [300, 400, 500, 600, 700, 800, 900] as const;

/** Numeric fields with their label, bounds, and the unit shown to people. */
const NUMBER_FIELDS = [
	["letterSpacing", "Letter spacing (em)", -0.1, 0.5, 0.01],
	["lineHeight", "Line height", 0.8, 3, 0.05],
	["outlineWidth", "Outline width", 0, 0.02, 0.001],
	["shadowDepth", "Shadow distance", 0, 0.02, 0.001],
	["shadowBlur", "Shadow blur", 0, 10, 0.5],
	["rotation", "Rotation (degrees)", -180, 180, 1],
	["animationInDuration", "In duration (s)", 0, 5, 0.05],
	["animationOutDuration", "Out duration (s)", 0, 5, 0.05],
] as const;

/** Text blur, as a fraction of the canvas height like the outline. */
const BLUR_FIELD = ["textBlur", "Text blur", 0, 0.02, 0.001] as const;

const BOX_FIELDS = [
	["backgroundOpacity", "Box opacity", 0, 1, 0.05],
	["backgroundPadding", "Box padding", 0, 0.05, 0.002],
	["backgroundPaddingX", "Box horizontal padding", 0, 0.05, 0.002],
	["backgroundPaddingY", "Box vertical padding", 0, 0.05, 0.002],
	["backgroundOffsetX", "Box offset X", -0.1, 0.1, 0.002],
	["backgroundOffsetY", "Box offset Y", -0.1, 0.1, 0.002],
	["backgroundRadius", "Corner radius", 0, 0.5, 0.05],
] as const;

type StyleNumberField =
	| (typeof BOX_FIELDS)[number]
	| (typeof NUMBER_FIELDS)[number]
	| typeof BLUR_FIELD;

/**
 * Text style and motion controls for one title. Unset fields show their
 * resolved default; choosing "Default" removes the field so legacy titles
 * keep rendering exactly as before.
 */
export function TitleStyleControls({
	index,
	onChange,
	title,
}: {
	index: number;
	onChange: (title: Title) => void;
	title: Title;
}) {
	const tl = useLiteralMessages();
	const id = useId();
	const bundled = useBundledAssets();
	const style = titleStyleOf(title);
	const set = <K extends OptionalKey>(key: K, value: Title[K] | undefined) =>
		onChange(withTitleField(title, key, value));
	const name = `Title ${index + 1}`;
	const numberInput = ([key, text, min, max, step]: StyleNumberField) => {
		const auto =
			key === "animationInDuration" || key === "animationOutDuration";
		const resolved = auto ? undefined : style[key as keyof typeof style];
		const current = title[key];
		return (
			<NumberField
				ariaLabel={`${name} ${text}`}
				blank={current === undefined}
				key={key}
				label={text}
				max={max}
				min={min}
				onChange={(value) => set(key, value)}
				onClear={() => set(key, undefined)}
				placeholder={auto ? "auto" : String(resolved ?? "")}
				step={step}
				value={current ?? (typeof resolved === "number" ? resolved : min)}
			/>
		);
	};
	const toggle = (key: "italic" | "strike" | "underline", text: string) => (
		<div className="flex items-center gap-2" key={key}>
			<Checkbox
				aria-label={`${name} ${text}`}
				checked={style[key]}
				id={`${id}-${key}`}
				onCheckedChange={(checked) => set(key, checked ? true : undefined)}
			/>
			<Label htmlFor={`${id}-${key}`}>{text}</Label>
		</div>
	);
	const select = <T extends string>(
		key:
			| "align"
			| "animationIn"
			| "animationLoop"
			| "animationOut"
			| "fontFamily",
		text: string,
		options: readonly T[],
		describe: (value: T) => string = label
	) => (
		<RyuAppField key={key} label={text}>
			<NativeSelect
				aria-label={`${name} ${text}`}
				onChange={(event) => {
					const value = event.target.value;
					set(key, (value === "" ? undefined : value) as Title[typeof key]);
				}}
				value={title[key] ?? ""}
			>
				<NativeSelectOption value="">Default</NativeSelectOption>
				{options.map((option) => (
					<NativeSelectOption key={option} value={option}>
						{describe(option)}
					</NativeSelectOption>
				))}
			</NativeSelect>
		</RyuAppField>
	);
	const color = (
		key:
			| "backgroundColor"
			| "gradientColor"
			| "highlightColor"
			| "outlineColor"
			| "shadowColor",
		text: string,
		value: string
	) => (
		<RyuAppField key={key} label={text}>
			<ColorPickerPopover
				onValueChange={(next) => set(key, next)}
				triggerAriaLabel={`${name} ${text}`}
				triggerClassName="w-full justify-start"
				value={value}
			/>
		</RyuAppField>
	);
	return (
		<details className="flex flex-col gap-2" data-title-style={title.id}>
			<summary className="cursor-pointer text-sm">Style and motion</summary>
			{select("fontFamily", "Font", fontFamilySchema.options, (font) =>
				font === "system-sans" ? "System sans" : TITLE_FONTS[font].label
			)}
			{bundled.fonts === false ? <small>{MISSING_FONTS_NOTICE}</small> : null}
			<ImportedFontField
				label={name}
				onChange={(choice) =>
					onChange(
						withTitleField(
							withTitleField(title, "customFont", choice.customFont),
							"systemFont",
							choice.systemFont
						)
					)
				}
				value={{ customFont: title.customFont, systemFont: title.systemFont }}
			/>
			<RyuAppField label="Weight">
				<NativeSelect
					aria-label={tl("Title {number} Weight", { number: index + 1 })}
					onChange={(event) =>
						set(
							"fontWeight",
							event.target.value ? Number(event.target.value) : undefined
						)
					}
					value={title.fontWeight ?? ""}
				>
					<NativeSelectOption value="">Default (bold)</NativeSelectOption>
					{WEIGHTS.map((weight) => (
						<NativeSelectOption key={weight} value={weight}>
							{weight}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<div className="flex flex-wrap gap-3">
				{toggle("italic", "Italic")}
				{toggle("underline", "Underline")}
				{toggle("strike", "Strikethrough")}
			</div>
			{select("align", "Alignment", textAlignSchema.options)}
			<RyuAppField label="Fill">
				<NativeSelect
					aria-label={tl("Title {number} Fill", { number: index + 1 })}
					onChange={(event) => {
						const gradient = event.target.value === "gradient";
						onChange(
							withTitleField(
								withTitleField(
									title,
									"fillMode",
									gradient ? "gradient" : undefined
								),
								"gradientColor",
								gradient
									? (title.gradientColor ?? DEFAULT_GRADIENT_END)
									: undefined
							)
						);
					}}
					value={title.fillMode ?? "solid"}
				>
					<NativeSelectOption value="solid">Solid color</NativeSelectOption>
					<NativeSelectOption value="gradient">
						Gradient (left to right)
					</NativeSelectOption>
				</NativeSelect>
			</RyuAppField>
			{style.gradientColor &&
				color("gradientColor", "Gradient end color", style.gradientColor)}
			{numberInput(BLUR_FIELD)}
			{NUMBER_FIELDS.slice(0, 2).map(numberInput)}
			{color("outlineColor", "Outline color", style.outlineColor)}
			{numberInput(NUMBER_FIELDS[2])}
			{color("shadowColor", "Shadow color", style.shadowColor)}
			{NUMBER_FIELDS.slice(3, 6).map(numberInput)}
			<div className="flex items-center gap-2">
				<Checkbox
					aria-label={tl("Title {number} Background box", {
						number: index + 1,
					})}
					checked={style.backgroundColor !== null}
					id={`${id}-box`}
					onCheckedChange={(checked) =>
						set("backgroundColor", checked ? "#000000" : undefined)
					}
				/>
				<Label htmlFor={`${id}-box`}>Background box</Label>
			</div>
			{style.backgroundColor && (
				<>
					{color("backgroundColor", "Box color", style.backgroundColor)}
					{BOX_FIELDS.map(numberInput)}
				</>
			)}
			{select("animationIn", "In animation", titleAnimationInSchema.options)}
			{select("animationOut", "Out animation", titleAnimationOutSchema.options)}
			{select("animationLoop", "Loop", titleAnimationLoopSchema.options)}
			{NUMBER_FIELDS.slice(6).map(numberInput)}
			{color("highlightColor", "Highlight color", style.highlightColor)}
		</details>
	);
}
