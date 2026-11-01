import { formatMessage } from "@ryu/i18n/core";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useRef } from "react";
import type { PasteMode } from "../../../shared/clipboard.ts";
import { clipboardPayload, pastePayload } from "../editor/actions/clipboard.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { hasAssetDrag } from "../library/drag-source.ts";
import { importFiles } from "../library/library-actions.ts";
import { isEditableTarget } from "../shortcuts/registry.ts";
import { isLottieFile } from "./lottie-import.ts";

/** Image types the library accepts (the file picker's `accept` list). */
const IMPORTABLE_IMAGE_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
]);

/**
 * Whether a dropped or picked file is media the library can import: video,
 * audio, PNG/JPEG/WebP images, or a Lottie animation (`.json`, `.lottie`),
 * which is rendered to a video with transparency.
 */
export function isImportableFile(
	file: Pick<File, "type"> & { name?: string }
): boolean {
	return (
		file.type.startsWith("video/") ||
		file.type.startsWith("audio/") ||
		IMPORTABLE_IMAGE_TYPES.has(file.type) ||
		isLottieFile({ name: file.name ?? "", type: file.type })
	);
}

/** Whether a pasted file is an image or video blob (pasted audio is ignored). */
export function isPastableMedia(file: Pick<File, "type">): boolean {
	return (
		file.type.startsWith("video/") || IMPORTABLE_IMAGE_TYPES.has(file.type)
	);
}

/** Whether a drag carries operating-system files. */
export function hasFileDrag(dataTransfer: DataTransfer | null): boolean {
	return Boolean(
		dataTransfer &&
			!hasAssetDrag(dataTransfer) &&
			[...dataTransfer.types].includes("Files")
	);
}

/** Whether an event target edits text, so a paste there stays a text paste. */
export function isTextEditingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) {
		return false;
	}
	return Boolean(
		target.closest("input, textarea, select, [contenteditable='true']")
	);
}

/** A `FileList` over a filtered array, for the existing import flow. */
export function fileListOf(files: readonly File[]): FileList {
	const list: FileList = {
		...files,
		item: (index: number) => files[index] ?? null,
		length: files.length,
		[Symbol.iterator]: () => files[Symbol.iterator](),
	};
	return list;
}

export interface OsDropHandlers {
	/**
	 * Whether the in-app clip clipboard holds clips. While it does, Cmd/Ctrl+V
	 * outside fields is kept from the shortcut dispatcher (which would cancel
	 * the browser `paste` event) and resolved in `paste` instead, so media on
	 * the system clipboard still imports.
	 */
	hasClipPaste?: () => boolean;
	/**
	 * Paste the in-app clip clipboard (`insert` for Shift). Called from the
	 * `paste` event when it holds no media, or after the fallback delay when
	 * no `paste` event follows the keystroke.
	 */
	onClipPaste?: (mode: PasteMode) => void;
	/**
	 * Media files to import, in drop or paste order, with the number of
	 * unsupported files skipped from the same drop.
	 */
	onFiles: (files: File[], skipped: number) => void;
	/** A drop where no file is importable media (e.g. only documents). */
	onRejected?: (count: number) => void;
}

/** How long to wait for a `paste` event after Cmd/Ctrl+V before pasting clips. */
export const CLIP_PASTE_FALLBACK_MS = 100;

type PasteKeyEvent = Pick<
	KeyboardEvent,
	| "altKey"
	| "ctrlKey"
	| "key"
	| "metaKey"
	| "shiftKey"
	| "stopImmediatePropagation"
	| "target"
>;

/** Whether `event` is Cmd/Ctrl+V or Cmd/Ctrl+Shift+V (not the Alt variant). */
export const isPasteKey = (event: PasteKeyEvent): boolean =>
	(event.metaKey || event.ctrlKey) &&
	!event.altKey &&
	event.key.toLowerCase() === "v";

const plural = (count: number, word: string) =>
	`${count} ${word}${count === 1 ? "" : "s"}`;

/** Status text for files skipped from a drop. */
export const skippedNotice = (
	count: number,
	tl: LiteralMessage = (source, values) => formatMessage(source, values, "en")
) =>
	tl(
		"{count, plural, one {Skipped {countLabel} file that is not video, audio, PNG, JPEG, WebP, or Lottie media.} other {Skipped {countLabel} files that are not video, audio, PNG, JPEG, WebP, or Lottie media.}}",
		{ count, countLabel: String(count) }
	);

/**
 * A runtime whose status messages carry `suffix`, so a skip notice stays
 * visible through the import's progress and completion messages.
 */
