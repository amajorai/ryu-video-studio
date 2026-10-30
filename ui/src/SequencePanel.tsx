import { RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Button, Input } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useState } from "react";
import type { Project } from "../../shared/project.ts";
import {
	decomposeClip,
	nestClips,
	nestedProjectOf,
	openNested,
	selectedClipIds,
	selectedSequenceClipId,
} from "./editor/actions/nest.ts";
import { useEditor } from "./editor/context.tsx";

/**
 * Nest the selected clips into a nested sequence, decompose or open the
 * selected sequence clip, and add another timeline as a sequence clip.
 */
export function SequencePanel({
	busy,
	currentProjectId,
	onCreate,
	projects,
}: {
	busy: boolean;
	currentProjectId: string;
	onCreate: (project: Project) => void;
	projects: Project[];
}) {
	const tl = useLiteralMessages();
	const runtime = useEditor();
	const [title, setTitle] = useState("");
	const clipIds = selectedClipIds(runtime);
	const nested = nestedProjectOf(runtime);
	const sequenceClipId = selectedSequenceClipId(runtime);
	const sources = projects.filter((project) => project.id !== currentProjectId);
	const nest = async () => {
		const outcome = await nestClips(
			runtime,
			clipIds,
			title.trim() || undefined
		);
		if (outcome.status === "ok") {
			setTitle("");
		}
	};
	return (
		<RyuAppSection title="Nested sequences">
			<p className="text-muted-foreground">
				Nest selected clips into their own timeline, shown here as one sequence
				clip. Decompose puts the clips back.
			</p>
			<div className="flex flex-wrap items-center gap-2">
				<Input
					aria-label="Nested sequence title"
					className="min-w-0 flex-1"
					maxLength={200}
					onChange={(event) => setTitle(event.target.value)}
					placeholder="Nested sequence title (optional)"
					value={title}
				/>
				<Button
					aria-keyshortcuts="Meta+Alt+G Control+Alt+G"
					disabled={busy || clipIds.length === 0}
					onClick={() => void nest()}
					size="sm"
					title={
						clipIds.length ? undefined : "Select clips on the timeline first."
					}
					variant="outline"
				>
					{clipIds.length > 1
						? tl("Nest {clipCount} clips", {
								clipCount: String(clipIds.length),
							})
						: tl("Nest selection")}
				</Button>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<Button
					aria-keyshortcuts="Meta+Alt+Shift+G Control+Alt+Shift+G"
					disabled={busy || !sequenceClipId}
					onClick={() => {
						if (sequenceClipId) {
							void decomposeClip(runtime, sequenceClipId);
						}
					}}
					size="sm"
					title={sequenceClipId ? undefined : "Select a sequence clip first."}
					variant="outline"
				>
					Decompose
				</Button>
				<Button
					disabled={busy || !nested}
					onClick={() => openNested(runtime)}
					size="sm"
					title={
						nested ? tl("Open {title}", { title: nested.title }) : undefined
					}
					variant="outline"
				>
					Open nested
				</Button>
			</div>
			{sources.length > 0 && (
				<p className="text-muted-foreground">
					Render another timeline as an editable sequence clip. The source
					workspace stays independent and can be refreshed after later edits.
				</p>
			)}
			{sources.slice(0, 8).map((source) => (
				<div className="studio-scene" key={source.id}>
					<strong>{source.title}</strong>
					<small>
						{tl("Revision {revision} · {width} × {height}", {
							height: String(source.height),
							revision: String(source.revision),
							width: String(source.width),
						})}
					</small>
					<Button
						disabled={busy}
						onClick={() => onCreate(source)}
						size="sm"
						variant="outline"
					>
						Add sequence clip
					</Button>
				</div>
			))}
		</RyuAppSection>
	);
}
