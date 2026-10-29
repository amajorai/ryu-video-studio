import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import type { CSSProperties } from "react";
import { useContext, useRef, useState } from "react";
import {
	type Asset,
	type Marker,
	type Segment,
	segmentDuration,
} from "../../../shared/project.ts";
import { mediaClipKind } from "../../../shared/timeline-colors.ts";
import {
	type DragEdge,
	formatSplitOffset,
	type SplitOffsetBadge,
	type TrimTool,
} from "../editing-ui.ts";
import { EditorContext } from "../editor/context.tsx";
import { ClipFadeHandles } from "./ClipFadeHandles.tsx";
import { ClipFilmstrip } from "./ClipFilmstrip.tsx";
import { ClipKeyframeLane } from "./ClipKeyframeLane.tsx";
import { ClipLabel } from "./ClipLabel.tsx";
import { ClipOfflineBadge } from "./ClipOfflineBadge.tsx";
import { ClipSilenceOverlay } from "./ClipSilenceOverlay.tsx";
import { ClipSpeakerTint } from "./ClipSpeakerTint.tsx";
import { ClipVolumeLine } from "./ClipVolumeLine.tsx";
import { ClipWaveform } from "./ClipWaveform.tsx";
import { handleToolClick } from "./clip-click.ts";
import {
	type ClipDragOrigin,
	clearToolDragFeedback,
	dragEdgeAt,
	nudgedStart,
	publishToolDragFeedback,
	resolveClipDrag,
} from "./clip-drag.ts";
import type { ClipSlotProps } from "./clip-slot-props.ts";
import type { TimeWindow } from "./virtualize.ts";

interface TimelineClipStyle extends CSSProperties {
	"--studio-clip-left": string;
	"--studio-clip-transform": string;
	"--studio-clip-width": string;
	"--studio-clip-z-index": string;
}

const toolTitles: Record<TrimTool, string> = {
	pointer:
		"Drag the body to move. Drag either edge to trim. Alt + arrow keys moves one frame.",
	razor: "Razor: not available yet. Choose another tool to edit clips.",
	ripple:
		"Ripple: drag an edge to trim and shift later clips. Drag the body to move.",
	roll: "Roll: drag an edge shared with the next or previous clip to move the edit point.",
	slide:
		"Slide: drag the body to move this clip between its neighbours. Drag an edge to trim.",
	slip: "Slip: drag the body to change which part of the source plays. Drag an edge to trim.",
};

