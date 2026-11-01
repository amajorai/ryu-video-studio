import { formatMessage } from "@ryu/i18n/core";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import {
	type KeyboardEvent,
	type PointerEvent,
	useContext,
	useRef,
	useState,
} from "react";
import {
	dragMask,
	type FramePoint,
	type Mask,
	type MaskHandle,
	maskAt,
	maskBoxToFrame,
	maskFeatherSigma,
	maskFrameGeometry,
	maskOutline,
	maskShapeLabels,
	updateMask,
} from "../../../../shared/masks.ts";
import type { Segment } from "../../../../shared/project.ts";
import { EditorContext } from "../../editor/context.tsx";
import { changeSelectedSegment } from "../../inspector/section-props.ts";
import {
	setActiveMask,
	useActiveMaskId,
} from "../../inspector/sections/mask-selection.ts";
import { maskFrameBox } from "../stages/mask.ts";
import { transformCss } from "../stages/transform.ts";
import { entryTransitionState } from "../stages/transitions.ts";
import { segmentActiveAt } from "../stages/visibility.ts";
import type { PreviewOverlayProps } from "./overlay-props.ts";

/** Client-pixel positions of three corners of the transformed crop window. */
export interface ClientFrame {
	origin: FramePoint;
	xAxis: FramePoint;
	yAxis: FramePoint;
}

/**
 * Invert the affine map from crop-window fractions to client pixels given
 * by three of its corners, so pointers work under any clip transform and
 * preview zoom. Returns `undefined` for a degenerate (zero-size) window.
 */
export function clientToFrame(
	frame: ClientFrame,
	client: FramePoint
): FramePoint | undefined {
	const ax = frame.xAxis.x - frame.origin.x;
	const ay = frame.xAxis.y - frame.origin.y;
	const bx = frame.yAxis.x - frame.origin.x;
	const by = frame.yAxis.y - frame.origin.y;
	const determinant = ax * by - ay * bx;
	if (Math.abs(determinant) < 1e-9) {
		return undefined;
	}
	const px = client.x - frame.origin.x;
	const py = client.y - frame.origin.y;
	return {
		x: (px * by - py * bx) / determinant,
		y: (ax * py - ay * px) / determinant,
	};
}

/** Mask-frame fractions ↔ overlay fractions for a flipped clip (an involution). */
export function mirrorPoint(segment: Segment, point: FramePoint): FramePoint {
	return {
		x: segment.flipH ? 1 - point.x : point.x,
		y: segment.flipV ? 1 - point.y : point.y,
	};
}

const ELLIPSE_STEPS = 32;

/** Box-space outline used for the dashed guide of any shape. */
function guideOutline(mask: Mask): { x: number; y: number }[] {
	const outline = maskOutline(mask);
	if (outline) {
		return outline;
	}
	if (mask.shape === "ellipse") {
		return Array.from({ length: ELLIPSE_STEPS }, (_, index) => {
			const angle = (index * 2 * Math.PI) / ELLIPSE_STEPS;
			return { x: Math.cos(angle), y: Math.sin(angle) };
		});
	}
	return [
		{ x: -1, y: -1 },
		{ x: 1, y: -1 },
		{ x: 1, y: 1 },
		{ x: -1, y: 1 },
	];
}

interface HandleSpec {
	handle: MaskHandle;
	label: string;
	point: { x: number; y: number };
	shape: "round" | "square";
}

