import { useLiteralMessages } from "@ryu/i18n/react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import {
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { fadeBounds, setClipFade } from "../../../shared/group-edits.ts";
import { segmentDuration } from "../../../shared/project.ts";
import { EditorContext } from "../editor/context.tsx";
import { message } from "../editor/format.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import {
	attachClipDragEngine,
	FADE_KNEE_PX,
	fadeFromDrag,
	fadeKneeOffset,
	fadeLabel,
} from "./clip-drag.ts";
import type { ClipSlotProps } from "./clip-slot-props.ts";

type Fade = "in" | "out";

interface KneeDrag {
	fade: Fade;
	pointerId: number;
	startSeconds: number;
	startX: number;
}

/** Apply a fade length as one undoable edit. */
function commitFade(
	runtime: EditorRuntime,
	segmentId: string,
	fade: Fade,
	seconds: number
) {
	const { project } = runtime;
	if (!project) {
		return;
	}
	try {
		const next = setClipFade(project, runtime.assets, {
			clipId: segmentId,
			fade,
			revision: project.revision,
			seconds,
		});
		if (next !== project) {
			runtime.edit(next, fade === "in" ? "Fade in" : "Fade out");
			runtime.setStatus(`${fadeLabel(fade, seconds)}.`);
		}
	} catch (error) {
		runtime.setStatus(message(error));
	}
}

/** Marks the knee overlay that sits beside a clip, with the clip's id. */
export const FADE_KNEES_ATTRIBUTE = "data-fade-knees-for";

const noSubscription = () => () => undefined;

/**
 * Fade knee handles at a clip's top corners: drag (or use the arrow keys)
 * to set `fadeIn` / `fadeOut`, with the length shown in seconds. The slot
 * also attaches the clip's group drag engine (group move and trim, linked
 * trim, Alt-duplicate) to the clip element it is mounted in.
 *
 * The slot mounts inside the clip's `<button>`, whose content is
 * presentational and may not hold interactive elements. Only the decorative
 * fade ramps render there; the knee sliders are portalled into an overlay
 * that is a sibling of the clip (in the same track row) and tracks its box,
 * so assistive technology sees real sliders.
 */
