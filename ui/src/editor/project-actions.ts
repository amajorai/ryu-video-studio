import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { z } from "zod";
import { mergeApprovalPolicy } from "../../../shared/approval-policy.ts";
import type { TimelineRange } from "../../../shared/filler-words.ts";
import type {
	multicamChangeRequestSchema,
	multicamCreateRequestSchema,
	multicamUngroupRequestSchema,
} from "../../../shared/multicam.ts";
import {
	applySceneDraft,
	sceneDraftRequest,
} from "../../../shared/production-prompts.ts";
import {
	assetSchema,
	type Project,
	projectSchema,
} from "../../../shared/project.ts";
import { syncDriftNotice } from "../../../shared/sync.ts";
import { request, studioResponseSchema } from "../bridge.ts";
import { clock, type Job, jobResponseSchema, message } from "./format.ts";
import { mapHistory } from "./history.ts";
import { openFresh, withProject } from "./project-actions-open.ts";
import type { EditorRuntime } from "./runtime.ts";

export {
	archiveDownloadStatus,
	downloadProjectArchive,
	importPackage,
} from "./project-actions-archive.ts";
export {
	makeHighlightShort,
	markHighlight,
} from "./project-actions-highlights.ts";
export { downloadInterchange } from "./project-actions-interchange.ts";
export { pushHistory, resetHistory } from "./project-actions-open.ts";

export type MulticamEditInput =
	| Omit<z.input<typeof multicamCreateRequestSchema>, "revision">
	| Omit<z.input<typeof multicamChangeRequestSchema>, "revision">
	| Omit<z.input<typeof multicamUngroupRequestSchema>, "revision">;

/** English fallback until a caller passes the Companion's `tl`. */
const englishMessages: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

export const createProject = (
	runtime: EditorRuntime,
	tl: LiteralMessage = englishMessages
) =>
	runtime.act(async () => {
		if (runtime.dirty) {
			await runtime.save();
		}
		const next = projectSchema.parse(
			await request(studioResponseSchema, "/projects", "POST", {
				title: tl("Untitled film {number}", {
					number: String(runtime.projects.length + 1),
				}),
			})
		);
		runtime.setProjects([next, ...runtime.projects]);
		openFresh(runtime, next, { resetRange: true, resetTime: true });
		runtime.setStatus("Project created. Import footage, audio, or images.");
	});

export const duplicateProject = (runtime: EditorRuntime) =>
	runtime.act(async () => {
		if (!runtime.project) {
			return;
		}
		const saved = runtime.dirty ? await runtime.save() : runtime.project;
		const next = projectSchema.parse(
			await request(
				studioResponseSchema,
				`/projects/${saved.id}/duplicate`,
				"POST",
				{ title: `${saved.title} copy` }
			)
		);
		runtime.setProjects((current) => [next, ...current]);
		openFresh(runtime, next, { resetRange: true, resetTime: true });
		runtime.setStatus(
			"Project duplicated. This alternate cut has its own revision history."
		);
	});

export const openProject = (runtime: EditorRuntime, id: string) =>
	runtime.act(async () => {
		if (runtime.dirty) {
			await runtime.save();
		}
		const next = projectSchema.parse(
			await request(studioResponseSchema, `/projects/${id}`)
		);
		openFresh(runtime, next, { resetRange: true, resetTime: true });
		runtime.setPlaying(false);
	});

export const captureFrame = (
	runtime: EditorRuntime,
	tl: LiteralMessage = englishMessages
) =>
	runtime.act(async () => {
		const saved = runtime.dirty ? await runtime.save() : runtime.project;
		if (!saved) {
			return;
		}
		const { time } = runtime;
		const asset = await request(
			assetSchema,
			`/projects/${saved.id}/capture-frame`,
			"POST",
			{
				name: `${saved.title} frame ${clock(time)}`,
				revision: saved.revision,
				time,
			}
		);
		runtime.setAssets((current) => [asset, ...current]);
		runtime.setPanel("media");
		runtime.setStatus(
			tl("Captured a PNG frame at {time} and added it to the library.", {
				time: clock(time),
			})
		);
	});

