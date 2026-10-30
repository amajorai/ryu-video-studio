import { type RefObject, useEffect, useMemo, useRef } from "react";
import type { PreviewQuality } from "../../editor/store.ts";
import type { PreviewStyle } from "../preview-style.ts";
import { type GlPass, glPassesKey } from "./pass.ts";
import {
	createGlPipeline,
	type GlPipeline,
	type GlSource,
} from "./pipeline.ts";

interface GlLayerProps {
	className?: string;
	label: string;
	/** Called once when WebGL2 is unavailable or a pass fails, so the caller can fall back to the plain media element. */
	onUnavailable?: (message: string) => void;
	passes: readonly GlPass[];
	playing: boolean;
	/**
	 * Preview quality: Half and Quarter draw the passes into a canvas that
	 * many times smaller (`previewCanvasSize`), scaled up by CSS.
	 */
	quality?: PreviewQuality;
	source: RefObject<GlSource | null>;
	style?: PreviewStyle;
	/** Clip-relative time in seconds, exposed to passes as `u_time`. */
	time: number;
}

/**
 * Draws a clip's `<video>`/`<img>` through an ordered list of WebGL2 passes.
 * With no passes it renders nothing, so the media element itself shows and
 * the preview is unchanged. The caller hides the media element while a
 * canvas is drawn in its place.
 */
export function GlLayer(props: GlLayerProps) {
	if (props.passes.length === 0) {
		return null;
	}
	return <GlCanvas {...props} />;
}

/** Media events after which the source has a new frame to upload. */
export const glRedrawEvents = ["loadeddata", "seeked", "load"] as const;

function GlCanvas({
	className,
	label,
	onUnavailable,
	passes,
	playing,
	quality = "full",
	source,
	style,
	time,
}: GlLayerProps) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const pipeline = useRef<GlPipeline | null>(null);
	const failed = useRef(false);
	// Latest callback without re-creating the WebGL context when it changes.
	const report = useRef(onUnavailable);
	useEffect(() => {
		report.current = onUnavailable;
	});

	useEffect(() => {
		const element = canvas.current;
		if (!element) {
			return;
		}
		pipeline.current = createGlPipeline(element);
		if (!pipeline.current) {
			failed.current = true;
			report.current?.(
				"WebGL2 is unavailable, so this effect is not previewed."
			);
		}
		return () => {
			pipeline.current?.dispose();
			pipeline.current = null;
		};
	}, []);

	// Draws read the latest inputs from refs, so playback (where `time` and
	// keyframed uniforms change every frame) never restarts the rAF loop.
	const latest = useRef({ passes, quality, source, time });
	useEffect(() => {
		latest.current = { passes, quality, source, time };
	});
	const draw = useRef(() => {
		const media = latest.current.source.current;
		if (failed.current || !(media && pipeline.current)) {
			return;
		}
		try {
			pipeline.current.render(
				media,
				latest.current.passes,
				latest.current.time,
				latest.current.quality
			);
		} catch (error) {
			failed.current = true;
			report.current?.(
				error instanceof Error
					? error.message
					: "This effect could not be previewed."
			);
		}
	});
	const passesKey = useMemo(() => glPassesKey(passes), [passes]);

	// A paused frame can only be uploaded once the media has one: redraw when
	// it loads, and when a seek (including the parent's paused-scrub sync,
	// which runs after this child's effects) lands on the new frame.
	useEffect(() => {
		const media = source.current;
		if (!media) {
			return;
		}
		const redraw = () => draw.current();
		for (const event of glRedrawEvents) {
			media.addEventListener(event, redraw);
		}
		return () => {
			for (const event of glRedrawEvents) {
				media.removeEventListener(event, redraw);
			}
		};
	}, [source]);

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

	// Paused: draw whenever the frame's inputs change.
	useEffect(() => {
		if (!playing) {
			draw.current();
		}
	}, [passesKey, playing, quality, time]);

	return (
		<canvas
			aria-label={label}
			className={className}
			ref={canvas}
			role="img"
			style={style}
		/>
	);
}
