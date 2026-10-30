/**
 * Project templates (W4-N2): save a project as a template, list built-in and
 * saved templates, and create a new project by filling a template's slots
 * from library media. Built-in templates are materialized on use from a
 * shared placeholder matte and a locally synthesized music bed.
 */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
	type Asset,
	type Project,
	validateProject,
} from "../../../shared/project.ts";
import {
	BUILT_IN_TEMPLATES,
	type BuiltInTemplate,
	builtInTemplate,
	builtInTemplateDuration,
	builtInTemplateProject,
	builtInTemplateSummary,
	TEMPLATE_PLACEHOLDER_COLOR,
	TEMPLATE_PLACEHOLDER_NAME,
} from "../../../shared/template-library.ts";
import {
	buildTemplateProject,
	fillTemplate,
	type InstantiateTemplateRequest,
	instantiateTemplateRequestSchema,
	saveTemplateRequestSchema,
	summarizeTemplate,
	type TemplateSummary,
	templateFillMedia,
} from "../../../shared/templates.ts";
import { createMatte } from "../matte.ts";
import { generateSoundtrack } from "../soundtrack.ts";
import type { StudioStore } from "../store.ts";
import type { StudioRoute, StudioRouteContext } from "./registry.ts";

/** Built-in templates first, then saved templates, most recent first. */
export function templateSummaries(store: StudioStore): TemplateSummary[] {
	const saved: TemplateSummary[] = [];
	for (const project of store.projects()) {
		if (project.template) {
			saved.push(summarizeTemplate(project, false));
		}
	}
	return [...BUILT_IN_TEMPLATES.map(builtInTemplateSummary), ...saved];
}

/**
 * Store `content` as a brand-new project. The empty project is removed again
 * when the content does not save, so a failure leaves no stray project.
 */
function storeAsNewProject(
	store: StudioStore,
	content: Project,
	title: string
): Project {
	const created = store.create(title);
	try {
		return store.save({
			...content,
			id: created.id,
			revision: created.revision,
			title,
			decisions: [],
		});
	} catch (error) {
		store.deleteProject(created.id, created.revision);
		throw error;
	}
}

/** Reuse the placeholder matte at this canvas size, or create it. */
async function placeholderMatte(
	store: StudioStore,
	template: BuiltInTemplate,
	signal: AbortSignal
): Promise<{ asset: Asset; created: boolean }> {
	const existing = store
		.assets()
		.find(
			(asset) =>
				asset.kind === "image" &&
				asset.derivation === "matte" &&
				asset.name === TEMPLATE_PLACEHOLDER_NAME &&
				asset.width === template.width &&
				asset.height === template.height &&
				existsSync(store.mediaPath(asset.id))
		);
	if (existing) {
		return { asset: existing, created: false };
	}
	const asset = await createMatte(
		store,
		{
			color: TEMPLATE_PLACEHOLDER_COLOR,
			height: template.height,
			name: TEMPLATE_PLACEHOLDER_NAME,
			width: template.width,
		},
		{ signal }
	);
	return { asset, created: true };
}

/**
 * Remove media this request created (the placeholder matte or generated
 * music) after the request failed, so a refused fill leaves no strays.
 * Best effort: a cleanup failure never hides the original error.
 */
async function discardCreatedAssets(
	store: StudioStore,
	created: readonly Asset[]
): Promise<void> {
	for (const asset of created) {
		try {
			store.discardAsset(asset.id);
			await rm(store.mediaPath(asset.id), { force: true });
			await rm(join(store.directory, "media", `${asset.id}.jpg`), {
				force: true,
			});
		} catch {
			// Keep going: the request error is what the caller needs to see.
		}
	}
}

/**
 * Fill a template into a new project; shared by `POST /template-instances`
 * and its alias `POST /templates/:id/instantiate`.
 */
