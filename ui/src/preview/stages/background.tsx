/**
 * Preview stage: canvas and clip backgrounds (W2-V8). Mirrors
 * `sidecar/src/render-stages/background.ts`.
 *
 * - The canvas draws an explicit color or gradient with CSS, or a library
 *   image/video covering the frame. With no explicit background (or a blur
 *   fill, which draws under clips) it renders nothing and the frame's CSS
 *   style color shows, as before.
 * - A clip background draws under its clip while the clip is active, at the
 *   clip's z-index, with the clip's opacity, fades and reveal (like the
 *   render, which gives the fill the clip's alpha chain). Color and gradient
 *   use CSS; a blur fill is a second, blurred and dimmed copy of the clip's
 *   media covering the frame (the export extends the clip's edges instead,
 *   so the two look alike but not identical). Waveform clips get none.
 * - A canvas video follows the playhead, looped, and plays with the editor.
 */
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import {
	type CSSProperties,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	blurFillCss,
	cssBackgroundOf,
	loopedMediaTime,
	renderableClipBackground,
} from "../../../../shared/background.ts";
import {
	type Asset,
	animatedValue,
	type Project,
	type Segment,
} from "../../../../shared/project.ts";
import { mediaBlob } from "../../bridge.ts";
import { EditorContext } from "../../editor/context.tsx";
import { clipBackgroundBlendStyle } from "./blend.ts";
import {
	entryTransitionState,
	fadeFactor,
	revealStyle,
} from "./transitions.ts";

const layerClass = "pointer-events-none absolute inset-0 h-full w-full";

/** Where the clip's source should be at `time` on the timeline. */
export function backgroundSourceTime(segment: Segment, time: number): number {
	return Math.min(
		segment.sourceOut,
		segment.sourceIn + Math.max(0, time - segment.start) * segment.speed
	);
}

/**
 * The clip's opacity, fade, entry and reveal at `elapsed` seconds into it,
 * applied to its fill so the fill fades, dissolves and wipes with the clip.
 * `filter` is the fill's own filter, joined with a fade-through tint.
 */
export function clipFillStyle(
	segment: Segment,
	elapsed: number,
	aspect: number,
	filter?: string
): CSSProperties {
	const opacity =
		animatedValue(segment, "opacity", elapsed) *
		Math.max(0, fadeFactor(segment, elapsed)) *
		entryTransitionState(segment, elapsed).opacity;
	const reveal = revealStyle(segment, elapsed, aspect);
	const filters = [filter, reveal.filter].filter(Boolean).join(" ");
	return {
		...reveal,
		filter: filters || undefined,
		opacity: Math.min(1, Math.max(0, opacity)),
	};
}

/** Library assets and preview URLs, when an editor is mounted. */
function useEditorMedia(): {
	assets: readonly Asset[];
	playing: boolean;
	sources: Record<string, string>;
} {
	const runtime = useContext(EditorContext);
	return {
		assets: runtime?.assets ?? [],
		playing: runtime?.playing ?? false,
		sources: runtime?.previewSources.snapshot?.() ?? {},
	};
}

/**
 * Object URL of a background image's media. Reuses the clip preview source
 * when the asset is also on the timeline, otherwise reads it once.
 */
function useBackgroundMediaUrl(asset: Asset | undefined, shared?: string) {
	const [loaded, setLoaded] = useState<{ id: string; url: string } | null>(
		null
	);
	const assetId = asset?.id;
	const kind = asset?.kind;
	useEffect(() => {
		if (!(assetId && kind) || shared) {
			return;
		}
		const controller = new AbortController();
		let url: string | undefined;
		mediaBlob(
			`/assets/${assetId}/data`,
			kind === "image" ? "image/png" : "video/mp4",
			controller.signal
		)
			.then((blob) => {
				if (controller.signal.aborted) {
					return;
				}
				url = URL.createObjectURL(blob);
				setLoaded({ id: assetId, url });
			})
			.catch(() => {
				// The canvas keeps its style color when the media cannot load.
			});
		return () => {
			controller.abort();
			if (url) {
				URL.revokeObjectURL(url);
			}
		};
	}, [assetId, kind, shared]);
	if (shared) {
		return shared;
	}
	return loaded && loaded.id === assetId ? loaded.url : undefined;
}

function CanvasMedia({
	asset,
	shared,
	time,
}: {
	asset: Asset;
	shared: string | undefined;
	time: number;
}) {
	const { playing } = useEditorMedia();
	const video = useRef<HTMLVideoElement>(null);
	const url = safeMediaUrl(useBackgroundMediaUrl(asset, shared) ?? "");
	useEffect(() => {
		const element = video.current;
		if (!(element && url)) {
			return;
		}
		const duration = Number.isFinite(element.duration)
			? element.duration
			: asset.duration;
		const desired = loopedMediaTime(time, duration);
		if (Math.abs(element.currentTime - desired) > (playing ? 0.3 : 0.04)) {
			element.currentTime = desired;
		}
		if (playing) {
			element.play().catch(() => {
				// The canvas stays on its last frame when autoplay is refused.
			});
		} else {
			element.pause();
		}
	}, [asset.duration, playing, time, url]);
	if (!url) {
		return null;
	}
	return asset.kind === "image" ? (
		<img
			alt=""
			aria-hidden="true"
			className={`${layerClass} object-cover`}
			data-testid="preview-canvas-background"
			height={1}
			src={url}
			width={1}
		/>
	) : (
		<video
			className={`${layerClass} object-cover`}
			data-testid="preview-canvas-background"
			loop
			muted
			playsInline
			ref={video}
			src={url}
		/>
	);
}

