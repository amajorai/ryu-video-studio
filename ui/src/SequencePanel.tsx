import { RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import type { Project } from "../../shared/project.ts";

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
	const sources = projects.filter((project) => project.id !== currentProjectId);
	if (!sources.length) {
		return null;
	}
	return (
		<RyuAppSection title="Nested sequences">
			<p className="text-muted-foreground">
				Render another timeline as an editable sequence clip. The source
				workspace stays independent and can be refreshed after later edits.
			</p>
			{sources.slice(0, 8).map((source) => (
				<div className="studio-scene" key={source.id}>
					<strong>{source.title}</strong>
					<small>
						Revision {source.revision} · {source.width} × {source.height}
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