export const changeApprovalRequirement = (runtime: EditorRuntime) =>
	runtime.act(async () => {
		const { project } = runtime;
		if (!project) {
			return;
		}
		const result = projectSchema.parse(
			await request(
				studioResponseSchema,
				`/projects/${project.id}/approval-policy`,
				"POST",
				{
					requireApproval: !project.requireApproval,
					revision: project.revision,
				}
			)
		);
		const mergePolicy = (current: Project): Project =>
			mergeApprovalPolicy(current, result);
		runtime.setProject((current) => (current ? mergePolicy(current) : current));
		runtime.setProjects((current) => current.map(mergePolicy));
		runtime.store.setState((state) => ({
			history: mapHistory(state.history, mergePolicy),
		}));
		runtime.setStatus("Scene approval requirement saved.");
	});

export async function appendProductionDecision(
	runtime: EditorRuntime,
	decision: Omit<Project["decisions"][number], "id" | "createdAt">
) {
	const { project } = runtime;
	if (!project || runtime.busy) {
		return false;
	}
	let appended = false;
	await runtime.act(async () => {
		const next = projectSchema.parse(
			await request(
				studioResponseSchema,
				`/projects/${project.id}/decisions`,
				"POST",
				{ ...decision, revision: project.revision }
			)
		);
		runtime.setProject((current) =>
			current?.id === next.id && current.revision <= next.revision
				? {
						...current,
						decisions: next.decisions,
						revision: next.revision,
						updatedAt: next.updatedAt,
					}
				: current
		);
		runtime.setProjects((current) => withProject(current, next));
		runtime.setStatus("Decision appended.");
		appended = true;
	});
	return appended;
}

/** Ask Ryu's model for draft scenes; editing continues while it runs. */
export async function draftScenes(runtime: EditorRuntime) {
	const { project } = runtime;
	if (!project || runtime.drafting) {
		return;
	}
	runtime.setDrafting(true);
	runtime.setStatus("Drafting scenes with Ryu. You can continue editing.");
	try {
		const complete = window.ryu?.model?.complete;
		if (!complete) {
			throw new Error("Ryu's model service is unavailable.");
		}
		const result = await complete(sceneDraftRequest(project.brief));
		if (!runtime.latestProject.current) {
			throw new Error("The project was closed during drafting.");
		}
		runtime.edit(
			(current) =>
				applySceneDraft(
					current,
					{ brief: project.brief, id: project.id },
					JSON.parse(result)
				),
			"Draft scenes"
		);
		runtime.setStatus(
			"Draft scenes added for review. No media has been generated."
		);
	} catch (error) {
		runtime.setStatus(message(error));
	} finally {
		runtime.setDrafting(false);
	}
}

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
		const confidence = result.matches
			.map((match) => `${Math.round(match.confidence * 100)}%`)
			.join(", ");
		const drift = syncDriftNotice(result.matches, result.warnings);
		runtime.setStatus(
			`${input.mode === "manual" ? "Shifted" : "Aligned"} ${result.matches.length} clip${result.matches.length === 1 ? "" : "s"}${confidence ? ` · confidence ${confidence}` : ""}.${drift ? ` ${drift}` : ""}`
		);
	});

export const manageMulticam = (
	runtime: EditorRuntime,
	body: MulticamEditInput,
	statusText: string
) =>
	runtime.act(async () => {
		const previous = runtime.project;
		if (!previous) {
			return;
		}
		const saved = runtime.dirty ? await runtime.save() : previous;
		const result = await request(
			z.object({
				group: projectSchema.shape.multicamGroups.unwrap().element.optional(),
				project: projectSchema,
			}),
			`/projects/${saved.id}/multicam`,
			"POST",
			{ ...body, revision: saved.revision }
		);
		runtime.commitServerProject(result.project, previous);
		runtime.setSelected(null);
		if (result.group) {
			runtime.setTime(result.group.start);
		}
		runtime.setStatus(statusText);
	});

