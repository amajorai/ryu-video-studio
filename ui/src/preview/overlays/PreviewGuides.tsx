import { customGuideOf } from "../../editor/actions/preview.ts";
import { usePreviewState } from "../use-preview-state.ts";
import {
	type GuideShape,
	type GuideTone,
	previewGuideShapes,
} from "./guide-geometry.ts";
import type { PreviewOverlayProps } from "./overlay-props.ts";

const TONE_STROKE: Record<GuideTone, string> = {
	aspect: "rgb(250 204 21 / 0.9)",
	grid: "rgb(255 255 255 / 0.7)",
	safe: "rgb(56 189 248 / 0.9)",
	zone: "rgb(244 114 182 / 0.85)",
};

const TONE_FILL: Record<GuideTone, string> = {
	aspect: "none",
	grid: "none",
	safe: "none",
	zone: "rgb(244 114 182 / 0.14)",
};

function GuideShapeElement({
	shape,
	labelSize,
}: {
	labelSize: number;
	shape: GuideShape;
}) {
	if (shape.kind === "line") {
		return (
			<line
				data-guide={shape.id}
				stroke={TONE_STROKE[shape.tone]}
				strokeWidth={1}
				vectorEffect="non-scaling-stroke"
				x1={shape.x1}
				x2={shape.x2}
				y1={shape.y1}
				y2={shape.y2}
			/>
		);
	}
	return (
		<g data-guide={shape.id}>
			<rect
				fill={TONE_FILL[shape.tone]}
				height={shape.height}
				stroke={TONE_STROKE[shape.tone]}
				strokeDasharray={shape.tone === "aspect" ? "6 4" : undefined}
				strokeWidth={1}
				vectorEffect="non-scaling-stroke"
				width={shape.width}
				x={shape.x}
				y={shape.y}
			/>
			{shape.label ? (
				<text
					fill={TONE_STROKE[shape.tone]}
					fontFamily="system-ui, sans-serif"
					fontSize={labelSize}
					x={shape.x + labelSize * 0.4}
					y={shape.y + labelSize * 1.1}
				>
					{shape.label}
				</text>
			) : null}
		</g>
	);
}

/**
 * Safe areas, aspect guides, thirds, a grid, a center cross, generic
 * vertical video layouts, and the viewer's custom guide, drawn in project pixels over the frame. Guides are a
 * viewer aid: they never reach a render, and they ignore the pointer.
 */
export function PreviewGuides({ project }: PreviewOverlayProps) {
	const guides = usePreviewState((state) => state.guides);
	const stored = usePreviewState((state) => state.customGuide);
	const custom = customGuideOf({ customGuide: stored });
	const shapes = previewGuideShapes(
		guides,
		project.width,
		project.height,
		custom
	);
	if (!shapes.length) {
		return null;
	}
	const labelSize = Math.max(10, Math.min(project.width, project.height) / 40);
	return (
		<svg
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 z-[60] h-full w-full"
			data-preview-guides=""
			preserveAspectRatio="none"
			viewBox={`0 0 ${project.width} ${project.height}`}
		>
			{shapes.map((shape) => (
				<GuideShapeElement key={shape.id} labelSize={labelSize} shape={shape} />
			))}
		</svg>
	);
}
