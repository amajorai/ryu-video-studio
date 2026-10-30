import type { RenderRequest } from "../../../../shared/render-options.ts";
import { request } from "../../bridge.ts";
import { clock, jobResponseSchema } from "../format.ts";
import type { EditorRuntime } from "../runtime.ts";
import type { ActionHandlers } from "./types.ts";

/**
 * Save pending edits, queue a render of the saved revision with `body` (an
 * empty body is the project's default export), and show exports.
 */
export const exportVideo = (runtime: EditorRuntime, body: RenderRequest = {}) =>
	runtime.act(async () => {
		const saved = runtime.dirty ? await runtime.save() : runtime.project;
		if (!saved) {
			return;
		}
		const job = await request(
			jobResponseSchema,
			`/projects/${saved.id}/render`,
			"POST",
			Object.keys(body).length
				? { ...body, revision: saved.revision }
				: undefined
		);
		runtime.registerJob(job);
		runtime.setPanel("exports");
		runtime.setStatus(
			body.range
				? `Rendering ${clock(body.range.start)}–${clock(body.range.end)} of the saved timeline. You can continue editing.`
				: "Rendering the saved timeline. You can continue editing."
		);
	});

/** Render only the I/O range with the project's export settings. */
export const exportRange = (runtime: EditorRuntime) => {
	const { end, start } = runtime.range;
	if (!(end > start)) {
		runtime.setStatus(
			"Set an In point before the Out point to export a range."
		);
		return;
	}
	return exportVideo(runtime, { range: { start, end } });
};

/** Whether the timeline has anything to render. */
export const hasRenderableContent = (
	project: EditorRuntime["project"]
): boolean =>
	Boolean(
		project?.segments.length ||
			project?.titles.length ||
			project?.graphics.length ||
			project?.avatars.length ||
			project?.spatialObjects.length ||
			project?.meshes.length
	);

/** Export handlers: the whole timeline, or only the I/O range. */
export const exportActions: ActionHandlers = {
	"export.range": (runtime) => {
		void exportRange(runtime);
	},
	"export.video": (runtime) => {
		void exportVideo(runtime);
	},
};
