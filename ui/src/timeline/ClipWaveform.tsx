import { useEffect, useMemo, useRef, useState } from "react";
import { clipAudioMutedOf } from "../../../shared/clip-speed.ts";
import type { ClipSlotProps } from "./clip-slot-props.ts";
import {
	DEFAULT_WAVEFORM_COLUMN_WIDTH,
	hasWaveform,
	peaksCache,
	type WaveformPeaks,
	watchPeaks,
	waveformColumnsInSpan,
} from "./clip-visual-cache.ts";
import { clipDrawSpan } from "./virtualize.ts";

/** Canvas height for an audio clip (full lane) and a video clip's band. */
const AUDIO_HEIGHT = 32;
const VIDEO_BAND_HEIGHT = 10;

/** Draw mirrored bars, one per column, in the canvas's current text color. */
function drawColumns(canvas: HTMLCanvasElement, columns: readonly number[]) {
	const context = canvas.getContext("2d");
	if (!context) {
		return;
	}
	const { height, width } = canvas;
	context.clearRect(0, 0, width, height);
	context.fillStyle = getComputedStyle(canvas).color || "currentColor";
	const barWidth = Math.max(1, DEFAULT_WAVEFORM_COLUMN_WIDTH - 0.5);
	for (const [index, amplitude] of columns.entries()) {
		const bar = Math.max(1, amplitude * height);
		context.fillRect(
			index * DEFAULT_WAVEFORM_COLUMN_WIDTH,
			(height - bar) / 2,
			barWidth,
			bar
		);
	}
}

/**
 * Audio waveform drawn from the asset's analysis peaks: the clip's visible
 * source range at its speed, scaled by its volume. Audio clips fill the
 * lane; video clips with sound show a band along the bottom. Nothing is
 * drawn until the asset has a completed source analysis; while it has not,
 * the analysis is re-read with a backoff. A clip wider than the draw window
 * draws only the columns near the viewport, on a canvas positioned over
 * that part of the clip.
 */
export function ClipWaveform({
	asset,
	drawWindow,
	segment,
	zoom,
}: ClipSlotProps) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const [loaded, setLoaded] = useState<{
		assetId: string;
		peaks: WaveformPeaks;
	} | null>(null);
	const audible = hasWaveform(asset) ? asset : undefined;
	const audibleId = audible?.id;
	const audibleDuration = audible?.duration ?? 0;
	useEffect(() => {
		if (audibleId === undefined) {
			return;
		}
		// The shared watch re-reads the analysis until it completes (it is
		// often started after clips are on the timeline) and after
		// `invalidatePeaks`, so the waveform appears without a remount.
		return watchPeaks({ duration: audibleDuration, id: audibleId }, (peaks) => {
			setLoaded({ assetId: audibleId, peaks });
		});
	}, [audibleId, audibleDuration]);
	const peaks = audible
		? loaded?.assetId === audible.id
			? loaded.peaks
			: (peaksCache.peek(audible.id) ?? undefined)
		: undefined;
	const { sourceIn, sourceOut, speed, start, volume } = segment;
	const span = drawWindow
		? clipDrawSpan({ sourceIn, sourceOut, speed, start }, drawWindow, zoom)
		: undefined;
	const spanFrom = span?.from;
	const spanTo = span?.to;
	const drawn = useMemo(
		() =>
			peaks
				? waveformColumnsInSpan(
						peaks,
						{ sourceIn, sourceOut, speed, volume },
						{ pxPerSec: zoom },
						spanFrom === undefined || spanTo === undefined
							? undefined
							: { from: spanFrom, to: spanTo }
					)
				: { columns: [], first: 0, total: 0 },
		[peaks, sourceIn, sourceOut, speed, volume, zoom, spanFrom, spanTo]
	);
	const { columns } = drawn;
	useEffect(() => {
		if (canvas.current) {
			drawColumns(canvas.current, columns);
		}
	}, [columns]);
	if (!(audible && columns.length > 0)) {
		return null;
	}
	const isAudio = audible.kind === "audio";
	// The canvas covers the drawn columns' share of the clip.
	const placement = {
		left: `${(drawn.first / drawn.total) * 100}%`,
		width: `${(columns.length / drawn.total) * 100}%`,
	};
	return (
		<span
			aria-hidden="true"
			className={`pointer-events-none absolute bottom-0 ${
				isAudio ? "top-0" : "h-[10px]"
			} ${clipAudioMutedOf(segment) ? "opacity-20" : "opacity-55"}`}
			data-waveform-first={drawn.first}
			style={placement}
		>
			<canvas
				className="block h-full w-full"
				data-waveform-columns={columns.length}
				height={isAudio ? AUDIO_HEIGHT : VIDEO_BAND_HEIGHT}
				ref={canvas}
				width={columns.length * DEFAULT_WAVEFORM_COLUMN_WIDTH}
			/>
		</span>
	);
}