export function TimelineClip({
	asset,
	assetDuration,
	badges = [],
	drawWindow = null,
	fps,
	locked,
	markers,
	name,
	onMove,
	onSelect,
	onToolEdit,
	onTrim,
	segment,
	selected,
	tool = "pointer",
	zoom,
}: {
	/** The clip's media, for per-clip visual slots. */
	asset?: Asset;
	assetDuration: number;
	/** J/L offsets of a linked audio clip against its picture partner. */
	badges?: readonly SplitOffsetBadge[];
	/** Timeline seconds wide clip visuals draw (`null` draws them whole). */
	drawWindow?: TimeWindow | null;
	fps: number;
	locked: boolean;
	markers: readonly Marker[];
	name: string;
	onMove: (start: number, track: number) => void;
	onSelect: (additive: boolean) => void;
	/** Tool drags (ripple/roll edges, slip/slide body) with a timeline delta. */
	onToolEdit?: (edge: DragEdge, delta: number) => void;
	onTrim: (segment: Segment) => void;
	segment: Segment;
	selected: boolean;
	tool?: TrimTool;
	zoom: number;
}) {
	const tl = useLiteralMessages();
	const runtime = useContext(EditorContext);
	const origin = useRef<ClipDragOrigin | null>(null);
	const suppressClick = useRef(false);
	const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
	const dragInput = (point: ClipDragOrigin, x: number, y: number) => ({
		assetDuration,
		fps,
		handlesToolEdits: onToolEdit !== undefined,
		markers,
		origin: point,
		segment,
		tool,
		x,
		y,
		zoom,
	});
	const endFeedback = () => {
		if (runtime) {
			clearToolDragFeedback(runtime.store);
		}
	};
	const finish = (x: number, y: number) => {
		const point = origin.current;
		origin.current = null;
		setDrag(null);
		endFeedback();
		if (!point) {
			return;
		}
		const result = resolveClipDrag(dragInput(point, x, y));
		if (result.kind === "none") {
			return;
		}
		suppressClick.current = true;
		if (result.kind === "tool") {
			onToolEdit?.(result.edge, result.delta);
		} else if (result.kind === "trim") {
			onTrim(result.segment);
		} else {
			onMove(result.start, result.track);
		}
	};
	const clipStyle: TimelineClipStyle = {
		"--studio-clip-left": `${segment.start * zoom}px`,
		"--studio-clip-width": `${Math.max(12, segmentDuration(segment) * zoom)}px`,
		"--studio-clip-transform": drag
			? `translate(${drag.x}px, ${drag.y}px)`
			: "none",
		"--studio-clip-z-index": drag ? "5" : "auto",
	};
	const badgeText = badges.map(formatSplitOffset).join(" · ");
	const clipLabelValues = {
		badges: badgeText,
		name,
		seconds: segment.start.toFixed(2),
	};
	const lockedLabel = badgeText
		? tl(
				"Locked {name} at {seconds} seconds · split edit {badges}",
				clipLabelValues
			)
		: tl("Locked {name} at {seconds} seconds", clipLabelValues);
	const selectLabel = badgeText
		? tl(
				"Select {name} at {seconds} seconds · split edit {badges}",
				clipLabelValues
			)
		: tl("Select {name} at {seconds} seconds", clipLabelValues);
	const slot: ClipSlotProps = {
		asset,
		drawWindow,
		fps,
		locked,
		segment,
		selected,
		zoom,
	};
	return (
		<Button
			aria-label={locked ? lockedLabel : selectLabel}
			className="studio-timeline-clip"
			data-clip-kind={mediaClipKind(asset?.kind)}
			data-color-tag={segment.color}
			data-locked={locked ? "true" : undefined}
			data-selected={selected ? "true" : undefined}
			data-tool={tool === "pointer" ? undefined : tool}
			disabled={locked}
			onClick={(event) => {
				if (suppressClick.current) {
					suppressClick.current = false;
					return;
				}
				const bounds = event.currentTarget.getBoundingClientRect();
				if (
					handleToolClick({
						at: segment.start + (event.clientX - bounds.left) / zoom,
						segment,
						shiftKey: event.shiftKey,
						tool,
					})
				) {
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
						nudgedStart(segment, fps, event.key === "ArrowLeft" ? -1 : 1),
						segment.track
					);
				}
			}}
			onPointerCancel={() => {
				origin.current = null;
				setDrag(null);
				endFeedback();
			}}
			onPointerDown={(event) => {
				if (locked || event.button !== 0) {
					return;
				}
				origin.current = {
					edge: dragEdgeAt(
						event.currentTarget.getBoundingClientRect(),
						event.clientX
					),
					x: event.clientX,
					y: event.clientY,
				};
				event.currentTarget.setPointerCapture(event.pointerId);
			}}
			onPointerMove={(event) => {
				const point = origin.current;
				if (point) {
					setDrag({ x: event.clientX - point.x, y: event.clientY - point.y });
					// Slip/roll/ripple drags feed the preview's two-up viewer.
					if (runtime && onToolEdit) {
						publishToolDragFeedback(
							runtime,
							dragInput(point, event.clientX, event.clientY)
						);
					}
				}
			}}
			onPointerUp={(event) => {
				finish(event.clientX, event.clientY);
				event.currentTarget.releasePointerCapture(event.pointerId);
			}}
			style={clipStyle}
			title={
				locked
					? "This track is locked. Unlock it from the track header to edit clips."
					: toolTitles[tool]
			}
			variant={selected ? "default" : "secondary"}
		>
			<ClipFilmstrip {...slot} />
			<ClipWaveform {...slot} />
			<ClipSpeakerTint {...slot} />
			<ClipSilenceOverlay {...slot} />
			<span
				aria-label={tl("Trim start of {name}", { name })}
				className="studio-timeline-handle studio-timeline-handle-start"
			/>
			<ClipLabel {...slot} />
			{name}
			{badges.map((badge) => (
				<span
					aria-hidden="true"
					className="studio-split-badge font-mono"
					data-edge={badge.edge}
					data-kind={badge.kind}
					key={badge.edge}
				>
					{formatSplitOffset(badge)}
				</span>
			))}
			<ClipOfflineBadge {...slot} />
			<ClipKeyframeLane {...slot} />
			<ClipVolumeLine {...slot} />
			<ClipFadeHandles {...slot} />
			<span
				aria-label={tl("Trim end of {name}", { name })}
				className="studio-timeline-handle studio-timeline-handle-end"
			/>
		</Button>
	);
}
