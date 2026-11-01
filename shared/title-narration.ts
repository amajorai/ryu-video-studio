import { z } from "zod";
import {
	type Asset,
	idSchema,
	newSegment,
	type Project,
	validateProject,
} from "./project.ts";
import { firstFreeTrack } from "./track-placement.ts";

/** Lowest track narration lands on: track 0 stays the picture lane. */
const NARRATION_FROM_TRACK = 1;

/**
 * Text to speak for a title layer: its lines joined into sentences, with
 * runs of whitespace collapsed. A lower third's "Name · Role" separator is
 * read as a pause. Empty when the title holds no speakable text.
 */
export function titleNarrationText(text: string): string {
	return text
		.split(/\r?\n/)
		.map((line) => line.replace(/\s*[·•|]\s*/g, ", ").trim())
		.filter(Boolean)
		.map((line) => (/[.!?…:;,]$/.test(line) ? line : `${line}.`))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

export const titleNarrationRequestSchema = z
	.object({
		/** The title layer the narration speaks. */
		titleId: idSchema,
		/** The generated narration audio, already in the library. */
		assetId: idSchema,
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type TitleNarrationRequest = z.infer<typeof titleNarrationRequestSchema>;

export interface TitleNarrationPlacement {
	project: Project;
	/** The new narration clip. */
	segmentId: string;
	track: number;
}

/**
 * Place a narration asset as an audio clip starting at a title's start, on
 * the lowest free, unlocked, visible audio track at or above track 1 (a new
 * track when every existing one is taken over the clip's span).
 */
export function placeTitleNarration(
	project: Project,
	assets: readonly Asset[],
	input: Pick<TitleNarrationRequest, "assetId" | "titleId">
): TitleNarrationPlacement {
	const title = project.titles.find((item) => item.id === input.titleId);
	if (!title) {
		throw new Error("That title is no longer in the project.");
	}
	const asset = assets.find((item) => item.id === input.assetId);
	if (!asset) {
		throw new Error("The narration audio is not in the library.");
	}
	if (asset.kind !== "audio") {
		throw new Error("Title narration must be an audio asset.");
	}
	const segment = newSegment(asset, title.start, NARRATION_FROM_TRACK);
	const end = title.start + asset.duration;
	const track = firstFreeTrack(project, title.start, end, {
		assets,
		from: NARRATION_FROM_TRACK,
		kind: "audio",
	});
	if (track === undefined) {
		throw new Error("No free audio track can hold this narration.");
	}
	const placed = { ...segment, track };
	const next = validateProject(
		{ ...project, segments: [...project.segments, placed] },
		[...assets]
	);
	return { project: next, segmentId: placed.id, track };
}
