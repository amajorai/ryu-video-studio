import { z } from "zod";
import type { Project } from "../../../shared/project.ts";
import { projectSchema } from "../../../shared/project.ts";
import {
	type ExportJobOutput,
	exportJobOutputSchema,
} from "../../../shared/render-options.ts";
import type { RenderReview } from "../../../shared/render-review.ts";
import { renderReviewSchema } from "../../../shared/render-review.ts";
import { localizedErrorMessage } from "../i18n/format.ts";

/** An export job as the sidecar's render queue reports it. */
export interface Job {
	codec?: Project["exportCodec"];
	error?: string;
	/** What the export produces, and the request it was queued with. */
	export?: ExportJobOutput;
	id: string;
	progress: number;
	projectId: string;
	review?: RenderReview;
	revision: number;
	status: string;
}

export const jobResponseSchema: z.ZodType<Job> = z.object({
	codec: projectSchema.shape.exportCodec.optional(),
	error: z.string().optional(),
	// A job summary this editor cannot read is dropped, not fatal.
	export: exportJobOutputSchema.optional().catch(undefined),
	id: z.string(),
	progress: z.number(),
	projectId: z.string(),
	review: renderReviewSchema.optional(),
	revision: z.number(),
	status: z.string(),
});

/** `m:ss.s` readout used across the editor's status messages. */
export const clock = (value: number) =>
	`${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, "0")}`;

/** Download container for a finished export. */
export const exportFormat = (codec: Job["codec"]) =>
	codec === "prores"
		? { extension: "mov", label: "MOV", mime: "video/quicktime" }
		: { extension: "mp4", label: "MP4", mime: "video/mp4" };

/**
 * A user-facing message for a failed operation. Sidecar errors that name a
 * clip, track or scene are shown in the host language.
 */
export const message = (error: unknown): string =>
	localizedErrorMessage(error) ?? "The operation failed.";

export const defaultMarkerColor = "#f59e0b";
