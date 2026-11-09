import { z } from "zod";
import {
	type Asset,
	type Keyframe,
	type Project,
	type Segment,
	segmentDuration,
	segmentSchema,
	trackSettingFor,
	validateProject,
} from "./project.ts";
import {
	type KeyframeProperty,
	maskKeyframeProperties,
} from "./schema/keyframe.ts";
import { revealCovered } from "./track-placement.ts";

/** Keyframes a clip may hold (mirrors `segmentSchema.keyframes`). */
const MAX_CLIP_KEYFRAMES = 200;

/** Treatment groups that paste-settings can copy independently. */
export const settingsGroupSchema = z.enum([
	"transform",
	"color",
	"effects",
	"audio",
	"masks",
	"animation",
]);
export type SettingsGroup = z.infer<typeof settingsGroupSchema>;
export const SETTINGS_GROUPS: readonly SettingsGroup[] =
	settingsGroupSchema.options;

const mutableClipSchema = segmentSchema
	.omit({ assetId: true, id: true, multicamGroupId: true, track: true })
	.partial()
	.strict();

export const setClipPropertiesRequestSchema = z
	.object({
		clipId: z.uuid(),
		patch: mutableClipSchema,
		revision: z.number().int().nonnegative(),
	})
	.strict();

export const copyClipSettingsRequestSchema = z
	.object({
		revision: z.number().int().nonnegative(),
		sourceClipId: z.uuid(),
		targetClipIds: z.array(z.uuid()).min(1).max(8),
	})
	.strict();

export const pasteSettingsRequestSchema = z
	.object({
		groups: z
			.array(settingsGroupSchema)
			.min(1)
			.max(6)
			.refine((groups) => new Set(groups).size === groups.length, {
				message: "Choose each settings group once.",
			}),
		revision: z.number().int().nonnegative(),
		sourceClipId: z.uuid(),
		targetClipIds: z.array(z.uuid()).min(1).max(200),
	})
	.strict();

export const swapClipMediaRequestSchema = z
	.object({
		assetId: z.uuid(),
		clipId: z.uuid(),
		revision: z.number().int().nonnegative(),
	})
	.strict();

function clip(project: Project, id: string) {
	const found = project.segments.find((segment) => segment.id === id);
	if (!found) {
		throw new Error("Clip not found on this timeline.");
	}
	return found;
}

function ensureEditable(project: Project, track: number) {
	if (trackSettingFor(project, track).locked) {
		throw new Error("Unlock the clip track before editing its properties.");
	}
}

type SegmentField = keyof Segment;

/**
 * Clip fields each settings group copies. Keyframes are not listed: they
 * travel with the group that owns their property (`KEYFRAME_GROUP`).
 */
export const SETTINGS_GROUP_FIELDS = {
	transform: [
		"x",
		"y",
		"scale",
		"scaleX",
		"scaleY",
		"rotation",
		"crop",
		"flipH",
		"flipV",
		"fit",
		"edgeRounding",
		"edgeSoftness",
		"opacity",
		"blendMode",
		"background",
	],
	color: ["brightness", "contrast", "saturation", "colorGrade"],
	effects: [
		"effects",
		"visualEffect",
		"visualization",
		"waveformColor",
		"waveformHeight",
		"frameInterpolation",
	],
	audio: [
		"volume",
		"duckUnderVoice",
		"ducking",
		"audioProcessing",
		"audioCleanup",
		"audioEffects",
		"pan",
		"channelMode",
	],
	masks: ["masks", "key"],
	animation: [
		"fadeIn",
		"fadeOut",
		"entryTransition",
		"entryDuration",
		"entryOffset",
		"exitTransition",
		"exitDuration",
		"transitionIn",
		"animation",
	],
} as const satisfies Record<SettingsGroup, readonly SegmentField[]>;

/** Clip label and color, copied by "copy all settings" but by no group. */
export const SETTINGS_META_FIELDS = [
	"label",
	"color",
] as const satisfies readonly SegmentField[];