export function PreviewCanvasBackground({
	project,
	time,
}: {
	project: Project;
	time: number;
}) {
	const { assets, sources } = useEditorMedia();
	const background = project.background;
	if (!background || background.type === "blur") {
		return null;
	}
	if (background.type === "image") {
		const asset = assets.find((item) => item.id === background.assetId);
		return asset && asset.kind !== "audio" ? (
			<CanvasMedia asset={asset} shared={sources[asset.id]} time={time} />
		) : null;
	}
	return (
		<div
			aria-hidden="true"
			className={layerClass}
			data-testid="preview-canvas-background"
			style={{ background: cssBackgroundOf(background) }}
		/>
	);
}

function BlurFill({
	asset,
	fill,
	playing,
	segment,
	src,
	time,
	zIndex,
}: {
	asset: Asset;
	fill: CSSProperties;
	playing: boolean;
	segment: Segment;
	src: string;
	time: number;
	zIndex: number;
}) {
	const video = useRef<HTMLVideoElement>(null);
	useEffect(() => {
		const element = video.current;
		if (!element) {
			return;
		}
		const desired = backgroundSourceTime(segment, time);
		if (Math.abs(element.currentTime - desired) > (playing ? 0.3 : 0.04)) {
			element.currentTime = desired;
		}
		element.playbackRate = segment.speed;
		if (playing) {
			element.play().catch(() => {
				// The fill stays on its last frame when autoplay is refused.
			});
		} else {
			element.pause();
		}
	}, [playing, segment, time]);
	// A blended clip's fill blends with the tracks below as the clip does.
	const style: CSSProperties = {
		...fill,
		...clipBackgroundBlendStyle(segment),
		zIndex,
	};
	return asset.kind === "image" ? (
		<img
			alt=""
			aria-hidden="true"
			className={`${layerClass} object-cover`}
			data-testid="preview-clip-background"
			height={1}
			src={src}
			style={style}
			width={1}
		/>
	) : (
		<video
			className={`${layerClass} object-cover`}
			data-testid="preview-clip-background"
			muted
			playsInline
			ref={video}
			src={src}
			style={style}
		/>
	);
}

/**
 * A clip's image background: the picture (a video's first frame) covering
 * the clip's box under the clip, like the render's cover-scaled fill.
 */
function ClipImageFill({
	asset,
	shared,
	style,
}: {
	asset: Asset;
	shared: string | undefined;
	style: CSSProperties;
}) {
	const url = safeMediaUrl(useBackgroundMediaUrl(asset, shared) ?? "");
	if (!url) {
		return null;
	}
	return asset.kind === "image" ? (
		<img
			alt=""
			aria-hidden="true"
			className={`${layerClass} object-cover`}
			data-testid="preview-clip-background"
			height={1}
			src={url}
			style={style}
			width={1}
		/>
	) : (
		<video
			className={`${layerClass} object-cover`}
			data-testid="preview-clip-background"
			muted
			playsInline
			preload="metadata"
			src={url}
			style={style}
		/>
	);
}

export function PreviewClipBackground({
	active,
	project,
	segment,
	time,
}: {
	active: boolean;
	project: Project;
	segment: Segment;
	time: number;
}) {
	const { assets, playing, sources } = useEditorMedia();
	const asset = assets.find((item) => item.id === segment.assetId);
	const background = renderableClipBackground(project, segment, asset?.kind);
	if (!(active && background)) {
		return null;
	}
	const zIndex = segment.track + 1;
	const elapsed = time - segment.start;
	const aspect = project.width / project.height;
	if (background.type === "image") {
		const picture = assets.find((item) => item.id === background.assetId);
		return picture && picture.kind !== "audio" ? (
			<ClipImageFill
				asset={picture}
				shared={sources[picture.id]}
				style={{
					...clipFillStyle(segment, elapsed, aspect),
					...clipBackgroundBlendStyle(segment),
					zIndex,
				}}
			/>
		) : null;
	}
	if (background.type !== "blur") {
		return (
			<div
				aria-hidden="true"
				className={layerClass}
				data-testid="preview-clip-background"
				style={{
					...clipFillStyle(segment, elapsed, aspect),
					...clipBackgroundBlendStyle(segment),
					background: cssBackgroundOf(background),
					zIndex,
				}}
			/>
		);
	}
	const src = safeMediaUrl(sources[segment.assetId] ?? "");
	if (!(asset && src) || asset.kind === "audio") {
		return null;
	}
	return (
		<BlurFill
			asset={asset}
			fill={clipFillStyle(
				segment,
				elapsed,
				aspect,
				blurFillCss(background, project.width)
			)}
			playing={playing}
			segment={segment}
			src={src}
			time={time}
			zIndex={zIndex}
		/>
	);
}
