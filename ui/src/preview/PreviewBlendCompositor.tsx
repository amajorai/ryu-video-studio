import { useEffect, useRef, useState } from "react";
import type { PreviewQuality } from "../editor/store.ts";
import {
	type BlendCompositor,
	type CompositorDraw,
	createBlendCompositor,
	STALE_INPUT_LIMIT_MS,
} from "./compositor/compositor.ts";
import type { PreviewMediaRegistry } from "./compositor/media-registry.ts";
import type { CompositorPlan } from "./compositor/plan.ts";

type ActivePlan = Extract<CompositorPlan, { active: true }>;

/**
 * Whether the canvas should stay on screen after a draw. A drawn (or briefly
 * stale) frame shows. A `waiting` frame means the canvas still holds an older
 * composite: while playing that picture would freeze over the moving CSS
 * stack, so the canvas hides at once; while paused it hides once it has been
 * waiting longer than `STALE_INPUT_LIMIT_MS` (`waitedMs`).
 */
export function compositorShownAfter(
	result: CompositorDraw,
	playing: boolean,
	waitedMs: number
): boolean {
	if (result !== "waiting") {
		return true;
	}
	return !playing && waitedMs <= STALE_INPUT_LIMIT_MS;
}

interface PreviewBlendCompositorProps {
	/**
	 * Whether the canvas is on screen (a frame is drawn and current), so the
	 * caller knows when the CSS stack below is covered. False on unmount.
	 */
	onShownChange?: (shown: boolean) => void;
	/** Called once when WebGL2 or a shader is unavailable; the caller returns to the CSS stack. */
	onUnavailable: (message: string) => void;
	plan: ActivePlan;
	playing: boolean;
	quality?: PreviewQuality;
	registry: PreviewMediaRegistry;
	/** Above every media clip, below adjustment layers, titles and graphics. */
	zIndex: number;
}

/**
 * The whole-stack blend compositor (`./compositor/`): while a blended clip
 * is on screen it draws the canvas background and every visible media clip
 * into one opaque WebGL2 canvas over the CSS media stack, with the render's
 * blend maths, during playback as well as paused.
 *
 * The canvas is hidden until a frame is drawn, and again whenever a frame
 * cannot be drawn (`compositorShownAfter`), so the CSS stack shows through
 * instead of a frozen composite.
 */
export function PreviewBlendCompositor({
	onUnavailable,
	onShownChange,
	plan,
	playing,
	quality = "full",
	registry,
	zIndex,
}: PreviewBlendCompositorProps) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const compositor = useRef<BlendCompositor | null>(null);
	const failed = useRef(false);
	// Hidden until the first complete frame, so the CSS stack shows while
	// media loads instead of an empty canvas.
	const [shown, setShown] = useState(false);
	const show = useRef(setShown);
	const report = useRef(onUnavailable);
	const reportShown = useRef(onShownChange);
	const latest = useRef({ playing, plan, quality, registry });
	/** When the current run of `waiting` frames began, and its hide timer. */
	const waiting = useRef<{
		since: number;
		timer: ReturnType<typeof setTimeout> | null;
	} | null>(null);
	useEffect(() => {
		report.current = onUnavailable;
		reportShown.current = onShownChange;
		latest.current = { playing, plan, quality, registry };
	});
	useEffect(() => {
		reportShown.current?.(shown);
	}, [shown]);
	useEffect(
		() => () => {
			if (waiting.current?.timer) {
				clearTimeout(waiting.current.timer);
			}
			reportShown.current?.(false);
		},
		[]
	);

	const draw = useRef(() => {
		const engine = compositor.current;
		if (failed.current || !engine) {
			return;
		}
		const current = latest.current;
		try {
			const result = engine.render(
				current.plan,
				(layer) => current.registry.get(layer.segmentId),
				current.quality
			);
			canvas.current?.setAttribute("data-compositor-frame", result);
			const now = performance.now();
			if (result !== "waiting") {
				if (waiting.current?.timer) {
					clearTimeout(waiting.current.timer);
				}
				waiting.current = null;
				show.current(true);
				return;
			}
			waiting.current ??= { since: now, timer: null };
			const run = waiting.current;
			if (!compositorShownAfter(result, current.playing, now - run.since)) {
				show.current(false);
				return;
			}
			// Paused: hide the old composite if nothing draws again in time.
			run.timer ??= setTimeout(() => {
				if (waiting.current === run) {
					show.current(false);
				}
			}, STALE_INPUT_LIMIT_MS);
		} catch (error) {
			failed.current = true;
			report.current(
				error instanceof Error
					? error.message
					: "Blend modes could not be composited exactly."
			);
		}
	});

	useEffect(() => {
		const element = canvas.current;
		if (!element) {
			return;
		}
		compositor.current = createBlendCompositor(element, () => draw.current());
		if (!compositor.current) {
			failed.current = true;
			report.current(
				"WebGL2 is unavailable, so blend modes preview through CSS and are exact only on the paused frame."
			);
		}
		return () => {
			compositor.current?.dispose();
			compositor.current = null;
		};
	}, []);

	// New media frames (loaded, seeked) and newly registered clips redraw.
	useEffect(() => registry.subscribe(() => draw.current()), [registry]);

	useEffect(() => {
		if (!playing) {
			return;
		}
		let frame = requestAnimationFrame(function loop() {
			draw.current();
			frame = requestAnimationFrame(loop);
		});
		return () => cancelAnimationFrame(frame);
	}, [playing]);

	// Paused: every change of the plan (time, edits, quality) redraws.
	useEffect(() => {
		if (!playing) {
			draw.current();
		}
	});

	return (
		<canvas
			aria-label="Composited preview"
			className="pointer-events-none absolute inset-0 size-full"
			data-testid="preview-blend-compositor"
			ref={canvas}
			role="img"
			style={{ visibility: shown ? "visible" : "hidden", zIndex }}
		/>
	);
}
