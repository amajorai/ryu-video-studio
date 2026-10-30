import type { KeyboardEvent } from "react";
import { useRef } from "react";
import { frameQuantize } from "../../../shared/edit-points.ts";
import { useEditorProject } from "../editor/context.tsx";
import { clock } from "../editor/format.ts";
import { usePlaybackTransportSync } from "../editor/playback-clock.ts";
import { formatTimecode } from "./timecode.ts";
import type { EditorTimelineStyle } from "./timeline-style.ts";
import { useScrub } from "./useScrub.ts";

/** Seconds a PageUp/PageDown press moves the playhead. */
const PAGE_SECONDS = 5;

/**
 * Where a playhead-slider key moves the playhead, or null for keys it does
 * not handle. Arrows step one frame (one second with Shift), PageUp/PageDown
 * five seconds, and Home/End jump to either end.
 */
export function playheadKeyTarget(
	key: string,
	shiftKey: boolean,
	{ duration, fps, time }: { duration: number; fps: number; time: number }
): number | null {
	const frame = 1 / (fps > 0 ? fps : 30);
	const step = shiftKey ? 1 : frame;
	let next: number;
	switch (key) {
		case "ArrowLeft":
		case "ArrowDown":
			next = time - step;
			break;
		case "ArrowRight":
		case "ArrowUp":
			next = time + step;
			break;
		case "PageDown":
			next = time - PAGE_SECONDS;
			break;
		case "PageUp":
			next = time + PAGE_SECONDS;
			break;
		case "Home":
			return 0;
		case "End":
			return Math.max(0, duration);
		default:
			return null;
	}
	const clamped = Math.max(0, Math.min(Math.max(0, duration), next));
	return shiftKey ? clamped : frameQuantize(clamped, fps > 0 ? fps : 30);
}

/**
 * The playhead line across every track, with a draggable, keyboard-operable
 * handle (`role="slider"`). It also keeps the playback clock's loop and
 * shuttle settings in step with the editor.
 */
export function Playhead({ time, zoom }: { time: number; zoom: number }) {
	const runtime = useEditorProject();
	const { duration, project, store } = runtime;
	usePlaybackTransportSync({
		duration,
		range: runtime.range,
		setTime: runtime.setTime,
		store,
	});
	const handleRef = useRef<HTMLDivElement>(null);
	const { onPointerDown } = useScrub({
		// The playhead sits in the lanes element, whose left edge is time 0.
		originOf: () => handleRef.current?.parentElement?.parentElement,
		runtime,
		zoom,
	});
	const playheadStyle: EditorTimelineStyle = {
		"--studio-playhead-left": `${time * zoom}px`,
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.altKey || event.metaKey || event.ctrlKey) {
			return;
		}
		const next = playheadKeyTarget(event.key, event.shiftKey, {
			duration,
			fps: project.fps,
			time,
		});
		if (next === null) {
			return;
		}
		// The slider owns these keys; the global shortcuts must not also act.
		event.preventDefault();
		event.stopPropagation();
		runtime.setPlaying(false);
		runtime.setTime(next);
	};
	return (
		<div className="studio-playhead" style={playheadStyle}>
			<div
				aria-label="Playhead position"
				aria-orientation="horizontal"
				aria-valuemax={Math.max(0, Number(duration.toFixed(3)))}
				aria-valuemin={0}
				aria-valuenow={Number(time.toFixed(3))}
				aria-valuetext={`${formatTimecode(time, project.fps)} (${clock(time)})`}
				className="pointer-events-auto absolute -top-3 left-0 h-3 w-3 -translate-x-1/2 cursor-ew-resize touch-none rounded-b-sm bg-primary outline-none ring-offset-1 focus-visible:ring-2 focus-visible:ring-ring"
				data-playhead-handle=""
				onKeyDown={onKeyDown}
				onPointerDown={onPointerDown}
				ref={handleRef}
				role="slider"
				tabIndex={0}
			/>
		</div>
	);
}
