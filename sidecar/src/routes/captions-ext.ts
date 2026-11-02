import {
	captionRechunkRequestSchema,
	rechunkProject,
} from "../../../shared/caption-chunking.ts";
import {
	captionImportRequestSchema,
	importCaptions,
} from "../../../shared/caption-edits.ts";
import {
	applyCaptionGlossary,
	applyGlossaryToCaptions,
	captionGlossaryRequestSchema,
} from "../../../shared/caption-glossary.ts";
import {
	applyCaptionStyle,
	captionStyleRequestSchema,
} from "../../../shared/caption-style.ts";
import { ConflictError } from "../store.ts";
import type { ProjectRoute } from "./registry.ts";

/**
 * Caption style, rechunking, and subtitle import. Rechunk and import live at
 * their own top-level actions; `POST /captions/rechunk` and
 * `POST /captions/import` are aliases (the built-in `POST /captions` handler
 * only answers the bare path).
 */
const captionStyleRoute: ProjectRoute = {
	scope: "project",
	action: "caption-style",
	method: "POST",
	operation: {
		id: "video_studio_caption_style",
		description:
			"Set the burned-in caption style for the project captions, or for one language track with trackId. mode 'merge' (default) overlays the given fields; 'replace' stores exactly `style` and an empty style clears it. Fields: presetId, fontFamily (a bundled family, the fallback), customFont {id, family} (an imported font from GET /fonts), systemFont (an installed family from GET /system-fonts; customFont wins when both are set), fontSize (fraction of canvas height), fontWeight, uppercase, color, highlightColor, outlineColor, outlineWidth, shadowDepth, backgroundColor, backgroundOpacity (above 0 draws a box), positionX/positionY (fractions of the canvas; positionY is the caption baseline), maxLines, wordAnimation (none|highlight|pop|bounce|box|karaoke|reveal). Requires the current project revision.",
		body: captionStyleRequestSchema,
	},
	handle: async ({ id, request, revisionedProjectEdit }) => {
		const input = captionStyleRequestSchema.parse(await request.json());
		return revisionedProjectEdit(
			id,
			input.revision,
			"The project changed. Reload before styling captions.",
			(project, assets) => applyCaptionStyle(project, assets, input)
		);
	},
};

const captionRechunkRoute: ProjectRoute = {
	scope: "project",
	action: "caption-rechunk",
	method: "POST",
	operation: {
		id: "video_studio_caption_rechunk",
		description:
			"Regroup the active captions (or a language track with trackId) and save the chunking on the project. chunking.mode: 'segments' keeps cues (splitting only those over maxWords/maxChars), 'words' regroups words up to maxWords (default 6) and maxChars (default 32), breaking at sentence ends, pauses, and speaker changes, 'single-word' shows one word per caption. minDuration grows short captions (extending into silence, then merging), closeGaps closes gaps shorter than it, and profanity 'mask' or 'remove' filters a bundled word list plus profanityWords. Speaker ids and word timings are preserved. Requires the current project revision.",
		body: captionRechunkRequestSchema,
	},
	handle: async ({ id, request, revisionedProjectEdit }) => {
		const input = captionRechunkRequestSchema.parse(await request.json());
		return revisionedProjectEdit(
			id,
			input.revision,
			"The project changed. Reload before rechunking captions.",
			(project, assets) => rechunkProject(project, assets, input)
		);
	},
};

const captionImportRoute: ProjectRoute = {
	scope: "project",
	action: "caption-import",
	method: "POST",
	operation: {
		id: "video_studio_caption_import",
		description:
			"Import SRT, WebVTT, or ASS/SSA subtitle text into the project captions or a language track (trackId). mode 'replace' (default) swaps the captions and 'append' adds to them. ASS override tags are stripped and \\N becomes a line break. With lenient true, malformed cues are skipped and reported as skipped [{line, reason}] instead of failing the import. Requires the current project revision.",
		body: captionImportRequestSchema,
	},
	handle: async ({ id, json, request, store }) => {
		const input = captionImportRequestSchema.parse(await request.json());
		const project = store.project(id);
		if (project.revision !== input.revision) {
			throw new ConflictError(
				"The project changed. Reload before importing captions."
			);
		}
		const result = importCaptions(project, store.assets(), input);
		return json({
			imported: result.imported,
			project: store.save(result.project),
			skipped: result.skipped,
		});
	},
};

const captionGlossaryRoute: ProjectRoute = {
	scope: "project",
	action: "caption-glossary",
	method: "POST",
	operation: {
		id: "video_studio_caption_glossary",
		description:
			"Fix names and terms: save a glossary of up to 200 {from, to} pairs on the project (glossary; omitted keeps the saved one) and, unless apply is false, replace every whole-word or whole-phrase match of from (ignoring case) with to in the source captions (line text and timed words, keeping word timing), in every caption language track with allTracks true, and in the finished transcripts of media on the timeline (transcripts, default true; each changed transcript gets a new revision). Returns the saved project, the glossary, caption replacements, and the asset ids whose transcripts changed. Requires the current project revision.",
		body: captionGlossaryRequestSchema,
	},
	handle: async ({ id, json, request, store }) => {
		const input = captionGlossaryRequestSchema.parse(await request.json());
		const project = store.project(id);
		if (project.revision !== input.revision) {
			throw new ConflictError(
				"The project changed. Reload before fixing names and terms."
			);
		}
		const result = applyCaptionGlossary(project, input);
		const transcripts: string[] = [];
		if (input.apply && input.transcripts && result.glossary.length) {
			for (const assetId of new Set(
				project.segments.map((segment) => segment.assetId)
			)) {
				const fixed = store.rewriteTranscriptText(assetId, (cues) => {
					const next = applyGlossaryToCaptions(cues, result.glossary);
					return next.replacements ? next.captions : cues;
				});
				if (fixed) {
					transcripts.push(assetId);
				}
			}
		}
		return json({
			glossary: result.glossary,
			project: store.save(result.project),
			replacements: result.replacements,
			transcripts,
		});
	},
};

/** The same handler at `POST /projects/:id/captions/<subaction>`. */
function captionsAlias(
	route: ProjectRoute,
	subaction: string,
	id: string
): ProjectRoute {
	return {
		...route,
		action: "captions",
		subaction,
		operation: {
			...route.operation,
			id,
			description: `Alias of POST /projects/{id}/${route.action} (same body and reply). ${route.operation.description}`,
		},
	};
}

export const routes: ProjectRoute[] = [
	captionStyleRoute,
	captionRechunkRoute,
	captionImportRoute,
	captionGlossaryRoute,
	captionsAlias(
		captionRechunkRoute,
		"rechunk",
		"video_studio_captions_rechunk"
	),
	captionsAlias(captionImportRoute, "import", "video_studio_captions_import"),
];