/**
 * Fields settings never copy: identity, placement, source timing, and
 * per-clip state (mute, hide, speaker attribution).
 */
export const SETTINGS_EXCLUDED_FIELDS = [
	"id",
	"assetId",
	"multicamGroupId",
	"linkGroupId",
	"track",
	"start",
	"sourceIn",
	"sourceOut",
	"speed",
	"speedCurve",
	"preservePitch",
	"muted",
	"hidden",
	"speakerId",
] as const satisfies readonly SegmentField[];

/** The settings group whose paste carries keyframes of each property. */
export const KEYFRAME_GROUP: Record<KeyframeProperty, SettingsGroup> = {
	x: "transform",
	y: "transform",
	scale: "transform",
	rotation: "transform",
	opacity: "transform",
	volume: "audio",
	scaleX: "transform",
	scaleY: "transform",
	cropLeft: "transform",
	cropRight: "transform",
	cropTop: "transform",
	cropBottom: "transform",
	brightness: "color",
	contrast: "color",
	saturation: "color",
	exposure: "color",
	temperature: "color",
	blur: "effects",
	effectAmount: "effects",
	pan: "audio",
	maskX: "masks",
	maskY: "masks",
	maskWidth: "masks",
	maskHeight: "masks",
	maskRotation: "masks",
	maskFeather: "masks",
	// Title and graphic channels never sit on a clip (validation refuses
	// them); they map to transform only to keep this table total.
	fontSize: "transform",
	letterSpacing: "transform",
	lineHeight: "transform",
	backgroundPadding: "transform",
	backgroundRadius: "transform",
	strokeWidth: "transform",
	cornerRadius: "transform",
	innerRadius: "transform",
	color: "color",
	backgroundColor: "color",
	fill: "color",
	stroke: "color",
};

/**
 * Drop keys whose value is `undefined`, so optional fields the source left
 * absent stay absent on the copy (legacy clips serialize unchanged).
 */
function withoutUndefined(value: Record<string, unknown>): Segment {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined)
	) as Segment;
}

/**
 * Drop reveal transitions that no longer have a covering predecessor (after
 * a settings paste or a clip paste), so the edit stays valid instead of
 * failing. Only clips in `ids` are touched.
 */
export function dropUncoveredReveals(
	segments: readonly Segment[],
	ids: ReadonlySet<string>
): Segment[] {
	return segments.map((segment) => {
		if (!(ids.has(segment.id) && segment.transitionIn)) {
			return segment;
		}
		if (revealCovered(segments, segment)) {
			return segment;
		}
		const { transitionIn: _dropped, ...rest } = segment;
		return rest;
	});
}

/**
 * Give masks fresh ids and point mask keyframes at them. Returns the old to
 * new id map so other keyframes can be retargeted.
 */
export function remintMasks(masks: Segment["masks"]): {
	masks: Segment["masks"];
	targets: Map<string, string>;
} {
	const targets = new Map<string, string>();
	if (!masks) {
		return { masks, targets };
	}
	const minted = masks.map((mask) => {
		const id = crypto.randomUUID();
		targets.set(mask.id, id);
		return { ...mask, id };
	});
	return { masks: minted, targets };
}

/** Copy `keyframe` with a fresh id and its mask target retargeted. */
export function remintKeyframe(
	keyframe: Keyframe,
	maskTargets: ReadonlyMap<string, string>
): Keyframe {
	const copy = { ...keyframe, id: crypto.randomUUID() };
	if (
		keyframe.target !== undefined &&
		maskKeyframeProperties.has(keyframe.property)
	) {
		copy.target = maskTargets.get(keyframe.target) ?? keyframe.target;
	}
	return copy;
}

interface ApplySettingsOptions {
	groups: readonly SettingsGroup[];
	/** Also copy the clip label and color. */
	meta: boolean;
	/** Audio targets skip keying, which validation reserves for visuals. */
	targetIsAudio: boolean;
}

