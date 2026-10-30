import { RyuAppActions } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { type PointerEvent, useRef, useState } from "react";
import type { SpeedRampPoint } from "../../shared/speed-ramp.ts";
import { NumberField } from "./NumberField.tsx";

const WIDTH = 240;
const HEIGHT = 80;
/** Smallest gap, as a share of the source, between neighbouring points. */
export const MIN_POINT_GAP = 0.01;

interface CurveLimits {
	maxPoints: number;
	maxSpeed: number;
	minPoints: number;
	minSpeed: number;
}

const round = (value: number, digits = 3) => Number(value.toFixed(digits));
const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));

/** Speed for a y-down SVG coordinate on the log10 axis (0.1× at the bottom, 10× at the top). */
export function speedForY(y: number, limits: CurveLimits, height = HEIGHT) {
	const log = (1 - clamp(y, 0, height) / height) * 2 - 1;
	return round(clamp(10 ** log, limits.minSpeed, limits.maxSpeed), 2);
}

const yForSpeed = (speed: number, height = HEIGHT) =>
	height - ((Math.log10(speed) + 1) / 2) * height;

/**
 * Move point `index` to `t`/`speed`, keeping the curve sorted with at least
 * `MIN_POINT_GAP` between neighbours. The first and last points stay pinned
 * to the clip's source in and out.
 */
export function movePoint(
	points: readonly SpeedRampPoint[],
	index: number,
	next: { speed?: number; t?: number },
	limits: CurveLimits
): SpeedRampPoint[] {
	const sorted = [...points].sort((a, b) => a.t - b.t);
	const current = sorted[index];
	if (!current) {
		return sorted;
	}
	const last = sorted.length - 1;
	let t = next.t ?? current.t;
	if (index === 0) {
		t = 0;
	} else if (index === last) {
		t = 1;
	} else {
		const low = (sorted[index - 1]?.t ?? 0) + MIN_POINT_GAP;
		const high = (sorted[index + 1]?.t ?? 1) - MIN_POINT_GAP;
		t = clamp(t, low, high);
	}
	const speed = clamp(
		next.speed ?? current.speed,
		limits.minSpeed,
		limits.maxSpeed
	);
	return sorted.map((point, position) =>
		position === index ? { speed: round(speed, 2), t: round(t) } : point
	);
}

/** Insert a point in the middle of the widest gap, on the curve's current speed. */
export function addPoint(
	points: readonly SpeedRampPoint[],
	limits: CurveLimits
): { index: number; points: SpeedRampPoint[] } {
	const sorted = [...points].sort((a, b) => a.t - b.t);
	if (sorted.length >= limits.maxPoints) {
		return { index: -1, points: sorted };
	}
	let widest = 0;
	let widestGap = -1;
	for (let index = 1; index < sorted.length; index++) {
		const gap = (sorted[index]?.t ?? 0) - (sorted[index - 1]?.t ?? 0);
		if (gap > widestGap) {
			widest = index - 1;
			widestGap = gap;
		}
	}
	const before = sorted[widest];
	const after = sorted[widest + 1];
	if (!(before && after) || after.t - before.t < 2 * MIN_POINT_GAP) {
		return { index: -1, points: sorted };
	}
	const point = {
		speed: round(Math.sqrt(before.speed * after.speed), 2),
		t: round((before.t + after.t) / 2),
	};
	const result = [...sorted];
	result.splice(widest + 1, 0, point);
	return { index: widest + 1, points: result };
}

/**
 * Editable custom speed curve: drag a point (horizontal is the position in
 * the source, vertical the speed on a log scale), or select it and type its
 * position and speed. The ends stay at the clip's source in and out.
 */
