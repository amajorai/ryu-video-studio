import { type ReactNode, useId } from "react";
import {
	type GraphicMaskPlacement,
	graphicMaskPlacement,
} from "../../../shared/graphic-masks.ts";
import type { Project } from "../../../shared/project.ts";
import {
	graphicFramePoints,
	graphicFrameRegions,
	graphicFrameState,
	graphicPaint,
	svgPathData,
	usesLegacyDrawbox,
} from "../../../shared/shape-geometry.ts";
import type { PreviewStyle } from "./preview-style.ts";
import { layerBlendStyle } from "./stages/blend.ts";

type Graphic = Project["graphics"][number];

const slideTransforms: Partial<
	Record<Graphic["animation"], (offset: number) => string>
> = {
	"slide-down": (offset) => `translateY(${-offset}%)`,
	"slide-left": (offset) => `translateX(${-offset}%)`,
	"slide-right": (offset) => `translateX(${offset}%)`,
	"slide-up": (offset) => `translateY(${offset}%)`,
};

/** Minimum drawn thickness of a line graphic, as a fraction of frame height. */
const minLineThickness = 0.006;

/**
 * CSS for one legacy graphic at `time` (which must lie inside the graphic).
 * Only graphics that `usesLegacyDrawbox` accepts are drawn this way.
 */
export function graphicStyle(graphic: Graphic, time: number): PreviewStyle {
	const elapsed = time - graphic.start;
	const progress = graphic.entryDuration
		? Math.min(1, Math.max(0, elapsed / graphic.entryDuration))
		: 1;
	const offset = (1 - progress) * 8;
	const transform = slideTransforms[graphic.animation]?.(offset);
	const line = graphic.shape === "line";
	const lineThickness = Math.max(graphic.strokeWidth, minLineThickness);
	return {
		"--studio-graphic-background": line ? graphic.stroke : graphic.fill,
		"--studio-graphic-height": `${(line ? lineThickness : graphic.height) * 100}%`,
		"--studio-graphic-left": `${graphic.x * 100}%`,
		"--studio-graphic-top": `${(line ? graphic.y + graphic.height / 2 - lineThickness / 2 : graphic.y) * 100}%`,
		"--studio-graphic-opacity": `${graphic.opacity}`,
		"--studio-graphic-border":
			!line && graphic.strokeWidth > 0
				? `${graphic.strokeWidth * 100}% solid ${graphic.stroke}`
				: "0 solid transparent",
		"--studio-graphic-radius": graphic.shape === "ellipse" ? "50%" : "0.4rem",
		"--studio-graphic-clip-path":
			graphic.shape === "triangle"
				? "polygon(50% 0%, 100% 100%, 0% 100%)"
				: "none",
		"--studio-graphic-transform": transform ?? "none",
		"--studio-graphic-width": `${graphic.width * 100}%`,
	};
}

/**
 * The full-frame box a vector graphic's SVG fills: `studio-graphic` with its
 * position variables spanning the frame, plus the graphic's blend mode.
 */
export function shapeLayerStyle(graphic: Graphic): PreviewStyle {
	return {
		"--studio-graphic-background": "transparent",
		"--studio-graphic-border": "0 solid transparent",
		"--studio-graphic-clip-path": "none",
		"--studio-graphic-height": "100%",
		"--studio-graphic-left": "0%",
		"--studio-graphic-opacity": "1",
		"--studio-graphic-radius": "0",
		"--studio-graphic-top": "0%",
		"--studio-graphic-transform": "none",
		"--studio-graphic-width": "100%",
		...layerBlendStyle(graphic),
	};
}

export interface ShapeDrawing {
	/** Clip the stroke to the outline (inside alignment). */
	clipStroke: boolean;
	fill: string;
	opacity: number;
	path: string;
	/**
	 * Two-region paint of a stroked rectangle: `outer` filled with the stroke
	 * color and `inner` (empty when all stroke) with the fill, like the
	 * render's raster. SVG stroke fields are then unused (`strokeWidth` 0).
	 */
	regions?: { inner: string; outer: string };
	stroke: string;
	/** Stroke paint order: `under` hides the inner half (outside alignment). */
	strokeOrder: "over" | "under";
	/** SVG stroke width in frame pixels (zero for none). */
	strokeWidth: number;
}

/**
 * SVG drawing of a vector graphic at `time`: the same outline the render
 * rasterizes (`graphicFramePoints`) and the same stroke band. SVG strokes
 * straddle the path, so inside and outside alignment double the width and
 * clip it to, or hide it under, the fill. Stroked rectangles draw their two
 * regions instead (their border is anisotropic, like the legacy border).
 */