/** Where each handle sits, in the mask's box space. */
export function maskHandleSpecs(
	mask: Mask,
	aspect: number,
	tl: LiteralMessage = (source, values) => formatMessage(source, values, "en")
): HandleSpec[] {
	const geometry = maskFrameGeometry(mask, aspect * 1000, 1000);
	const featherOffset =
		(4 * maskFeatherSigma(mask.feather, aspect * 1000, 1000)) /
		geometry.halfWidth;
	const specs: HandleSpec[] = [
		{
			handle: "move",
			label: "Move mask",
			point: { x: 0, y: 0 },
			shape: "round",
		},
		{
			handle: "nw",
			label: "Resize mask",
			point: { x: -1, y: -1 },
			shape: "square",
		},
		{
			handle: "ne",
			label: "Resize mask",
			point: { x: 1, y: -1 },
			shape: "square",
		},
		{
			handle: "sw",
			label: "Resize mask",
			point: { x: -1, y: 1 },
			shape: "square",
		},
		{
			handle: "se",
			label: "Resize mask",
			point: { x: 1, y: 1 },
			shape: "square",
		},
		{
			handle: "rotate",
			label: "Rotate mask",
			point: { x: 0, y: -1 - 120 / geometry.halfHeight },
			shape: "round",
		},
		{
			handle: "feather",
			// Sits on the outer edge of the feather ramp: on the right edge
			// midpoint when sharp, moving out as the feather grows.
			label: "Feather mask",
			point: { x: 1 + featherOffset, y: 0 },
			shape: "round",
		},
	];
	for (const [index, point] of (mask.path ?? []).entries()) {
		if (mask.shape === "freeform") {
			specs.push({
				handle: `point:${index}`,
				label: tl("Move path point {pointNumber}", {
					pointNumber: String(index + 1),
				}),
				point,
				shape: "square",
			});
		}
	}
	return specs;
}

const NUDGE = 0.01;
const nudges: Record<string, FramePoint> = {
	ArrowDown: { x: 0, y: NUDGE },
	ArrowLeft: { x: -NUDGE, y: 0 },
	ArrowRight: { x: NUDGE, y: 0 },
	ArrowUp: { x: 0, y: -NUDGE },
};

interface Drag {
	from: FramePoint;
	handle: MaskHandle;
	start: Mask;
}

/**
 * On-canvas mask editing (W2-V3): a dashed guide of the active mask of the
 * selected clip, a center handle to move it (arrow keys nudge), corner
 * handles to resize, a rotation handle above, a feather handle to the right,
 * and one handle per freeform point. The overlay follows the clip's own
 * transform, so handles track rotated, scaled and flipped clips. Changes
 * commit on release as one undoable edit.
 */
