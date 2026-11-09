import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { z } from "zod";
import {
	type CustomGuide,
	DEFAULT_CUSTOM_GUIDE,
	DEFAULT_PREVIEW_GUIDES,
	isPreviewGuideId,
	normalizeCustomGuide,
	type PreviewGuideId,
} from "../../preview/overlays/guide-geometry.ts";
import { clampPlaybackRate } from "../../preview/quality.ts";
import {
	clampPreviewZoom,
	type PreviewZoom,
} from "../../preview/viewport-math.ts";
import { clock } from "../format.ts";
import type { EditorRuntime } from "../runtime.ts";
import type { PreviewQuality } from "../store.ts";
import {
	readViewerValue,
	type ViewerStorageArea,
	writeViewerValue,
} from "../viewer-storage.ts";
import type { ActionHandlers } from "./types.ts";

/** English fallback until a caller passes the Companion's `tl`. */
const englishMessages: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

/** The element `requestFullscreen` targets and the preview shortcut scope lives on. */
export const PREVIEW_VIEWPORT_SELECTOR = "[data-preview-viewport]";

/** Viewer-storage key holding the guides last shown, restored by the guides toggle. */
export const GUIDES_STORAGE_KEY = "preview.guides";

const guideListSchema = z.array(z.string()).max(32);

/** Viewer-storage key holding the custom guide and grid density. */
export const CUSTOM_GUIDE_STORAGE_KEY = "preview.customGuide";

const customGuideSchema = z
	.object({
		aspect: z.number().nullable().optional(),
		gridColumns: z.number().optional(),
		gridRows: z.number().optional(),
		margins: z
			.object({
				bottom: z.number(),
				left: z.number(),
				right: z.number(),
				top: z.number(),
			})
			.optional(),
	})
	.loose();

/** The viewer's custom guide: the editor's copy, else the stored one. */
export function customGuideOf(
	state: { customGuide?: CustomGuide },
	area?: ViewerStorageArea | null
): CustomGuide {
	if (state.customGuide) {
		return state.customGuide;
	}
	const stored = readViewerValue(
		CUSTOM_GUIDE_STORAGE_KEY,
		customGuideSchema,
		{},
		area
	);
	return normalizeCustomGuide({
		...DEFAULT_CUSTOM_GUIDE,
		...stored,
		aspect: stored.aspect === undefined ? null : stored.aspect,
	});
}

/** Change the custom guide or grid density and remember it for this viewer. */
export function setCustomGuide(
	runtime: Pick<EditorRuntime, "store">,
	patch: Partial<CustomGuide>,
	area?: ViewerStorageArea | null
) {
	const next = normalizeCustomGuide({
		...customGuideOf(runtime.store.getState(), area),
		...patch,
	});
	writeViewerValue(CUSTOM_GUIDE_STORAGE_KEY, next, area);
	runtime.store.setState({ customGuide: next });
}

export function setPreviewZoom(runtime: EditorRuntime, zoom: PreviewZoom) {
	runtime.store.setState({
		previewZoom: zoom === "fit" ? "fit" : clampPreviewZoom(zoom),
	});
}

export function setPreviewQuality(
	runtime: EditorRuntime,
	quality: PreviewQuality
) {
	runtime.store.setState({ previewQuality: quality });
}

export function setPlaybackRate(runtime: EditorRuntime, rate: number) {
	runtime.store.setState({ playbackRate: clampPlaybackRate(rate) });
}

/** Show exactly `guides`, remembering a non-empty choice for the guides toggle. */
export function setPreviewGuides(
	runtime: EditorRuntime,
	guides: Iterable<string>,
	area?: ViewerStorageArea | null
) {
	const next = new Set([...guides].filter(isPreviewGuideId));
	if (next.size) {
		writeViewerValue(GUIDES_STORAGE_KEY, [...next], area);
	}
	runtime.store.setState({ guides: next });
}

/** Turn one guide on or off. */
export function togglePreviewGuide(
	runtime: EditorRuntime,
	id: PreviewGuideId,
	area?: ViewerStorageArea | null
) {
	const current = new Set(runtime.store.getState().guides);
	if (current.has(id)) {
		current.delete(id);
	} else {
		current.add(id);
	}
	setPreviewGuides(runtime, current, area);
}

/**
 * Hide every guide, or bring back the last guides the viewer showed (safe
 * areas the first time).
 */
export function togglePreviewGuides(
	runtime: EditorRuntime,
	area?: ViewerStorageArea | null
) {
	if (runtime.store.getState().guides.size) {
		runtime.store.setState({ guides: new Set() });
		return;
	}
	const remembered = readViewerValue(
		GUIDES_STORAGE_KEY,
		guideListSchema,
		[],
		area
	).filter(isPreviewGuideId);
	setPreviewGuides(
		runtime,
		remembered.length ? remembered : DEFAULT_PREVIEW_GUIDES,
		area
	);
}

/** The parts of `document` fullscreen uses, so tests can pass a fake. */
export interface FullscreenDocument {
	exitFullscreen?: () => Promise<void>;
	fullscreenElement: Element | null;
	querySelector: (selector: string) => Element | null;
}

/** Enter fullscreen on the preview viewport, or leave it when already fullscreen. */
export async function togglePreviewFullscreen(
	runtime: EditorRuntime,
	doc: FullscreenDocument | undefined = globalThis.document
): Promise<void> {
	try {
		if (doc?.fullscreenElement) {
			await doc.exitFullscreen?.();
			return;
		}
		const viewport = doc?.querySelector(PREVIEW_VIEWPORT_SELECTOR);
		if (!viewport || typeof viewport.requestFullscreen !== "function") {
			runtime.setStatus("Fullscreen preview is not available here.");
			return;
		}
		await viewport.requestFullscreen();
	} catch {
		runtime.setStatus("Fullscreen preview was blocked by the browser.");
	}
}

