/**
 * Shared state and helpers for direct manipulation in the preview (W2-P2):
 * which item the handles wrap, crop mode, in-place title editing, and the
 * one-undo-step gesture commit. Geometry lives in `shared/preview-geometry.ts`.
 */
import {
	type RefObject,
	useContext,
	useLayoutEffect,
	useState,
	useSyncExternalStore,
} from "react";
import {
	type ContentSize,
	type CropAspectId,
	estimateTitleSize,
	type FrameSize,
	graphicBox,
	type Point,
	type SegmentPlacement,
	type SnapGuides,
	segmentPlacement,
	type TransformBox,
	titleBox,
} from "../../../../shared/preview-geometry.ts";
import {
	type Asset,
	type Graphic,
	type Project,
	type Segment,
	type Title,
	trackSettingFor,
} from "../../../../shared/project.ts";
import type { ActionHandlers } from "../../editor/actions/types.ts";
import { EditorContext } from "../../editor/context.tsx";
import type { EditorRuntime } from "../../editor/runtime.ts";
import type { EditorSelection, EditorStore } from "../../editor/store.ts";
import { segmentActiveAt } from "../stages/visibility.ts";

/** Transient direct-manipulation state, one per editor store. */
export interface DirectManipulationState {
	cropAspect: CropAspectId;
	cropMode: boolean;
	/**
	 * The clip crop mode was entered for. Crop mode ends when the selection
	 * moves to another clip or this one can no longer be cropped.
	 */
	cropTargetId: string | null;
	/** The title whose text is being edited in place. */
	editingTitleId: string | null;
	/** Guides shown while a moved item is snapped. */
	snapGuides: SnapGuides | null;
}

const initialState = (): DirectManipulationState => ({
	cropAspect: "free",
	cropMode: false,
	cropTargetId: null,
	editingTitleId: null,
	snapGuides: null,
});

export interface DirectManipulationStore {
	getState: () => DirectManipulationState;
	setState: (patch: Partial<DirectManipulationState>) => void;
	subscribe: (listener: () => void) => () => void;
}

