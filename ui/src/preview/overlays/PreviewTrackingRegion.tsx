import { useLiteralMessages } from "@ryu/i18n/react";
import {
	type KeyboardEvent,
	type PointerEvent,
	useContext,
	useRef,
	useSyncExternalStore,
} from "react";
import type { TrackRegion } from "../../../../shared/tracking.ts";
import { EditorContext } from "../../editor/context.tsx";
import type { EditorStore } from "../../editor/store.ts";
import type { PreviewOverlayProps } from "./overlay-props.ts";
import {
	type FramePoint,
	framePointAt,
	movedRegion,
	regionBetween,
} from "./tracking-region.ts";

const noSubscription = () => () => undefined;

type Gesture =
	| { kind: "draw"; origin: FramePoint }
	| { kind: "move"; origin: FramePoint; start: TrackRegion };

const percent = (value: number) => `${Math.round(value * 1e5) / 1e3}%`;

/** Arrow-key nudge in frame fractions (Shift moves ten times as far). */
const NUDGE = 0.01;

function useTrackingState(store: EditorStore | undefined) {
	const region = useSyncExternalStore(
		store?.subscribe ?? noSubscription,
		() => store?.getState().trackingRegion ?? null,
		() => null
	);
	const drawing = useSyncExternalStore(
		store?.subscribe ?? noSubscription,
		() => store?.getState().trackingRegionDrawing ?? false,
		() => false
	);
	return { drawing, region };
}

/**
 * The motion-tracking region on the preview while the Motion tracking panel
 * is open: a dashed box over the subject. Drag the box (or use the arrow
 * keys on it) to move it; with "Draw region on preview" on, a drag anywhere
 * on the frame draws a new region. Hidden during playback.
 */
export function PreviewTrackingRegion({ playing }: PreviewOverlayProps) {
	const tl = useLiteralMessages();
	const runtime = useContext(EditorContext);
	const store = runtime?.store;
	const { drawing, region } = useTrackingState(store);
	const layer = useRef<HTMLDivElement>(null);
	const gesture = useRef<Gesture | null>(null);
	if (!(store && region) || playing) {
		return null;
	}
	const pointAt = (event: PointerEvent<HTMLElement>) => {
		const rect = layer.current?.getBoundingClientRect();
		return rect
			? framePointAt(rect, event.clientX, event.clientY)
			: { x: 0, y: 0 };
	};
	const setRegion = (next: TrackRegion) =>
		store.setState({ trackingRegion: next });
	const begin = (event: PointerEvent<HTMLElement>, next: Gesture) => {
		event.preventDefault();
		event.stopPropagation();
		event.currentTarget.setPointerCapture?.(event.pointerId);
		gesture.current = next;
	};
	const move = (event: PointerEvent<HTMLElement>) => {
		const current = gesture.current;
		if (!current) {
			return;
		}
		const point = pointAt(event);
		setRegion(
			current.kind === "draw"
				? regionBetween(current.origin, point)
				: movedRegion(
						current.start,
						point.x - current.origin.x,
						point.y - current.origin.y
					)
		);
	};
	const end = (event: PointerEvent<HTMLElement>) => {
		if (!gesture.current) {
			return;
		}
		event.currentTarget.releasePointerCapture?.(event.pointerId);
		if (gesture.current.kind === "draw") {
			store.setState({ trackingRegionDrawing: false });
		}
		gesture.current = null;
	};
	const nudge = (event: KeyboardEvent<HTMLButtonElement>) => {
		const step = event.shiftKey ? NUDGE * 10 : NUDGE;
		const deltas: Record<string, [number, number]> = {
			ArrowDown: [0, step],
			ArrowLeft: [-step, 0],
			ArrowRight: [step, 0],
			ArrowUp: [0, -step],
		};
		const delta = deltas[event.key];
		if (!delta) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		setRegion(movedRegion(region, delta[0], delta[1]));
	};
	return (
		<div
			className={`absolute inset-0 z-[71] ${drawing ? "cursor-crosshair" : "pointer-events-none"}`}
			data-testid="preview-tracking-layer"
			onPointerCancel={end}
			onPointerDown={(event) => {
				if (drawing && event.button === 0) {
					const origin = pointAt(event);
					begin(event, { kind: "draw", origin });
					setRegion(regionBetween(origin, origin));
				}
			}}
			onPointerMove={move}
			onPointerUp={end}
			ref={layer}
		>
			<button
				aria-label={tl(
					"Tracking region: left {left}, top {top}, {width} by {height}. Arrow keys move it.",
					{
						height: percent(region.height),
						left: percent(region.x),
						top: percent(region.y),
						width: percent(region.width),
					}
				)}
				className="pointer-events-auto absolute cursor-move border-2 border-warning border-dashed bg-warning/10 outline-none focus-visible:ring-2 focus-visible:ring-ring"
				data-slot="tracking-region"
				data-testid="preview-tracking-region"
				onKeyDown={nudge}
				onPointerDown={(event) => {
					// While drawing, the press reaches the layer and starts a new box.
					if (!drawing && event.button === 0) {
						begin(event, {
							kind: "move",
							origin: pointAt(event),
							start: region,
						});
					}
				}}
				style={{
					height: percent(region.height),
					left: percent(region.x),
					top: percent(region.y),
					width: percent(region.width),
				}}
				type="button"
			/>
		</div>
	);
}
