import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	type Asset,
	type Marker,
	type Project,
	type Segment,
	segmentDuration,
	trackSettingFor,
} from "../../../shared/project.ts";
import { type CutPoint, findCutPoints } from "../../../shared/split-edits.ts";
import { timelineColorVariables } from "../../../shared/timeline-colors.ts";
import { trackOrderFor } from "../../../shared/track-edits.ts";
import {
	type DragEdge,
	splitOffsetBadges,
	type TrimTool,
} from "../editing-ui.ts";
import { moveLinkedClip } from "../editor/actions/placement.ts";
import { applyToolEdit } from "../editor/actions/trim.ts";
import { useEditorProject } from "../editor/context.tsx";
import type { EditorRuntime } from "../editor/runtime.ts";
import { useEditorStore, withClickSelection } from "../editor/store.ts";
import { ClipContextMenu } from "./ClipContextMenu.tsx";
import { DropPreview } from "./DropPreview.tsx";
import { MarqueeLayer } from "./MarqueeLayer.tsx";
import { OverlayLanes } from "./OverlayLanes.tsx";
import { Playhead } from "./Playhead.tsx";
import { RangeToolbar } from "./RangeToolbar.tsx";
import { SnapIndicator } from "./SnapIndicator.tsx";
import { TimelineClip } from "./TimelineClip.tsx";
import { TimelineGapMenu } from "./TimelineGapMenu.tsx";
import { TimelineRange } from "./TimelineRange.tsx";
import { TimelineRuler } from "./TimelineRuler.tsx";
import { TimelineToolbar } from "./TimelineToolbar.tsx";
import { TrackHeader } from "./TrackHeader.tsx";
import { useTimelineColors } from "./timeline-colors.ts";
import type { EditorTimelineStyle } from "./timeline-style.ts";
import { lanesOffsetOf, timelineViewport } from "./useTimelineZoom.ts";
import {
	CLIP_DRAW_WINDOW_MIN_PX,
	clipsInWindow,
	type LaneIndex,
	laneIndex,
	laneIndexes,
	scrollBucket,
	type TimeWindow,
	viewportTimeWindow,
	visibleTimeWindow,
	widestClipPx,
} from "./virtualize.ts";

/** Lanes stay at least this wide so short timelines remain usable. */
const MIN_TRACKS_WIDTH = 640;
/** Empty seconds shown after the last clip. */
const TRAILING_SECONDS = 3;
const EMPTY_LANE: LaneIndex = laneIndex([]);

/**
 * Clip handlers that read the latest runtime when they run, so the object
 * itself is stable and memoized lanes do not re-render on every editor
 * render (the playhead moves the runtime many times a second).
 */
interface LaneActions {
	move(segment: Segment, start: number, track: number): void;
	select(segment: Segment, additive: boolean): void;
	toolEdit(segment: Segment, edge: DragEdge, delta: number): void;
	trim(segment: Segment, next: Segment): void;
}

function laneActions(runtime: { current: EditorRuntime }): LaneActions {
	return {
		move: (segment, start, track) =>
			moveLinkedClip(runtime.current, segment, start, track, true),
		select: (segment, additive) => {
			const current = runtime.current;
			current.store.setState((state) => ({
				selection: withClickSelection(state.selection, segment.id, additive),
			}));
			current.setTime(segment.start);
		},
		toolEdit: (segment, edge, delta) =>
			applyToolEdit(runtime.current, segment, edge, delta),
		trim: (segment, next) => {
			const current = runtime.current;
			const project = current.project;
			if (!project) {
				return;
			}
			current.edit(
				{
					...project,
					segments: project.segments.map((candidate) =>
						candidate.id === segment.id ? next : candidate
					),
				},
				"Trim clip"
			);
			current.setSelected(segment.id);
			current.setTime(next.start);
		},
	};
}

