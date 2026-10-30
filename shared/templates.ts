import { z } from "zod";
import { retimeKeyframes } from "./animation.ts";
import { MIN_CLIP_SPEED } from "./audio.ts";
import { restoredVideo } from "./detach-audio.ts";
import {
	type Asset,
	fitEdgeTransitions,
	idSchema,
	type Project,
	type Segment,
	segmentDuration,
} from "./project.ts";
import type { ProjectTemplate, TemplateSlot } from "./schema/template.ts";
import { studioError } from "./studio-error.ts";
import { revealCovered } from "./track-placement.ts";

type TemplateSlotKind = TemplateSlot["kind"];

/**
 * Project templates (W4-N2). A template is an ordinary project whose
 * `template.slots` name replaceable clips. Everything else in the project
 * (titles, graphics, effects, timing, fixed clips) is kept as authored.
 * Saving a template copies a project and marks the chosen clips as slots;
 * using one fills the slots from media in order and returns a plain project
 * (no `template`) ready to edit.
 */

/** Most slots a saved template may declare (matches the schema bound). */
export const MAX_TEMPLATE_SLOTS = 100;
/** Most media a single instantiation may receive. */
export const MAX_TEMPLATE_ASSETS = 100;
/** Shortest clip a fill may produce, in seconds (the project validator's floor). */
const MIN_FILLED_SECONDS = 0.04;
const EPSILON = 1e-6;

const slotLabelSchema = z.string().trim().min(1).max(80);

