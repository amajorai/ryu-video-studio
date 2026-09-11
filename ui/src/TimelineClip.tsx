import { Button } from "@ryu/blocks/companion/controls";
import { useRef, useState } from "react";
import {
	type Marker,
	type Segment,
	segmentDuration,
	snapTimelineTime,
	trimSegment,
} from "../../shared/project.ts";

export function TimelineClip({
	assetDuration,
	fps,
	locked,
	markers,
	name,
	onMove,
	onSelect,
	onTrim,
	segment,
	selected,
	zoom,
}: {
	assetDuration: number;
	fps: number;
	locked: boolean;
	markers: readonly Marker[];
	name: string;
	onMove: (start: number, track: number) => void;
	onSelect: (additive: boolean) => void;
	onTrim: (segment: Segment) => void;
	segment: Segment;
	selected: boolean;
	zoom: number;
}) {
	const origin = useRef<{
		edge: "move" | "start" | "end";
		x: number;
		y: number;
	} | null>(null);
	const suppressClick = useRef(false);
	const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
	const finish = (x: number, y: number) => {
		const point = origin.current;
		origin.current = null;
		setDrag(null);
		if (!point || Math.abs(x - point.x) + Math.abs(y - point.y) < 4) {
			return;
		}
		suppressClick.current = true;
		const delta = Math.round(((x - point.x) / zoom) * fps) / fps;
		if (point.edge !== "move") {
			const currentEdge =
				point.edge === "start"
					? segment.start
					: segment.start + segmentDuration(segment);
			const snappedEdge = snapTimelineTime(currentEdge + delta, fps, markers);
			onTrim(
				trimSegment(
					segment,
					assetDuration,
					point.edge,
					snappedEdge - currentEdge
				)
			);
			return;
		}
		const start = Math.max(
			0,
			Math.min(
				7200 - segmentDuration(segment),
				snapTimelineTime(segment.start + (x - point.x) / zoom, fps, markers)
			)
		);
		const track = Math.max(
			0,
			Math.min(15, segment.track + Math.round((y - point.y) / 54))
		);
		onMove(start, track);
	};
	return (
		<Button
			aria-label={`${locked ? "Locked " : "Select "}${name} at ${segment.start.toFixed(2)} seconds`}
			className="studio-timeline-clip"
			data-locked={locked ? "true" : undefined}
			disabled={locked}
			onClick={(event) => {
				if (suppressClick.current) {
					suppressClick.current = false;
					return;
				}
				onSelect(event.shiftKey);
			}}
			onKeyDown={(event) => {
				if (locked || !event.altKey) {
					return;
				}
				if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
					event.preventDefault();
					event.stopPropagation();
					onMove(
						Math.max(
							0,
							Math.min(
								7200 - segmentDuration(segment),
								segment.start + (event.key === "ArrowLeft" ? -1 : 1) / fps
							)
						),
						segment.track
					);
				}
			}}
			onPointerCancel={() => {
				origin.current = null;
				setDrag(null);
			}}
			onPointerDown={(event) => {
				if (locked || event.button !== 0) {
					return;
				}
				const bounds = event.currentTarget.getBoundingClientRect();
				const edge =
					event.clientX - bounds.left < 10
						? "start"
						: bounds.right - event.clientX < 10
							? "end"
							: "move";
				origin.current = { edge, x: event.clientX, y: event.clientY };
				event.currentTarget.setPointerCapture(event.pointerId);
			}}
			onPointerMove={(event) => {
				const point = origin.current;
				if (point) {
					setDrag({ x: event.clientX - point.x, y: event.clientY - point.y });
				}
			}}
			onPointerUp={(event) => {
				finish(event.clientX, event.clientY);
				event.currentTarget.releasePointerCapture(event.pointerId);
			}}
			style={{
				left: segment.start * zoom,
				width: Math.max(12, segmentDuration(segment) * zoom),
				transform: drag ? `translate(${drag.x}px,${drag.y}px)` : undefined,
				zIndex: drag ? 5 : undefined,
				touchAction: "none",
			}}
			title={
				locked
					? "This track is locked. Unlock it from the track header to edit clips."
					: "Drag the body to move. Drag either edge to trim. Alt + arrow keys moves one frame."
			}
			variant={selected ? "default" : "secondary"}
		>
			<span
				aria-label={`Trim start of ${name}`}
				className="studio-timeline-handle studio-timeline-handle-start"
			/>
			{name}
			<span
				aria-label={`Trim end of ${name}`}
				className="studio-timeline-handle studio-timeline-handle-end"
			/>
		</Button>
	);
}
