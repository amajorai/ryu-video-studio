import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useRef } from "react";
import { titleBox } from "../../../../shared/preview-geometry.ts";
import type { Project, Title } from "../../../../shared/project.ts";
import type { EditorRuntime } from "../../editor/runtime.ts";
import type { EditorSelection } from "../../editor/store.ts";
import { titleStyle } from "../PreviewTitles.tsx";
import type { PreviewStyle } from "../preview-style.ts";
import { useOptionalEditor, usePreviewState } from "../use-preview-state.ts";
import {
	directManipulationStore,
	useDirectManipulation,
	useTitleSizer,
} from "./direct-manipulation.ts";
import type { PreviewOverlayProps } from "./overlay-props.ts";
import { boxStyle } from "./PreviewTransformHandles.tsx";

/** Longest title text the schema accepts. */
export const TITLE_TEXT_LIMIT = 500;
export const EMPTY_TITLE_MESSAGE =
	"A title needs text. Delete the title to remove it.";

/** Editable text with line endings, non-breaking spaces and edges normalized. */
export function normalizeTitleText(raw: string): string {
	return raw
		.replace(/\r\n?/g, "\n")
		.replace(/ /g, " ")
		.trim()
		.slice(0, TITLE_TEXT_LIMIT);
}

export type TitleTextEdit =
	| { kind: "unchanged" }
	| { kind: "empty" }
	| { kind: "changed"; project: Project };

/** Apply edited text to a title, or explain why nothing was written. */
export function titleTextEdit(
	project: Project,
	titleId: string,
	raw: string
): TitleTextEdit {
	const text = normalizeTitleText(raw);
	const title = project.titles.find((item) => item.id === titleId);
	if (!title || text === title.text) {
		return { kind: "unchanged" };
	}
	if (!text) {
		return { kind: "empty" };
	}
	return {
		kind: "changed",
		project: {
			...project,
			titles: project.titles.map((item) =>
				item.id === titleId ? { ...item, text } : item
			),
		},
	};
}

/** Select one title (the inspector and handles follow the selection). */
export function selectTitle(runtime: EditorRuntime, id: string) {
	const selection: EditorSelection = {
		overlayIds: [{ id, kind: "titles" }],
		primaryId: null,
		segmentIds: [],
	};
	runtime.store.setState({ selection });
}

/** Text of a contenteditable element, keeping the line breaks the viewer typed. */
function editableText(element: HTMLElement): string {
	const rendered = element.innerText;
	return typeof rendered === "string" && rendered.length
		? rendered
		: (element.textContent ?? "");
}

function TitleEditor({
	project,
	runtime,
	time,
	title,
}: {
	project: Project;
	runtime: EditorRuntime;
	time: number;
	title: Title;
}) {
	const editor = useRef<HTMLDivElement>(null);
	const closed = useRef(false);
	const manipulation = directManipulationStore(runtime.store);
	const originalText = useRef(title.text);
	useEffect(() => {
		const element = editor.current;
		if (!element) {
			return;
		}
		element.textContent = originalText.current;
		element.focus();
		const range = document.createRange?.();
		const selection = window.getSelection?.();
		if (range && selection) {
			range.selectNodeContents(element);
			selection.removeAllRanges();
			selection.addRange(range);
		}
	}, []);
	const close = () => {
		closed.current = true;
		manipulation.setState({ editingTitleId: null });
	};
	const commit = () => {
		const element = editor.current;
		if (closed.current || !element) {
			return;
		}
		const result = titleTextEdit(project, title.id, editableText(element));
		if (result.kind === "empty") {
			runtime.setStatus(EMPTY_TITLE_MESSAGE);
		} else if (result.kind === "changed") {
			runtime.edit(result.project, "Edit title text");
		}
		close();
	};
	const style: PreviewStyle = {
		...titleStyle(title, project, time),
		"--studio-title-opacity": "1",
		// Titles are drawn unrotated (overlay rotation is W3-X1), so the editor is too.
		"--studio-title-transform": "translate(-50%, -50%)",
	};
	return (
		<div
			aria-label="Title text"
			aria-multiline="true"
			className="studio-title pointer-events-auto z-[80] cursor-text rounded-sm bg-black/40 outline-2 outline-primary outline-offset-4"
			contentEditable="plaintext-only"
			data-title-editor={title.id}
			onBlur={commit}
			onKeyDown={(event) => {
				event.stopPropagation();
				if (event.key === "Escape") {
					event.preventDefault();
					close();
				} else if (event.key === "Enter" && !event.shiftKey) {
					event.preventDefault();
					commit();
				}
			}}
			ref={editor}
			role="textbox"
			style={style}
			suppressContentEditableWarning
			tabIndex={0}
		/>
	);
}

/**
 * In-place title editing: click a title in the preview to select it,
 * double-click (or press Enter on its selected box) to edit its text with the
 * title's own styling. Enter commits, Shift+Enter adds a line, Escape cancels.
 */
export function TextEditOverlay({
	playing,
	project,
	time,
}: PreviewOverlayProps) {
	const tl = useLiteralMessages();
	const runtime = useOptionalEditor();
	const root = useRef<HTMLDivElement>(null);
	const selection = usePreviewState((state) => state.selection);
	const editingTitleId = useDirectManipulation((state) => state.editingTitleId);
	const titleSize = useTitleSizer(root, project, time);
	const visible = playing
		? []
		: project.titles.filter((title) => time >= title.start && time < title.end);
	const editing = visible.find((title) => title.id === editingTitleId);
	useEffect(() => {
		if (editingTitleId && !editing && runtime) {
			directManipulationStore(runtime.store).setState({ editingTitleId: null });
		}
	}, [editing, editingTitleId, runtime]);
	if (!runtime) {
		return null;
	}
	const selectedTitleIds = new Set(
		selection.segmentIds.length
			? []
			: selection.overlayIds
					.filter((item) => item.kind === "titles")
					.map((item) => item.id)
	);
	const manipulation = directManipulationStore(runtime.store);
	return (
		<div
			className="pointer-events-none absolute inset-0 z-[75]"
			data-preview-text-edit=""
			ref={root}
		>
			{visible
				.filter(
					(title) =>
						title.id !== editingTitleId && !selectedTitleIds.has(title.id)
				)
				.map((title) => (
					<button
						aria-label={tl(
							'Select title "{text}". Double-click to edit its text.',
							{ text: title.text.slice(0, 40) }
						)}
						className="pointer-events-auto absolute cursor-pointer border-0 bg-transparent p-0 hover:outline hover:outline-1 hover:outline-primary/70"
						data-slot="preview-handle"
						data-title-hit={title.id}
						key={title.id}
						onClick={() => selectTitle(runtime, title.id)}
						onDoubleClick={() => {
							selectTitle(runtime, title.id);
							manipulation.setState({ editingTitleId: title.id });
						}}
						style={boxStyle(titleBox(title, titleSize(title)))}
						type="button"
					/>
				))}
			{editing ? (
				<TitleEditor
					key={editing.id}
					project={project}
					runtime={runtime}
					time={time}
					title={editing}
				/>
			) : null}
		</div>
	);
}
