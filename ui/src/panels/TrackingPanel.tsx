import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { formatMessage } from "@ryu/i18n/core";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useEffect, useState } from "react";
import {
	type Asset,
	type Segment,
	segmentDuration,
} from "../../../shared/project.ts";
import {
	MAX_TRACK_SECONDS,
	MIN_TRACK_REGION,
	type TrackRegion,
	type TrackTarget,
	trackTargetsAt,
} from "../../../shared/tracking.ts";
import { useEditorProject } from "../editor/context.tsx";
import { useEditorStore } from "../editor/store.ts";
import { NumberField } from "../NumberField.tsx";
import { clampRegion } from "../preview/overlays/tracking-region.ts";
import type { PanelTab } from "./types.ts";

/**
 * Its own library tab while this is non-null; otherwise the panel mounts
 * inside its home category (Graphics), next to the items it animates.
 */
export const trackingPanelTab: PanelTab | null = null;

/** A centered region a fifth of the canvas wide and tall. */
export const DEFAULT_TRACK_REGION: TrackRegion = {
	height: 0.2,
	width: 0.2,
	x: 0.4,
	y: 0.4,
};

type FollowerTarget = ReturnType<typeof trackTargetsAt>[number];

const BLUR_OPTION = "region:blur";
const MOSAIC_OPTION = "region:mosaic";

/** Select value of a target choice. */
export function targetOptionValue(target: TrackTarget): string {
	return "createRegion" in target
		? `region:${target.createRegion}`
		: `${target.kind}:${target.id}`;
}

/** The target a select value names, or null for an unknown value. */
export function targetFromOption(value: string): TrackTarget | null {
	if (value === BLUR_OPTION) {
		return { createRegion: "blur" };
	}
	if (value === MOSAIC_OPTION) {
		return { createRegion: "mosaic" };
	}
	const [kind, id] = value.split(":");
	if (!id || (kind !== "title" && kind !== "graphic" && kind !== "clip")) {
		return null;
	}
	return { id, kind };
}

/**
 * The option the Follower menu actually shows: `option` while it is a
 * region or one of the listed followers, else the blur region. A follower
 * that left the screen (playhead moved, selection changed) must not keep
 * driving the request while the menu displays something else.
 */
export function effectiveTargetOption(
	option: string,
	targets: readonly Pick<FollowerTarget, "id" | "kind">[]
): string {
	if (option === BLUR_OPTION || option === MOSAIC_OPTION) {
		return option;
	}
	const listed = targets.some(
		(target) =>
			targetOptionValue({ id: target.id, kind: target.kind }) === option
	);
	return listed ? option : BLUR_OPTION;
}

export { clampRegion } from "../preview/overlays/tracking-region.ts";

/** Why tracking cannot run for this selection and playhead, or null. */
export function trackingBlocker(
	segment: Segment | undefined,
	assets: readonly Asset[],
	time: number
): string | null {
	if (!segment) {
		return "Select the video clip that shows the subject.";
	}
	const asset = assets.find((item) => item.id === segment.assetId);
	if (asset?.kind !== "video") {
		return "Motion tracking follows subjects in video clips only.";
	}
	const end = segment.start + segmentDuration(segment);
	if (time < segment.start || time >= end) {
		return "Move the playhead onto the selected clip, to the frame where the region is drawn.";
	}
	return null;
}

/** Status line after a tracking run, from the route's extras. */
export function trackingSummary(
	extras: Record<string, unknown>,
	tl: LiteralMessage = (source, values) => formatMessage(source, values, "en")
): string {
	const samples = typeof extras.samples === "number" ? extras.samples : 0;
	const keyframes = typeof extras.keyframes === "number" ? extras.keyframes : 0;
	const lost = typeof extras.lostFrames === "number" ? extras.lostFrames : 0;
	const confidence =
		typeof extras.confidence === "number" ? extras.confidence : 0;
	const values = {
		keyframeCount: String(keyframes),
		lostCount: String(lost),
		matchPercent: String(Math.round(confidence * 100)),
		sampleCount: String(samples),
	};
	return lost > 0
		? tl(
				"Tracked {sampleCount} frames ({matchPercent}% match) into {keyframeCount} keyframes. The subject was lost on {lostCount} frames; its position was held there.",
				values
			)
		: tl(
				"Tracked {sampleCount} frames ({matchPercent}% match) into {keyframeCount} keyframes.",
				values
			);
}

/** The request body (without revision) for `POST /projects/:id/track`. */
export function trackingBody(input: {
	clipId: string;
	duration: number;
	region: TrackRegion;
	remaining: number;
	target: TrackTarget;
	time: number;
}): Record<string, unknown> {
	return {
		clipId: input.clipId,
		roi: input.region,
		target: input.target,
		time: input.time,
		// Tracking to the clip end needs no duration.
		...(input.duration < input.remaining ? { duration: input.duration } : {}),
	};
}