export function SpeedCurveEditor({
	disabled,
	limits,
	onChange,
	points,
}: {
	disabled?: boolean;
	limits: CurveLimits;
	onChange: (points: SpeedRampPoint[]) => void;
	points: readonly SpeedRampPoint[];
}) {
	const tl = useLiteralMessages();
	const sorted = [...points].sort((a, b) => a.t - b.t);
	const [selected, setSelected] = useState(0);
	const dragging = useRef<number | null>(null);
	const svg = useRef<SVGSVGElement>(null);
	const active = Math.min(selected, sorted.length - 1);
	const point = sorted[active];

	const fromPointer = (event: PointerEvent<SVGElement>) => {
		const box = svg.current?.getBoundingClientRect();
		if (!box || box.width <= 0 || box.height <= 0) {
			return null;
		}
		return {
			speed: speedForY(
				((event.clientY - box.top) / box.height) * HEIGHT,
				limits
			),
			t: clamp((event.clientX - box.left) / box.width, 0, 1),
		};
	};
	const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
		const index = dragging.current;
		const next = index === null ? null : fromPointer(event);
		if (index === null || !next) {
			return;
		}
		onChange(movePoint(sorted, index, next, limits));
	};
	const endDrag = (event: PointerEvent<SVGSVGElement>) => {
		if (dragging.current !== null) {
			dragging.current = null;
			event.currentTarget.releasePointerCapture?.(event.pointerId);
		}
	};
	const line = sorted
		.map(
			(item) =>
				`${(item.t * WIDTH).toFixed(1)},${yForSpeed(item.speed).toFixed(1)}`
		)
		.join(" ");
	return (
		<div className="flex flex-col gap-2">
			<svg
				aria-label="Custom speed curve from 0.1× to 10×. Drag a point, or select it and edit its position and speed below."
				className="studio-speed-curve studio-speed-curve-editor touch-none"
				onPointerCancel={endDrag}
				onPointerMove={onPointerMove}
				onPointerUp={endDrag}
				ref={svg}
				role="img"
				viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
			>
				<line
					className="studio-speed-curve-baseline"
					x1="0"
					x2={WIDTH}
					y1={HEIGHT / 2}
					y2={HEIGHT / 2}
				/>
				<polyline className="studio-speed-curve-line" points={line} />
				{sorted.map((item, index) => (
					<circle
						className={
							index === active
								? "cursor-grab fill-primary stroke-background"
								: "cursor-grab fill-background stroke-primary"
						}
						cx={item.t * WIDTH}
						cy={yForSpeed(item.speed)}
						data-point={index}
						// biome-ignore lint/suspicious/noArrayIndexKey: points are positional; the index is their identity while dragging.
						key={index}
						onPointerDown={(event) => {
							if (disabled) {
								return;
							}
							setSelected(index);
							dragging.current = index;
							svg.current?.setPointerCapture?.(event.pointerId);
						}}
						r={5}
						strokeWidth={1.5}
					/>
				))}
			</svg>
			{point && (
				<div className="grid grid-cols-2 gap-2">
					<NumberField
						label={tl("Point {number} position (%)", {
							number: String(active + 1),
						})}
						max={100}
						min={0}
						onChange={(value) =>
							onChange(movePoint(sorted, active, { t: value / 100 }, limits))
						}
						step={1}
						value={round(point.t * 100, 1)}
					/>
					<NumberField
						label={tl("Point {number} speed (×)", {
							number: String(active + 1),
						})}
						max={limits.maxSpeed}
						min={limits.minSpeed}
						onChange={(value) =>
							onChange(movePoint(sorted, active, { speed: value }, limits))
						}
						step={0.05}
						value={point.speed}
					/>
				</div>
			)}
			<RyuAppActions>
				<Button
					disabled={disabled || sorted.length >= limits.maxPoints}
					onClick={() => {
						const added = addPoint(sorted, limits);
						if (added.index >= 0) {
							onChange(added.points);
							setSelected(added.index);
						}
					}}
					size="sm"
					variant="outline"
				>
					Add point
				</Button>
				<Button
					disabled={
						disabled ||
						sorted.length <= limits.minPoints ||
						active === 0 ||
						active === sorted.length - 1
					}
					onClick={() => {
						onChange(sorted.filter((_, index) => index !== active));
						setSelected(Math.max(0, active - 1));
					}}
					size="sm"
					variant="ghost"
				>
					Remove point
				</Button>
				<Button
					disabled={disabled || sorted.length < 2}
					onClick={() =>
						setSelected((current) => (current + 1) % sorted.length)
					}
					size="sm"
					variant="ghost"
				>
					Next point
				</Button>
			</RyuAppActions>
		</div>
	);
}
