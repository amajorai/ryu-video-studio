import { z } from "zod";
import { fcpxmlText } from "./interchange-fcpxml.ts";
import { otioText } from "./interchange-otio.ts";
import { referencedAssets } from "./interchange-shared.ts";
import { xmemlText } from "./interchange-xmeml.ts";
import type { Asset, Project } from "./project.ts";

export {
	OTIO_SPEED_CURVE_EFFECT,
	readOtioSpeedCurves,
} from "./interchange-otio.ts";
export {
	CURVE_SAMPLE_FRAMES,
	curveRemapPoints,
	MAX_CURVE_REMAP_POINTS,
	type RemapPoint,
} from "./interchange-shared.ts";

export const interchangeFormatSchema = z.enum(["fcpxml", "xmeml", "otio"]);
export type InterchangeFormat = z.infer<typeof interchangeFormatSchema>;

/**
 * Serialize the saved timeline for import into Final Cut/Resolve (FCPXML),
 * Premiere (XMEML) or OpenTimelineIO tools (OTIO JSON).
 */
export function interchangeText(
	project: Project,
	assets: readonly Asset[],
	format: InterchangeFormat
): string {
	const referenced = referencedAssets(project, assets);
	switch (format) {
		case "fcpxml":
			return fcpxmlText(project, referenced);
		case "otio":
			return otioText(project, referenced);
		default:
			return xmemlText(project, referenced);
	}
}

const INTERCHANGE_EXTENSIONS: Record<InterchangeFormat, string> = {
	fcpxml: "fcpxml",
	otio: "otio",
	xmeml: "xml",
};

export function interchangeFilename(
	project: Pick<Project, "title">,
	format: InterchangeFormat
): string {
	const safeTitle = project.title
		.trim()
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return `${safeTitle || "video-studio-project"}.${INTERCHANGE_EXTENSIONS[format]}`;
}