/**
 * Copy the chosen settings groups from `source` onto `target`, keeping the
 * target's media, placement, and timing. Fades, exit and reveal durations
 * are fitted to the target, and keyframes past its end are dropped.
 */
export function applySettings(
	source: Segment,
	target: Segment,
	options: ApplySettingsOptions
): Segment {
	const duration = segmentDuration(target);
	const groups = new Set(options.groups);
	const next: Record<string, unknown> = { ...target };
	const fields: SegmentField[] = [
		...[...groups].flatMap((group) => SETTINGS_GROUP_FIELDS[group]),
		...(options.meta ? SETTINGS_META_FIELDS : []),
	];
	for (const field of fields) {
		if (field === "key" && options.targetIsAudio) {
			continue;
		}
		next[field] = source[field];
	}
	if (groups.has("audio") && source.audioEffects) {
		// Audio effect ids identify instances within one clip; a pasted chain
		// gets fresh ids so it never aliases the source clip's effects.
		next.audioEffects = source.audioEffects.map((effect) => ({
			...effect,
			id: crypto.randomUUID(),
		}));
	}
	let maskTargets = new Map<string, string>();
	if (groups.has("masks")) {
		const minted = remintMasks(source.masks);
		maskTargets = minted.targets;
		next.masks = minted.masks;
	}
	if (groups.has("animation")) {
		const fadeIn = Math.min(source.fadeIn, duration);
		next.fadeIn = fadeIn;
		next.fadeOut = Math.min(source.fadeOut, duration - fadeIn);
		if (source.exitDuration !== undefined) {
			next.exitDuration = Math.min(source.exitDuration, duration);
		}
		if (source.transitionIn && source.transitionIn.duration > duration) {
			next.transitionIn = undefined;
		}
	}
	const copied = (keyframe: Keyframe) =>
		groups.has(KEYFRAME_GROUP[keyframe.property]);
	next.keyframes = [
		...target.keyframes.filter((keyframe) => !copied(keyframe)),
		...source.keyframes
			.filter((keyframe) => copied(keyframe) && keyframe.time <= duration)
			.map((keyframe) => remintKeyframe(keyframe, maskTargets)),
	].slice(0, MAX_CLIP_KEYFRAMES);
	return withoutUndefined(next);
}

export type SetClipPropertiesInput = z.input<
	typeof setClipPropertiesRequestSchema
>;

/** Apply one bounded inspector patch to a clip. */
export function setClipProperties(
	project: Project,
	assets: readonly Asset[],
	input: SetClipPropertiesInput
): Project {
	const request = setClipPropertiesRequestSchema.parse(input);
	const current = clip(project, request.clipId);
	ensureEditable(project, current.track);
	return validateProject(
		{
			...project,
			segments: project.segments.map((segment) =>
				segment.id === current.id ? { ...segment, ...request.patch } : segment
			),
		},
		[...assets]
	);
}

export type CopyClipSettingsInput = z.input<
	typeof copyClipSettingsRequestSchema
>;

/** Copy visual/audio treatment and compatible keyframes to several clips. */
export function copyClipSettings(
	project: Project,
	assets: readonly Asset[],
	input: CopyClipSettingsInput
): Project {
	const request = copyClipSettingsRequestSchema.parse(input);
	if (request.targetClipIds.includes(request.sourceClipId)) {
		throw new Error("The source clip cannot also be a copy target.");
	}
	if (new Set(request.targetClipIds).size !== request.targetClipIds.length) {
		throw new Error("Choose each copy target once.");
	}
	const source = clip(project, request.sourceClipId);
	ensureEditable(project, source.track);
	return applySettingsTo(project, assets, source, request.targetClipIds, {
		groups: SETTINGS_GROUPS,
		meta: true,
	});
}