interface TimelineLaneProps {
	actions: LaneActions;
	assetById: ReadonlyMap<string, Asset>;
	assets: readonly Asset[];
	cuts: readonly CutPoint[];
	/** Window wide clips draw their filmstrip and waveform in. */
	drawWindow: TimeWindow | null;
	isBottom: boolean;
	isTop: boolean;
	lane: LaneIndex;
	markers: readonly Marker[];
	project: Project;
	selected: ReadonlySet<string>;
	/** Mounted time window; `null` mounts every clip. */
	timeWindow: TimeWindow | null;
	tool: TrimTool;
	track: number;
	zoom: number;
}

/**
 * One track: header, the clips in the mounted window (plus selected ones),
 * and the gap menu. Memoized on stable inputs, so playhead ticks and edits
 * on other tracks skip it.
 */
const TimelineLane = memo(function TimelineLane({
	actions,
	assetById,
	assets,
	cuts,
	drawWindow,
	isBottom,
	isTop,
	lane,
	markers,
	project,
	selected,
	tool,
	timeWindow,
	track,
	zoom,
}: TimelineLaneProps) {
	const setting = trackSettingFor(project, track);
	const clips = clipsInWindow(lane, timeWindow, selected);
	return (
		<div
			className="studio-track"
			data-clip-count={lane.segments.length}
			data-locked={setting.locked ? "true" : undefined}
			data-mounted-clips={clips.length}
			data-muted={setting.muted ? "true" : undefined}
		>
			<TrackHeader
				isBottom={isBottom}
				isTop={isTop}
				setting={setting}
				track={track}
			/>
			{clips.map((segment) => {
				const asset = assetById.get(segment.assetId);
				return (
					<ClipContextMenu key={segment.id} segment={segment}>
						<TimelineClip
							asset={asset}
							assetDuration={asset?.duration ?? segmentDuration(segment)}
							badges={splitOffsetBadges(project, assets, segment, cuts)}
							drawWindow={drawWindow}
							fps={project.fps}
							locked={setting.locked}
							markers={markers}
							name={asset?.name ?? "Media"}
							onMove={(start, nextTrack) =>
								actions.move(segment, start, nextTrack)
							}
							onSelect={(additive) => actions.select(segment, additive)}
							onToolEdit={(edge, delta) =>
								actions.toolEdit(segment, edge, delta)
							}
							onTrim={(next) => actions.trim(segment, next)}
							segment={segment}
							selected={selected.has(segment.id)}
							tool={tool}
							zoom={zoom}
						/>
					</ClipContextMenu>
				);
			})}
			<TimelineGapMenu track={track} />
		</div>
	);
});

/** The scroll viewport's width and where time 0 sits in it, once measured. */
function useViewportSize(
	scrollRef: { current: HTMLDivElement | null },
	runtime: EditorRuntime
): { lanesOffset: number; width: number | undefined } {
	const [size, setSize] = useState<{
		lanesOffset: number;
		width: number | undefined;
	}>({ lanesOffset: 0, width: undefined });
	const { store } = runtime;
	useLayoutEffect(() => {
		const scroll = scrollRef.current;
		if (!scroll) {
			return;
		}
		const measure = () => {
			const viewport = timelineViewport(store);
			const next = {
				lanesOffset: viewport ? lanesOffsetOf(viewport) : 0,
				width: scroll.clientWidth,
			};
			setSize((current) =>
				current.width === next.width && current.lanesOffset === next.lanesOffset
					? current
					: next
			);
		};
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(scroll);
		return () => observer.disconnect();
	}, [scrollRef, store]);
	return size;
}

