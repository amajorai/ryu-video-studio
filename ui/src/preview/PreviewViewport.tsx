import {
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import type { Project } from "../../../shared/project.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { useEditorStore } from "../editor/store.ts";
import { isEditableTarget } from "../shortcuts/registry.ts";
import { PreviewToolbar } from "./PreviewToolbar.tsx";
import { previewQualityScale } from "./quality.ts";
import { useOptionalEditor } from "./use-preview-state.ts";
import {
	canPan,
	clampPan,
	fitScale,
	NO_PAN,
	type Pan,
	type Size,
	viewportScale,
	viewportTransform,
} from "./viewport-math.ts";

const MIDDLE_BUTTON = 1;
const PRIMARY_BUTTON = 0;

interface PanGesture {
	origin: Pan;
	pointerId: number;
	startX: number;
	startY: number;
}

/** Follow the stage element's size; zero until it is measured. */
function useElementSize(element: HTMLElement | null): Size {
	const [size, setSize] = useState<Size>({ height: 0, width: 0 });
	useEffect(() => {
		if (!element) {
			return;
		}
		const measure = () => {
			const rect = element.getBoundingClientRect();
			setSize((current) =>
				current.width === rect.width && current.height === rect.height
					? current
					: { height: rect.height, width: rect.width }
			);
		};
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [element]);
	return size;
}

/** Whether `element` is the document's fullscreen element. */
function useFullscreen(element: HTMLElement | null): boolean {
	const [fullscreen, setFullscreen] = useState(false);
	useEffect(() => {
		const update = () =>
			setFullscreen(Boolean(element) && document.fullscreenElement === element);
		update();
		document.addEventListener("fullscreenchange", update);
		return () => document.removeEventListener("fullscreenchange", update);
	}, [element]);
	return fullscreen;
}

/**
 * Whether a key event belongs to text entry. `isEditableTarget` matches
 * `[contenteditable=true]` only, so `plaintext-only` editors (the in-place
 * title editor) and custom textboxes are caught here too.
 */
function isTextEntryTarget(target: EventTarget | null): boolean {
	if (isEditableTarget(target)) {
		return true;
	}
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return target.isContentEditable || Boolean(target.closest("[role=textbox]"));
}

/**
 * Space held over a pannable preview acts as a hand tool: the key is taken
 * from the playback shortcut while it is down so dragging can pan.
 */
function useSpaceHand(active: () => boolean): boolean {
	const [held, setHeld] = useState(false);
	const activeRef = useRef(active);
	activeRef.current = active;
	useEffect(() => {
		const down = (event: KeyboardEvent) => {
			if (
				event.code !== "Space" ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				isTextEntryTarget(event.target) ||
				!activeRef.current()
			) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			setHeld(true);
		};
		const up = (event: KeyboardEvent) => {
			if (event.code === "Space") {
				setHeld(false);
			}
		};
		const reset = () => setHeld(false);
		window.addEventListener("keydown", down, true);
		window.addEventListener("keyup", up, true);
		window.addEventListener("blur", reset);
		return () => {
			window.removeEventListener("keydown", down, true);
			window.removeEventListener("keyup", up, true);
			window.removeEventListener("blur", reset);
		};
	}, []);
	return held;
}

function EditorViewport({
	children,
	project,
	runtime,
}: {
	children: ReactNode;
	project: Project;
	runtime: EditorRuntime;
}) {
	const zoom = useEditorStore(runtime.store, (state) => state.previewZoom);
	const quality = useEditorStore(
		runtime.store,
		(state) => state.previewQuality
	);
	const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
	const [stageElement, setStageElement] = useState<HTMLDivElement | null>(null);
	const stage = useElementSize(stageElement);
	const fullscreen = useFullscreen(viewport);
	const frame = { height: project.height, width: project.width };
	const [rawPan, setRawPan] = useState<Pan>(NO_PAN);
	const [gesture, setGesture] = useState<PanGesture | null>(null);
	const hovering = useRef(false);
	const pannable = canPan(zoom, stage, frame);
	const spaceHeld = useSpaceHand(() => hovering.current && pannable);
	const pan = clampPan(rawPan, zoom, stage, frame);

	useEffect(() => {
		if (zoom === "fit") {
			setRawPan(NO_PAN);
		}
	}, [zoom]);

	const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
		// Focus the stage for preview shortcuts, but never steal focus from a
		// descendant (the in-place title editor commits on blur).
		if (!event.currentTarget.contains(document.activeElement)) {
			event.currentTarget.focus({ preventScroll: true });
		}
		const wantsPan =
			event.button === MIDDLE_BUTTON ||
			(event.button === PRIMARY_BUTTON && spaceHeld);
		if (!(wantsPan && pannable)) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		event.currentTarget.setPointerCapture?.(event.pointerId);
		setGesture({
			origin: pan,
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
		});
	};

	const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (gesture?.pointerId !== event.pointerId) {
			return;
		}
		setRawPan(
			clampPan(
				{
					x: gesture.origin.x + event.clientX - gesture.startX,
					y: gesture.origin.y + event.clientY - gesture.startY,
				},
				zoom,
				stage,
				frame
			)
		);
	};

	const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (gesture?.pointerId === event.pointerId) {
			setGesture(null);
		}
	};

	let cursor: string | undefined;
	if (gesture) {
		cursor = "grabbing";
	} else if (spaceHeld && pannable) {
		cursor = "grab";
	}

	return (
		<div
			className="absolute inset-0 isolate flex flex-col [&:fullscreen]:bg-black [&:fullscreen]:p-2"
			data-preview-quality={quality}
			data-preview-viewport=""
			ref={setViewport}
		>
			<PreviewToolbar
				fitScale={fitScale(stage, frame)}
				fullscreen={fullscreen}
				runtime={runtime}
				showPlaybackRate
				showProxies
				showQuality
			/>
			{/* The stage is the size container the frame fits itself to, so fullscreen re-fits it. `isolate` keeps its overlay z-indexes (transform handles, crop mode) below the toolbar popovers. */}
			<div
				aria-label="Preview"
				className="relative isolate flex min-h-0 flex-1 items-center justify-center overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
				data-shortcut-scope="preview"
				onAuxClick={(event) => {
					if (event.button === MIDDLE_BUTTON) {
						event.preventDefault();
					}
				}}
				onPointerCancel={endPan}
				onPointerDownCapture={startPan}
				onPointerEnter={() => {
					hovering.current = true;
				}}
				onPointerLeave={() => {
					hovering.current = false;
				}}
				onPointerMove={movePan}
				onPointerUp={endPan}
				ref={setStageElement}
				role="region"
				style={{
					containerType: "size",
					cursor,
					["--studio-preview-quality-scale" as string]: String(
						previewQualityScale(quality)
					),
				}}
				tabIndex={-1}
			>
				<div
					className="absolute inset-0 flex items-center justify-center"
					data-preview-zoom={String(zoom)}
					style={{
						transform: viewportTransform(
							viewportScale(zoom, stage, frame),
							pan
						),
						transformOrigin: "center",
					}}
				>
					{children}
				</div>
			</div>
		</div>
	);
}

/**
 * Viewport around the preview frame: the preview toolbar, zoom (Fit or
 * 25-400%), panning with Space or the middle button, and the fullscreen
 * target. Outside an editor (tests, thumbnails) it adds no DOM.
 */
export function PreviewViewport({
	children,
	project,
}: {
	children: ReactNode;
	project: Project;
}) {
	const runtime = useOptionalEditor();
	if (!runtime) {
		return <>{children}</>;
	}
	return (
		<EditorViewport project={project} runtime={runtime}>
			{children}
		</EditorViewport>
	);
}
