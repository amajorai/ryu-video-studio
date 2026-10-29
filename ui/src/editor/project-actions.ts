import { z } from "zod";
import { mergeApprovalPolicy } from "../../../shared/approval-policy.ts";
import type { TimelineRange } from "../../../shared/filler-words.ts";
import type { HighlightCandidate } from "../../../shared/highlights.ts";
import type { InterchangeFormat } from "../../../shared/interchange.ts";
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
import {
	download,
	loadAssets,
	request,
	studioResponseSchema,
} from "../bridge.ts";
import { planIsCurrent } from "../editing-ui.ts";
import {
	createHighlightShort,
	withHighlightMarker,
} from "../HighlightsPanel.tsx";
import { clock, type Job, jobResponseSchema, message } from "./format.ts";
import { emptyHistory, mapHistory, recordHistory } from "./history.ts";
import type { EditorRuntime } from "./runtime.ts";

export type MulticamEditInput =
	| Omit<z.input<typeof multicamCreateRequestSchema>, "revision">
	| Omit<z.input<typeof multicamChangeRequestSchema>, "revision">
	| Omit<z.input<typeof multicamUngroupRequestSchema>, "revision">;

/** Forget undo history (another project, or a revision reloaded from disk). */
export function resetHistory(runtime: EditorRuntime) {
	runtime.store.setState({ history: emptyHistory() });
}

/** Record `previous` as an undo step without changing the project. */
export function pushHistory(
	runtime: EditorRuntime,
	previous: Project,
	label: string
) {
	runtime.store.setState((state) => ({
		history: recordHistory(state.history, previous, label),
	}));
}

/** Show `next` as a freshly opened project: no selection, history, or range. */
function openFresh(
	runtime: EditorRuntime,
	next: Project,
	options: { resetRange: boolean; resetTime: boolean }
) {
	runtime.setProject(next);
	runtime.setSelected(null);
	resetHistory(runtime);
	if (options.resetTime) {
		runtime.setTime(0);
	}
	if (options.resetRange) {
		runtime.setRangeStart(0);
		runtime.setRangeEnd(1);
	}
	runtime.setRangeMarked(false);
}

/** Prepend `next` to the project list, replacing an older copy. */
const withProject = (projects: Project[], next: Project) => [
	next,
	...projects.filter((item) => item.id !== next.id),
];

