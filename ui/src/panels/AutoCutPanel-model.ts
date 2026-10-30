import { z } from "zod";
import {
	type AutoEditAspect,
	type AutoEditInput,
	type AutoEditStyle,
	MAX_AUTO_EDIT_SECONDS,
	MAX_AUTO_EDIT_SOURCES,
	MIN_AUTO_EDIT_SECONDS,
	type ShortsInput,
} from "../../../shared/auto-edit.ts";
import {
	type Asset,
	type Project,
	projectSchema,
} from "../../../shared/project.ts";
import type { EditorRuntime } from "../editor/runtime.ts";

export interface AutoCutForm {
	aspect: AutoEditAspect;
	assetIds: string[];
	captions: boolean;
	duration: number;
	musicAssetId: string;
	style: AutoEditStyle;
}

export interface ShortsForm {
	aspect: AutoEditAspect;
	captions: boolean;
	count: number;
	exportShorts: boolean;
	maxSeconds: number;
	minSeconds: number;
}

/** The `POST /auto-edit` body for the form. */
export function autoCutBody(form: AutoCutForm): AutoEditInput {
	return {
		aspect: form.aspect,
		assetIds: form.assetIds.slice(0, MAX_AUTO_EDIT_SOURCES),
		captions: form.captions,
		duration: Math.min(
			MAX_AUTO_EDIT_SECONDS,
			Math.max(MIN_AUTO_EDIT_SECONDS, form.duration)
		),
		style: form.style,
		...(form.musicAssetId ? { musicAssetId: form.musicAssetId } : {}),
	};
}

/** The `POST /projects/:id/shorts` body for the form. */
export function shortsBody(form: ShortsForm, revision: number): ShortsInput {
	return {
		aspect: form.aspect,
		captions: form.captions,
		count: form.count,
		export: form.exportShorts,
		maxSeconds: Math.max(form.minSeconds, form.maxSeconds),
		minSeconds: form.minSeconds,
		revision,
	};
}

export const autoCutResponseSchema = z.object({
	beatSource: z.enum(["detected", "estimate", "none"]),
	captions: z.number(),
	duration: z.number(),
	project: projectSchema,
	slots: z.array(z.object({ end: z.number(), start: z.number() })),
	transitions: z.number(),
});
export type AutoCutResponse = z.infer<typeof autoCutResponseSchema>;

export const shortsResponseSchema = z.object({
	shorts: z.array(
		z.object({
			end: z.number(),
			exportError: z.string().optional(),
			job: z.object({ id: z.string() }).passthrough().optional(),
			project: projectSchema,
			start: z.number(),
			title: z.string(),
		})
	),
});
export type ShortsResponse = z.infer<typeof shortsResponseSchema>;

const BEAT_TEXT: Record<AutoCutResponse["beatSource"], string> = {
	detected: "cut on detected beats",
	estimate: "cut on estimated beats (detect beats on the music for exact bars)",
	none: "cut on a steady grid",
};

/** One status line describing an AutoCut result. */
export function autoCutSummary(result: AutoCutResponse): string {
	const clips = result.slots.length;
	const parts = [
		`${result.project.title}: ${clips} clip${clips === 1 ? "" : "s"} over ${result.duration.toFixed(1)} s, ${BEAT_TEXT[result.beatSource]}`,
	];
	if (result.transitions > 0) {
		parts.push(
			`${result.transitions} transition${result.transitions === 1 ? "" : "s"}`
		);
	}
	if (result.captions > 0) {
		parts.push(`${result.captions} caption${result.captions === 1 ? "" : "s"}`);
	}
	return `${parts.join(", ")}.`;
}

/** Media AutoCut can cut from: video and stills. */
export const autoCutSources = (assets: readonly Asset[]) =>
	assets.filter((asset) => asset.kind !== "audio");

export const errorText = (error: unknown, fallback: string) =>
	error instanceof Error ? error.message : fallback;

export function remember(runtime: EditorRuntime, project: Project) {
	runtime.setProjects((projects) => [
		...projects.filter((item) => item.id !== project.id),
		project,
	]);
}