export function ClipFadeHandles({
	fps,
	locked,
	segment,
	selected,
	zoom,
}: ClipSlotProps) {
	const tl = useLiteralMessages();
	const runtime = useContext(EditorContext);
	const rootRef = useRef<HTMLSpanElement>(null);
	const latestRuntime = useRef(runtime);
	// The knee drag lives in a ref so back-to-back pointer events see it.
	const dragRef = useRef<KneeDrag | null>(null);
	const [preview, setPreview] = useState<{
		fade: Fade;
		seconds: number;
	} | null>(null);
	useEffect(() => {
		latestRuntime.current = runtime;
	});
	const hasRuntime = runtime !== null;
	useEffect(() => {
		const clip = rootRef.current?.parentElement;
		if (!(clip && hasRuntime)) {
			return;
		}
		return attachClipDragEngine(clip, segment.id, () => latestRuntime.current);
	}, [hasRuntime, segment.id]);
	// The knee overlay: a sibling of the clip element inside its track row.
	const [overlay, setOverlay] = useState<HTMLElement | null>(null);
	useLayoutEffect(() => {
		const clip = rootRef.current?.parentElement;
		if (!clip?.parentElement) {
			return;
		}
		const element = clip.ownerDocument.createElement("div");
		element.setAttribute(FADE_KNEES_ATTRIBUTE, segment.id);
		element.className = "pointer-events-none absolute z-[4]";
		clip.after(element);
		setOverlay(element);
		return () => {
			element.remove();
			setOverlay(null);
		};
	}, [segment.id]);
	const store = runtime?.store;
	// Knees step aside while a group drag previews this clip elsewhere.
	const groupDragging = useSyncExternalStore(
		store?.subscribe ?? noSubscription,
		() => store?.getState().drag?.ids.includes(segment.id) ?? false,
		() => false
	);

	const width = Math.max(12, segmentDuration(segment) * zoom);
	const left = segment.start * zoom;
	// Keep the overlay on the clip's box (track height changes its top/height).
	useLayoutEffect(() => {
		const clip = rootRef.current?.parentElement;
		if (!(overlay && clip)) {
			return;
		}
		overlay.style.left = `${left}px`;
		overlay.style.width = `${width}px`;
		overlay.style.top = `${clip.offsetTop}px`;
		overlay.style.height = `${clip.offsetHeight}px`;
	});
	const bounds = fadeBounds(segment);
	const fadeSecondsOf = (fade: Fade) =>
		preview?.fade === fade
			? preview.seconds
			: fade === "in"
				? segment.fadeIn
				: segment.fadeOut;
	const showKnees =
		runtime !== null &&
		!locked &&
		!groupDragging &&
		(selected || segment.fadeIn > 0 || segment.fadeOut > 0);

	const onPointerDown = (fade: Fade) => (event: ReactPointerEvent) => {
		if (event.button !== 0) {
			return;
		}
		event.stopPropagation();
		event.currentTarget.setPointerCapture(event.pointerId);
		const startSeconds = fade === "in" ? segment.fadeIn : segment.fadeOut;
		dragRef.current = {
			fade,
			pointerId: event.pointerId,
			startSeconds,
			startX: event.clientX,
		};
		setPreview({ fade, seconds: startSeconds });
	};
	const onPointerMove = (event: ReactPointerEvent) => {
		const drag = dragRef.current;
		if (drag && event.pointerId === drag.pointerId) {
			setPreview({
				fade: drag.fade,
				seconds: fadeFromDrag(
					segment,
					drag.fade,
					drag.startSeconds,
					event.clientX - drag.startX,
					zoom,
					fps
				),
			});
		}
	};
	const onPointerUp = (event: ReactPointerEvent) => {
		const drag = dragRef.current;
		if (!drag || event.pointerId !== drag.pointerId) {
			return;
		}
		event.stopPropagation();
		const seconds = fadeFromDrag(
			segment,
			drag.fade,
			drag.startSeconds,
			event.clientX - drag.startX,
			zoom,
			fps
		);
		dragRef.current = null;
		setPreview(null);
		if (runtime) {
			commitFade(runtime, segment.id, drag.fade, seconds);
		}
	};
	const onPointerCancel = () => {
		dragRef.current = null;
		setPreview(null);
	};
	const onKeyDown = (fade: Fade) => (event: KeyboardEvent) => {
		const current = fade === "in" ? segment.fadeIn : segment.fadeOut;
		const limit = fade === "in" ? bounds.in : bounds.out;
		const step = (event.shiftKey ? 10 : 1) / fps;
		const next: Record<string, number> = {
			ArrowDown: current - step,
			ArrowLeft: fade === "in" ? current - step : current + step,
			ArrowRight: fade === "in" ? current + step : current - step,
			ArrowUp: current + step,
			End: limit,
			Home: 0,
		};
		const target = next[event.key];
		if (target === undefined || !runtime) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		commitFade(
			runtime,
			segment.id,
			fade,
			Math.max(0, Math.min(limit, Math.round(target * fps) / fps))
		);
	};

	const knees = showKnees
		? (["in", "out"] as const).map((fade) => {
				const value = fadeSecondsOf(fade);
				const limit = fade === "in" ? bounds.in : bounds.out;
				const label = fadeLabel(fade, value);
				const dragging = preview?.fade === fade;
				return (
					<span
						aria-label={fade === "in" ? "Fade in" : "Fade out"}
						aria-valuemax={Number(limit.toFixed(3))}
						aria-valuemin={0}
						aria-valuenow={Number(value.toFixed(3))}
						aria-valuetext={tl("{seconds} seconds", {
							seconds: value.toFixed(2),
						})}
						className="pointer-events-auto absolute top-0 -translate-x-1/2 cursor-ew-resize rounded-full border border-background bg-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
						data-clip-drag-ignore=""
						data-fade-knee={fade}
						key={`knee-${fade}`}
						onClick={(event) => event.stopPropagation()}
						onKeyDown={onKeyDown(fade)}
						onPointerCancel={onPointerCancel}
						onPointerDown={onPointerDown(fade)}
						onPointerMove={onPointerMove}
						onPointerUp={onPointerUp}
						role="slider"
						style={{
							height: `${FADE_KNEE_PX}px`,
							left: `${fadeKneeOffset(fade, value, width, zoom)}px`,
							width: `${FADE_KNEE_PX}px`,
						}}
						tabIndex={0}
						title={label}
					>
						{dragging ? (
							<span
								className={`pointer-events-none absolute top-full mt-0.5 whitespace-nowrap rounded bg-popover px-1 font-mono text-[0.6rem] text-popover-foreground shadow ${fade === "in" ? "left-0" : "right-0"}`}
								role="status"
							>
								{label}
							</span>
						) : null}
					</span>
				);
			})
		: null;

	return (
		<span
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 z-[4]"
			ref={rootRef}
		>
			{(["in", "out"] as const).map((fade) => {
				const value = fadeSecondsOf(fade);
				const ramp = Math.min(width, value * zoom);
				return ramp > 0 ? (
					<span
						className={`absolute inset-y-0 ${fade === "in" ? "left-0 bg-gradient-to-r" : "right-0 bg-gradient-to-l"} from-black/45 to-transparent`}
						data-fade-ramp={fade}
						key={`ramp-${fade}`}
						style={{ width: `${ramp}px` }}
					/>
				) : null;
			})}
			{overlay && knees ? createPortal(knees, overlay) : null}
		</span>
	);
}
