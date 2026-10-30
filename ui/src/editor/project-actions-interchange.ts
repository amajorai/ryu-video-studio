import { z } from "zod";
import type { InterchangeFormat } from "../../../shared/interchange.ts";
import { download, request } from "../bridge.ts";
import type { EditorRuntime } from "./runtime.ts";

const INTERCHANGE_DOWNLOADED: Record<InterchangeFormat, string> = {
	fcpxml: "FCPXML timeline downloaded for Final Cut or Resolve.",
	otio: "OpenTimelineIO timeline downloaded.",
	xmeml: "Premiere XMEML timeline downloaded.",
};

export const downloadInterchange = (
	runtime: EditorRuntime,
	format: InterchangeFormat
) =>
	runtime.act(async () => {
		const saved = runtime.dirty ? await runtime.save() : runtime.project;
		if (!saved) {
			return;
		}
		const result = await request(
			z.object({ filename: z.string(), format: z.string(), text: z.string() }),
			`/projects/${saved.id}/interchange?format=${format}`
		);
		download(
			new Blob([result.text], {
				type: format === "otio" ? "application/json" : "application/xml",
			}),
			result.filename
		);
		runtime.setStatus(INTERCHANGE_DOWNLOADED[format]);
	});
