import { createContext, type ReactNode, useContext } from "react";
import type { Project } from "../../../shared/project.ts";
import type { EditorRuntime } from "./runtime.ts";

/**
 * The open editor: project, assets, edit/history, sidecar requests, playhead,
 * range, and busy state. Panels, inspector sections, and timeline slots read
 * it instead of receiving props from App.
 */
export const EditorContext = createContext<EditorRuntime | null>(null);

export function EditorProvider({
	children,
	value,
}: {
	children: ReactNode;
	value: EditorRuntime;
}) {
	return (
		<EditorContext.Provider value={value}>{children}</EditorContext.Provider>
	);
}

export function useEditor(): EditorRuntime {
	const runtime = useContext(EditorContext);
	if (!runtime) {
		throw new Error("Video Studio editor components need an EditorProvider.");
	}
	return runtime;
}

/** The editor plus its open project, for components mounted only with one. */
export function useEditorProject(): EditorRuntime & { project: Project } {
	const runtime = useEditor();
	const { project } = runtime;
	if (!project) {
		throw new Error("Open a project before showing this editor panel.");
	}
	return { ...runtime, project };
}
