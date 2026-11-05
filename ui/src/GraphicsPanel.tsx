import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { ColorPickerPopover } from "@ryu/ui/components/color-picker.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import {
	blendModeLabels,
	blendModes,
	isBlendMode,
} from "../../shared/blend.ts";
import type { Graphic } from "../../shared/project.ts";
import { graphicSchema } from "../../shared/project.ts";
import {
	type StrokeAlign,
	strokeAlignOf,
} from "../../shared/shape-geometry.ts";
import { type StyleProfile, styleProfileConfig } from "../../shared/styles.ts";
import { withGraphicFields } from "./GraphicsPanel-graphic-fields.ts";
import {
	GraphicKeyframes,
	GraphicMasks,
	ShapeGeometryFields,
} from "./GraphicsPanel-shape-sections.tsx";
import { NumberField } from "./NumberField.tsx";

export {
	addGraphicKeyframe,
	removeGraphicKeyframe,
	setGraphicKeyframeInterpolation,
	withGraphicFields,
} from "./GraphicsPanel-graphic-fields.ts";

type GraphicShape = Graphic["shape"];

const shapeLabels: Record<GraphicShape, string> = {
	arrow: "Arrow",
	ellipse: "Ellipse",
	heart: "Heart",
	line: "Line",
	polygon: "Polygon",
	rectangle: "Rectangle",
	star: "Star",
	triangle: "Triangle",
};

const strokeAlignLabels: Record<StrokeAlign, string> = {
	center: "Center",
	inside: "Inside",
	outside: "Outside",
};