function TargetSelect({
	onChange,
	targets,
	value,
}: {
	onChange: (value: string) => void;
	targets: readonly FollowerTarget[];
	value: string;
}) {
	return (
		<NativeSelect
			aria-label="Follower"
			onChange={(event) => onChange(event.target.value)}
			value={value}
		>
			<NativeSelectOption value={BLUR_OPTION}>
				New blur region
			</NativeSelectOption>
			<NativeSelectOption value={MOSAIC_OPTION}>
				New mosaic region
			</NativeSelectOption>
			{targets.map((target) => (
				<NativeSelectOption
					key={target.id}
					value={targetOptionValue({ id: target.id, kind: target.kind })}
				>
					{target.label}
				</NativeSelectOption>
			))}
		</NativeSelect>
	);
}

/**
 * Motion tracking: draw a region over the subject at the playhead, then make
 * a title, graphic, sticker clip or a new blur/mosaic region follow it.
 */
export function TrackingPanel() {
	const runtime = useEditorProject();
	const tl = useLiteralMessages();
	const { assets, busy, project, selectedSegment, time } = runtime;
	const { store } = runtime;
	// The region lives in the editor store so the preview can draw it and
	// the viewer can drag a new one there; it is cleared when the panel closes.
	const region =
		useEditorStore(store, (state) => state.trackingRegion) ??
		DEFAULT_TRACK_REGION;
	const drawing = useEditorStore(store, (state) => state.trackingRegionDrawing);
	const setRegion = (update: (current: TrackRegion) => TrackRegion) =>
		store.setState((state) => ({
			trackingRegion: update(state.trackingRegion ?? DEFAULT_TRACK_REGION),
		}));
	useEffect(() => {
		store.setState((state) => ({
			trackingRegion: state.trackingRegion ?? DEFAULT_TRACK_REGION,
		}));
		return () =>
			store.setState({ trackingRegion: null, trackingRegionDrawing: false });
	}, [store]);
	const [option, setOption] = useState(BLUR_OPTION);
	const [duration, setDuration] = useState(MAX_TRACK_SECONDS);
	const blocker = trackingBlocker(selectedSegment, assets, time);
	const targets = selectedSegment
		? trackTargetsAt(project, assets, selectedSegment.id, time)
		: [];
	const effectiveOption = effectiveTargetOption(option, targets);
	const target = targetFromOption(effectiveOption);
	const remaining = selectedSegment
		? Math.max(
				0,
				selectedSegment.start + segmentDuration(selectedSegment) - time
			)
		: 0;
	const field = (key: keyof TrackRegion, label: string) => (
		<NumberField
			label={label}
			max={100}
			min={key === "width" || key === "height" ? MIN_TRACK_REGION * 100 : 0}
			onChange={(percent) =>
				setRegion((current) =>
					clampRegion({ ...current, [key]: percent / 100 })
				)
			}
			step={0.5}
			value={Math.round(region[key] * 1000) / 10}
		/>
	);
	return (
		<RyuAppSection title="Motion tracking">
			<p className="text-muted-foreground">
				Region on the canvas at the playhead, in percent of the frame. Drag the
				dashed box on the preview to move it, or draw a new one. The subject is
				tracked from the playhead to the end of the clip.
			</p>
			<RyuAppActions>
				<Button
					aria-pressed={drawing}
					onClick={() => store.setState({ trackingRegionDrawing: !drawing })}
					size="sm"
					variant={drawing ? "secondary" : "outline"}
				>
					{drawing ? "Drawing on the preview…" : "Draw region on preview"}
				</Button>
			</RyuAppActions>
			<div className="studio-inline-fields">
				{field("x", "Left (%)")}
				{field("y", "Top (%)")}
				{field("width", "Width (%)")}
				{field("height", "Height (%)")}
			</div>
			<RyuAppField label="Follower">
				<TargetSelect
					onChange={setOption}
					targets={targets}
					value={effectiveOption}
				/>
			</RyuAppField>
			<NumberField
				label="Track for at most (s)"
				max={MAX_TRACK_SECONDS}
				min={0.1}
				onChange={setDuration}
				step={0.5}
				value={duration}
			/>
			<RyuAppActions>
				<Button
					disabled={busy || blocker !== null || target === null}
					onClick={() => {
						if (!(selectedSegment && target)) {
							return;
						}
						void runtime.routeEdit(
							"track",
							trackingBody({
								clipId: selectedSegment.id,
								duration,
								region,
								remaining,
								target,
								time,
							}),
							(extras) => trackingSummary(extras, tl)
						);
					}}
					size="sm"
					title={blocker ?? undefined}
				>
					Track motion
				</Button>
			</RyuAppActions>
			{blocker && <p className="text-muted-foreground">{blocker}</p>}
		</RyuAppSection>
	);
}