/** The timeline section: toolbars, ruler, tracks with clips, guides, and playhead. */
export function Timeline() {
	const runtime = useEditorProject();
	const { assets, busy, duration, project, time, zoom } = runtime;
	const latest = useRef<EditorRuntime>(runtime);
	latest.current = runtime;
	const actions = useMemo(() => laneActions(latest), []);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const viewport = useViewportSize(scrollRef, runtime);
	const timelineColors = useTimelineColors();
	const bucket = useEditorStore(runtime.store, (state) =>
		scrollBucket(state.scrollLeft)
	);
	const lanes = useMemo(
		() => laneIndexes(project.segments),
		[project.segments]
	);
	const assetById = useMemo(
		() => new Map(assets.map((asset) => [asset.id, asset])),
		[assets]
	);
	/** Editable audio/video cuts, scanned once per edit for the J/L badges. */
	const timelineCuts = useMemo(
		() => findCutPoints(project, assets),
		[project, assets]
	);
	const selectedKey = runtime.selectedIds.join("\n");
	const selected = useMemo(
		() => new Set(selectedKey ? selectedKey.split("\n") : []),
		[selectedKey]
	);
	const timeWindow = useMemo(
		() =>
			visibleTimeWindow({
				clipCount: project.segments.length,
				lanesOffset: viewport.lanesOffset,
				scrollLeft: bucket,
				viewportWidth: viewport.width,
				zoom,
			}),
		[bucket, project.segments.length, viewport, zoom]
	);
	const widest = useMemo(
		() => widestClipPx(project.segments, zoom),
		[project.segments, zoom]
	);
	// Only timelines with a clip wider than the draw threshold follow the
	// scroll here, so other timelines do not re-render lanes while scrolling.
	const drawWindow = useMemo(
		() =>
			widest > CLIP_DRAW_WINDOW_MIN_PX
				? viewportTimeWindow({
						lanesOffset: viewport.lanesOffset,
						scrollLeft: bucket,
						viewportWidth: viewport.width,
						zoom,
					})
				: null,
		[bucket, viewport, widest, zoom]
	);
	const trackWidthStyle: EditorTimelineStyle = {
		...timelineColorVariables(timelineColors),
		"--studio-tracks-width": `${Math.max(MIN_TRACKS_WIDTH, (duration + TRAILING_SECONDS) * zoom)}px`,
	};
	return (
		<section
			aria-label="Video timeline"
			className="studio-timeline"
			inert={busy}
		>
			<TimelineToolbar />
			<RangeToolbar />
			<div className="studio-timeline-scroll" ref={scrollRef}>
				<div className="studio-tracks" style={trackWidthStyle}>
					<TimelineRuler
						duration={duration}
						markers={project.markers}
						onSeek={runtime.setTime}
						zoom={zoom}
					/>
					<OverlayLanes zoom={zoom} />
					{trackOrderFor(project).map((track, index, order) => (
						<TimelineLane
							actions={actions}
							assetById={assetById}
							assets={assets}
							cuts={timelineCuts}
							drawWindow={drawWindow}
							isBottom={index === 0}
							isTop={index === order.length - 1}
							key={track}
							lane={lanes.get(track) ?? EMPTY_LANE}
							markers={project.markers}
							project={project}
							selected={selected}
							timeWindow={timeWindow}
							tool={runtime.tool}
							track={track}
							zoom={zoom}
						/>
					))}
					{runtime.timelineGuides.map((guide) => {
						const guideStyle: EditorTimelineStyle = {
							"--studio-guide-left": `${guide.start * zoom}px`,
							"--studio-guide-width":
								guide.end === undefined
									? "0px"
									: `${Math.max(2, (guide.end - guide.start) * zoom)}px`,
						};
						return (
							<div
								aria-hidden="true"
								className="studio-timeline-guide"
								data-kind={guide.kind}
								key={guide.id}
								style={guideStyle}
								title={guide.label}
							/>
						);
					})}
					<MarqueeLayer zoom={zoom} />
					<DropPreview zoom={zoom} />
					<SnapIndicator zoom={zoom} />
					<TimelineRange zoom={zoom} />
					<Playhead time={time} zoom={zoom} />
				</div>
			</div>
		</section>
	);
}
