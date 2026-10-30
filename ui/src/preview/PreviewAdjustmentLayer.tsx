import {
	type CSSProperties,
	Fragment,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { z } from "zod";
import {
	type AdjustmentLayer,
	activeAdjustmentLayers,
	adjustmentLayerAsSegment,
	adjustmentLayerHasEffect,
	adjustmentLayerValuesAt,
	adjustmentPreviewApproximate,
} from "../../../shared/adjustment.ts";
import type { Project } from "../../../shared/project.ts";
import { EditorContext } from "../editor/context.tsx";
import { effectFilterCss } from "./stages/effects.ts";
import { basicFilterCss } from "./stages/filter-basic.ts";
import { maskStrokeStyle, maskStyle } from "./stages/mask.ts";

/**
 * Adjustment layers (W2-V7) in the preview. Mirrors
 * `sidecar/src/render-stages/adjustment.ts`: each active layer is a
 * full-frame element whose `backdrop-filter` grades everything painted
 * beneath it. Its z-index sits just above the media of its track (media use
 * `track + 1`, and the layer comes later in the DOM), so clips on higher
 * tracks stay ungraded, like the render. Opacity and CSS masks limit the
 * graded backdrop the same way the render's alpha does.
 *
 * Advanced grades, LUTs, blend modes and effects CSS cannot draw are
 * approximate in CSS. While paused with no unsaved edits, the preview then
 * shows the server-rendered frame (`inspect-frame`) instead. That frame is
 * the whole timeline (every track, titles, graphics, avatars, meshes and
 * captions), so it is opaque and stacked at `SERVER_FRAME_Z_INDEX`, above
 * every content layer: nothing it already contains is drawn a second time.
 * Interactive overlays stack above it.
 */

const frameSchema = z.object({ data: z.string() });

/**
 * Stacking of the server frame: above clip media (`track + 1`, at most
 * `MAX_TRACK_INDEX + 1`) and every DOM content layer (graphics 15 to titles
 * 30), below the interactive overlays (mask handles at 60).
 */
export const SERVER_FRAME_Z_INDEX = 40;

/** Debounce for server frames while scrubbing a paused preview. */
export const SERVER_FRAME_DELAY_MS = 150;

/** The CSS filter list for a layer at project time `time`. */
export function adjustmentFilterCss(
	layer: AdjustmentLayer,
	time: number
): string {
	const values = adjustmentLayerValuesAt(layer, time);
	const segment = adjustmentLayerAsSegment(layer);
	const resolved = {
		...segment,
		brightness: values.brightness,
		colorGrade: {
			...segment.colorGrade,
			exposure: values.exposure,
			temperature: values.temperature,
		},
		contrast: values.contrast,
		saturation: values.saturation,
	};
	return `${basicFilterCss(resolved, time)} ${effectFilterCss(segment, time)}`
		.replaceAll(/\s+/g, " ")
		.trim();
}

/** Inline style of one layer element: stacking, backdrop filter, opacity, masks. */
export function adjustmentLayerStyle(
	layer: AdjustmentLayer,
	time: number,
	frame: { height: number; width: number }
): CSSProperties {
	const filter = adjustmentFilterCss(layer, time);
	return {
		backdropFilter: filter,
		opacity: adjustmentLayerValuesAt(layer, time).opacity,
		WebkitBackdropFilter: filter,
		zIndex: layer.track + 1,
		...maskStyle(adjustmentLayerAsSegment(layer), time, frame),
	};
}

/**
 * The layer's mask outline strokes, drawn above it at full strength (the
 * render overlays them after the layer's opacity and masks), or `undefined`.
 */
export function adjustmentStrokeStyle(
	layer: AdjustmentLayer,
	time: number,
	frame: { height: number; width: number }
): CSSProperties | undefined {
	const strokes = maskStrokeStyle(adjustmentLayerAsSegment(layer), time, frame);
	return strokes ? { ...strokes, zIndex: layer.track + 1 } : undefined;
}

/** Layers that draw at `time` and change pixels, in application order. */
export function visibleAdjustmentLayers(
	project: Project,
	time: number
): AdjustmentLayer[] {
	return activeAdjustmentLayers(project, time).filter(adjustmentLayerHasEffect);
}

/**
 * A server-rendered frame for approximate layers while paused. Returns the
 * data URL once it matches the current project revision and time. Requests
 * are debounced (`SERVER_FRAME_DELAY_MS`) and keyed by project, revision and
 * time, so a scrub or an edit drops a stale frame. Also used for blend modes
 * the browser cannot match (`PreviewExactBlendFrame`).
 */
export function useServerFrame(
	project: Project,
	time: number,
	enabled: boolean
): string | null {
	const runtime = useContext(EditorContext);
	const api = useRef(runtime?.api);
	api.current = runtime?.api;
	const active =
		enabled && runtime !== null && !runtime.playing && !runtime.dirty;
	const key = `${project.id}:${project.revision}:${time.toFixed(3)}`;
	const [frame, setFrame] = useState<{ key: string; src: string } | null>(null);
	useEffect(() => {
		const request = api.current;
		if (!(active && request)) {
			return;
		}
		let cancelled = false;
		const [projectId, , at] = key.split(":");
		const timer = setTimeout(async () => {
			try {
				const parsed = frameSchema.parse(
					await request(`/projects/${projectId}/inspect-frame?time=${at}`)
				);
				if (!cancelled) {
					setFrame({ key, src: `data:image/png;base64,${parsed.data}` });
				}
			} catch {
				// The CSS approximation stays on screen when the frame fails.
				if (!cancelled) {
					setFrame(null);
				}
			}
		}, SERVER_FRAME_DELAY_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [active, key]);
	return active && frame?.key === key ? frame.src : null;
}

export function PreviewAdjustmentLayer({
	project,
	time,
}: {
	project: Project;
	time: number;
}) {
	const layers = visibleAdjustmentLayers(project, time);
	const approximate = layers.some(adjustmentPreviewApproximate);
	const serverFrame = useServerFrame(project, time, approximate);
	if (layers.length === 0) {
		return null;
	}
	if (serverFrame) {
		return (
			<img
				alt=""
				className="pointer-events-none absolute inset-0 size-full object-fill"
				data-testid="adjustment-server-frame"
				height={project.height}
				src={serverFrame}
				style={{ zIndex: SERVER_FRAME_Z_INDEX }}
				width={project.width}
			/>
		);
	}
	const frame = { height: project.height, width: project.width };
	return (
		<>
			{layers.map((layer) => {
				const strokes = adjustmentStrokeStyle(layer, time, frame);
				return (
					<Fragment key={layer.id}>
						<div
							aria-hidden
							className="pointer-events-none absolute inset-0"
							data-adjustment-layer={layer.id}
							data-approximate={
								adjustmentPreviewApproximate(layer) ? "true" : undefined
							}
							style={adjustmentLayerStyle(layer, time, frame)}
						/>
						{strokes && (
							<div
								aria-hidden
								className="pointer-events-none absolute inset-0"
								data-adjustment-mask-strokes={layer.id}
								style={strokes}
							/>
						)}
					</Fragment>
				);
			})}
		</>
	);
}