const inspectFrameSchema = z.object({
	data: z.string().min(1),
	mimeType: z.literal("image/png"),
});

const decodeBase64 = (data: string) =>
	Uint8Array.from(atob(data), (character) => character.charCodeAt(0));

/**
 * Render the composited frame at the playhead through the sidecar's
 * read-only `inspect-frame` route and return it as a PNG blob. Pending
 * edits are saved first so the frame matches what the preview shows.
 */
export async function fetchPreviewFrame(
	runtime: EditorRuntime,
	time = runtime.time
): Promise<Blob> {
	const project = (await runtime.ensureSaved()) ?? runtime.project;
	if (!project) {
		throw new Error("Open a project before capturing a frame.");
	}
	const seconds = Math.max(0, Number.isFinite(time) ? time : 0);
	const frame = inspectFrameSchema.parse(
		await runtime.api(
			`/projects/${encodeURIComponent(project.id)}/inspect-frame?time=${seconds}`
		)
	);
	return new Blob([decodeBase64(frame.data)], { type: frame.mimeType });
}

/** File name for a saved frame: the project title plus the playhead, filesystem safe. */
export function frameFileName(title: string, time: number): string {
	const base =
		title
			.trim()
			.replace(/[^\w.-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || "frame";
	const stamp = clock(Math.max(0, time)).replace(/[^\d]+/g, "-");
	return `${base}-${stamp}.png`;
}

export interface FrameSnapshotDeps {
	download?: (blob: Blob, name: string) => void;
	fetchFrame?: (runtime: EditorRuntime) => Promise<Blob>;
}

function downloadBlob(blob: Blob, name: string) {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = name;
	anchor.rel = "noopener";
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Download the frame at the playhead as a PNG. */
export async function savePreviewFrame(
	runtime: EditorRuntime,
	deps: FrameSnapshotDeps = {},
	tl: LiteralMessage = englishMessages
): Promise<void> {
	const { project, time } = runtime;
	if (!project) {
		return;
	}
	try {
		const blob = await (deps.fetchFrame ?? fetchPreviewFrame)(runtime);
		(deps.download ?? downloadBlob)(blob, frameFileName(project.title, time));
		runtime.setStatus(tl("Saved the frame at {time}.", { time: clock(time) }));
	} catch (error) {
		runtime.setStatus(
			tl("Could not save the frame: {errorMessage}", {
				errorMessage:
					error instanceof Error ? error.message : tl("unknown error"),
			})
		);
	}
}

/** The clipboard surface frame copying needs, so tests can pass a fake. */
export interface ImageClipboard {
	ClipboardItem?: new (items: Record<string, Blob | Promise<Blob>>) => unknown;
	write?: (items: unknown[]) => Promise<void>;
}

export const COPY_FRAME_UNSUPPORTED =
	"Copying images is not supported here. Use Save frame instead.";

function browserClipboard(): ImageClipboard {
	const clipboard = globalThis.navigator?.clipboard;
	return {
		ClipboardItem: globalThis.ClipboardItem,
		write: clipboard?.write
			? (items) => clipboard.write(items as ClipboardItem[])
			: undefined,
	};
}

/** Whether this browser can put a PNG on the clipboard. */
export function canCopyFrame(clipboard: ImageClipboard = browserClipboard()) {
	return Boolean(clipboard.write && clipboard.ClipboardItem);
}

/**
 * Copy the frame at the playhead to the clipboard as a PNG. The clipboard
 * item is created synchronously with a pending blob, so the click's user
 * activation still covers the write after the frame finishes rendering.
 */
export async function copyPreviewFrame(
	runtime: EditorRuntime,
	clipboard: ImageClipboard = browserClipboard(),
	deps: Pick<FrameSnapshotDeps, "fetchFrame"> = {},
	tl: LiteralMessage = englishMessages
): Promise<boolean> {
	const { ClipboardItem: Item, write } = clipboard;
	if (!(runtime.project && Item && write)) {
		runtime.setStatus(COPY_FRAME_UNSUPPORTED);
		return false;
	}
	const { time } = runtime;
	try {
		const blob = (deps.fetchFrame ?? fetchPreviewFrame)(runtime);
		// The write reports a failed render; this only keeps it from going unhandled.
		blob.catch(() => undefined);
		await write([new Item({ "image/png": blob })]);
		runtime.setStatus(tl("Copied the frame at {time}.", { time: clock(time) }));
		return true;
	} catch (error) {
		runtime.setStatus(
			tl("Could not copy the frame: {errorMessage}", {
				errorMessage:
					error instanceof Error ? error.message : tl("clipboard unavailable"),
			})
		);
		return false;
	}
}

/**
 * Preview handlers: the guides toggle (toolbar and palette), fullscreen (F),
 * fit (Cmd+0) and 100% (Cmd+1). Crop mode (C inside the focused preview) is
 * `directManipulationActions` in `preview/overlays/direct-manipulation.ts`.
 */
export const previewActions: ActionHandlers = {
	"preview.fullscreen": (runtime) => {
		void togglePreviewFullscreen(runtime);
	},
	"preview.toggleGuides": (runtime) => {
		togglePreviewGuides(runtime);
	},
	"preview.zoom100": (runtime) => {
		setPreviewZoom(runtime, 1);
	},
	"preview.zoomFit": (runtime) => {
		setPreviewZoom(runtime, "fit");
	},
};
