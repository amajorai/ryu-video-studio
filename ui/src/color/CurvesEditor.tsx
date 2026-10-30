import { useLiteralMessages } from "@ryu/i18n/react";
import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { curveFunction } from "../../../shared/color-advanced.ts";
import type { CurvePoint } from "../../../shared/schema/color.ts";
import {
	identityCurve,
	insertCurvePoint,
	moveCurvePoint,
	removeCurvePoint,
} from "./color-controls.ts";

export type CurveMode = "tone" | "hue";

interface CurvesEditorProps {
	/** Accessible name of the curve ("Master curve", "Hue vs saturation"). */
	label: string;
	/**
	 * `tone`: output against input (2-16 points, the diagonal is neutral).
	 * `hue`: saturation against hue (0-16 points, the 0.5 line is neutral).
	 */
	mode: CurveMode;
	/** `undefined` resets the curve to neutral. */
	onChange: (points: CurvePoint[] | undefined) => void;
	points: CurvePoint[] | undefined;
	/** Stroke color of the curve line. */
	stroke?: string;
}

const SIZE = 100;
/** Margin around the plot in viewBox units, so edge points stay visible. */
const PAD = 2;
const SAMPLES = 64;
const STEP = 0.01;

/**
 * Curve coordinates under a client point, through the SVG's
 * `-PAD -PAD SIZE+2·PAD SIZE+2·PAD` viewBox (stretched with
 * `preserveAspectRatio="none"`), so a point stays under the pointer.
 */
export function clientToCurve(
	box: { height: number; left: number; top: number; width: number },
	clientX: number,
	clientY: number
): CurvePoint {
	const span = SIZE + PAD * 2;
	return {
		x: (((clientX - box.left) / box.width) * span - PAD) / SIZE,
		y: 1 - (((clientY - box.top) / box.height) * span - PAD) / SIZE,
	};
}

/** The SVG path of a curve (or its neutral line) in a 100×100 box, y up. */
export function curvePath(
	points: readonly CurvePoint[] | undefined,
	mode: CurveMode
): string {
	const evaluate =
		points && points.length > 0
			? curveFunction(points)
			: (x: number) => (mode === "hue" ? 0.5 : x);
	const commands: string[] = [];
	for (let index = 0; index <= SAMPLES; index++) {
		const x = index / SAMPLES;
		const y = evaluate(x);
		commands.push(
			`${index === 0 ? "M" : "L"}${(x * SIZE).toFixed(2)} ${((1 - y) * SIZE).toFixed(2)}`
		);
	}
	return commands.join(" ");
}

/** Interactive curve: drag points, click the plot to add one, Delete to remove. */
export function CurvesEditor({
	label,
	mode,
	onChange,
	points,
	stroke = "currentColor",
}: CurvesEditorProps) {
	const shown = points ?? (mode === "tone" ? identityCurve() : []);
	const minimum = mode === "tone" ? 2 : 0;
	const svg = useRef<SVGSVGElement>(null);
	const tl = useLiteralMessages();
	const [dragging, setDragging] = useState<number | null>(null);
	const [focused, setFocused] = useState<number | null>(null);

	const toCurve = (event: PointerEvent<SVGElement>): CurvePoint | null => {
		const box = svg.current?.getBoundingClientRect();
		if (!(box?.width && box.height)) {
			return null;
		}
		return clientToCurve(box, event.clientX, event.clientY);
	};
	const commit = (next: CurvePoint[]) =>
		onChange(next.length === 0 ? undefined : next);

	const startAdd = (event: PointerEvent<SVGSVGElement>) => {
		if (event.target !== event.currentTarget && dragging === null) {
			return;
		}
		const target = toCurve(event);
		const inserted = target && insertCurvePoint(shown, target);
		if (!inserted) {
			return;
		}
		commit(inserted.points);
		setDragging(inserted.index);
		setFocused(inserted.index);
		event.currentTarget.setPointerCapture?.(event.pointerId);
	};
	const move = (event: PointerEvent<SVGSVGElement>) => {
		if (dragging === null) {
			return;
		}
		const target = toCurve(event);
		if (target) {
			commit(moveCurvePoint(shown, dragging, target));
		}
	};
	const keyDown = (event: KeyboardEvent<SVGCircleElement>, index: number) => {
		const point = shown[index];
		if (!point) {
			return;
		}
		const step = event.shiftKey ? STEP * 10 : STEP;
		const moves: Record<string, CurvePoint> = {
			ArrowDown: { x: point.x, y: point.y - step },
			ArrowLeft: { x: point.x - step, y: point.y },
			ArrowRight: { x: point.x + step, y: point.y },
			ArrowUp: { x: point.x, y: point.y + step },
		};
		const target = moves[event.key];
		if (target) {
			event.preventDefault();
			commit(moveCurvePoint(shown, index, target));
		} else if (event.key === "Delete" || event.key === "Backspace") {
			event.preventDefault();
			commit(removeCurvePoint(shown, index, minimum));
			setFocused(null);
		}
	};

	return (
		<svg
			aria-label={tl(
				"{label}. Click to add a point; drag or use the arrow keys to move one; Delete removes it.",
				{ label }
			)}
			className="h-32 w-full touch-none select-none rounded-md border bg-muted/40"
			data-testid={`curve-${label}`}
			onPointerCancel={() => setDragging(null)}
			onPointerDown={startAdd}
			onPointerMove={move}
			onPointerUp={() => setDragging(null)}
			preserveAspectRatio="none"
			ref={svg}
			role="group"
			viewBox={`${-PAD} ${-PAD} ${SIZE + PAD * 2} ${SIZE + PAD * 2}`}
		>
			<title>{label}</title>
			{[25, 50, 75].map((line) => (
				<g
					className="text-border"
					key={line}
					pointerEvents="none"
					stroke="currentColor"
				>
					<line strokeWidth={0.3} x1={line} x2={line} y1={0} y2={SIZE} />
					<line strokeWidth={0.3} x1={0} x2={SIZE} y1={line} y2={line} />
				</g>
			))}
			<path
				d={curvePath(shown, mode)}
				fill="none"
				pointerEvents="none"
				stroke={stroke}
				strokeWidth={1.2}
				vectorEffect="non-scaling-stroke"
			/>
			{shown.map((point, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: points never reorder (moves clamp between neighbours), so the index is each point's identity; keying by x would remount the focused point on every horizontal arrow press.
				<circle
					aria-label={tl(
						"{label} point {pointNumber}: input {inputValue}, output {outputValue}",
						{
							inputValue: point.x.toFixed(2),
							label,
							outputValue: point.y.toFixed(2),
							pointNumber: String(index + 1),
						}
					)}
					className="cursor-grab outline-none"
					cx={point.x * SIZE}
					cy={(1 - point.y) * SIZE}
					fill={focused === index ? stroke : "var(--background, #fff)"}
					key={index}
					onBlur={() => setFocused(null)}
					onFocus={() => setFocused(index)}
					onKeyDown={(event) => keyDown(event, index)}
					onPointerDown={(event) => {
						event.stopPropagation();
						setDragging(index);
						setFocused(index);
						svg.current?.setPointerCapture?.(event.pointerId);
					}}
					r={3}
					role="button"
					stroke={stroke}
					strokeWidth={1}
					tabIndex={0}
				/>
			))}
		</svg>
	);
}