export function MaskHandles({ playing, project, time }: PreviewOverlayProps) {
	const runtime = useContext(EditorContext);
	const tl = useLiteralMessages();
	const segment = runtime?.selectedSegment;
	const masks = segment?.masks ?? [];
	const activeId = useActiveMaskId(
		segment?.id,
		masks.map((mask) => mask.id)
	);
	const [drag, setDrag] = useState<Drag | null>(null);
	const [draft, setDraft] = useState<Mask | null>(null);
	const corners = {
		origin: useRef<HTMLSpanElement>(null),
		xAxis: useRef<HTMLSpanElement>(null),
		yAxis: useRef<HTMLSpanElement>(null),
	};
	const stored = masks.find((mask) => mask.id === activeId);
	if (
		!(runtime && segment && stored) ||
		playing ||
		!segmentActiveAt(segment, time)
	) {
		return null;
	}
	const elapsed = time - segment.start;
	const shown = draft ?? maskAt(segment, stored, elapsed);
	// Anchor to the same mask frame the preview mask and the render use: the
	// crop window of the clip's letterboxed picture, at its source aspect.
	const source = runtime.assets.find((asset) => asset.id === segment.assetId);
	const { box, size } = maskFrameBox(
		segment,
		project,
		source && { height: source.height, width: source.width }
	);
	const aspect = size.width / size.height;

	const pointerFrame = (event: PointerEvent): FramePoint | undefined => {
		const [origin, xAxis, yAxis] = [
			corners.origin.current,
			corners.xAxis.current,
			corners.yAxis.current,
		].map((element) => {
			const rect = element?.getBoundingClientRect();
			return { x: rect?.left ?? 0, y: rect?.top ?? 0 };
		});
		if (!(origin && xAxis && yAxis)) {
			return undefined;
		}
		const local = clientToFrame(
			{ origin, xAxis, yAxis },
			{ x: event.clientX, y: event.clientY }
		);
		return local && mirrorPoint(segment, local);
	};

	const commit = (next: Mask) => {
		const { id: _id, ...patch } = next;
		try {
			changeSelectedSegment(runtime, {
				masks: updateMask(masks, stored.id, patch),
			});
		} catch {
			runtime.setStatus("That mask change is out of range.");
		}
	};

	const onPointerDown = (handle: MaskHandle) => (event: PointerEvent) => {
		const from = pointerFrame(event);
		if (!from) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		event.currentTarget.setPointerCapture?.(event.pointerId);
		setActiveMask({ maskId: stored.id, segmentId: segment.id });
		setDrag({ from, handle, start: shown });
	};
	const onPointerMove = (event: PointerEvent) => {
		const to = drag && pointerFrame(event);
		if (drag && to) {
			setDraft(dragMask(drag.start, drag.handle, drag.from, to, aspect));
		}
	};
	const onPointerUp = () => {
		if (draft) {
			commit(draft);
		}
		setDrag(null);
		setDraft(null);
	};
	const onKeyDown = (event: KeyboardEvent) => {
		const nudge = nudges[event.key];
		if (!nudge) {
			return;
		}
		event.preventDefault();
		const step = event.shiftKey ? 10 : 1;
		commit(
			dragMask(
				shown,
				"move",
				{ x: 0, y: 0 },
				{ x: nudge.x * step, y: nudge.y * step },
				aspect
			)
		);
	};

	const toOverlay = (point: { x: number; y: number }) =>
		mirrorPoint(segment, maskBoxToFrame(shown, point, aspect));
	const guide = guideOutline(shown)
		.map((point) => {
			const at = toOverlay(point);
			return `${at.x * aspect * 1000},${at.y * 1000}`;
		})
		.join(" ");
	const entry = entryTransitionState(segment, elapsed);
	// The same sizes the media layer is transformed with, so the handles
	// follow a fill or cropped clip exactly (`PreviewMediaLayer`).
	const transform = transformCss(segment, elapsed, entry, {
		canvas: { height: project.height, width: project.width },
		media: { height: source?.height ?? 0, width: source?.width ?? 0 },
	});
	return (
		<div
			className="pointer-events-none absolute inset-0"
			data-testid="mask-handles"
			style={{ transform, zIndex: 60 }}
		>
			<div
				className="absolute"
				style={{
					height: `${box.height * 100}%`,
					left: `${box.left * 100}%`,
					top: `${box.top * 100}%`,
					width: `${box.width * 100}%`,
				}}
			>
				<span className="absolute top-0 left-0 size-0" ref={corners.origin} />
				<span className="absolute top-0 right-0 size-0" ref={corners.xAxis} />
				<span className="absolute bottom-0 left-0 size-0" ref={corners.yAxis} />
				<svg
					aria-hidden="true"
					className="absolute inset-0 size-full overflow-visible"
					preserveAspectRatio="none"
					viewBox={`0 0 ${aspect * 1000} 1000`}
				>
					<polygon
						fill="none"
						points={guide}
						stroke="white"
						strokeDasharray="6 4"
						strokeWidth={1.5}
						vectorEffect="non-scaling-stroke"
					/>
				</svg>
				{maskHandleSpecs(shown, aspect, tl).map((spec) => {
					const at = toOverlay(spec.point);
					return (
						<button
							aria-label={`${spec.label} (${maskShapeLabels[shown.shape]})`}
							className={`pointer-events-auto absolute size-3 -translate-x-1/2 -translate-y-1/2 touch-none border border-white bg-sky-500 shadow ${spec.shape === "round" ? "rounded-full" : "rounded-[2px]"} ${spec.handle === "move" ? "cursor-move" : "cursor-crosshair"}`}
							data-handle={spec.handle}
							key={spec.handle}
							onKeyDown={spec.handle === "move" ? onKeyDown : undefined}
							onPointerCancel={onPointerUp}
							onPointerDown={onPointerDown(spec.handle)}
							onPointerMove={onPointerMove}
							onPointerUp={onPointerUp}
							style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
							type="button"
						/>
					);
				})}
			</div>
		</div>
	);
}
