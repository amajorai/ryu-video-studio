import { useLiteralMessages } from "@ryu/i18n/react";
import {
	useContext,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import type { Asset } from "../../../../shared/project.ts";
import { EditorContext } from "../../editor/context.tsx";
import {
	createEditorStore,
	type DragState,
	useEditorStore,
} from "../../editor/store.ts";
import {
	type FilmstripPlan,
	type FilmstripSprite,
	filmstripKey,
	filmstripPath,
	loadFilmstrip,
} from "../../timeline/clip-visual-cache.ts";
import { formatTimecode } from "../../timeline/timecode.ts";
import {
	type TrimFeedbackFrame,
	type TrimFeedbackFrames,
	trimFeedbackFrames,
	trimFeedbackStoreFor,
	trimFramePlan,
	trimFrameTile,
} from "../../timeline/trim-feedback.ts";
import type { PreviewOverlayProps } from "./overlay-props.ts";

/** Frames are requested only after the proposal holds still this long. */
export const TRIM_FRAME_DEBOUNCE_MS = 60;

const FEEDBACK_KINDS = new Set<DragState["kind"]>(["slip", "roll", "ripple"]);
const detachedEditorStore = createEditorStore();
const noAssets: readonly Asset[] = [];

const MODE_LABELS: Record<TrimFeedbackFrames["mode"], string> = {
	ripple: "Ripple trim",
	roll: "Roll edit",
	slip: "Slip",
};

/** `value`, held back until it has been stable for `delay` ms. */
function useDebounced<Value>(value: Value, key: string, delay: number): Value {
	const [settled, setSettled] = useState({ key, value });
	useEffect(() => {
		if (settled.key === key) {
			return;
		}
		const timer = setTimeout(() => setSettled({ key, value }), delay);
		return () => clearTimeout(timer);
	}, [delay, key, settled.key, value]);
	return settled.value;
}

type FrameLoader = (plan: FilmstripPlan) => Promise<FilmstripSprite>;

interface FrameRequest {
	frame: TrimFeedbackFrame;
	plan: FilmstripPlan | null;
}

/** A frame picture that finished loading, with the request it answers. */
interface LoadedFrame {
	plan: FilmstripPlan;
	sprite: FilmstripSprite;
	time: number;
}

/**
 * One tile of a filmstrip sprite (`trimFrameTile`), cropped out of the row:
 * the sprite is scaled so a tile fills the box and shifted left past the
 * tiles before it.
 */
function SpriteTile({
	alt,
	plan,
	sprite,
	time,
}: {
	alt: string;
	plan: FilmstripPlan;
	sprite: FilmstripSprite;
	time: number;
}) {
	const tiles = Math.max(1, sprite.count);
	const tile = Math.min(trimFrameTile(plan), tiles - 1);
	return (
		<div
			className="relative h-full max-w-full overflow-hidden"
			data-testid="slip-two-up-tile"
			style={{
				aspectRatio: `${sprite.frameWidth} / ${sprite.frameHeight}`,
			}}
		>
			<img
				alt={alt}
				className="absolute top-0 h-full max-w-none"
				data-request={filmstripPath(plan)}
				data-tile={tile}
				data-time={time}
				height={sprite.frameHeight}
				src={sprite.url}
				style={{ left: `${-tile * 100}%`, width: `${tiles * 100}%` }}
				width={sprite.frameWidth * tiles}
			/>
		</div>
	);
}

function TrimFrame({
	fps,
	loaded,
	request,
}: {
	fps: number;
	loaded: LoadedFrame | undefined;
	request: FrameRequest;
}) {
	const tl = useLiteralMessages();
	const { frame, plan } = request;
	const timecode = formatTimecode(frame.time, fps);
	const shown = plan ? loaded : undefined;
	return (
		<figure
			className="flex min-w-0 flex-1 flex-col gap-1"
			data-role={frame.role}
			data-testid="slip-two-up-frame"
		>
			<div className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-sm bg-black">
				{shown ? (
					<SpriteTile
						alt={tl("{label} at source {timecode}", {
							label: frame.label,
							timecode: formatTimecode(shown.time, fps),
						})}
						plan={shown.plan}
						sprite={shown.sprite}
						time={shown.time}
					/>
				) : (
					<span className="px-2 text-center text-muted-foreground text-xs">
						{plan ? "Loading frame…" : "No picture"}
					</span>
				)}
			</div>
			<figcaption className="flex justify-between gap-2 text-xs">
				<span className="font-medium">{frame.label}</span>
				<span className="font-mono text-muted-foreground">{timecode}</span>
			</figcaption>
		</figure>
	);
}

/**
 * Two source frames side by side. Frame requests wait until the frames have
 * been stable for `debounceMs`, then load through the shared filmstrip cache
 * (`GET /assets/:id/filmstrip`, whose last tile is the frame); a frame keeps
 * its last picture until the new one arrives, and the caption always shows
 * the live proposed time.
 */
export function TrimFeedbackViewer({
	assets,
	debounceMs = TRIM_FRAME_DEBOUNCE_MS,
	feedback,
	fps,
	load = loadFilmstrip,
}: {
	assets: readonly Asset[];
	debounceMs?: number;
	feedback: TrimFeedbackFrames;
	fps: number;
	load?: FrameLoader;
}) {
	const tl = useLiteralMessages();
	const requests = useMemo<FrameRequest[]>(
		() =>
			feedback.frames.map((frame) => ({
				frame,
				plan: trimFramePlan(
					frame,
					assets.find((asset) => asset.id === frame.assetId)
				),
			})),
		[assets, feedback]
	);
	const requestKey = requests
		.map(({ frame, plan }) =>
			plan ? filmstripKey(plan) : `${frame.assetId}|none`
		)
		.join(";");
	const settled = useDebounced(requests, requestKey, debounceMs);
	const [loaded, setLoaded] = useState<Record<string, LoadedFrame>>({});
	useEffect(() => {
		let live = true;
		for (const { frame, plan } of settled) {
			if (!plan) {
				continue;
			}
			load(plan).then(
				(sprite) => {
					if (live) {
						setLoaded((current) => ({
							...current,
							[frame.role]: { plan, sprite, time: frame.time },
						}));
					}
				},
				() => {
					// The viewer is guidance; a missing frame keeps its placeholder.
				}
			);
		}
		return () => {
			live = false;
		};
	}, [load, settled]);
	return (
		<section
			aria-label={tl("{mode} source frames", {
				mode: MODE_LABELS[feedback.mode],
			})}
			className="pointer-events-none absolute inset-x-2 bottom-2 z-[7] flex gap-2 rounded-md bg-background/85 p-2 text-foreground shadow-md backdrop-blur-sm"
			data-mode={feedback.mode}
			data-testid="slip-two-up"
		>
			{requests.map((request) => (
				<TrimFrame
					fps={fps}
					key={request.frame.role}
					loaded={loaded[request.frame.role]}
					request={request}
				/>
			))}
		</section>
	);
}

/**
 * Slip-edit two-up source viewer (W1-T12). While a slip drag is in flight it
 * shows the clip's first and last source frames at the proposed range; roll
 * and ripple drags show the outgoing and incoming frames at the edit point.
 * The drag publishes its live proposal through `trimFeedbackStoreFor`.
 */
export function PreviewSlipTwoUp({ project }: PreviewOverlayProps) {
	const runtime = useContext(EditorContext);
	const store = runtime?.store ?? detachedEditorStore;
	const dragKind = useEditorStore(store, (state) => state.drag?.kind ?? null);
	const channel = trimFeedbackStoreFor(runtime?.store);
	const proposal = useSyncExternalStore(
		channel.subscribe,
		channel.get,
		channel.get
	);
	const assets = runtime?.assets ?? noAssets;
	const feedback = useMemo(
		() =>
			dragKind &&
			FEEDBACK_KINDS.has(dragKind) &&
			proposal &&
			proposal.mode === dragKind
				? trimFeedbackFrames(project, assets, proposal)
				: null,
		[assets, dragKind, project, proposal]
	);
	if (!feedback) {
		return null;
	}
	return (
		<TrimFeedbackViewer assets={assets} feedback={feedback} fps={project.fps} />
	);
}