export function shapeDrawing(
	graphic: Graphic,
	frame: { height: number; width: number },
	time: number
): ShapeDrawing {
	const paint = graphicPaint(graphic, frame);
	const opacity = graphicFrameState(graphic, time).opacity;
	const regions = graphicFrameRegions(graphic, frame, time);
	if (regions) {
		return {
			clipStroke: false,
			fill: paint.fill,
			opacity,
			path: svgPathData(regions.outer),
			regions: {
				inner: regions.inner.length ? svgPathData(regions.inner) : "",
				outer: svgPathData(regions.outer),
			},
			stroke: paint.stroke,
			strokeOrder: "over",
			strokeWidth: 0,
		};
	}
	const band = paint.band.outer - paint.band.inner;
	const inside = paint.band.outer === 0 && band > 0;
	const outside = paint.band.inner === 0 && band > 0;
	return {
		clipStroke: inside,
		fill: paint.fill,
		opacity,
		path: svgPathData(graphicFramePoints(graphic, frame, time)),
		stroke: paint.stroke,
		strokeOrder: outside ? "under" : "over",
		strokeWidth: inside || outside ? band * 2 : band,
	};
}

/**
 * SVG `<mask>` definitions for a graphic's masks: each mask image (alpha,
 * placed on the graphic's box) is one `<mask>`, nested so they multiply.
 */
function GraphicMaskDefs({
	frame,
	id,
	placement,
}: {
	frame: { height: number; width: number };
	id: string;
	placement: GraphicMaskPlacement;
}) {
	return (
		<>
			{placement.layers.map((layer) => (
				<mask
					height={frame.height}
					id={`${id}-${layer.id}`}
					key={layer.id}
					maskUnits="userSpaceOnUse"
					style={{ maskType: "alpha" }}
					width={frame.width}
					x={0}
					y={0}
				>
					<image
						height={layer.image.height}
						href={layer.image.href}
						preserveAspectRatio="none"
						transform={placement.transform}
						width={layer.image.width}
						x={layer.image.x}
						y={layer.image.y}
					/>
				</mask>
			))}
		</>
	);
}

/** `content` inside one group per mask, then the masks' strokes over it. */
function maskedContent(
	content: ReactNode,
	id: string,
	placement: GraphicMaskPlacement | undefined,
	opacity: number
): ReactNode {
	if (!placement) {
		return content;
	}
	let masked = content;
	for (const layer of placement.layers) {
		masked = <g mask={`url(#${id}-${layer.id})`}>{masked}</g>;
	}
	const strokes = placement.layers.flatMap((layer) =>
		layer.stroke ? [{ href: layer.stroke, id: layer.id }] : []
	);
	return (
		<>
			{masked}
			{strokes.length > 0 ? (
				<g data-graphic-mask-strokes="" opacity={opacity}>
					{strokes.map((stroke) => (
						<image
							height={placement.box.height}
							href={stroke.href}
							key={stroke.id}
							preserveAspectRatio="none"
							transform={placement.transform}
							width={placement.box.width}
						/>
					))}
				</g>
			) : null}
		</>
	);
}

function PreviewShapeGraphic({
	graphic,
	project,
	time,
}: {
	graphic: Graphic;
	project: Project;
	time: number;
}) {
	const clipId = useId();
	const maskId = useId();
	const drawing = shapeDrawing(graphic, project, time);
	const placement = graphicMaskPlacement(graphic, project, time);
	const strokePath =
		drawing.strokeWidth > 0 ? (
			<path
				clipPath={drawing.clipStroke ? `url(#${clipId})` : undefined}
				d={drawing.path}
				fill="none"
				stroke={drawing.stroke}
				strokeLinejoin="round"
				strokeWidth={drawing.strokeWidth}
			/>
		) : null;
	return (
		<svg
			aria-hidden="true"
			className="studio-graphic"
			data-graphic-id={graphic.id}
			preserveAspectRatio="none"
			style={shapeLayerStyle(graphic)}
			viewBox={`0 0 ${project.width} ${project.height}`}
		>
			{drawing.clipStroke || placement ? (
				<defs>
					{drawing.clipStroke ? (
						<clipPath id={clipId}>
							<path d={drawing.path} />
						</clipPath>
					) : null}
					{placement ? (
						<GraphicMaskDefs
							frame={project}
							id={maskId}
							placement={placement}
						/>
					) : null}
				</defs>
			) : null}
			{maskedContent(
				<g opacity={drawing.opacity}>
					{drawing.regions ? (
						<>
							<path d={drawing.regions.outer} fill={drawing.stroke} />
							{drawing.regions.inner ? (
								<path d={drawing.regions.inner} fill={drawing.fill} />
							) : null}
						</>
					) : (
						<>
							{drawing.strokeOrder === "under" ? strokePath : null}
							<path d={drawing.path} fill={drawing.fill} />
							{drawing.strokeOrder === "over" ? strokePath : null}
						</>
					)}
				</g>,
				maskId,
				placement,
				drawing.opacity
			)}
		</svg>
	);
}

/** Shape graphics visible at `time`, in project order. */
export function PreviewGraphics({
	project,
	time,
}: {
	project: Project;
	time: number;
}) {
	return project.graphics
		.filter((graphic) => time >= graphic.start && time < graphic.end)
		.map((graphic) =>
			usesLegacyDrawbox(graphic) ? (
				<div
					className="studio-graphic"
					key={graphic.id}
					style={graphicStyle(graphic, time)}
				/>
			) : (
				<PreviewShapeGraphic
					graphic={graphic}
					key={graphic.id}
					project={project}
					time={time}
				/>
			)
		);
}
