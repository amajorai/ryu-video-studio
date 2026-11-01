import { RyuAppActions } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { useEffect, useRef, useState } from "react";
import type { Asset } from "../../../shared/project.ts";
import { mediaBlob } from "../bridge.ts";
import { dropAssetOnTimeline } from "../editor/actions/placement.ts";
import { useEditor } from "../editor/context.tsx";
import { clock, message } from "../editor/format.ts";
import { nextShuttleRate } from "../editor/playback-clock.ts";
import { useEditorStore } from "../editor/store.ts";
import {
	addLibraryAsset,
	libraryTrackFor,
} from "../library/add-to-timeline.ts";
import { assetDragProps } from "../library/drag-source.ts";
import {
	canMarkSource,
	markedRange,
	markSourceIn,
	markSourceOut,
	type SourceMarks,
} from "../library/source-marks.ts";
import { previewMimeType } from "../preview-sources.ts";
import {
	registerSourceTransport,
	type SourceTransport,
	setSourceMarks,
} from "./source-tabs.ts";

/** Loads an asset's stored media as a blob (tests pass a fake). */
export type SourceMediaLoader = (
	asset: Asset,
	signal: AbortSignal
) => Promise<Blob>;

export const loadSourceMedia: SourceMediaLoader = (asset, signal) =>
	mediaBlob(
		`/assets/${asset.id}/data`,
		previewMimeType(asset, () => undefined),
		signal
	);

const NO_MARKS: SourceMarks = {};

/** The asset's media as an object URL while mounted, plus load state. */
function useSourceUrl(asset: Asset, load: SourceMediaLoader) {
	const [state, setState] = useState<{
		error: string | null;
		url: string | null;
	}>({ error: null, url: null });
	useEffect(() => {
		const controller = new AbortController();
		let url: string | null = null;
		setState({ error: null, url: null });
		load(asset, controller.signal)
			.then((blob) => {
				if (controller.signal.aborted) {
					return;
				}
				url = URL.createObjectURL(blob);
				setState({ error: null, url });
			})
			.catch((error: unknown) => {
				if (!controller.signal.aborted) {
					setState({ error: message(error), url: null });
				}
			});
		return () => {
			controller.abort();
			if (url) {
				URL.revokeObjectURL(url);
			}
		};
	}, [asset, load]);
	return state;
}

/**
 * Source monitor for one library asset in a preview tab: real-time playback
 * with audio, J/K/L shuttle (reverse included), and I/O marks shared with
 * the library tile, so the marked range feeds dragging, Add, and Insert.
 */
