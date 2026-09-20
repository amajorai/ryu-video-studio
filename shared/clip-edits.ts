import { z } from "zod";
import {
	type Asset,
	type Project,
	segmentDuration,
	segmentSchema,
	trackSettingFor,
	validateProject,
} from "./project.ts";

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

function copySettings(
	source: Project["segments"][number],
	target: Project["segments"][number]
): Project["segments"][number] {
	const duration = segmentDuration(target);
	return {
		...target,
		crop: source.crop,
		edgeRounding: source.edgeRounding,
		edgeSoftness: source.edgeSoftness,
		colorGrade: source.colorGrade,
		effects: source.effects,
		brightness: source.brightness,
		contrast: source.contrast,
		duckUnderVoice: source.duckUnderVoice,
		entryDuration: source.entryDuration,
		entryOffset: source.entryOffset,
		entryTransition: source.entryTransition,
		fadeIn: Math.min(source.fadeIn, duration),
		fadeOut: Math.min(source.fadeOut, duration),
		keyframes: source.keyframes
			.filter((frame) => frame.time <= duration)
			.map((frame) => ({ ...frame, id: crypto.randomUUID() })),
		opacity: source.opacity,
		saturation: source.saturation,
		scale: source.scale,
		rotation: source.rotation,
		visualEffect: source.visualEffect,
		visualization: source.visualization,
		volume: source.volume,
		waveformColor: source.waveformColor,
		waveformHeight: source.waveformHeight,
		x: source.x,
		y: source.y,
		audioProcessing: source.audioProcessing,
	};
}

/** Apply one bounded inspector patch to a clip. */
export function setClipProperties(
	project: Project,
	assets: readonly Asset[],
	input: unknown
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

/** Copy visual/audio treatment and compatible keyframes to several clips. */
export function copyClipSettings(
	project: Project,
	assets: readonly Asset[],
	input: unknown
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
	const targets = request.targetClipIds.map((id) => clip(project, id));
	for (const target of targets) {
		ensureEditable(project, target.track);
	}
	const targetIds = new Set(targets.map((target) => target.id));
	return validateProject(
		{
			...project,
			segments: project.segments.map((segment) =>
				targetIds.has(segment.id) ? copySettings(source, segment) : segment
			),
		},
		[...assets]
	);
}

/** Swap a clip's source while preserving its authored treatment and timeline slot. */
export function swapClipMedia(
	project: Project,
	assets: readonly Asset[],
	input: unknown
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