/** Apply settings from `source` to every target and validate the result. */
function applySettingsTo(
	project: Project,
	assets: readonly Asset[],
	source: Segment,
	targetClipIds: readonly string[],
	options: Omit<ApplySettingsOptions, "targetIsAudio">
): Project {
	const targets = targetClipIds.map((id) => clip(project, id));
	for (const target of targets) {
		ensureEditable(project, target.track);
	}
	const targetIds = new Set(targets.map((target) => target.id));
	const audioAssets = new Set(
		assets.filter((asset) => asset.kind === "audio").map((asset) => asset.id)
	);
	const segments = project.segments.map((segment) =>
		targetIds.has(segment.id)
			? applySettings(source, segment, {
					...options,
					targetIsAudio: audioAssets.has(segment.assetId),
				})
			: segment
	);
	return validateProject(
		{ ...project, segments: dropUncoveredReveals(segments, targetIds) },
		[...assets]
	);
}

export interface PasteSettingsOptions {
	groups: readonly SettingsGroup[];
}

/**
 * Paste the chosen settings groups from a copied clip snapshot (which may
 * since have been deleted) onto several clips. Each target keeps its media,
 * placement, and timing; keyframes move with the group owning their
 * property, and a reveal transition without a covering predecessor at the
 * target is dropped rather than failing the paste.
 */
export function pasteSettings(
	project: Project,
	assets: readonly Asset[],
	sourceSnapshot: Segment,
	targetIds: readonly string[],
	options: PasteSettingsOptions
): Project {
	const groups = z
		.array(settingsGroupSchema)
		.min(1, "Choose at least one settings group to paste.")
		.parse(options.groups);
	const targets = [...new Set(targetIds)].filter(
		(id) => id !== sourceSnapshot.id
	);
	if (!targets.length) {
		throw new Error("Choose at least one other clip to paste settings onto.");
	}
	return applySettingsTo(project, assets, sourceSnapshot, targets, {
		groups: [...new Set(groups)],
		meta: false,
	});
}

export type PasteSettingsInput = z.input<typeof pasteSettingsRequestSchema>;

/** Agent form of `pasteSettings`: the source is a clip on the timeline. */
export function pasteSettingsFromClip(
	project: Project,
	assets: readonly Asset[],
	input: PasteSettingsInput
): Project {
	const request = pasteSettingsRequestSchema.parse(input);
	if (request.targetClipIds.includes(request.sourceClipId)) {
		throw new Error("The source clip cannot also be a paste target.");
	}
	if (new Set(request.targetClipIds).size !== request.targetClipIds.length) {
		throw new Error("Choose each paste target once.");
	}
	return pasteSettings(
		project,
		assets,
		clip(project, request.sourceClipId),
		request.targetClipIds,
		{ groups: request.groups }
	);
}

export type SwapClipMediaInput = z.input<typeof swapClipMediaRequestSchema>;

/** Swap a clip's source while preserving its authored treatment and timeline slot. */
export function swapClipMedia(
	project: Project,
	assets: readonly Asset[],
	input: SwapClipMediaInput
): Project {
	const request = swapClipMediaRequestSchema.parse(input);
	const current = clip(project, request.clipId);
	ensureEditable(project, current.track);
	if (current.multicamGroupId) {
		throw new Error("Ungroup the multicam session before swapping its media.");
	}
	const asset = assets.find((candidate) => candidate.id === request.assetId);
	if (!asset) {
		throw new Error("Replacement media is unavailable.");
	}
	const duration = segmentDuration(current);
	const sourceIn = Math.min(
		current.sourceIn,
		Math.max(0, asset.duration - 0.04)
	);
	const sourceOut = Math.min(
		asset.duration,
		sourceIn + duration * current.speed
	);
	if (sourceOut - sourceIn < 0.04) {
		throw new Error("Replacement media is too short for this clip.");
	}
	return validateProject(
		{
			...project,
			segments: project.segments.map((segment) =>
				segment.id === current.id
					? { ...segment, assetId: asset.id, sourceIn, sourceOut }
					: segment
			),
		},
		[...assets]
	);
}