export function SourceMonitor({
	asset,
	load = loadSourceMedia,
}: {
	asset: Asset;
	load?: SourceMediaLoader;
}) {
	const tl = useLiteralMessages();
	const runtime = useEditor();
	const { store } = runtime;
	const marks =
		useEditorStore(store, (state) => state.sourceMarks[asset.id]) ?? NO_MARKS;
	const { error, url } = useSourceUrl(asset, load);
	const src = url ? safeMediaUrl(url) : null;
	const media = useRef<HTMLMediaElement | null>(null);
	const [time, setTime] = useState(0);
	const [playing, setPlaying] = useState(false);
	/** Signed shuttle rate: negative plays in reverse. */
	const [rate, setRate] = useState(1);
	const markable = canMarkSource(asset);
	const range = markedRange(marks, asset);
	const duration = asset.duration;

	const currentTime = () => media.current?.currentTime ?? time;
	const seek = (next: number) => {
		const clamped = Math.min(Math.max(0, next), duration);
		if (media.current) {
			media.current.currentTime = clamped;
		}
		setTime(clamped);
	};
	const start = (nextRate: number) => {
		const element = media.current;
		setRate(nextRate);
		setPlaying(true);
		if (!element) {
			return;
		}
		if (nextRate > 0) {
			if (element.ended || element.currentTime >= duration) {
				element.currentTime = 0;
			}
			element.playbackRate = nextRate;
			element.play()?.catch(() => {
				setPlaying(false);
				runtime.setStatus("Source playback is unavailable.");
			});
		} else {
			// Reverse is stepped by the frame loop below.
			element.pause();
		}
	};
	const pause = () => {
		media.current?.pause();
		setPlaying(false);
		setRate(1);
	};
	const toggle = () => (playing ? pause() : start(1));
	const shuttle = (direction: -1 | 1) => {
		const accelerate = playing && Math.sign(rate) === direction;
		start(direction * nextShuttleRate(Math.abs(rate), accelerate));
	};
	const changeMarks = (next: SourceMarks) =>
		setSourceMarks(store, asset.id, next);
	const markIn = () => {
		if (markable) {
			changeMarks(markSourceIn(marks, currentTime(), asset));
		}
	};
	const markOut = () => {
		if (markable) {
			changeMarks(markSourceOut(marks, currentTime(), asset));
		}
	};

	// The registered transport reads the latest closures through this ref.
	const latest = useRef<SourceTransport>({
		markIn,
		markOut,
		pause,
		shuttle,
		toggle,
	});
	latest.current = { markIn, markOut, pause, shuttle, toggle };
	useEffect(
		() =>
			registerSourceTransport(store, {
				markIn: () => latest.current.markIn(),
				markOut: () => latest.current.markOut(),
				pause: () => latest.current.pause(),
				shuttle: (direction) => latest.current.shuttle(direction),
				toggle: () => latest.current.toggle(),
			}),
		[store]
	);

	// Reverse shuttle: step the element backwards each animation frame.
	useEffect(() => {
		if (!(playing && rate < 0)) {
			return;
		}
		let frame = 0;
		let last = performance.now();
		const step = (now: number) => {
			const element = media.current;
			const next = Math.max(
				0,
				(element?.currentTime ?? 0) + ((now - last) / 1000) * rate
			);
			last = now;
			if (element) {
				element.currentTime = next;
			}
			setTime(next);
			if (next <= 0) {
				setPlaying(false);
				setRate(1);
				return;
			}
			frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
		return () => cancelAnimationFrame(frame);
	}, [playing, rate]);

	const mediaProps = {
		"aria-label": `Source media: ${asset.name}`,
		onEnded: () => {
			setPlaying(false);
			setRate(1);
		},
		onTimeUpdate: (event: { currentTarget: HTMLMediaElement }) =>
			setTime(event.currentTarget.currentTime),
		ref: (element: HTMLMediaElement | null) => {
			media.current = element;
		},
		src: src ?? undefined,
	};
	const insertAtPlayhead = () =>
		dropAssetOnTimeline(runtime, asset, {
			at: runtime.time,
			mode: "insert",
			sourceIn: range?.start,
			sourceOut: range?.end,
			track: libraryTrackFor(asset),
		});

	return (
		<section
			aria-label={tl("Source: {name}", { name: asset.name })}
			className="studio-source-monitor"
			data-source-asset={asset.id}
			data-source-playing={playing || undefined}
		>
			<div className="studio-source-frame">
				{error ? (
					<p className="studio-preview-empty" role="alert">
						{tl("Could not load {name}: {error}", { error, name: asset.name })}
					</p>
				) : src ? (
					asset.kind === "image" ? (
						<img
							alt={asset.name}
							height={asset.height || undefined}
							src={src}
							width={asset.width || undefined}
						/>
					) : asset.kind === "audio" ? (
						<>
							{/* biome-ignore lint/a11y/useMediaCaption: user media in a source monitor has no caption track. */}
							<audio {...mediaProps} preload="auto" />
							<p className="studio-preview-empty">{asset.name}</p>
						</>
					) : (
						// biome-ignore lint/a11y/useMediaCaption: user media in a source monitor has no caption track.
						<video {...mediaProps} playsInline preload="auto" />
					)
				) : (
					<p className="studio-preview-empty">Loading source…</p>
				)}
			</div>
			{asset.kind === "image" ? null : (
				<>
					<input
						aria-label="Source position"
						className="w-full"
						max={duration}
						min={0}
						onChange={(event) => seek(Number(event.target.value))}
						step={0.01}
						type="range"
						value={time}
					/>
					<div className="studio-playback">
						<Button
							aria-label="Play source in reverse (J)"
							disabled={!src}
							onClick={() => shuttle(-1)}
							size="sm"
							variant="ghost"
						>
							J
						</Button>
						<Button
							aria-label={playing ? "Pause source" : "Play source"}
							disabled={!src}
							onClick={toggle}
							variant="ghost"
						>
							{playing ? "Pause" : "Play"}
						</Button>
						<Button
							aria-label="Play source forward (L)"
							disabled={!src}
							onClick={() => shuttle(1)}
							size="sm"
							variant="ghost"
						>
							L
						</Button>
						<span className="font-mono" data-source-time={time.toFixed(3)}>
							{clock(time)} / {clock(duration)}
						</span>
						{playing && rate !== 1 ? (
							<span className="font-mono text-muted-foreground">
								{rate < 0 ? "−" : ""}
								{Math.abs(rate)}×
							</span>
						) : null}
					</div>
				</>
			)}
			<RyuAppActions>
				{markable ? (
					<>
						<Button onClick={markIn} size="sm" variant="outline">
							Mark in (I)
						</Button>
						<Button onClick={markOut} size="sm" variant="outline">
							Mark out (O)
						</Button>
						<Button
							disabled={marks.in === undefined && marks.out === undefined}
							onClick={() => changeMarks({})}
							size="sm"
							variant="ghost"
						>
							Clear marks
						</Button>
					</>
				) : null}
				<Button
					aria-label={tl("Add {name} to timeline", { name: asset.name })}
					onClick={() => addLibraryAsset(runtime, asset, range)}
					size="sm"
					variant="outline"
				>
					Add to timeline
				</Button>
				<Button
					aria-label={tl("Insert {name} at playhead", { name: asset.name })}
					disabled={!runtime.project}
					onClick={insertAtPlayhead}
					size="sm"
					variant="outline"
				>
					Insert at playhead
				</Button>
				<span
					className="cursor-grab rounded-md border border-dashed px-2 py-1 text-xs"
					data-source-drag=""
					{...assetDragProps(asset, range)}
				>
					Drag to timeline
				</span>
			</RyuAppActions>
			{range ? (
				<small data-source-range="">
					{tl("Marked {start}–{end}", {
						end: clock(range.end),
						start: clock(range.start),
					})}
				</small>
			) : null}
		</section>
	);
}
