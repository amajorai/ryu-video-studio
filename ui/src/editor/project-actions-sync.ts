import { activeLocale, numberFormatter, translate as tl } from "@ryu/i18n/core";
import { z } from "zod";
import { projectSchema } from "../../../shared/project.ts";
import { syncDriftNotice } from "../../../shared/sync.ts";
import { request } from "../bridge.ts";
import type { EditorRuntime } from "./runtime.ts";

/**
 * Line clips up against a reference (`POST /projects/:id/sync`) and report
 * the alignment, drift corrections and sidecar warnings in one status line.
 */
export const syncProject = (
	runtime: EditorRuntime,
	input: {
		driftCorrection?: boolean;
		mode: "auto" | "manual" | "timecode";
		offsetSeconds?: number;
		referenceClipId: string;
		targetClipIds: string[];
	}
) =>
	runtime.act(async () => {
		const previous = runtime.project;
		if (!previous) {
			return;
		}
		const saved = runtime.dirty ? await runtime.save() : previous;
		const result = await request(
			z.object({
				matches: z.array(
					z.object({
						alignmentOffsetSeconds: z.number(),
						confidence: z.number(),
						drift: z
							.object({
								status: z.enum([
									"corrected",
									"negligible",
									"too-large",
									"disabled",
									"too-short",
									"unmeasured",
								]),
							})
							.optional(),
						method: z.string(),
						offsetSeconds: z.number(),
					})
				),
				project: projectSchema,
				shiftedFrames: z.number(),
				warnings: z.array(z.string()).default([]),
			}),
			`/projects/${saved.id}/sync`,
			"POST",
			{ ...input, revision: saved.revision }
		);
		runtime.commitServerProject(result.project, previous);
		runtime.setSelected(input.referenceClipId);
		const reference = result.project.segments.find(
			(segment) => segment.id === input.referenceClipId
		);
		if (reference) {
			runtime.setTime(reference.start);
		}
		const percent = numberFormatter(activeLocale(), {
			maximumFractionDigits: 0,
			style: "percent",
		});
		const confidence = result.matches
			.map((match) => percent.format(match.confidence))
			.join(", ");
		// Sidecar warnings are catalog sentences (or templates); translate each
		// before joining so the status line never mixes languages.
		const drift = syncDriftNotice(
			result.matches,
			result.warnings.map((warning) => tl(warning)),
			tl
		);
		const values = {
			confidence,
			count: result.matches.length,
			verb: input.mode === "manual" ? tl("Shifted") : tl("Aligned"),
		};
		const summary = confidence
			? tl(
					"{verb} {count, plural, one {# clip} other {# clips}} · confidence {confidence}.",
					values
				)
			: tl("{verb} {count, plural, one {# clip} other {# clips}}.", values);
		runtime.setStatus(drift ? `${summary} ${drift}` : summary);
	});
