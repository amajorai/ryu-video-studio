import { useLiteralMessages } from "@ryu/i18n/react";
import { useState } from "react";
import {
	addMask,
	MAX_CLIP_MASKS,
	type Mask,
	maskShapes,
	removeMask,
	updateMask,
} from "../../shared/masks.ts";
import {
	graphicChannelSample,
	graphicKeyframeChannels,
	isGraphicKeyframeChannel,
} from "../../shared/overlay-keyframes.ts";
import type { Graphic } from "../../shared/project.ts";
import {
	cornerRadiusOf,
	graphicRotationOf,
	innerRadiusOf,
	sidesOf,
	starPointsOf,
} from "../../shared/shape-geometry.ts";
import {
	graphicBounds,
	keyframeLabels,
	withGraphicFields,
} from "./GraphicsPanel-graphic-fields.ts";
import { MaskListEditor } from "./inspector/sections/MaskSection.tsx";
import { OverlayKeyframesEditor } from "./keyframes/OverlayKeyframesEditor.tsx";
import { NumberField } from "./NumberField.tsx";

export function GraphicKeyframes({
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
	const tl = useLiteralMessages();
	return (
		<OverlayKeyframesEditor
			boundsOf={graphicBounds}
			channels={graphicKeyframeChannels}
			insideHint="Records the value at the playhead. Keyframe times are relative to the shape's start."
			isChannel={isGraphicKeyframeChannel}
			item={graphic}
			labels={keyframeLabels}
			name={tl("Vector shape {number}", { number: index + 1 })}
			onChange={onChange}
			outsideHint="Move the playhead inside this shape to add keyframes."
			sampleAt={(property, elapsed) =>
				graphicChannelSample(graphic, property, elapsed)
			}
			time={time}
		/>
	);
}

export function ShapeGeometryFields({
	graphic,
	index,
	onChange,
}: {
	graphic: Graphic;
	index: number;
	onChange: (graphic: Graphic) => void;
}) {
	const tl = useLiteralMessages();
	const name = tl("Vector shape {number}", { number: index + 1 });
	return (
		<>
			{graphic.shape === "polygon" ? (
				<NumberField
					ariaLabel={tl("{name} sides", { name })}
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
						ariaLabel={tl("{name} points", { name })}
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
						ariaLabel={tl("{name} inner radius", { name })}
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
					ariaLabel={tl("{name} corner radius", { name })}
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
				ariaLabel={tl("{name} rotation", { name })}
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
export function GraphicMasks({
	graphic,
	onChange,
}: {
	graphic: Graphic;
	onChange: (next: Graphic) => void;
}) {
	const tl = useLiteralMessages();
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
				<small>
					{tl("A graphic can have up to {max} masks.", { max: MAX_CLIP_MASKS })}
				</small>
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