export function GraphicsPanel({
	graphics,
	styleProfile,
	time,
	onChange,
}: {
	graphics: Graphic[];
	styleProfile: StyleProfile;
	time: number;
	onChange: (graphics: Graphic[]) => void;
}) {
	const tl = useLiteralMessages();
	const add = () =>
		onChange([
			...graphics,
			{
				animation: "slide-up",
				end: Math.min(7200, time + 3),
				entryDuration: 0.35,
				fill: styleProfileConfig(styleProfile).accent,
				height: 0.18,
				id: crypto.randomUUID(),
				opacity: 0.88,
				shape: "rectangle",
				start: time,
				stroke: "#ffffff",
				strokeWidth: 0,
				width: 0.42,
				x: 0.08,
				y: 0.12,
			},
		]);
	const change = (id: string, patch: Partial<Graphic>) =>
		onChange(
			graphics.map((graphic) =>
				graphic.id === id ? { ...graphic, ...patch } : graphic
			)
		);
	const replace = (next: Graphic) =>
		onChange(
			graphics.map((graphic) => (graphic.id === next.id ? next : graphic))
		);
	return (
		<RyuAppSection title="Vector graphics">
			<RyuAppActions>
				<Button disabled={time > 7199} onClick={add} variant="outline">
					Add vector shape
				</Button>
			</RyuAppActions>
			<p className="text-muted-foreground">
				Create rectangle, ellipse, triangle, line, polygon, star, heart, and
				arrow layers with rounded corners, aligned strokes, rotation, blend
				modes, and keyframed motion. They stay editable in the saved project and
				render locally.
			</p>
			{graphics.map((graphic, index) => (
				<div className="studio-scene" key={graphic.id}>
					<strong>{tl("Vector shape {number}", { number: index + 1 })}</strong>
					<RyuAppField label="Shape">
						<NativeSelect
							aria-label={tl("Vector shape {number} shape", {
								number: index + 1,
							})}
							onChange={(event) =>
								change(graphic.id, {
									shape: graphicSchema.shape.shape.parse(event.target.value),
								})
							}
							value={graphic.shape}
						>
							{graphicSchema.shape.shape.unwrap().options.map((shape) => (
								<NativeSelectOption key={shape} value={shape}>
									{shapeLabels[shape]}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</RyuAppField>
					<ShapeGeometryFields
						graphic={graphic}
						index={index}
						onChange={replace}
					/>
					{(
						[
							["start", "Start", 0, 7200],
							["end", "End", 0, 7200],
							["x", "Left", 0, 1],
							["y", "Top", 0, 1],
							["width", "Width", 0.02, 1],
							["height", "Height", 0.02, 1],
							["opacity", "Opacity", 0, 1],
							["entryDuration", "Entry duration", 0, 10],
						] as const
					).map(([key, label, min, max]) => (
						<NumberField
							ariaLabel={tl("Graphic {number} {label}", {
								label,
								number: index + 1,
							})}
							key={key}
							label={label}
							max={max}
							min={min}
							onChange={(value) => change(graphic.id, { [key]: value })}
							step={0.01}
							value={graphic[key]}
						/>
					))}
					<RyuAppField label="Fill color">
						<ColorPickerPopover
							onValueChange={(value) => change(graphic.id, { fill: value })}
							triggerAriaLabel={tl("Graphic {number} fill color", {
								number: index + 1,
							})}
							triggerClassName="w-full justify-start"
							value={graphic.fill}
						/>
					</RyuAppField>
					<RyuAppField label="Stroke color">
						<ColorPickerPopover
							onValueChange={(value) => change(graphic.id, { stroke: value })}
							triggerAriaLabel={tl("Vector shape {number} stroke color", {
								number: index + 1,
							})}
							triggerClassName="w-full justify-start"
							value={graphic.stroke}
						/>
					</RyuAppField>
					<NumberField
						ariaLabel={tl("Vector shape {number} stroke width", {
							number: index + 1,
						})}
						label="Stroke width"
						max={0.08}
						min={0}
						onChange={(value) => change(graphic.id, { strokeWidth: value })}
						step={0.005}
						value={graphic.strokeWidth}
					/>
					{graphic.shape === "line" ? null : (
						<RyuAppField label="Stroke alignment">
							<NativeSelect
								aria-label={tl("Vector shape {number} stroke alignment", {
									number: index + 1,
								})}
								onChange={(event) => {
									const align = graphicSchema.shape.strokeAlign
										.unwrap()
										.safeParse(event.target.value);
									if (align.success) {
										replace(
											withGraphicFields(graphic, { strokeAlign: align.data })
										);
									}
								}}
								value={strokeAlignOf(graphic)}
							>
								{(["inside", "center", "outside"] as const).map((align) => (
									<NativeSelectOption key={align} value={align}>
										{strokeAlignLabels[align]}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</RyuAppField>
					)}
					<RyuAppField label="Blend mode">
						<NativeSelect
							aria-label={tl("Vector shape {number} blend mode", {
								number: index + 1,
							})}
							onChange={(event) => {
								const { value } = event.target;
								if (isBlendMode(value)) {
									replace(
										withGraphicFields(graphic, {
											blendMode: value === "normal" ? undefined : value,
										})
									);
								}
							}}
							value={graphic.blendMode ?? "normal"}
						>
							{blendModes.map((mode) => (
								<NativeSelectOption key={mode} value={mode}>
									{blendModeLabels[mode]}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</RyuAppField>
					<RyuAppField label="Entry animation">
						<NativeSelect
							aria-label={tl("Graphic {number} entry animation", {
								number: index + 1,
							})}
							onChange={(event) =>
								change(graphic.id, {
									animation: graphicSchema.shape.animation.parse(
										event.target.value
									),
								})
							}
							value={graphic.animation}
						>
							<NativeSelectOption value="none">None</NativeSelectOption>
							<NativeSelectOption value="slide-up">Slide up</NativeSelectOption>
							<NativeSelectOption value="slide-down">
								Slide down
							</NativeSelectOption>
							<NativeSelectOption value="slide-left">
								Slide left
							</NativeSelectOption>
							<NativeSelectOption value="slide-right">
								Slide right
							</NativeSelectOption>
						</NativeSelect>
					</RyuAppField>
					<GraphicMasks graphic={graphic} onChange={replace} />
					<GraphicKeyframes
						graphic={graphic}
						index={index}
						onChange={replace}
						time={time}
					/>
					<Button
						onClick={() =>
							onChange(graphics.filter((item) => item.id !== graphic.id))
						}
						size="sm"
						variant="ghost"
					>
						Remove graphic
					</Button>
				</div>
			))}
		</RyuAppSection>
	);
}