function createDirectManipulationStore(): DirectManipulationStore {
	let state = initialState();
	const listeners = new Set<() => void>();
	return {
		getState: () => state,
		setState: (patch) => {
			const keys = Object.keys(patch) as (keyof DirectManipulationState)[];
			if (keys.every((key) => Object.is(patch[key], state[key]))) {
				return;
			}
			state = { ...state, ...patch };
			for (const listener of listeners) {
				listener();
			}
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

const stores = new WeakMap<EditorStore, DirectManipulationStore>();
const detached = createDirectManipulationStore();

/** The direct-manipulation state that belongs to an editor store. */
export function directManipulationStore(
	editorStore: EditorStore | null | undefined
): DirectManipulationStore {
	if (!editorStore) {
		return detached;
	}
	let store = stores.get(editorStore);
	if (!store) {
		store = createDirectManipulationStore();
		stores.set(editorStore, store);
	}
	return store;
}

/** Subscribe a preview overlay to one slice of the direct-manipulation state. */
export function useDirectManipulation<Selected>(
	select: (state: DirectManipulationState) => Selected
): Selected {
	const runtime = useContext(EditorContext);
	const store = directManipulationStore(runtime?.store);
	return useSyncExternalStore(
		store.subscribe,
		() => select(store.getState()),
		() => select(store.getState())
	);
}

/** An item the transform handles can wrap. */
export type ManipulationTarget =
	| {
			box: TransformBox;
			elapsed: number;
			id: string;
			kind: "segment";
			locked: boolean;
			placement: SegmentPlacement;
			segment: Segment;
	  }
	| { box: TransformBox; id: string; kind: "title"; title: Title }
	| { box: TransformBox; graphic: Graphic; id: string; kind: "graphic" };

/** Normalized width/height of a title (measured from the DOM or estimated). */
export type TitleSizer = (title: Title) => { height: number; width: number };

export const frameOf = (project: Pick<Project, "height" | "width">) => ({
	height: project.height,
	width: project.width,
});

/** Pixel size of a clip's media; unknown sizes fill the canvas. */
export function contentSizeOf(
	asset: Pick<Asset, "height" | "width"> | undefined,
	canvas: FrameSize
): ContentSize {
	return asset && asset.width > 0 && asset.height > 0
		? { height: asset.height, width: asset.width }
		: canvas;
}

/** Whether a clip draws a picture the handles can wrap. */
function hasPicture(segment: Segment, asset: Asset | undefined): boolean {
	return Boolean(
		asset && (asset.kind !== "audio" || segment.visualization === "waveform")
	);
}

const visibleAt = (item: { end: number; start: number }, time: number) =>
	time >= item.start && time < item.end;

function segmentTarget(
	project: Project,
	assets: readonly Asset[],
	segment: Segment,
	time: number
): ManipulationTarget | null {
	const asset = assets.find((candidate) => candidate.id === segment.assetId);
	if (!(hasPicture(segment, asset) && segmentActiveAt(segment, time))) {
		return null;
	}
	const canvas = frameOf(project);
	const elapsed = time - segment.start;
	const placement = segmentPlacement(
		segment,
		contentSizeOf(asset, canvas),
		canvas,
		elapsed
	);
	return {
		box: placement.visible,
		elapsed,
		id: segment.id,
		kind: "segment",
		locked: trackSettingFor(project, segment.track).locked,
		placement,
		segment,
	};
}

/**
 * The item the handles wrap at `time`: a single selected title or graphic
 * when no clip is selected, otherwise the inspected clip. Items outside the
 * playhead, audio-only clips, and other overlay kinds have no handles.
 */
export function selectedTarget(
	project: Project,
	assets: readonly Asset[],
	selection: EditorSelection,
	time: number,
	titleSize: TitleSizer
): ManipulationTarget | null {
	const overlay =
		selection.segmentIds.length === 0 && selection.overlayIds.length === 1
			? selection.overlayIds[0]
			: undefined;
	if (overlay?.kind === "titles") {
		const title = project.titles.find((item) => item.id === overlay.id);
		return title && visibleAt(title, time)
			? {
					box: titleBox(title, titleSize(title)),
					id: title.id,
					kind: "title",
					title,
				}
			: null;
	}
	if (overlay?.kind === "graphics") {
		const graphic = project.graphics.find((item) => item.id === overlay.id);
		return graphic && visibleAt(graphic, time)
			? { box: graphicBox(graphic), graphic, id: graphic.id, kind: "graphic" }
			: null;
	}
	const segment = project.segments.find(
		(item) => item.id === selection.primaryId
	);
	return segment ? segmentTarget(project, assets, segment, time) : null;
}

type TitleSizes = Record<string, { height: number; width: number }>;

const sameSizes = (a: TitleSizes, b: TitleSizes) => {
	const keys = Object.keys(b);
	return (
		keys.length === Object.keys(a).length &&
		keys.every(
			(key) =>
				Math.abs((a[key]?.width ?? -1) - (b[key]?.width ?? 0)) < 1e-4 &&
				Math.abs((a[key]?.height ?? -1) - (b[key]?.height ?? 0)) < 1e-4
		)
	);
};

/**
 * Title sizes measured from the rendered `.studio-title` elements of the
 * frame that contains `root`, falling back to an estimate when the DOM has
 * no layout (tests, thumbnails) or the titles do not line up.
 */
export function useTitleSizer(
	root: RefObject<HTMLElement | null>,
	project: Project,
	time: number
): TitleSizer {
	const [measured, setMeasured] = useState<TitleSizes>({});
	useLayoutEffect(() => {
		const frame = root.current?.closest(".studio-preview-frame");
		const frameRect = frame?.getBoundingClientRect();
		if (!(frame && frameRect?.width && frameRect.height)) {
			return;
		}
		const visible = project.titles.filter((title) => visibleAt(title, time));
		const elements = frame.querySelectorAll(":scope > .studio-title");
		if (elements.length !== visible.length) {
			return;
		}
		const next: TitleSizes = {};
		for (const [index, title] of visible.entries()) {
			const rect = elements[index]?.getBoundingClientRect();
			if (rect?.width && rect.height) {
				next[title.id] = {
					height: rect.height / frameRect.height,
					width: rect.width / frameRect.width,
				};
			}
		}
		setMeasured((previous) => (sameSizes(previous, next) ? previous : next));
	});
	return (title) =>
		measured[title.id] ?? estimateTitleSize(title, frameOf(project));
}

/** Boxes of every other visible clip, title and graphic (snap targets). */
export function otherBoxes(
	project: Project,
	assets: readonly Asset[],
	time: number,
	excludeId: string,
	titleSize: TitleSizer
): TransformBox[] {
	const boxes: TransformBox[] = [];
	for (const segment of project.segments) {
		const target =
			segment.id === excludeId
				? null
				: segmentTarget(project, assets, segment, time);
		if (target) {
			boxes.push(target.box);
		}
	}
	for (const title of project.titles) {
		if (title.id !== excludeId && visibleAt(title, time)) {
			boxes.push(titleBox(title, titleSize(title)));
		}
	}
	for (const graphic of project.graphics) {
		if (graphic.id !== excludeId && visibleAt(graphic, time)) {
			boxes.push(graphicBox(graphic));
		}
	}
	return boxes;
}

/** `project` with a `clip-properties`-style patch merged into the target. */
export function applyTargetPatch(
	project: Project,
	target: Pick<ManipulationTarget, "id" | "kind">,
	patch: Partial<Segment> | Partial<Title> | Partial<Graphic>
): Project {
	if (target.kind === "segment") {
		return {
			...project,
			segments: project.segments.map((segment) =>
				segment.id === target.id
					? { ...segment, ...(patch as Partial<Segment>) }
					: segment
			),
		};
	}
	if (target.kind === "title") {
		return {
			...project,
			titles: project.titles.map((title) =>
				title.id === target.id
					? { ...title, ...(patch as Partial<Title>) }
					: title
			),
		};
	}
	return {
		...project,
		graphics: project.graphics.map((graphic) =>
			graphic.id === target.id
				? { ...graphic, ...(patch as Partial<Graphic>) }
				: graphic
		),
	};
}

/** Client coordinates → project pixels, through the overlay's on-screen rect. */
export function clientToFramePx(
	client: Point,
	rect: Pick<DOMRect, "height" | "left" | "top" | "width">,
	frame: FrameSize
): Point {
	return {
		x: rect.width ? ((client.x - rect.left) / rect.width) * frame.width : 0,
		y: rect.height ? ((client.y - rect.top) / rect.height) * frame.height : 0,
	};
}

/** Project pixels per on-screen pixel (1 when the overlay is not laid out). */
export const framePxPerScreenPx = (
	rect: Pick<DOMRect, "width">,
	frame: FrameSize
) => (rect.width ? frame.width / rect.width : 1);

/**
 * Commit a pointer gesture as one undo step: the first change goes through
 * `edit()` (which records the gesture's starting project), and later frames
 * of the same gesture replace the project without adding history.
 */
export function createGestureCommit(
	runtime: () => EditorRuntime,
	label: string
) {
	let started = false;
	return {
		get started() {
			return started;
		},
		update(next: Project) {
			const current = runtime();
			if (!started) {
				started = true;
				current.edit(next, label);
				return;
			}
			current.setProject(next);
			current.setDirty(true);
		},
	};
}

export const LOCKED_TRACK_MESSAGE =
	"Unlock this track before editing its clips.";
export const CROP_NEEDS_CLIP =
	"Select a video or image clip under the playhead to crop it.";

/** Leave crop mode and forget its aspect preset. */
export function exitCropMode(store: DirectManipulationStore): void {
	store.setState({ cropAspect: "free", cropMode: false, cropTargetId: null });
}

/** Whether crop mode is on for `targetId`. */
export const croppingTarget = (
	state: Pick<DirectManipulationState, "cropMode" | "cropTargetId">,
	targetId: string
) => state.cropMode && state.cropTargetId === targetId;

/** Turn crop mode on for the inspected clip, or off. */
export function toggleCropMode(runtime: EditorRuntime): void {
	const store = directManipulationStore(runtime.store);
	if (store.getState().cropMode) {
		exitCropMode(store);
		return;
	}
	const { project } = runtime;
	const target = project
		? selectedTarget(
				project,
				runtime.assets,
				{
					...runtime.store.getState().selection,
					overlayIds: [],
				},
				runtime.time,
				() => ({ height: 0, width: 0 })
			)
		: null;
	if (target?.kind !== "segment") {
		runtime.setStatus(CROP_NEEDS_CLIP);
		return;
	}
	if (target.locked) {
		runtime.setStatus(LOCKED_TRACK_MESSAGE);
		return;
	}
	store.setState({
		cropAspect: "free",
		cropMode: true,
		cropTargetId: target.id,
		editingTitleId: null,
	});
}

/**
 * Handlers for the pre-declared preview bindings this item implements
 * (C inside the focused preview). Registered with the other preview
 * actions at integration.
 */
export const directManipulationActions: ActionHandlers = {
	"preview.cropMode": (runtime) => {
		toggleCropMode(runtime);
	},
};