export const createProject = (runtime: EditorRuntime) =>
	runtime.act(async () => {
		if (runtime.dirty) {
			await runtime.save();
		}
		const next = projectSchema.parse(
			await request(studioResponseSchema, "/projects", "POST", {
				title: `Untitled film ${runtime.projects.length + 1}`,
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

/** ZIP archives start with "PK\x03\x04". */
async function isZipFile(file: Blob): Promise<boolean> {
	const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
	return head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4;
}

const libraryImportSchema = z
	.object({ added: z.array(z.string()), reused: z.array(z.string()) })
	.default({ added: [], reused: [] });

const archiveChunkSchema = z.object({
	data: z.string(),
	done: z.boolean(),
	offset: z.number(),
	size: z.number(),
});

/**
 * Build a self-contained project archive (package JSON plus every referenced
 * media file) on the node and download it in chunks.
 */
export const downloadProjectArchive = (
	runtime: EditorRuntime,
	onProgress?: (fraction: number) => void
) =>
	runtime.act(async () => {
		const saved = runtime.dirty ? await runtime.save() : runtime.project;
		if (!saved) {
			return;
		}
		runtime.setStatus("Packing the project and its media…");
		const built = await request(
			z.object({
				archiveId: z.string(),
				assets: z.number(),
				filename: z.string(),
				fonts: z.number().default(0),
				luts: z.number().default(0),
				missing: z.array(z.string()),
				missingFonts: z.array(z.string()).default([]),
				missingLuts: z.array(z.string()).default([]),
				size: z.number(),
			}),
			`/projects/${saved.id}/package-archive`
		);
		const parts: Uint8Array<ArrayBuffer>[] = [];
		for (let offset = 0; ; ) {
			const chunk = await request(
				archiveChunkSchema,
				`/package-archive-data?id=${encodeURIComponent(built.archiveId)}&offset=${offset}`
			);
			const bytes = Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0));
			parts.push(bytes);
			offset += bytes.length;
			onProgress?.(built.size ? offset / built.size : 1);
			runtime.setStatus(
				`Downloading the project archive · ${Math.round((offset / Math.max(1, built.size)) * 100)}%`
			);
			if (chunk.done) {
				break;
			}
			if (!bytes.length) {
				throw new Error("The project archive download stopped early.");
			}
		}
		download(new Blob(parts, { type: "application/zip" }), built.filename);
		runtime.setStatus(archiveDownloadStatus(built));
	});

const plural = (count: number, noun: string) =>
	`${count} ${noun}${count === 1 ? "" : "s"}`;

/** The " plus 2 LUTs and 1 font" part of an archive status, or "". */
function libraryPart(luts: number, fonts: number): string {
	const parts = [
		...(luts ? [plural(luts, "LUT")] : []),
		...(fonts ? [plural(fonts, "font")] : []),
	];
	return parts.length ? ` plus ${parts.join(" and ")}` : "";
}

/** Status line after a project archive download. */
export function archiveDownloadStatus(built: {
	assets: number;
	fonts: number;
	luts: number;
	missing: string[];
	missingFonts: string[];
	missingLuts: string[];
}): string {
	const media = built.missing.length
		? `${built.assets - built.missing.length} of ${built.assets} media files`
		: plural(built.assets, "media file");
	const left = [
		...(built.missing.length
			? [plural(built.missing.length, "offline file")]
			: []),
		...(built.missingLuts.length
			? [plural(built.missingLuts.length, "missing LUT")]
			: []),
		...(built.missingFonts.length
			? [plural(built.missingFonts.length, "missing font")]
			: []),
	];
	return `Project archive downloaded with ${media}${libraryPart(built.luts, built.fonts)}${left.length ? `; ${left.join(", ")} left out` : ""}.`;
}

/** Upload a project archive in chunks and import it as a new project. */
async function importProjectArchive(runtime: EditorRuntime, file: File) {
	const started = await request(
		z.object({ chunkSize: z.number(), id: z.string() }),
		"/package-archive-imports",
		"POST",
		{ size: file.size }
	);
	for (let offset = 0; offset < file.size; ) {
		const bytes = new Uint8Array(
			await file.slice(offset, offset + started.chunkSize).arrayBuffer()
		);
		let binary = "";
		for (const byte of bytes) {
			binary += String.fromCharCode(byte);
		}
		const sent = await request(
			z.object({ offset: z.number() }),
			"/package-archive-import-chunks",
			"POST",
			{ data: btoa(binary), id: started.id, offset }
		);
		offset = sent.offset;
		runtime.setStatus(
			`Uploading the project archive · ${Math.round((offset / file.size) * 100)}%`
		);
	}
	runtime.setStatus("Unpacking the project archive and its media…");
	const result = await request(
		z.object({
			added: z.array(z.string()),
			fonts: libraryImportSchema,
			luts: libraryImportSchema,
			project: projectSchema,
			reused: z.array(z.string()),
		}),
		"/package-archive-import-finish",
		"POST",
		{ id: started.id }
	);
	runtime.setAssets(await loadAssets());
	runtime.setProjects((current) => withProject(current, result.project));
	openFresh(runtime, result.project, { resetRange: false, resetTime: false });
	runtime.setDirty(false);
	runtime.setStatus(
		`Project archive imported as a new project with ${plural(result.added.length, "new media file")}${libraryPart(result.luts.added.length, result.fonts.added.length)}${result.reused.length ? ` (${result.reused.length} already in the library)` : ""}.`
	);
}

export async function importPackage(runtime: EditorRuntime, file: File) {
	if (await isZipFile(file)) {
		await importProjectArchive(runtime, file);
		return;
	}
	const bundle = z.json().parse(JSON.parse(await file.text()));
	const imported = await request(
		projectSchema,
		"/projects/package",
		"POST",
		bundle
	);
	runtime.setProjects((current) => withProject(current, imported));
	openFresh(runtime, imported, { resetRange: false, resetTime: false });
	runtime.setDirty(false);
	runtime.setStatus("Production package imported as a new project.");
}

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

export const captureFrame = (runtime: EditorRuntime) =>
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
			`Captured a PNG frame at ${clock(time)} and added it to the library.`
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

export const createSequenceClip = (runtime: EditorRuntime, source: Project) =>
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
		runtime.setStatus(`${asset.name} added to the media library.`);
	});

export function markHighlight(
	runtime: EditorRuntime,
	candidate: HighlightCandidate,
	rank: number,
	stamp: string
) {
	const { project } = runtime;
	if (!project) {
		return;
	}
	if (!planIsCurrent(stamp, project)) {
		runtime.setStatus(
			"The timeline changed since these highlights were found. Find them again before marking one."
		);
		return;
	}
	try {
		runtime.localEdit(
			withHighlightMarker(project, candidate, rank),
			`Highlight ${rank} marked at ${clock(candidate.start)}.`
		);
	} catch (error) {
		runtime.setStatus(message(error));
	}
}

export const makeHighlightShort = (
	runtime: EditorRuntime,
	candidate: HighlightCandidate,
	rank: number,
	stamp: string
) =>
	runtime.act(async () => {
		const current = runtime.latestProject.current;
		if (!(current && planIsCurrent(stamp, current))) {
			runtime.setStatus(
				"The timeline changed since these highlights were found. Find them again before making a short."
			);
			return;
		}
		const saved = await runtime.ensureSaved();
		if (!saved) {
			return;
		}
		const short = await createHighlightShort(saved, candidate, rank);
		runtime.setProjects((projects) => withProject(projects, short));
		runtime.latestProject.current = short;
		openFresh(runtime, short, { resetRange: false, resetTime: true });
		runtime.setDirty(false);
		runtime.setStatus(
			`${short.title} created as an alternate cut with only highlight ${rank}.`
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
