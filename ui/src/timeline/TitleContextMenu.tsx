import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { type ReactNode, useState } from "react";
import { titleNarrationText } from "../../../shared/title-narration.ts";
import { narrateTitle } from "../editor/actions/title-narration.ts";
import { useEditorProject } from "../editor/context.tsx";

/**
 * The right-click (or Shift+F10, or long-press) menu on a title in the
 * Titles lane: speak it with text to speech at the title's start using the
 * viewer's Titles-panel voice, duplicate it, or remove it.
 */
export function TitleContextMenu({
	children,
	narrate = narrateTitle,
	narrationAvailable = Boolean(window.ryu?.media?.tts),
	onDuplicate,
	onRemove,
	titleId,
}: {
	children: ReactNode;
	/** Injectable for tests; defaults to the editor's title narration action. */
	narrate?: typeof narrateTitle;
	narrationAvailable?: boolean;
	onDuplicate: () => void;
	onRemove: () => void;
	titleId: string;
}) {
	const runtime = useEditorProject();
	const [speaking, setSpeaking] = useState(false);
	const title = runtime.project?.titles.find((item) => item.id === titleId);
	const speakable = Boolean(title && titleNarrationText(title.text));
	const speak = async () => {
		if (speaking) {
			return;
		}
		setSpeaking(true);
		try {
			await narrate(runtime, titleId);
		} finally {
			setSpeaking(false);
		}
	};
	return (
		<ContextMenu>
			<ContextMenuTrigger className="contents" data-title-menu={titleId}>
				{children}
			</ContextMenuTrigger>
			<ContextMenuContent aria-label="Title actions" className="max-w-72">
				<ContextMenuItem
					data-menu-item="text-to-speech"
					disabled={!(narrationAvailable && speakable) || speaking}
					onClick={() => void speak()}
					title={
						narrationAvailable
							? undefined
							: "Open Video Studio in Ryu with narration access to use text to speech."
					}
				>
					{speaking ? "Speaking…" : "Text to speech"}
				</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem data-menu-item="duplicate" onClick={onDuplicate}>
					Duplicate
				</ContextMenuItem>
				<ContextMenuItem data-menu-item="remove" onClick={onRemove}>
					Remove
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}
