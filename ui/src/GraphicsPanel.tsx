import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { ColorPickerPopover } from "@ryu/ui/components/color-picker.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useState } from "react";
import {
	blendModeLabels,
	blendModes,
	isBlendMode,
} from "../../shared/blend.ts";
import {
	addMask,
	MAX_CLIP_MASKS,
	type Mask,
	maskShapes,
	removeMask,
	updateMask,
} from "../../shared/masks.ts";
import {
	addOverlayKeyframe,
	type GraphicKeyframeChannel,
	graphicChannelSample,
	graphicKeyframeChannels,
	isGraphicKeyframeChannel,
	overlayKeyframeBounds,
	removeOverlayKeyframe,
	setOverlayKeyframeInterpolation,
} from "../../shared/overlay-keyframes.ts";
import type { Graphic } from "../../shared/project.ts";
import { graphicSchema } from "../../shared/project.ts";
import type { KeyframeInterpolation } from "../../shared/schema/keyframe.ts";
import {
	cornerRadiusOf,
	graphicRotationOf,
	innerRadiusOf,
	type StrokeAlign,
	sidesOf,
	starPointsOf,
	strokeAlignOf,
} from "../../shared/shape-geometry.ts";
import { type StyleProfile, styleProfileConfig } from "../../shared/styles.ts";
import { MaskListEditor } from "./inspector/sections/MaskSection.tsx";
import { OverlayKeyframesEditor } from "./keyframes/OverlayKeyframesEditor.tsx";
import { NumberField } from "./NumberField.tsx";

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

/** Shape-specific names for the shared keyframe channel labels. */
const keyframeLabels: Partial<Record<GraphicKeyframeChannel, string>> = {
	scale: "Scale (about the center)",
	x: "Left",
	y: "Top",
};

const graphicBounds = (property: GraphicKeyframeChannel) =>
	overlayKeyframeBounds("graphic", property);

type OptionalGraphicField =
	| "blendMode"
	| "cornerRadius"
	| "innerRadius"
	| "keyframes"
	| "points"
	| "rotation"
	| "sides"
	| "strokeAlign"
	| "masks";

/**
 * Returns the graphic with optional fields set, or removed when the value is
 * `undefined`, so cleared fields leave no key behind in the saved project.
 */
export function withGraphicFields(
	graphic: Graphic,
	fields: { [Key in OptionalGraphicField]?: Graphic[Key] | undefined }
): Graphic {
	const next: Graphic = { ...graphic };
	for (const [key, value] of Object.entries(fields) as [
		OptionalGraphicField,
		unknown,
	][]) {
		if (value === undefined) {
			delete next[key];
		} else {
			Object.assign(next, { [key]: value });
		}
	}
	return next;
}

/**
 * Adds (or replaces) a keyframe of `property` at the playhead with the
 * graphic's current value there. Returns the graphic unchanged when the
 * playhead is outside the graphic or the keyframe limit is reached.
 */
export function addGraphicKeyframe(
	graphic: Graphic,
	property: GraphicKeyframeChannel,
	time: number,
	id: string
): Graphic {
	return addOverlayKeyframe(
		graphic,
		property,
		graphicChannelSample(graphic, property, time - graphic.start),
		time,
		id,
		graphicBounds(property)
	);
}

/**
 * Sets the easing from one keyframe to the next (see
 * `setOverlayKeyframeInterpolation`).
 */
export function setGraphicKeyframeInterpolation(
	graphic: Graphic,
	id: string,
	interpolation: KeyframeInterpolation
): Graphic {
	return setOverlayKeyframeInterpolation(graphic, id, interpolation);
}

/** Removes one keyframe; the field disappears with the last one. */
export function removeGraphicKeyframe(graphic: Graphic, id: string): Graphic {
	return removeOverlayKeyframe(graphic, id);
}

function GraphicKeyframes({
	graphic,
	index,
	onChange,
	time,
}: {
	graphic: Graphic;
	index: number;
	onChange: (graphic: Graphic) => void;
	time: number;
}) {
	return (
		<OverlayKeyframesEditor
			boundsOf={graphicBounds}
			channels={graphicKeyframeChannels}
			insideHint="Records the value at the playhead. Keyframe times are relative to the shape's start."
			isChannel={isGraphicKeyframeChannel}
			item={graphic}
			labels={keyframeLabels}
			name={`Vector shape ${index + 1}`}
			onChange={onChange}
			outsideHint="Move the playhead inside this shape to add keyframes."
			sampleAt={(property, elapsed) =>
				graphicChannelSample(graphic, property, elapsed)
			}
			time={time}
		/>
	);
}

