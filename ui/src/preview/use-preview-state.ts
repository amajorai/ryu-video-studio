import { useContext } from "react";
import { EditorContext } from "../editor/context.tsx";
import type { EditorRuntime } from "../editor/runtime.ts";
import {
	createEditorStore,
	type EditorState,
	useEditorStore,
} from "../editor/store.ts";

/** Stands in for the editor store when the preview renders without an editor (tests, thumbnails). */
const detachedStore = createEditorStore();

/** The editor runtime when the preview is mounted inside one, else null. */
export function useOptionalEditor(): EditorRuntime | null {
	return useContext(EditorContext);
}

/**
 * Read one slice of the editor store from preview chrome. Without an editor
 * the slice comes from a detached store holding the defaults (fit, full
 * quality, no guides), so the preview renders exactly as it did before.
 */
export function usePreviewState<Selected>(
	select: (state: EditorState) => Selected
): Selected {
	const runtime = useContext(EditorContext);
	return useEditorStore(runtime?.store ?? detachedStore, select);
}