export const saveTemplateRequestSchema = z
	.object({
		/** Clips that become slots; every other clip stays fixed content. */
		slots: z
			.array(
				z
					.object({
						segmentId: idSchema,
						label: slotLabelSchema.optional(),
						/** Absent means true: the slot keeps its exact length. */
						fixedDuration: z.boolean().optional(),
					})
					.strict()
			)
			.min(1)
			.max(MAX_TEMPLATE_SLOTS),
		title: z.string().trim().min(1).max(200).optional(),
		description: z.string().max(2000).optional(),
		category: z.string().trim().max(40).optional(),
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type SaveTemplateRequest = z.infer<typeof saveTemplateRequestSchema>;

export const instantiateTemplateRequestSchema = z
	.object({
		/** A built-in template id or a saved template project id. */
		templateId: idSchema,
		/** Media that fill the slots, in order. */
		assetIds: z.array(idSchema).max(MAX_TEMPLATE_ASSETS),
		title: z.string().trim().min(1).max(200).optional(),
		/**
		 * Built-in templates only: whether to synthesize their local music bed.
		 * Absent means true. An audio asset in `assetIds` replaces the music.
		 */
		music: z.boolean().optional(),
	})
	.strict();
export type InstantiateTemplateRequest = z.infer<
	typeof instantiateTemplateRequestSchema
>;

export const templateSlotSummarySchema = z
	.object({
		id: idSchema,
		label: slotLabelSchema,
		kind: z.enum(["video", "image", "audio", "any"]),
		start: z.number(),
		duration: z.number(),
		fixedDuration: z.boolean(),
	})
	.strict();
export type TemplateSlotSummary = z.infer<typeof templateSlotSummarySchema>;

export const templateSummarySchema = z
	.object({
		id: idSchema,
		title: z.string(),
		description: z.string(),
		category: z.string(),
		builtIn: z.boolean(),
		width: z.number().int(),
		height: z.number().int(),
		duration: z.number(),
		slots: z.array(templateSlotSummarySchema),
	})
	.strict();
export type TemplateSummary = z.infer<typeof templateSummarySchema>;

export const templatesResponseSchema = z
	.object({ templates: z.array(templateSummarySchema) })
	.strict();

export const templateAdjustmentSchema = z
	.object({
		segmentId: idSchema,
		change: z.enum(["retimed", "short", "reveal-dropped"]),
	})
	.strict();
export type TemplateAdjustment = z.infer<typeof templateAdjustmentSchema>;

export const templateAssignmentSchema = z
	.object({ slotId: idSchema, assetId: idSchema })
	.strict();
export type TemplateAssignment = z.infer<typeof templateAssignmentSchema>;

/** Which media kinds a slot accepts. Visual slots take any still or video. */
export function slotAccepts(
	kind: TemplateSlotKind,
	assetKind: Asset["kind"]
): boolean {
	if (kind === "any") {
		return true;
	}
	if (kind === "audio") {
		return assetKind === "audio";
	}
	return assetKind !== "audio";
}

const slotKindOf = (asset: Asset): TemplateSlotKind => asset.kind;

function segmentById(project: Project, id: string): Segment {
	const segment = project.segments.find((item) => item.id === id);
	if (!segment) {
		throw new Error("A template slot references a missing clip.");
	}
	return segment;
}

const inMulticam = (project: Project, segment: Segment) =>
	segment.multicamGroupId !== undefined ||
	project.multicamGroups.some((group) => group.segmentIds.includes(segment.id));

/** Default slot label: `Video 1`, `Image 2`, `Audio 1`… counted per kind. */
function defaultLabels(kinds: readonly TemplateSlotKind[]): string[] {
	const counts = new Map<TemplateSlotKind, number>();
	return kinds.map((kind) => {
		const count = (counts.get(kind) ?? 0) + 1;
		counts.set(kind, count);
		return `${kind.charAt(0).toUpperCase()}${kind.slice(1)} ${count}`;
	});
}

/**
 * Copy `source` as a template whose slots are the requested clips, ordered
 * by timeline position (start, then track). Every placeholder keeps its
 * timing, effects and animation, so beat-aligned cuts stay on the beat.
 * The result keeps `source`'s id and revision; the caller stores it as a new
 * project.
 */
export function buildTemplateProject(
	source: Project,
	assets: readonly Asset[],
	request: Omit<SaveTemplateRequest, "revision">,
	newId: () => string = () => crypto.randomUUID()
): Project {
	const seen = new Set<string>();
	const chosen = request.slots.map((slot) => {
		if (seen.has(slot.segmentId)) {
			throw new Error("A clip can be a template slot only once.");
		}
		seen.add(slot.segmentId);
		const segment = segmentById(source, slot.segmentId);
		if (inMulticam(source, segment)) {
			throw new Error("A multicam clip cannot be a template slot.");
		}
		const asset = assets.find((item) => item.id === segment.assetId);
		if (!asset) {
			throw new Error("A timeline segment references missing media.");
		}
		return { asset, segment, slot };
	});
	chosen.sort(
		(a, b) =>
			a.segment.start - b.segment.start || a.segment.track - b.segment.track
	);
	const labels = defaultLabels(chosen.map(({ asset }) => slotKindOf(asset)));
	const slots: TemplateSlot[] = chosen.map(
		({ asset, segment, slot }, index) => ({
			id: newId(),
			segmentId: segment.id,
			label: slot.label ?? labels[index] ?? `Slot ${index + 1}`,
			kind: slotKindOf(asset),
			fixedDuration: slot.fixedDuration ?? true,
		})
	);
	const template: ProjectTemplate = { slots };
	const description = request.description?.trim();
	if (description) {
		template.description = description;
	}
	const category = request.category?.trim();
	if (category) {
		template.category = category;
	}
	return {
		...source,
		title: request.title ?? `${source.title} template`.slice(0, 200),
		template,
	};
}

/** Timeline start and length of every slot, in slot order. */
export function templateSlotSummaries(project: Project): TemplateSlotSummary[] {
	return (project.template?.slots ?? []).map((slot) => {
		const segment = segmentById(project, slot.segmentId);
		return {
			id: slot.id,
			label: slot.label,
			kind: slot.kind,
			start: segment.start,
			duration: segmentDuration(segment),
			fixedDuration: slot.fixedDuration,
		};
	});
}

/** End of the last timeline element, in seconds. */
function contentEnd(project: Project): number {
	let end = 0;
	for (const segment of project.segments) {
		end = Math.max(end, segment.start + segmentDuration(segment));
	}
	for (const item of [...project.titles, ...project.graphics]) {
		end = Math.max(end, item.end);
	}
	return end;
}

/** Library card for a template project. */
export function summarizeTemplate(
	project: Project,
	builtIn: boolean
): TemplateSummary {
	if (!project.template) {
		throw new Error("This project is not a template.");
	}
	return {
		id: project.id,
		title: project.title,
		description: project.template.description ?? "",
		category: project.template.category ?? "",
		builtIn,
		width: project.width,
		height: project.height,
		duration: contentEnd(project),
		slots: templateSlotSummaries(project),
	};
}

export interface TemplateFillResult {
	adjustments: TemplateAdjustment[];
	assignments: TemplateAssignment[];
	project: Project;
	/** Slots left with their placeholder media because media ran out. */
	unfilledSlotIds: string[];
	/** Media no compatible slot was left for. */
	unusedAssetIds: string[];
}

/**
 * Clamp a clip's fades, keyframes, exit and reveal transition to `duration`
 * (reveal and exit through `fitEdgeTransitions`, as split pieces do).
 */
function fitToDuration(segment: Segment, duration: number): Segment {
	const next: Segment = { ...segment };
	const fadeTotal = next.fadeIn + next.fadeOut;
	if (fadeTotal > duration) {
		const ratio = duration / fadeTotal;
		next.fadeIn *= ratio;
		next.fadeOut *= ratio;
	}
	// Keep the curve up to the new end with a boundary keyframe, as an end
	// trim does (`trimSegment`); with nothing past the end they stay as stored.
	if (next.keyframes.some((keyframe) => keyframe.time > duration + EPSILON)) {
		next.keyframes = retimeKeyframes(next, 0, duration);
	}
	// The filled clip keeps both edges, so its reveal and exit are clamped
	// like split edges are (the authored reveal is kept).
	return fitEdgeTransitions(next, true, true);
}

interface FilledClip {
	adjustment?: TemplateAdjustment["change"];
	segment: Segment;
}

/**
 * Put `asset` into a slot's placeholder clip. The clip keeps its position,
 * look and animation; its source starts at 0. Stills hold for the slot
 * length. Video longer than the slot is trimmed; shorter video is slowed to
 * fill a fixed-length slot (never below the minimum clip speed) and
 * otherwise ends early. Audio is trimmed but never retimed.
 */
function fillClip(
	placeholder: Segment,
	slot: TemplateSlot,
	asset: Asset
): FilledClip {
	const slotLength = segmentDuration(placeholder);
	const { linkGroupId: _link, speakerId: _speaker, ...kept } = placeholder;
	const base: Segment = { ...kept, assetId: asset.id, sourceIn: 0 };
	if (asset.kind === "image") {
		return { segment: { ...base, speed: 1, sourceOut: slotLength } };
	}
	const needed = slotLength * placeholder.speed;
	if (asset.duration + EPSILON >= needed) {
		return { segment: { ...base, sourceOut: needed } };
	}
	if (asset.kind === "video" && slot.fixedDuration) {
		const speed = Math.max(MIN_CLIP_SPEED, asset.duration / slotLength);
		const sourceOut = Math.min(asset.duration, slotLength * speed);
		if (sourceOut / speed < MIN_FILLED_SECONDS) {
			throw studioError((text) => new Error(text), "template.slot-too-short", {
				name: asset.name,
			});
		}
		const segment = fitToDuration(
			{ ...base, speed, sourceOut },
			sourceOut / speed
		);
		return {
			adjustment:
				sourceOut / speed + EPSILON >= slotLength ? "retimed" : "short",
			segment,
		};
	}
	const sourceOut = asset.duration;
	if (sourceOut / base.speed < MIN_FILLED_SECONDS) {
		throw studioError((text) => new Error(text), "template.slot-too-short", {
			name: asset.name,
		});
	}
	return {
		adjustment: "short",
		segment: fitToDuration({ ...base, sourceOut }, sourceOut / base.speed),
	};
}

/**
 * Remove reveal transitions that lost the same-track predecessor they
 * overlap (a shortened or removed clip), reporting each one.
 */
function dropUncoveredReveals(segments: Segment[]): {
	dropped: string[];
	segments: Segment[];
} {
	const dropped: string[] = [];
	const next = segments.map((segment) => {
		if (revealCovered(segments, segment)) {
			return segment;
		}
		dropped.push(segment.id);
		const { transitionIn: _dropped, ...rest } = segment;
		return rest;
	});
	return { dropped, segments: next };
}

/**
 * Drop avatar lip-sync clip links whose clip the fill removed (a filled
 * placeholder's detached audio), keeping the lip-sync asset itself.
 */
function pruneLipSyncLinks(project: Project): Project {
	const surviving = new Set(project.segments.map((segment) => segment.id));
	return {
		...project,
		avatars: project.avatars.map((avatar) => {
			const segmentId = avatar.lipSync?.segmentId;
			if (
				!avatar.lipSync ||
				segmentId === undefined ||
				surviving.has(segmentId)
			) {
				return avatar;
			}
			const { segmentId: _removed, ...lipSync } = avatar.lipSync;
			return { ...avatar, lipSync };
		}),
	};
}

/**
 * A video placeholder whose audio was detached is silent (volume 0) while
 * its linked audio clip plays. The fill removes that companion, so its
 * volume, volume and pan keyframes, and audio settings move back onto the
 * placeholder first; otherwise the new media would never be heard.
 */
function withCompanionAudio(
	template: Project,
	assets: readonly Asset[],
	placeholder: Segment,
	slotSegments: ReadonlySet<string>
): Segment {
	const group = placeholder.linkGroupId;
	const kindOf = (segment: Segment) =>
		assets.find((asset) => asset.id === segment.assetId)?.kind;
	if (!group || kindOf(placeholder) !== "video") {
		return placeholder;
	}
	const companion = template.segments.find(
		(segment) =>
			segment.id !== placeholder.id &&
			segment.linkGroupId === group &&
			!slotSegments.has(segment.id) &&
			kindOf(segment) === "audio"
	);
	return companion ? restoredVideo(placeholder, companion) : placeholder;
}

/**
 * Validate the media a template fill will use, in order: every id must be
 * in the library and none may be a preview proxy. Run before any media is
 * created so a rejected request leaves the library unchanged.
 */
export function templateFillMedia(
	assets: readonly Asset[],
	assetIds: readonly string[]
): Asset[] {
	return assetIds.map((id) => {
		const asset = assets.find((item) => item.id === id);
		if (!asset) {
			throw new Error("Template media was not found in the library.");
		}
		if (asset.derivation === "proxy") {
			throw new Error("A template cannot use a preview proxy; use its source.");
		}
		return asset;
	});
}

/**
 * Fill a template's slots from `assetIds` in order: each asset takes the
 * next unfilled slot that accepts its kind. Slots left over keep their
 * placeholder media; assets left over are reported unused. Clips linked to a
 * filled placeholder (its detached audio) are removed so the old media is
 * not heard; their volume and level keyframes move onto the filled clip. Returns a plain project without `template`; the caller assigns
 * its id, revision and title.
 */
export function fillTemplate(
	template: Project,
	assets: readonly Asset[],
	assetIds: readonly string[]
): TemplateFillResult {
	if (!template.template) {
		throw new Error("This project is not a template.");
	}
	const slots = template.template.slots;
	const media = templateFillMedia(assets, assetIds);
	const filledBy = new Map<string, Asset>();
	const unusedAssetIds: string[] = [];
	for (const asset of media) {
		const slot = slots.find(
			(candidate) =>
				!filledBy.has(candidate.id) && slotAccepts(candidate.kind, asset.kind)
		);
		if (slot) {
			filledBy.set(slot.id, asset);
		} else {
			unusedAssetIds.push(asset.id);
		}
	}
	const slotSegments = new Set(slots.map((slot) => slot.segmentId));
	const replaced = new Map<string, Segment>();
	const assignments: TemplateAssignment[] = [];
	const adjustments: TemplateAdjustment[] = [];
	const brokenLinks = new Set<string>();
	for (const slot of slots) {
		const asset = filledBy.get(slot.id);
		if (!asset) {
			continue;
		}
		const placeholder = segmentById(template, slot.segmentId);
		if (inMulticam(template, placeholder)) {
			throw new Error("A multicam clip cannot be a template slot.");
		}
		if (placeholder.linkGroupId) {
			brokenLinks.add(placeholder.linkGroupId);
		}
		const filled = fillClip(
			withCompanionAudio(template, assets, placeholder, slotSegments),
			slot,
			asset
		);
		replaced.set(placeholder.id, filled.segment);
		assignments.push({ slotId: slot.id, assetId: asset.id });
		if (filled.adjustment) {
			adjustments.push({
				segmentId: placeholder.id,
				change: filled.adjustment,
			});
		}
	}
	const segments: Segment[] = [];
	for (const segment of template.segments) {
		const next = replaced.get(segment.id) ?? segment;
		if (next.linkGroupId && brokenLinks.has(next.linkGroupId)) {
			if (!slotSegments.has(segment.id)) {
				// The filled placeholder's companion (its detached audio).
				continue;
			}
			const { linkGroupId: _link, ...unlinked } = next;
			segments.push(unlinked);
			continue;
		}
		segments.push(next);
	}
	const reveals = dropUncoveredReveals(segments);
	for (const segmentId of reveals.dropped) {
		adjustments.push({ segmentId, change: "reveal-dropped" });
	}
	const { template: _template, ...rest } = template;
	return {
		adjustments,
		assignments,
		project: pruneLipSyncLinks({ ...rest, segments: reveals.segments }),
		unfilledSlotIds: slots
			.filter((slot) => !filledBy.has(slot.id))
			.map((slot) => slot.id),
		unusedAssetIds,
	};
}