export function withStatusSuffix(
	runtime: EditorRuntime,
	suffix: string
): EditorRuntime {
	if (!suffix) {
		return runtime;
	}
	return {
		...runtime,
		setStatus: (text) => runtime.setStatus(`${text} ${suffix}`),
	};
}

/**
 * Listen for operating-system file drops and media pastes on `target`
 * (usually the window). Library asset drags and text pastes in fields are
 * left alone. With `onClipPaste`, Cmd/Ctrl+V also routes the in-app clip
 * paste through the `paste` event, so system-clipboard media wins over clips
 * copied earlier in the session. Returns the cleanup function.
 */
export function installOsDrop(
	target: Pick<Window, "addEventListener" | "removeEventListener">,
	handlers: OsDropHandlers
): () => void {
	/** The clip paste a Cmd/Ctrl+V is waiting to resolve in `paste`. */
	let pending: {
		mode: PasteMode;
		timer: ReturnType<typeof setTimeout>;
	} | null = null;
	const settlePending = () => {
		const settled = pending;
		if (settled) {
			clearTimeout(settled.timer);
			pending = null;
		}
		return settled;
	};
	const deliver = (files: readonly File[], accept: (file: File) => boolean) => {
		const accepted = files.filter(accept);
		const skipped = files.length - accepted.length;
		if (accepted.length) {
			handlers.onFiles(accepted, skipped);
		} else if (skipped) {
			handlers.onRejected?.(skipped);
		}
	};
	const onDragOver = (event: DragEvent) => {
		if (!hasFileDrag(event.dataTransfer)) {
			return;
		}
		// Without this the browser would open the file instead of importing it.
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = "copy";
		}
	};
	const onDrop = (event: DragEvent) => {
		if (!hasFileDrag(event.dataTransfer)) {
			return;
		}
		event.preventDefault();
		deliver([...(event.dataTransfer?.files ?? [])], isImportableFile);
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (
			!(
				handlers.onClipPaste &&
				handlers.hasClipPaste?.() &&
				isPasteKey(event)
			) ||
			isEditableTarget(event.target)
		) {
			return;
		}
		// Let the browser fire `paste` (no preventDefault) and keep the
		// keystroke from the shortcut dispatcher, which would cancel it.
		event.stopImmediatePropagation();
		settlePending();
		const mode: PasteMode = event.shiftKey ? "insert" : "overwrite";
		pending = {
			mode,
			timer: setTimeout(() => {
				if (settlePending()) {
					handlers.onClipPaste?.(mode);
				}
			}, CLIP_PASTE_FALLBACK_MS),
		};
	};
	const onPaste = (event: ClipboardEvent) => {
		const awaited = settlePending();
		if (isTextEditingTarget(event.target)) {
			return;
		}
		const files = [...(event.clipboardData?.files ?? [])];
		const media = files.filter(isPastableMedia);
		if (media.length) {
			event.preventDefault();
			handlers.onFiles(media, 0);
			return;
		}
		if (awaited) {
			event.preventDefault();
			handlers.onClipPaste?.(awaited.mode);
		}
	};
	target.addEventListener("keydown", onKeyDown, true);
	target.addEventListener("dragover", onDragOver);
	target.addEventListener("drop", onDrop);
	target.addEventListener("paste", onPaste);
	return () => {
		settlePending();
		target.removeEventListener("keydown", onKeyDown, true);
		target.removeEventListener("dragover", onDragOver);
		target.removeEventListener("drop", onDrop);
		target.removeEventListener("paste", onPaste);
	};
}

/**
 * Import media dropped anywhere on the window, or pasted outside a text
 * field, through the library's existing import flow.
 */
export function useOsDrop(runtime: EditorRuntime) {
	const latest = useRef(runtime);
	latest.current = runtime;
	const tl = useLiteralMessages();
	const latestTl = useRef(tl);
	latestTl.current = tl;
	useEffect(
		() =>
			installOsDrop(window, {
				onFiles: (files, skipped) => {
					const runtimeWithNotice = withStatusSuffix(
						latest.current,
						skipped ? skippedNotice(skipped, latestTl.current) : ""
					);
					runtimeWithNotice.setStatus(
						`Importing ${plural(files.length, "file")}…`
					);
					void importFiles(runtimeWithNotice, fileListOf(files));
				},
				hasClipPaste: () => {
					const current = latest.current;
					return Boolean(
						current.project && !current.busy && clipboardPayload(current)
					);
				},
				onClipPaste: (mode) => {
					const current = latest.current;
					if (current.project && !current.busy) {
						pastePayload(current, { mode });
					}
				},
				onRejected: (count) =>
					latest.current.setStatus(skippedNotice(count, latestTl.current)),
			}),
		[]
	);
}