/**
 * Run a revision-checked project route that returns the saved project (recipe
 * apply, storyboard assembly), keeping the pre-route timeline as an undo step.
 */
export const applyProjectRoute = (
	runtime: EditorRuntime,
	action: "recipe" | "assemble",
	body: Record<string, unknown>,
	statusText: string
) =>
	runtime.act(async () => {
		const previous = runtime.project;
		if (!previous) {
			return;
		}
		const saved = runtime.dirty ? await runtime.save() : previous;
		const result = projectSchema.parse(
			await request(
				studioResponseSchema,
				`/projects/${saved.id}/${action}`,
				"POST",
				{ ...body, revision: saved.revision }
			)
		);
		runtime.commitServerProject(result, previous);
		runtime.setSelected(null);
		runtime.setTime(0);
		runtime.setStatus(statusText);
	});

export const approveScene = (
	runtime: EditorRuntime,
	scene: Project["scenes"][number]
) =>
	runtime.act(async () => {
		const { project } = runtime;
		if (!project) {
			return;
		}
		const saved = runtime.dirty ? await runtime.save() : project;
		const result = projectSchema.parse(
			await request(
				studioResponseSchema,
				`/projects/${project.id}/approve-scene`,
				"POST",
				{
					approved: !scene.approved,
					revision: saved.revision,
					sceneId: scene.id,
				}
			)
		);
		runtime.setProject(result);
		runtime.setDirty(false);
		runtime.setStatus("Scene approval saved.");
	});

export const createSequenceClip = (
	runtime: EditorRuntime,
	source: Project,
	tl: LiteralMessage = englishMessages
) =>
	runtime.act(async () => {
		const { project } = runtime;
		if (!project) {
			return;
		}
		const saved = runtime.dirty ? await runtime.save() : project;
		const asset = await request(
			assetSchema,
			`/projects/${saved.id}/sequence`,
			"POST",
			{
				name: `Sequence · ${source.title}`,
				revision: saved.revision,
				sourceProjectId: source.id,
			}
		);
		runtime.setAssets((current) => [asset, ...current]);
		runtime.setProject(saved);
		runtime.setStatus(
			tl("{name} added to the media library.", { name: asset.name })
		);
	});

export const removeTimelineRanges = (
	runtime: EditorRuntime,
	ranges: TimelineRange[],
	description: string,
	stamp: string
) =>
	runtime.routeEdit(
		"remove-words",
		{ ranges },
		() =>
			`Removed ${ranges.length} ${description} range${ranges.length === 1 ? "" : "s"} and rippled later layers.`,
		{ planStamp: stamp }
	);

export const retryExport = (runtime: EditorRuntime, job: Job) =>
	runtime.act(async () => {
		const { project } = runtime;
		if (!project || job.projectId !== project.id) {
			throw new Error(
				"Select the project that owns this export before retrying."
			);
		}
		if (job.revision !== project.revision) {
			throw new Error(
				"This export belongs to an older revision. Export the current revision instead."
			);
		}
		// Retry the same export (range, format, codec, overrides) it was
		// queued with; legacy jobs without a recorded request use the defaults.
		const original = job.export?.request;
		const saveAsAsset = job.export?.saveAsAsset;
		const body =
			original || saveAsAsset
				? {
						...(original ?? {}),
						...(saveAsAsset ? { saveAsAsset } : {}),
						revision: project.revision,
					}
				: undefined;
		const next = await request(
			jobResponseSchema,
			`/projects/${project.id}/render`,
			"POST",
			body
		);
		runtime.registerJob(next);
		runtime.setStatus("Retrying the saved timeline export.");
	});

export function newScene(runtime: EditorRuntime) {
	const { project } = runtime;
	if (!project) {
		return;
	}
	runtime.edit(
		{
			...project,
			scenes: [
				...project.scenes,
				{
					approved: false,
					assetIds: [],
					duration: 5,
					id: crypto.randomUUID(),
					prompt: "",
					script: "",
					sourceIn: 0,
					title: `Scene ${project.scenes.length + 1}`,
				},
			],
		},
		"Add scene"
	);
}