function ShapeGeometryFields({
	graphic,
	index,
	onChange,
}: {
	graphic: Graphic;
	index: number;
	onChange: (graphic: Graphic) => void;
}) {
	const name = `Vector shape ${index + 1}`;
	return (
		<>
			{graphic.shape === "polygon" ? (
				<NumberField
					ariaLabel={`${name} sides`}
					label="Sides"
					max={12}
					min={3}
					onChange={(value) =>
						onChange(withGraphicFields(graphic, { sides: Math.round(value) }))
					}
					step={1}
					value={sidesOf(graphic)}
				/>
			) : null}
			{graphic.shape === "star" ? (
				<>
					<NumberField
						ariaLabel={`${name} points`}
						label="Points"
						max={12}
						min={3}
						onChange={(value) =>
							onChange(
								withGraphicFields(graphic, { points: Math.round(value) })
							)
						}
						step={1}
						value={starPointsOf(graphic)}
					/>
					<NumberField
						ariaLabel={`${name} inner radius`}
						label="Inner radius"
						max={0.95}
						min={0.1}
						onChange={(value) =>
							onChange(withGraphicFields(graphic, { innerRadius: value }))
						}
						step={0.05}
						value={innerRadiusOf(graphic)}
					/>
				</>
			) : null}
			{graphic.shape === "rectangle" ? (
				<NumberField
					ariaLabel={`${name} corner radius`}
					label="Corner radius"
					max={0.5}
					min={0}
					onChange={(value) =>
						onChange(
							withGraphicFields(graphic, {
								cornerRadius: value === 0 ? undefined : value,
							})
						)
					}
					step={0.01}
					value={cornerRadiusOf(graphic)}
				/>
			) : null}
			<NumberField
				ariaLabel={`${name} rotation`}
				label="Rotation (degrees)"
				max={180}
				min={-180}
				onChange={(value) =>
					onChange(
						withGraphicFields(graphic, {
							rotation: value === 0 ? undefined : value,
						})
					)
				}
				step={1}
				value={graphicRotationOf(graphic)}
			/>
		</>
	);
}

/** Mask shapes a graphic accepts: every shape but text. */
const graphicMaskShapes = maskShapes.filter((shape) => shape !== "text");

/**
 * Up to four masks on one graphic, in its own box (before its rotation),
 * edited with the clip masks' editor. Graphic masks do not animate.
 */
function GraphicMasks({
	graphic,
	onChange,
}: {
	graphic: Graphic;
	onChange: (next: Graphic) => void;
}) {
	const masks = graphic.masks ?? [];
	const [selected, setSelected] = useState<string | undefined>();
	const activeId = masks.some((mask) => mask.id === selected)
		? selected
		: masks[0]?.id;
	const save = (next: Mask[] | undefined) =>
		onChange(withGraphicFields(graphic, { masks: next }));
	return (
		<MaskListEditor
			activeId={activeId}
			label="Masks"
			limitNotice={
				<small>A graphic can have up to {MAX_CLIP_MASKS} masks.</small>
			}
			listLabel="Graphic masks"
			masks={masks}
			onAdd={(shape) => {
				const id = crypto.randomUUID();
				save(addMask(masks, shape, id));
				setSelected(id);
			}}
			onPatch={(id, patch) => {
				try {
					save(updateMask(masks, id, patch));
				} catch {
					// Out-of-range values are refused; the field resets to the stored value.
				}
			}}
			onRemove={(id) => save(removeMask(masks, id))}
			onSelect={setSelected}
			shapes={graphicMaskShapes}
		/>
	);
}

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
					<strong>Vector shape {index + 1}</strong>
					<RyuAppField label="Shape">
						<NativeSelect
							aria-label={`Vector shape ${index + 1} shape`}
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
							ariaLabel={`Graphic ${index + 1} ${label}`}
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
							triggerAriaLabel={`Graphic ${index + 1} fill color`}
							triggerClassName="w-full justify-start"
							value={graphic.fill}
						/>
					</RyuAppField>
					<RyuAppField label="Stroke color">
						<ColorPickerPopover
							onValueChange={(value) => change(graphic.id, { stroke: value })}
							triggerAriaLabel={`Vector shape ${index + 1} stroke color`}
							triggerClassName="w-full justify-start"
							value={graphic.stroke}
						/>
					</RyuAppField>
					<NumberField
						ariaLabel={`Vector shape ${index + 1} stroke width`}
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
								aria-label={`Vector shape ${index + 1} stroke alignment`}
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
							aria-label={`Vector shape ${index + 1} blend mode`}
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
							aria-label={`Graphic ${index + 1} entry animation`}
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