async function instantiateTemplate(
	{ json, mediaSignal, request, soundtrackSignal, store }: StudioRouteContext,
	input: InstantiateTemplateRequest
): Promise<Response> {
	// Every per-asset check runs before any media is created.
	const media = templateFillMedia(store.assets(), input.assetIds);
	const template = input.templateId;
	const builtIn = builtInTemplate(template);
	if (!builtIn) {
		// Saved templates create no media; a missing id fails here.
		store.project(template);
	}
	const createdAssets: Asset[] = [];
	let filled: ReturnType<typeof fillTemplate>;
	let project: Project;
	try {
		let source: Project;
		if (builtIn) {
			const placeholder = await placeholderMatte(
				store,
				builtIn,
				mediaSignal(request)
			);
			if (placeholder.created) {
				createdAssets.push(placeholder.asset);
			}
			let music = media.find((asset) => asset.kind === "audio");
			if (!music && input.music !== false) {
				music = await generateSoundtrack(
					store,
					{
						bpm: builtIn.music.bpm,
						duration: builtInTemplateDuration(builtIn),
						mood: builtIn.music.mood,
						...(builtIn.music.layers ? { layers: builtIn.music.layers } : {}),
					},
					{ signal: soundtrackSignal(request) }
				);
				createdAssets.push(music);
			}
			source = builtInTemplateProject(builtIn, {
				placeholder: placeholder.asset,
				...(music ? { music } : {}),
			});
		} else {
			source = store.project(template);
		}
		const assets = store.assets();
		filled = fillTemplate(source, assets, input.assetIds);
		const title = input.title ?? source.title;
		validateProject({ ...filled.project, title }, assets);
		project = storeAsNewProject(store, filled.project, title);
	} catch (error) {
		await discardCreatedAssets(store, createdAssets);
		throw error;
	}
	return json(
		{
			adjustments: filled.adjustments,
			assignments: filled.assignments,
			createdAssets,
			project,
			unfilledSlotIds: filled.unfilledSlotIds,
			unusedAssetIds: filled.unusedAssetIds,
		},
		201
	);
}

/** `POST /templates/:id/instantiate` body: the template id is the path. */
const instantiateTemplateByIdRequestSchema =
	instantiateTemplateRequestSchema.omit({ templateId: true });

export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "save-template",
		method: "POST",
		operation: {
			id: "video_studio_save_template",
			description:
				"Save a copy of the project as a reusable template. `slots` lists the clips that become replaceable placeholders (optional `label`, and `fixedDuration`, default true, to keep the exact slot length). Every other clip, title, graphic, effect and timing stays as authored, so beat-aligned cuts stay on the beat. Slots are ordered by timeline position; multicam clips cannot be slots. The source project is unchanged. Requires the current revision; returns 201 {project, template} where template is the library summary.",
			body: saveTemplateRequestSchema,
		},
		handle: async ({ currentProject, id, json, request, store }) => {
			const input = saveTemplateRequestSchema.parse(await request.json());
			const source = currentProject(
				id,
				input.revision,
				"The project changed. Reload before saving it as a template."
			);
			const built = buildTemplateProject(source, store.assets(), input);
			const project = storeAsNewProject(store, built, built.title);
			return json(
				{ project, template: summarizeTemplate(project, false) },
				201
			);
		},
	},
	{
		scope: "root",
		path: "templates",
		method: "GET",
		operation: {
			id: "video_studio_list_templates",
			description:
				"List project templates: the eight built-ins (builtIn true: vlog intro, product promo, recap montage, quote card, podcast clip, slideshow, event highlight, tutorial step) and every saved template project. Each has id, title, description, category, canvas width and height, duration in seconds, and slots (id, label, kind video|image|audio|any, start, duration, fixedDuration).",
		},
		handle: ({ json, store }) => json({ templates: templateSummaries(store) }),
	},
	{
		scope: "root",
		path: "template-instances",
		method: "POST",
		operation: {
			id: "video_studio_instantiate_template",
			description:
				"Create a new project from a template (`templateId`: a built-in id or a saved template project id). `assetIds` fill the slots in order: each asset takes the next unfilled slot that accepts its kind (visual slots take video or stills, audio slots take audio). Stills hold for the slot length; longer video is trimmed; shorter video is slowed to fill a fixed-length slot (never below 0.1x) and otherwise ends early; audio is trimmed, never retimed. Slots without media keep their placeholder; extra media is reported unused. Built-ins use a shared gray placeholder matte and, unless `music` is false or an audio asset is given, a synthesized local music bed. Returns 201 {project, assignments, unfilledSlotIds, unusedAssetIds, adjustments (retimed|short|reveal-dropped), createdAssets}.",
			body: instantiateTemplateRequestSchema,
		},
		handle: async (context) =>
			instantiateTemplate(
				context,
				instantiateTemplateRequestSchema.parse(await context.request.json())
			),
	},
	{
		scope: "item",
		resource: "templates",
		action: "instantiate",
		method: "POST",
		operation: {
			id: "video_studio_instantiate_template_by_id",
			description:
				"Alias of POST /template-instances with the template id in the path: create a new project from the built-in or saved template `id`. Body {assetIds, title?, music?}; same fill rules and 201 reply as POST /template-instances.",
			body: instantiateTemplateByIdRequestSchema,
		},
		handle: async (context) =>
			instantiateTemplate(context, {
				...instantiateTemplateByIdRequestSchema.parse(
					await context.request.json()
				),
				templateId: context.id,
			}),
	},
];
