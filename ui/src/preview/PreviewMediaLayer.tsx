import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import {
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import {
	type Asset,
	animatedValue,
	type Project,
	type Segment,
} from "../../../shared/project.ts";
import { clipSourceOffset } from "../../../shared/speed-curve.ts";
import {
	connectPreviewAudio,
	type PreviewAudioGraph,
	resumePreviewAudio,
} from "../audio-preview/graph.ts";
import { scrubPreviewAudio } from "../audio-preview/scrub.ts";
import {
	previewClipGraphGain,
	previewClipMixGain,
	previewTempo,
	previewTrackPan,
} from "../audio-preview/tempo.ts";
import { usePreviewLut } from "../color/lut-client.ts";
import { EditorContext } from "../editor/context.tsx";
import { previewMediaSync } from "../editor/playback-clock.ts";
import type { PreviewQuality } from "../editor/store.ts";
import { Waveform } from "../Waveform.tsx";
import { PreviewMediaRegistryContext } from "./compositor/media-registry.ts";
import { GlLayer } from "./gl/GlLayer.tsx";
import { hasGradePass } from "./gl/passes/grade.ts";
import { segmentGlPasses } from "./gl/segment-passes.ts";
import {
	maskStrokeLayerStyle,
	mediaLayerStyle,
	type PreviewStyle,
} from "./preview-style.ts";
import { PreviewClipBackground } from "./stages/background.tsx";
import { vignetteAmount } from "./stages/effects.ts";
import { fadeFactor, revealStyle } from "./stages/transitions.ts";
import { segmentActiveAt } from "./stages/visibility.ts";

/** Where the clip's source should be at `time` on the timeline. */
function sourceTimeAt(segment: Segment, time: number): number {
	return Math.min(
		segment.sourceOut,
		segment.sourceIn +
			clipSourceOffset(segment, Math.max(0, time - segment.start))
	);
}

const noSubscription = () => () => undefined;

/**
 * The viewer's transport rate (J/L shuttle, the playback-rate menu) and
 * preview quality from the editor store; 1x and full outside an editor.
 */
export function usePreviewTransport(): {
	quality: PreviewQuality;
	rate: number;
} {
	const store = useContext(EditorContext)?.store;
	const rate = useSyncExternalStore(
		store?.subscribe ?? noSubscription,
		() => store?.getState().playbackRate ?? 1,
		() => 1
	);
	const quality = useSyncExternalStore(
		store?.subscribe ?? noSubscription,
		() => store?.getState().previewQuality ?? "full",
		() => "full" as const
	);
	return { quality, rate };
}

/**
 * One timeline clip in the preview: the `<video>`/`<img>` element, its audio
 * graph, an optional WebGL pass layer and the vignette overlay. While a
 * shaped reveal or fade-through plays, the clip draws inside a full-frame
 * reveal layer (the reveal is a frame-space shape, like the render's).
 */
export function PreviewMediaLayer({
	asset,
	segment: s,
	src,
	time,
	playing,
	fps,
	audible,
	onError,
	project,
}: {
	asset: Asset;
	audible: boolean;
	segment: Segment;
	src: string;
	time: number;
	playing: boolean;
	fps: number;
	onError?: (message: string) => void;
	project: Project;
}) {
	const safeSrc = safeMediaUrl(src);
	const media = useRef<HTMLVideoElement>(null);
	const image = useRef<HTMLImageElement>(null);
	const audioGraph = useRef<PreviewAudioGraph | null>(null);
	const [glUnavailable, setGlUnavailable] = useState(false);
	const transport = usePreviewTransport();
	// The blend compositor samples this clip's element (`PreviewBlendCompositor`).
	const registry = useContext(PreviewMediaRegistryContext);
	useEffect(() => {
		const element = asset.kind === "image" ? image.current : media.current;
		if (!(registry && element) || asset.kind === "audio") {
			return;
		}
		return registry.register(s.id, element);
	}, [registry, s.id, asset.kind]);
	// Load the clip's LUT for the grade pass; re-renders once it arrives.
	usePreviewLut(asset.kind === "audio" ? undefined : s.colorGrade.lut?.lutId);
	useEffect(() => {
		const element = media.current;
		if (!(element && asset.hasAudio)) {
			return;
		}
		try {
			audioGraph.current = connectPreviewAudio(
				element,
				s.audioProcessing ?? "none"
			);
		} catch {
			onError?.("Audio preview could not be initialized.");
		}
		return () => {
			element.pause();
			audioGraph.current?.dispose();
			audioGraph.current = null;
		};
	}, [asset.hasAudio, onError, playing, s.audioProcessing]);

	const active = segmentActiveAt(s, time);
	useEffect(() => {
		const el = media.current;
		if (!el) {
			return;
		}
		const desired = sourceTimeAt(s, time);
		const tempo = previewTempo(s, time - s.start);
		// The element plays at the clip tempo times the transport rate, and
		// fast shuttling tolerates more drift before it re-seeks.
		const sync = previewMediaSync(tempo.playbackRate, transport.rate);
		if (
			Math.abs(el.currentTime - desired) >
			(playing ? sync.driftTolerance : 1 / (fps * 2))
		) {
			el.currentTime = desired;
		}
		el.playbackRate = sync.playbackRate;
		if (tempo.preservesPitch !== undefined) {
			el.preservesPitch = tempo.preservesPitch;
		}
		const elapsed = time - s.start;
		const fade = Math.max(0, fadeFactor(s, elapsed));
		// Clip mute (or the default mute above 16x) and the track mixer gain
		// apply in the preview as they do in the export.
		// Through the audio graph the track balance is a per-channel stage,
		// so the clip gain carries only the track's dB gain.
		const graph = audioGraph.current;
		const mix = graph
			? previewClipGraphGain(project, s)
			: previewClipMixGain(project, s);
		const volume =
			active && audible ? animatedValue(s, "volume", elapsed) * fade * mix : 0;
		if (graph) {
			el.volume = 1;
			graph.gain.gain.value = volume;
			graph.update(s, previewTrackPan(project, s.track));
		} else {
			el.volume = Math.min(1, volume);
		}
		if (playing && active) {
			void resumePreviewAudio()
				.then(() => el.play())
				.catch(() =>
					onError?.("Playback could not start. Press Play to try again.")
				);
		} else {
			el.pause();
			scrubPreviewAudio(el, desired, {
				active,
				assetId: asset.id,
				audible,
				volume,
			});
		}
	}, [
		time,
		s,
		playing,
		active,
		audible,
		fps,
		onError,
		project,
		asset.id,
		transport.rate,
	]);
	const handleGlUnavailable = useCallback(
		(message: string) => {
			setGlUnavailable(true);
			onError?.(message);
		},
		[onError]
	);
	const elapsed = time - s.start;
	const vignette = vignetteAmount(s, elapsed);
	const vignetteStyle: PreviewStyle = {
		"--studio-vignette-opacity": `${vignette}`,
		"--studio-vignette-z-index": `${s.track + 2}`,
	};
	const vignetteOverlay =
		active && vignette > 0 ? (
			<div
				aria-hidden="true"
				className="studio-media-layer studio-vignette-overlay"
				style={vignetteStyle}
			/>
		) : null;
	const glPasses =
		glUnavailable || asset.kind === "audio" ? [] : segmentGlPasses(s, elapsed);
	const glActive = glPasses.length > 0;
	const mediaSize = {
		canvas: { height: project.height, width: project.width },
		media: { height: asset.height ?? 0, width: asset.width ?? 0 },
	};
	const mediaStyle = mediaLayerStyle(s, elapsed, {
		active,
		basicColorInGl: hasGradePass(glPasses),
		media: mediaSize,
	});
	// A shaped reveal or fade-through clips the whole frame; the layer then
	// carries the clip's blend mode so it still blends with the tracks below.
	const reveal = active
		? revealStyle(s, elapsed, project.width / project.height)
		: {};
	const revealing = Object.keys(reveal).length > 0;
	const { mixBlendMode, ...unblended } = mediaStyle;
	const layerStyle: PreviewStyle = revealing ? unblended : mediaStyle;
	// Mask outline strokes draw over the masked clip, sharing its placement.
	const strokeStyle =
		active && asset.kind !== "audio"
			? maskStrokeLayerStyle(s, elapsed, layerStyle, mediaSize)
			: undefined;
	const maskStrokes = strokeStyle ? (
		<div
			aria-hidden="true"
			className="studio-media-layer"
			data-testid="preview-mask-strokes"
			style={strokeStyle}
		/>
	) : null;
	const wrap = (content: ReactNode) =>
		revealing ? (
			<div
				className="studio-reveal-layer"
				data-testid="preview-reveal-layer"
				style={{ ...reveal, mixBlendMode, zIndex: s.track + 1 }}
			>
				{content}
			</div>
		) : (
			content
		);
	const background = (
		<PreviewClipBackground
			active={active}
			project={project}
			segment={s}
			time={time}
		/>
	);

	if (asset.kind === "image") {
		const imageStyle: PreviewStyle = glActive
			? { ...layerStyle, "--studio-media-visibility": "hidden" }
			: layerStyle;
		return (
			<>
				{background}
				{wrap(
					<>
						<img
							alt={asset.name}
							className="studio-media-layer"
							ref={image}
							src={safeSrc ?? undefined}
							style={imageStyle}
						/>
						<GlLayer
							className="studio-media-layer"
							label={asset.name}
							onUnavailable={handleGlUnavailable}
							passes={glPasses}
							playing={playing}
							quality={transport.quality}
							source={image}
							style={layerStyle}
							time={elapsed}
						/>
						{maskStrokes}
					</>
				)}
				{vignetteOverlay}
			</>
		);
	}
	const videoStyle: PreviewStyle = {
		...layerStyle,
		"--studio-media-visibility":
			asset.kind === "audio" || glActive ? "hidden" : "visible",
	};
	return (
		<>
			{background}
			{wrap(
				<>
					<video
						aria-label={asset.name}
						className="studio-media-layer"
						onError={() => onError?.("This source could not be previewed.")}
						onLoadedMetadata={() => {
							const element = media.current;
							if (element) {
								element.currentTime = sourceTimeAt(s, time);
							}
						}}
						playsInline
						preload="auto"
						ref={media}
						src={safeSrc ?? undefined}
						style={videoStyle}
					/>
					<GlLayer
						className="studio-media-layer"
						label={asset.name}
						onUnavailable={handleGlUnavailable}
						passes={glPasses}
						playing={playing}
						quality={transport.quality}
						source={media}
						style={layerStyle}
						time={elapsed}
					/>
					{maskStrokes}
					{asset.kind === "audio" &&
						s.visualization === "waveform" &&
						active && (
							<div className="studio-media-layer" style={layerStyle}>
								<Waveform
									assetId={asset.id}
									color={s.waveformColor}
									fps={fps}
									height={s.waveformHeight}
									sourceIn={s.sourceIn}
									sourceOut={s.sourceOut}
									speed={s.speed}
									time={time - s.start}
								/>
							</div>
						)}
				</>
			)}
			{vignetteOverlay}
		</>
	);
}
