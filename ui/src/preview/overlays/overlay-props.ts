import type { Project } from "../../../../shared/project.ts";

/** What every preview overlay receives from `PreviewStage`. */
export interface PreviewOverlayProps {
	playing: boolean;
	project: Project;
	time: number;
}
