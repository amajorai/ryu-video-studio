import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import {
	backgroundImageCandidates,
	backgroundTypes,
	defaultCanvasColor,
	describeBackground,
	setProjectBackground,
} from "../../../shared/background.ts";
import { useEditor } from "../editor/context.tsx";
import { BackgroundFields } from "./BackgroundFields.tsx";
import type { PanelTab } from "./types.ts";

/** The canvas background mounts inside the Graphics category. */
export const backgroundPanelTab: PanelTab | null = null;

/**
 * The project canvas background (W2-V8): the style color, a color, a
 * gradient, a blur fill under base-track clips, or a library image or video.
 * Edits are local and undoable; agents use `POST /projects/:id/background`.
 */
export function BackgroundPanel() {
	const runtime = useEditor();
	const { assets, project } = runtime;
	if (!project) {
		return null;
	}
	const imageAssets = backgroundImageCandidates(assets);
	const value = project.background;
	// Registered panels stack under the Graphics panel with no gap of their own.
	return (
		<div className="pt-3">
			<RyuAppField
				description={
					value?.type === "blur"
						? "Fills the space around each clip on the base track with a blurred, dimmed copy of its edges."
						: "Shown wherever no clip covers the frame, in the preview and in exports."
				}
				label="Canvas background"
			>
				<BackgroundFields
					fallbackColor={defaultCanvasColor(project)}
					imageAssets={imageAssets}
					label="Canvas"
					noneLabel="Style color"
					onChange={(background) =>
						runtime.edit(
							(current) =>
								setProjectBackground(current, assets, background ?? null),
							background
								? `Canvas background: ${describeBackground(background, assets)}`
								: "Canvas background: style color"
						)
					}
					types={backgroundTypes}
					value={value}
				/>
			</RyuAppField>
		</div>
	);
}
