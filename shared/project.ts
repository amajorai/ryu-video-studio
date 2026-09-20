import { z } from "zod";
import { audioProcessingSchema } from "./audio.ts";
import { avatarRigKeyframeSchema } from "./avatar.ts";
import { productionDecisionSchema } from "./decisions.ts";
import { effectStackSchema, visualEffectSchema } from "./effects.ts";
import { objMeshSchema } from "./mesh.ts";
import {
	meshDeformationFrameSchema,
	meshKeyframeSchema,
	meshRigSchema,
} from "./mesh-animation.ts";
import { productionBudgetSchema } from "./production-budget.ts";
import {
	defaultProductionStages,
	productionStageStateSchema,
} from "./production-stages.ts";
import { referenceProfileSchema } from "./reference.ts";
import { researchSourceSchema } from "./research.ts";
import { stageCameraKeyframeSchema } from "./stage-camera.ts";
import { styleProfileSchema } from "./styles.ts";

const time = z.number().finite().min(0).max(7200);
export const idSchema = z.uuid();
export const assetTimecodeSchema = z
	.string()
	.regex(/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/);
export const assetOriginSchema = z
	.object({
		attribution: z.string().trim().min(1).max(500),
		identifier: z.string().trim().min(1).max(200),
		licenseUrl: z.string().url().optional(),
		pageUrl: z.string().url(),
		provider: z.enum([
			"archive.org",
			"coverr",
			"openverse.audio",
			"openverse.image",
			"unsplash.image",
			"wikimedia.commons",
			"nasa",
			"pexels",
			"pixabay",
		]),
		rights: z.string().trim().min(1).max(2000),
	})
	.strict();
export const assetSchema = z
	.object({
		id: idSchema,
		name: z.string().min(1).max(200),
		folder: z
			.string()
			.trim()
			.max(300)
			.refine(
				(value) =>
					!(
						value &&
						(value.startsWith("/") ||
							value.endsWith("/") ||
							value.split("/").includes("..") ||
							value.includes(String.fromCharCode(0)))
					),
				"Asset folders must be relative paths without parent traversal."
			)
			.optional(),
		kind: z.enum(["video", "audio", "image"]),
		sequenceProjectId: idSchema.optional(),
		duration: time,
		width: z.number().int().min(0).max(16_384),
		height: z.number().int().min(0).max(16_384),
		hasAudio: z.boolean(),
		createdAt: z.iso.datetime(),
		timecodeFrameRate: z.number().finite().min(1).max(240).optional(),
		timecodeStart: assetTimecodeSchema.optional(),
		origin: assetOriginSchema.optional(),
	})
	.strict();
export const exportCodecSchema = z.enum(["h264", "h265", "prores"]);
export type ExportCodec = z.infer<typeof exportCodecSchema>;

export const keyframeSchema = z
	.object({
		id: idSchema,
		time,
		property: z.enum(["x", "y", "scale", "rotation", "opacity", "volume"]),
		value: z.number().finite().min(-180).max(180),
	})
	.strict();
export type Keyframe = z.infer<typeof keyframeSchema>;

export const cropSchema = z
	.object({
		bottom: z.number().finite().min(0).max(0.9).default(0),
		left: z.number().finite().min(0).max(0.9).default(0),
		right: z.number().finite().min(0).max(0.9).default(0),
		top: z.number().finite().min(0).max(0.9).default(0),
	})
	.strict()
	.refine(
		(value) => value.left + value.right < 1 && value.top + value.bottom < 1,
		"Crop edges must leave visible source content."
	);
export type Crop = z.infer<typeof cropSchema>;

export const colorGradeSchema = z
	.object({
		exposure: z.number().finite().min(-3).max(3).default(0),
		temperature: z.number().finite().min(-1).max(1).default(0),
		tint: z.number().finite().min(-1).max(1).default(0),
		vibrance: z.number().finite().min(-1).max(1).default(0),
	})
	.strict();
export type ColorGrade = z.infer<typeof colorGradeSchema>;

export const segmentSchema = z
	.object({
		id: idSchema,
		assetId: idSchema,
		multicamGroupId: idSchema.optional(),
		linkGroupId: idSchema.optional(),
		track: z.number().int().min(0).max(15),
		start: time,
		sourceIn: time,
		sourceOut: time,
		speed: z.number().min(0.25).max(4),
		volume: z.number().min(0).max(4),
		opacity: z.number().min(0).max(1),
		scale: z.number().min(0.1).max(4),
		x: z.number().min(-1).max(1),
		y: z.number().min(-1).max(1),
		crop: cropSchema.default({
			bottom: 0,
			left: 0,
			right: 0,
			top: 0,
		}),
		edgeRounding: z.number().finite().min(0).max(0.5).default(0),
		edgeSoftness: z.number().finite().min(0).max(80).default(0),
		colorGrade: colorGradeSchema.default({
			exposure: 0,
			temperature: 0,
			tint: 0,
			vibrance: 0,
		}),
		effects: effectStackSchema,
		brightness: z.number().min(-1).max(1),
		contrast: z.number().min(0).max(3),
		saturation: z.number().min(0).max(3),
		rotation: z.number().finite().min(-180).max(180).default(0),
		visualEffect: visualEffectSchema.optional(),
		fadeIn: time,
		fadeOut: time,
		keyframes: z.array(keyframeSchema).max(200).default([]),
		visualization: z.enum(["none", "waveform"]).default("none"),
		entryTransition: z
			.enum([
				"none",
				"crossfade",
				"zoom-in",
				"zoom-out",
				"slide-left",
				"slide-right",
				"slide-up",
				"slide-down",
			])
			.default("none"),
		entryDuration: time.default(0.5),
		entryOffset: time.default(0),
		waveformHeight: z.number().min(0.05).max(1).default(0.2),
		waveformColor: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}$/)
			.default("#ffffff"),
		duckUnderVoice: z.boolean().default(false),
		audioProcessing: audioProcessingSchema.optional(),
	})
	.strict();
export const captionSchema = z
	.object({
		id: idSchema,
		sourceAssetId: idSchema.optional(),
		start: time,
		end: time,
		text: z.string().min(1).max(2000),
		words: z
			.array(
				z
					.object({
						id: idSchema,
						start: time,
						end: time,
						text: z.string().min(1).max(2000),
					})
					.strict()
			)
			.max(20)
			.optional(),
		highlightColor: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}$/)
			.optional(),
	})
	.strict();
export const captionTrackSchema = z
	.object({
		captions: z.array(captionSchema).max(5000),
		id: idSchema,
		label: z.string().trim().min(1).max(80),
		language: z.string().trim().min(2).max(35),
	})
	.strict();
export const titleSchema = z
	.object({
		id: idSchema,
		start: time,
		end: time,
		text: z.string().min(1).max(500),
		x: z.number().min(0).max(1),
		y: z.number().min(0).max(1),
		fontSize: z.number().min(0.02).max(0.2),
		color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
		fadeIn: time,
		fadeOut: time,
		animation: z
			.enum(["fade", "slide-up", "slide-down", "slide-left", "slide-right"])
			.default("fade"),
	})
	.strict();
export type Title = z.infer<typeof titleSchema>;

export const graphicSchema = z
	.object({
		animation: z
			.enum(["none", "slide-up", "slide-down", "slide-left", "slide-right"])
			.default("none"),
		end: time,
		entryDuration: time.default(0.35),
		fill: z.string().regex(/^#[0-9a-fA-F]{6}$/),
		height: z.number().min(0.02).max(1),
		id: idSchema,
		opacity: z.number().min(0).max(1),
		shape: z
			.enum(["rectangle", "ellipse", "triangle", "line"])
			.default("rectangle"),
		start: time,
		stroke: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}$/)
			.default("#ffffff"),
		strokeWidth: z.number().finite().min(0).max(0.08).default(0),
		width: z.number().min(0.02).max(1),
		x: z.number().min(0).max(1),
		y: z.number().min(0).max(1),
	})
	.strict();
export type Graphic = z.infer<typeof graphicSchema>;

export const avatarSchema = z
	.object({
		accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
		animation: z
			.enum(["none", "idle", "slide-left", "slide-right"])
			.default("idle"),
		depth: z.number().min(0).max(1).default(0.45),
		end: time,
		entryDuration: time.default(0.35),
		height: z.number().min(0.08).max(1),
		id: idSchema,
		outfit: z.string().regex(/^#[0-9a-fA-F]{6}$/),
		pose: z.enum(["neutral", "wave", "point"]).default("neutral"),
		rigKeyframes: z.array(avatarRigKeyframeSchema).max(100).optional(),
		skin: z.string().regex(/^#[0-9a-fA-F]{6}$/),
		start: time,
		width: z.number().min(0.08).max(1),
		x: z.number().min(0).max(1),
		y: z.number().min(0).max(1),
	})
	.strict();
export type Avatar = z.infer<typeof avatarSchema>;

export const spatialObjectSchema = z
	.object({
		animation: z
			.enum(["none", "float", "orbit-left", "orbit-right"])
			.default("float"),
		depth: z.number().min(0.04).max(1),
		end: time,
		entryDuration: time.default(0.4),
		fill: z.string().regex(/^#[0-9a-fA-F]{6}$/),
		height: z.number().min(0.04).max(1),
		id: idSchema,
		start: time,
		width: z.number().min(0.04).max(1),
		x: z.number().min(-1).max(1),
		y: z.number().min(-1).max(1),
		z: z.number().min(-1).max(1),
	})
	.strict();
export type SpatialObject = z.infer<typeof spatialObjectSchema>;

export const stageCameraSchema = z
	.object({
		keyframes: z.array(stageCameraKeyframeSchema).max(200).optional(),
		x: z.number().min(-1).max(1).default(0),
		y: z.number().min(-1).max(1).default(0),
		zoom: z.number().min(0.5).max(2).default(1),
		orbit: z.number().min(-1).max(1).default(0),
		tilt: z.number().min(-1).max(1).default(0),
	})
	.strict();
export type StageCamera = z.infer<typeof stageCameraSchema>;

export const meshSchema = objMeshSchema
	.extend({
		end: time,
		fill: z.string().regex(/^#[0-9a-fA-F]{6}$/),
		id: idSchema,
		texture: z
			.string()
			.regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/)
			.max(2_000_000)
			.optional(),
		rotationX: z.number().finite().min(-180).max(180).default(0),
		rotationY: z.number().finite().min(-180).max(180).default(0),
		rotationZ: z.number().finite().min(-180).max(180).default(0),
		scale: z.number().min(0.02).max(4).default(0.3),
		start: time,
		keyframes: z.array(meshKeyframeSchema).max(120).optional(),
		deformationFrames: z.array(meshDeformationFrameSchema).max(30).optional(),
		rig: meshRigSchema.optional(),
		x: z.number().min(-1).max(1).default(0),
		y: z.number().min(-1).max(1).default(0),
		z: z.number().min(-1).max(1).default(0),
	})
	.strict();
export type Mesh = z.infer<typeof meshSchema>;

export const sceneReviewStatusSchema = z.enum([
	"in-review",
	"changes-requested",
	"approved",
]);
export type SceneReviewStatus = z.infer<typeof sceneReviewStatusSchema>;

export const markerSchema = z
	.object({
		color: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}$/)
			.optional(),
		comment: z.string().max(2000).optional(),
		duration: time.optional(),
		id: idSchema,
		label: z.string().trim().min(1).max(120),
		status: z.enum(["open", "review", "resolved"]).optional(),
		time,
	})
	.strict();
export type Marker = z.infer<typeof markerSchema>;

export const trackSettingSchema = z
	.object({
		locked: z.boolean().default(false),
		muted: z.boolean().default(false),
		name: z.string().trim().min(1).max(80),
		solo: z.boolean().default(false),
		track: z.number().int().min(0).max(15),
	})
	.strict();
export type TrackSetting = z.infer<typeof trackSettingSchema>;

export const sceneSchema = z
	.object({
		id: idSchema,
		title: z.string().min(1).max(200),
		script: z.string().max(8000),
		prompt: z.string().max(8000),
		assetIds: z.array(idSchema).max(30),
		audioOffsets: z.record(idSchema, time).optional(),
		muteVisualAudio: z.boolean().optional(),
		duration: time.default(5),
		sourceIn: time.default(0),
		reviewNotes: z.string().max(2000).optional(),
		reviewStatus: sceneReviewStatusSchema.optional(),
		approved: z.boolean(),
	})
	.strict();

const multicamTime = z.number().finite().min(0).max(7200);
export const multicamMemberSchema = z
	.object({
		assetId: idSchema,
		kind: z.enum(["angle", "mic", "both"]),
		label: z.string().trim().min(1).max(80),
		offsetSeconds: z.number().finite().min(-600).max(600).default(0),
	})
	.strict();
export type MulticamMember = z.infer<typeof multicamMemberSchema>;

export const multicamSwitchSchema = z
	.object({
		angle: z.string().trim().min(1).max(80),
		end: multicamTime,
		start: multicamTime,
	})
	.strict();
export type MulticamSwitch = z.infer<typeof multicamSwitchSchema>;

export const multicamGroupSchema = z
	.object({
		duration: multicamTime,
		id: idSchema,
		masterAssetId: idSchema,
		members: z.array(multicamMemberSchema).min(2).max(8),
		name: z.string().trim().min(1).max(120),
		segmentIds: z.array(idSchema).min(1).max(400),
		start: multicamTime,
		switches: z.array(multicamSwitchSchema).min(1).max(200),
	})
	.strict();
export type MulticamGroup = z.infer<typeof multicamGroupSchema>;

export const projectSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: idSchema,
		revision: z.number().int().nonnegative(),
		title: z.string().trim().min(1).max(200),
		width: z.number().int().min(128).max(3840).multipleOf(2),
		height: z.number().int().min(128).max(3840).multipleOf(2),
		fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]),
		exportPreset: z.enum(["master", "review", "social"]).default("master"),
		exportCodec: exportCodecSchema.default("h264"),
		styleProfile: styleProfileSchema.default("clean-professional"),
		markers: z.array(markerSchema).max(500).default([]),
		trackSettings: z.array(trackSettingSchema).max(16).default([]),
		segments: z.array(segmentSchema).max(200),
		captions: z.array(captionSchema).max(5000),
		captionTracks: z.array(captionTrackSchema).max(20).default([]),
		captionTrackId: idSchema.nullable().default(null),
		titles: z.array(titleSchema).max(200).default([]),
		graphics: z.array(graphicSchema).max(200).default([]),
		avatars: z.array(avatarSchema).max(100).default([]),
		spatialObjects: z.array(spatialObjectSchema).max(100).default([]),
		stageWorldPrompt: z.string().trim().max(400).optional(),
		stageCamera: stageCameraSchema.default({
			x: 0,
			y: 0,
			zoom: 1,
			orbit: 0,
			tilt: 0,
		}),
		meshes: z.array(meshSchema).max(20).default([]),
		productionBudget: productionBudgetSchema.default({
			estimates: { audio: 100_000, image: 250_000, video: 1_000_000 },
			limitMicroUsd: 0,
		}),
		decisions: z.array(productionDecisionSchema).max(200).default([]),
		stages: z
			.array(productionStageStateSchema)
			.length(7)
			.default(defaultProductionStages()),
		brief: z.string().max(32_000),
		multicamGroups: z.array(multicamGroupSchema).max(50).default([]),
		scenes: z.array(sceneSchema).max(200),
		referenceProfile: referenceProfileSchema.optional(),
		researchSources: z.array(researchSourceSchema).max(100).default([]),
		requireApproval: z.boolean(),
		updatedAt: z.iso.datetime(),
	})
	.strict();

export type Asset = z.infer<typeof assetSchema>;
export type Segment = z.infer<typeof segmentSchema>;
export type Caption = z.infer<typeof captionSchema>;
export type CaptionTrack = z.infer<typeof captionTrackSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type Project = z.infer<typeof projectSchema>;

export function dissolveOrphanedLinkGroups(
	segments: readonly Segment[]
): Segment[] {
	const counts = new Map<string, number>();
	for (const segment of segments) {
		if (segment.linkGroupId) {
			counts.set(
				segment.linkGroupId,
				(counts.get(segment.linkGroupId) ?? 0) + 1
			);
		}
	}
	return segments.map((segment) =>
		segment.linkGroupId && counts.get(segment.linkGroupId) === 1
			? { ...segment, linkGroupId: undefined }
			: segment
	);
}

export function activeCaptions(project: Project): Caption[] {
	if (!project.captionTrackId) {
		return project.captions;
	}
	return (
		project.captionTracks.find((track) => track.id === project.captionTrackId)
			?.captions ?? project.captions
	);
}

export function withActiveCaptions(
	project: Project,
	captions: Caption[]
): Project {
	if (!project.captionTrackId) {
		return { ...project, captions };
	}
	return {
		...project,
		captionTracks: project.captionTracks.map((track) =>
			track.id === project.captionTrackId ? { ...track, captions } : track
		),
	};
}

const defaultTrackName = (track: number) => `Track ${track + 1}`;

export function trackSettingFor(
	project: Pick<Project, "trackSettings">,
	track: number
): TrackSetting {
	return (
		project.trackSettings.find((setting) => setting.track === track) ?? {
			locked: false,
			muted: false,
			name: defaultTrackName(track),
			solo: false,
			track,
		}
	);
}

export function updateTrackSetting(
	project: Project,
	track: number,
	patch: Partial<Omit<TrackSetting, "track">>
): Project {
	const next = trackSettingSchema.parse({
		...trackSettingFor(project, track),
		...patch,
		track,
	});
	return {
		...project,
		trackSettings: [
			...project.trackSettings.filter((setting) => setting.track !== track),
			next,
		].sort((a, b) => a.track - b.track),
	};
}

export function isTrackAudible(
	project: Pick<Project, "trackSettings">,
	track: number
): boolean {
	const setting = trackSettingFor(project, track);
	const soloTracks = project.trackSettings
		.filter((candidate) => candidate.solo)
		.map((candidate) => candidate.track);
	return !setting.muted && (!soloTracks.length || soloTracks.includes(track));
}
export const segmentDuration = (s: Segment) =>
	(s.sourceOut - s.sourceIn) / s.speed;

export function trimSegment(
	segment: Segment,
	assetDuration: number,
	edge: "start" | "end",
	deltaSeconds: number
): Segment {
	const minimumSource = 0.04 * segment.speed;
	if (edge === "start") {
		const requestedIn = segment.sourceIn + deltaSeconds * segment.speed;
		const nextIn = Math.max(
			0,
			Math.min(segment.sourceOut - minimumSource, requestedIn)
		);
		const actualDelta = (nextIn - segment.sourceIn) / segment.speed;
		const nextStart = Math.max(0, segment.start + actualDelta);
		const boundedDelta = nextStart - segment.start;
		const boundedIn = segment.sourceIn + boundedDelta * segment.speed;
		const duration = (segment.sourceOut - boundedIn) / segment.speed;
		return {
			...segment,
			start: nextStart,
			sourceIn: boundedIn,
			keyframes: segment.keyframes.filter(
				(keyframe) => keyframe.time <= duration
			),
		};
	}
	const requestedOut = segment.sourceOut + deltaSeconds * segment.speed;
	const nextOut = Math.max(
		segment.sourceIn + minimumSource,
		Math.min(assetDuration, requestedOut)
	);
	const duration = (nextOut - segment.sourceIn) / segment.speed;
	return {
		...segment,
		sourceOut: nextOut,
		keyframes: segment.keyframes.filter(
			(keyframe) => keyframe.time <= duration
		),
	};
}

/** Remove a timeline interval and shift every later timed layer left. */
export function rippleDeleteRange(
	project: Project,
	assets: readonly Asset[],
	rangeStart: number,
	rangeEnd: number
): Project {
	const duration = projectDuration(project);
	if (
		!(Number.isFinite(rangeStart) && Number.isFinite(rangeEnd)) ||
		rangeStart < 0 ||
		rangeEnd > duration ||
		rangeEnd <= rangeStart ||
		rangeEnd - rangeStart < 0.04
	) {
		throw new Error("Choose a timeline range of at least 0.04 seconds.");
	}
	const deletedDuration = rangeEnd - rangeStart;
	const mapTime = (value: number) =>
		value <= rangeStart
			? value
			: value >= rangeEnd
				? value - deletedDuration
				: rangeStart;
	const mapInterval = (start: number, end: number) => {
		const nextStart = mapTime(start);
		const nextEnd = mapTime(end);
		return nextEnd - nextStart >= 0.04
			? { end: nextEnd, start: nextStart }
			: null;
	};
	const sliceSegment = (
		segment: Segment,
		localStart: number,
		localEnd: number,
		timelineStart: number,
		preserveId: boolean
	): Segment => {
		const segmentDurationValue = segmentDuration(segment);
		const slicedDuration = localEnd - localStart;
		const keyframes: Keyframe[] = [];
		for (const property of [
			"x",
			"y",
			"scale",
			"rotation",
			"opacity",
			"volume",
		] as const) {
			const frames = segment.keyframes.filter(
				(frame) => frame.property === property
			);
			if (!frames.length) {
				continue;
			}
			if (localStart > 0) {
				keyframes.push({
					id: crypto.randomUUID(),
					property,
					time: 0,
					value: animatedValue(segment, property, localStart),
				});
			}
			for (const frame of frames) {
				if (
					frame.time < localStart ||
					frame.time > localEnd ||
					(localStart > 0 && frame.time === localStart)
				) {
					continue;
				}
				keyframes.push({
					...frame,
					id: crypto.randomUUID(),
					time: frame.time - localStart,
				});
			}
		}
		return {
			...segment,
			id: preserveId ? segment.id : crypto.randomUUID(),
			start: timelineStart,
			sourceIn: segment.sourceIn + localStart * segment.speed,
			sourceOut: segment.sourceIn + localEnd * segment.speed,
			fadeIn: localStart === 0 ? Math.min(segment.fadeIn, slicedDuration) : 0,
			fadeOut:
				localEnd >= segmentDurationValue
					? Math.min(segment.fadeOut, slicedDuration)
					: 0,
			entryOffset: Math.min(7200, segment.entryOffset + localStart),
			keyframes: keyframes.slice(0, 200),
		};
	};
	const segments: Segment[] = [];
	for (const segment of project.segments) {
		const segmentLength = segmentDuration(segment);
		const segmentEnd = segment.start + segmentLength;
		if (segmentEnd <= rangeStart) {
			segments.push(segment);
			continue;
		}
		if (segment.start >= rangeEnd) {
			segments.push({ ...segment, start: segment.start - deletedDuration });
			continue;
		}
		const localStart = Math.max(0, rangeStart - segment.start);
		const localEnd = Math.min(segmentLength, rangeEnd - segment.start);
		if (localStart >= 0.04) {
			segments.push(sliceSegment(segment, 0, localStart, segment.start, true));
		}
		if (segmentLength - localEnd >= 0.04) {
			segments.push(
				sliceSegment(
					segment,
					localEnd,
					segmentLength,
					mapTime(segment.start + localEnd),
					false
				)
			);
		}
	}
	const remapFrames = <T extends { id: string; time: number }>(
		frames: readonly T[] | undefined,
		objectStart: number,
		nextStart: number,
		max: number,
		key: (frame: T, time: number) => string
	): T[] | undefined => {
		if (!frames) {
			return undefined;
		}
		const seen = new Set<string>();
		return frames
			.flatMap((frame) => {
				const time = Number(
					(mapTime(objectStart + frame.time) - nextStart).toFixed(3)
				);
				if (time < 0 || seen.has(key(frame, time))) {
					return [];
				}
				seen.add(key(frame, time));
				return [{ ...frame, id: crypto.randomUUID(), time }];
			})
			.slice(0, max);
	};
	const timed = <T extends { end: number; start: number }>(
		items: readonly T[],
		map: (item: T, interval: { end: number; start: number }) => T
	): T[] =>
		items.flatMap((item) => {
			const interval = mapInterval(item.start, item.end);
			return interval ? [map(item, interval)] : [];
		});
	const titles = timed(project.titles, (title, interval) => {
		const length = interval.end - interval.start;
		return {
			...title,
			...interval,
			fadeIn: Math.min(title.fadeIn, length),
			fadeOut: Math.min(title.fadeOut, length),
		};
	});
	const graphics = timed(project.graphics, (graphic, interval) => ({
		...graphic,
		...interval,
		entryDuration: Math.min(
			graphic.entryDuration,
			interval.end - interval.start
		),
	}));
	const avatars = timed(project.avatars, (avatar, interval) => ({
		...avatar,
		...interval,
		entryDuration: Math.min(
			avatar.entryDuration,
			interval.end - interval.start
		),
		rigKeyframes: remapFrames(
			avatar.rigKeyframes,
			avatar.start,
			interval.start,
			100,
			(frame, time) => `${frame.property}:${time}`
		),
	}));
	const spatialObjects = timed(project.spatialObjects, (object, interval) => ({
		...object,
		...interval,
		entryDuration: Math.min(
			object.entryDuration,
			interval.end - interval.start
		),
	}));
	const meshes = timed(project.meshes, (mesh, interval) => ({
		...mesh,
		...interval,
		keyframes: remapFrames(
			mesh.keyframes,
			mesh.start,
			interval.start,
			120,
			(frame, time) => `${frame.property}:${time}`
		),
		deformationFrames: mesh.deformationFrames
			?.reduce<typeof mesh.deformationFrames>((frames, frame) => {
				const time = Number(
					(mapTime(mesh.start + frame.time) - interval.start).toFixed(3)
				);
				if (time < 0 || frames.some((existing) => existing.time === time)) {
					return frames;
				}
				frames.push({ ...frame, time });
				return frames;
			}, [])
			.slice(0, 30),
		rig: mesh.rig
			? {
					...mesh.rig,
					keyframes: remapFrames(
						mesh.rig.keyframes,
						mesh.start,
						interval.start,
						384,
						(frame, time) => `${frame.joint}:${frame.property}:${time}`
					),
				}
			: undefined,
	}));
	const mapCaptions = (captions: readonly Caption[]) =>
		captions.flatMap((caption) => {
			const interval = mapInterval(caption.start, caption.end);
			if (!interval) {
				return [];
			}
			const wordsTouched = caption.words?.some(
				(word) => word.start < rangeEnd && word.end > rangeStart
			);
			return [
				{
					...caption,
					...interval,
					words: wordsTouched
						? undefined
						: caption.words?.map((word) => ({
								...word,
								start: mapTime(word.start),
								end: mapTime(word.end),
							})),
				},
			];
		});
	const captions = mapCaptions(project.captions);
	const captionTracks = project.captionTracks.map((track) => ({
		...track,
		captions: mapCaptions(track.captions),
	}));
	const markers: Project["markers"] = [];
	const markerTimes = new Set<number>();
	for (const marker of project.markers) {
		const markerDuration = marker.duration ?? 0;
		const markerEnd = marker.time + markerDuration;
		if (markerDuration > 0) {
			const interval = mapInterval(marker.time, markerEnd);
			if (!interval) {
				continue;
			}
			const time = Number(interval.start.toFixed(3));
			if (markerTimes.has(time)) {
				continue;
			}
			markerTimes.add(time);
			markers.push({
				...marker,
				duration: Number((interval.end - interval.start).toFixed(3)),
				time,
			});
			continue;
		}
		if (marker.time > rangeStart && marker.time < rangeEnd) {
			continue;
		}
		const time = Number(mapTime(marker.time).toFixed(3));
		if (markerTimes.has(time)) {
			continue;
		}
		markerTimes.add(time);
		markers.push({ ...marker, time });
	}
	return validateProject(
		{
			...project,
			segments: dissolveOrphanedLinkGroups(segments),
			titles,
			graphics,
			avatars,
			spatialObjects,
			meshes,
			captions,
			captionTracks,
			markers,
		},
		[...assets]
	);
}
export const projectDuration = (p: Project) =>
	Math.max(
		0,
		...p.segments.map((s) => s.start + segmentDuration(s)),
		...p.titles.map((title) => title.end),
		...p.graphics.map((graphic) => graphic.end),
		...p.avatars.map((avatar) => avatar.end),
		...p.spatialObjects.map((object) => object.end),
		...p.meshes.map((mesh) => mesh.end)
	);

export function snapTimelineTime(
	value: number,
	fps: number,
	markers: readonly Marker[],
	threshold = 0.12
): number {
	const frame = Math.max(0, Math.round(value * fps) / fps);
	const nearest = markers.reduce<Marker | undefined>((current, marker) => {
		if (
			!current ||
			Math.abs(marker.time - frame) < Math.abs(current.time - frame)
		) {
			return marker;
		}
		return current;
	}, undefined);
	return nearest && Math.abs(nearest.time - frame) <= threshold
		? nearest.time
		: frame;
}

export function newProject(title = "Untitled film"): Project {
	return {
		schemaVersion: 1,
		id: crypto.randomUUID(),
		revision: 0,
		title,
		width: 1920,
		height: 1080,
		fps: 30,
		exportCodec: "h264",
		exportPreset: "master",
		styleProfile: "clean-professional",
		markers: [],
		trackSettings: [],
		segments: [],
		captions: [],
		captionTracks: [],
		captionTrackId: null,
		titles: [],
		graphics: [],
		avatars: [],
		spatialObjects: [],
		stageWorldPrompt: "",
		stageCamera: stageCameraSchema.parse({}),
		meshes: [],
		productionBudget: productionBudgetSchema.parse({}),
		decisions: [],
		stages: defaultProductionStages(),
		brief: "",
		multicamGroups: [],
		scenes: [],
		researchSources: [],
		requireApproval: false,
		updatedAt: new Date().toISOString(),
	};
}
export function newSegment(asset: Asset, start = 0, track = 0): Segment {
	return {
		id: crypto.randomUUID(),
		assetId: asset.id,
		track,
		start,
		sourceIn: 0,
		sourceOut: asset.kind === "image" ? 5 : asset.duration,
		speed: 1,
		volume: 1,
		opacity: 1,
		scale: 1,
		x: 0,
		y: 0,
		crop: { bottom: 0, left: 0, right: 0, top: 0 },
		edgeRounding: 0,
		edgeSoftness: 0,
		colorGrade: { exposure: 0, temperature: 0, tint: 0, vibrance: 0 },
		effects: [],
		brightness: 0,
		contrast: 1,
		saturation: 1,
		rotation: 0,
		fadeIn: 0,
		fadeOut: 0,
		keyframes: [],
		visualization: "none",
		entryTransition: "none",
		entryDuration: 0.5,
		entryOffset: 0,
		waveformHeight: 0.2,
		waveformColor: "#ffffff",
		duckUnderVoice: false,
		audioProcessing: "none",
		visualEffect: "none",
	};
}

export function validateProject(value: unknown, assets: Asset[]): Project {
	const p = projectSchema.parse(value);
	const ids = new Set<string>();
	const tracks = new Set<number>();
	for (const setting of p.trackSettings) {
		if (tracks.has(setting.track)) {
			throw new Error("Duplicate timeline track setting.");
		}
		tracks.add(setting.track);
	}
	for (const s of p.segments) {
		const asset = assets.find((a) => a.id === s.assetId);
		if (!asset) {
			throw new Error("A timeline segment references missing media.");
		}
		if (ids.has(s.id)) {
			throw new Error("Duplicate timeline segment ID.");
		}
		ids.add(s.id);
		const duration = segmentDuration(s);
		const frameKeys = new Set<string>();
		for (const frame of s.keyframes) {
			const key = `${frame.property}:${frame.time}`;
			const min =
				frame.property === "scale"
					? 0.1
					: frame.property === "volume"
						? 0
						: frame.property === "opacity"
							? 0
							: frame.property === "rotation"
								? -180
								: -1;
			const max =
				frame.property === "x" || frame.property === "y"
					? 1
					: frame.property === "opacity"
						? 1
						: frame.property === "rotation"
							? 180
							: 4;
			if (
				frame.time > duration ||
				frame.value < min ||
				frame.value > max ||
				frameKeys.has(key)
			) {
				throw new Error("Invalid or duplicate animation keyframe.");
			}
			frameKeys.add(key);
		}

		if (
			duration < 0.04 ||
			s.fadeIn + s.fadeOut > duration ||
			(asset.kind !== "image" && s.sourceOut > asset.duration + 0.05)
		) {
			throw new Error("Segment trim or fades exceed the source duration.");
		}
	}
	const linkGroups = new Map<string, Segment[]>();
	for (const segment of p.segments) {
		if (segment.linkGroupId) {
			const members = linkGroups.get(segment.linkGroupId) ?? [];
			members.push(segment);
			linkGroups.set(segment.linkGroupId, members);
		}
	}
	for (const [groupId, members] of linkGroups) {
		if (members.length < 2) {
			throw new Error("A clip link group must contain at least two clips.");
		}
		const kinds = new Set(
			members.map(
				(member) => assets.find((asset) => asset.id === member.assetId)?.kind
			)
		);
		if (!kinds.has("audio") || kinds.size < 2) {
			throw new Error(
				`Clip link group ${groupId} must pair audio with visual media.`
			);
		}
	}
	if (projectDuration(p) > 7200) {
		throw new Error("Projects are limited to two hours.");
	}
	for (const title of p.titles) {
		if (
			ids.has(title.id) ||
			title.end <= title.start ||
			title.fadeIn + title.fadeOut > title.end - title.start ||
			title.text.includes("\0")
		) {
			throw new Error("Invalid title timing or fade.");
		}
		ids.add(title.id);
	}
	for (const graphic of p.graphics) {
		if (
			ids.has(graphic.id) ||
			graphic.end <= graphic.start ||
			graphic.entryDuration > graphic.end - graphic.start
		) {
			throw new Error("Invalid graphic timing or duplicate ID.");
		}
		ids.add(graphic.id);
	}
	for (const avatar of p.avatars) {
		if (
			ids.has(avatar.id) ||
			avatar.end <= avatar.start ||
			avatar.entryDuration > avatar.end - avatar.start
		) {
			throw new Error("Invalid avatar timing or duplicate ID.");
		}
		const keyframes = avatar.rigKeyframes ?? [];
		const keyframeIds = new Set<string>();
		for (const keyframe of keyframes) {
			const bounds = keyframe.property === "mouth" ? [0, 1] : [-180, 180];
			const key = `${keyframe.property}:${keyframe.time}`;
			if (
				keyframe.time > avatar.end - avatar.start ||
				keyframe.value < bounds[0]! ||
				keyframe.value > bounds[1]! ||
				keyframeIds.has(key) ||
				ids.has(keyframe.id)
			) {
				throw new Error("Invalid or duplicate avatar rig keyframe.");
			}
			keyframeIds.add(key);
			ids.add(keyframe.id);
		}
		ids.add(avatar.id);
	}
	for (const object of p.spatialObjects) {
		if (
			ids.has(object.id) ||
			object.end <= object.start ||
			object.entryDuration > object.end - object.start
		) {
			throw new Error("Invalid 3D object timing or duplicate ID.");
		}
		ids.add(object.id);
	}
	for (const mesh of p.meshes) {
		if (
			ids.has(mesh.id) ||
			mesh.end <= mesh.start ||
			(mesh.uvs !== undefined && mesh.uvs.length !== mesh.vertices.length) ||
			mesh.faces.some((face) =>
				face.some((index) => index >= mesh.vertices.length)
			)
		) {
			throw new Error("Invalid mesh timing, faces, or duplicate ID.");
		}
		const keyframes = mesh.keyframes ?? [];
		const deformationFrames = mesh.deformationFrames ?? [];
		if (
			deformationFrames.some(
				(frame, index) =>
					(index > 0 && frame.time <= deformationFrames[index - 1]!.time) ||
					frame.time > mesh.end - mesh.start ||
					frame.vertices.length !== mesh.vertices.length
			)
		) {
			throw new Error("Invalid or non-monotonic mesh deformation frames.");
		}
		const rig = mesh.rig;
		if (
			rig &&
			(rig.vertices.length !== mesh.vertices.length ||
				rig.influences.length !== rig.vertices.length ||
				rig.weights.length !== rig.vertices.length ||
				rig.bindMatrices.length !== rig.joints.length)
		) {
			throw new Error("Invalid mesh rig geometry or joint binding.");
		}
		if (rig) {
			for (let jointIndex = 0; jointIndex < rig.joints.length; jointIndex++) {
				const visited = new Set<number>();
				let current: number | undefined = jointIndex;
				while (current !== undefined && current >= 0) {
					if (visited.has(current) || current >= rig.joints.length) {
						throw new Error("Invalid or cyclic mesh rig hierarchy.");
					}
					visited.add(current);
					current = rig.joints[current]?.parent;
				}
			}
			if (
				rig.influences.some((influences) =>
					influences.some((index) => index >= rig.joints.length)
				)
			) {
				throw new Error("Mesh rig influence references a missing joint.");
			}
			const constraintKeys = new Set<string>();
			for (const constraint of rig.constraints ?? []) {
				const key = `${constraint.type}:${constraint.joint}:${constraint.axis}`;
				if (
					constraint.joint >= rig.joints.length ||
					constraint.min > constraint.max ||
					constraintKeys.has(key)
				) {
					throw new Error("Invalid or duplicate mesh rig constraint.");
				}
				constraintKeys.add(key);
			}
		}
		const keyframeIds = new Set<string>();
		for (const keyframe of keyframes) {
			const bounds = ["x", "y", "z"].includes(keyframe.property)
				? [-1, 1]
				: [-180, 180];
			const key = `${keyframe.property}:${keyframe.time}`;
			if (
				mesh.end - mesh.start > 30 ||
				keyframe.time > mesh.end - mesh.start ||
				keyframe.value < bounds[0]! ||
				keyframe.value > bounds[1]! ||
				keyframeIds.has(key) ||
				ids.has(keyframe.id)
			) {
				throw new Error("Invalid or duplicate mesh animation keyframe.");
			}
			keyframeIds.add(key);
			ids.add(keyframe.id);
		}
		for (const keyframe of rig?.keyframes ?? []) {
			const translation = ["x", "y", "z"].includes(keyframe.property);
			const key = `rig:${keyframe.joint}:${keyframe.property}:${keyframe.time}`;
			if (
				keyframe.joint >= (rig?.joints.length ?? 0) ||
				keyframe.time > mesh.end - mesh.start ||
				(translation && (keyframe.value < -2 || keyframe.value > 2)) ||
				keyframeIds.has(key) ||
				ids.has(keyframe.id)
			) {
				throw new Error("Invalid or duplicate mesh rig keyframe.");
			}
			keyframeIds.add(key);
			ids.add(keyframe.id);
		}
		ids.add(mesh.id);
	}
	const validateCaptions = (
		captions: readonly Caption[],
		sharedIds?: Set<string>
	) => {
		const idsForTrack = sharedIds ?? new Set<string>();
		for (const cue of captions) {
			if (cue.words?.length) {
				if (cue.words.map((word) => word.text).join(" ") !== cue.text) {
					throw new Error("Caption text no longer matches its word alignment.");
				}
				for (const word of cue.words) {
					if (
						idsForTrack.has(word.id) ||
						word.start < cue.start ||
						word.end > cue.end ||
						word.end <= word.start ||
						word.text.includes("\0")
					) {
						throw new Error("Invalid caption word timing.");
					}
					idsForTrack.add(word.id);
				}
			}
			if (
				idsForTrack.has(cue.id) ||
				cue.end <= cue.start ||
				cue.text.includes("\0")
			) {
				throw new Error("Invalid timed caption.");
			}
			idsForTrack.add(cue.id);
		}
	};
	validateCaptions(p.captions, ids);
	const trackIds = new Set<string>();
	for (const track of p.captionTracks) {
		if (trackIds.has(track.id) || ids.has(track.id)) {
			throw new Error("Invalid or duplicate caption track.");
		}
		trackIds.add(track.id);
		ids.add(track.id);
		validateCaptions(track.captions);
	}
	if (p.captionTrackId && !trackIds.has(p.captionTrackId)) {
		throw new Error("The active caption track is unavailable.");
	}
	const markerTimes = new Set<number>();
	for (const marker of p.markers) {
		if (
			ids.has(marker.id) ||
			markerTimes.has(marker.time) ||
			(marker.duration !== undefined && marker.time + marker.duration > 7200)
		) {
			throw new Error("Invalid or duplicate timeline marker.");
		}
		markerTimes.add(marker.time);
		ids.add(marker.id);
	}
	for (const scene of p.scenes) {
		for (const [id, offset] of Object.entries(scene.audioOffsets ?? {})) {
			const source = assets.find((asset) => asset.id === id);
			if (
				!scene.assetIds.includes(id) ||
				source?.kind !== "audio" ||
				offset >= source.duration
			) {
				throw new Error("Invalid storyboard audio range.");
			}
		}
		if (
			ids.has(scene.id) ||
			new Set(scene.assetIds).size !== scene.assetIds.length ||
			scene.assetIds.some((id) => !assets.some((a) => a.id === id))
		) {
			throw new Error("Invalid storyboard scene.");
		}
		if (
			(scene.reviewStatus === "approved" && !scene.approved) ||
			(scene.reviewStatus === "changes-requested" && scene.approved)
		) {
			throw new Error("Invalid storyboard review status.");
		}
		ids.add(scene.id);
	}
	for (const group of p.multicamGroups) {
		if (
			ids.has(group.id) ||
			new Set(group.segmentIds).size !== group.segmentIds.length
		) {
			throw new Error("Invalid multicam group identity.");
		}
		const members = new Set<string>();
		for (const member of group.members) {
			if (
				members.has(member.label) ||
				!assets.some((asset) => asset.id === member.assetId)
			) {
				throw new Error("Invalid multicam member.");
			}
			members.add(member.label);
		}
		if (
			!members.has(
				group.members.find((member) => member.assetId === group.masterAssetId)
					?.label ?? ""
			)
		) {
			throw new Error("A multicam master must be one of its members.");
		}
		if (
			group.duration < 0.04 ||
			group.start + group.duration > 7200 ||
			group.switches.some(
				(switchPoint) =>
					switchPoint.end <= switchPoint.start ||
					switchPoint.start < group.start ||
					switchPoint.end > group.start + group.duration ||
					!members.has(switchPoint.angle)
			)
		) {
			throw new Error("Invalid multicam switch range.");
		}
		ids.add(group.id);
	}
	return p;
}

export function splitSegment(s: Segment, at: number): [Segment, Segment] {
	const offset = at - s.start;
	if (offset < 0.04 || segmentDuration(s) - offset < 0.04) {
		throw new Error("Place the playhead inside the segment to split.");
	}
	const cut = s.sourceIn + offset * s.speed;
	return [
		{
			...s,
			sourceOut: cut,
			fadeIn: Math.min(s.fadeIn, offset),
			fadeOut: 0,
			keyframes: [
				...s.keyframes.filter((f) => f.time < offset),
				...(["x", "y", "scale", "rotation", "opacity", "volume"] as const)
					.filter((property) =>
						s.keyframes.some((f) => f.property === property)
					)
					.map((property) => ({
						id: crypto.randomUUID(),
						property,
						time: offset,
						value: animatedValue(s, property, offset),
					})),
			],
		},
		{
			...s,
			id: crypto.randomUUID(),
			sourceIn: cut,
			entryOffset: Math.min(7200, s.entryOffset + offset),
			start: at,
			x: animatedValue(s, "x", offset),
			y: animatedValue(s, "y", offset),
			scale: animatedValue(s, "scale", offset),
			rotation: animatedValue(s, "rotation", offset),
			opacity: animatedValue(s, "opacity", offset),
			volume: animatedValue(s, "volume", offset),
			keyframes: s.keyframes
				.filter((f) => f.time > offset)
				.map((f) => ({ ...f, id: crypto.randomUUID(), time: f.time - offset })),
			fadeIn: 0,
			fadeOut: Math.min(s.fadeOut, segmentDuration(s) - offset),
		},
	];
}

export function subtitleText(
	captions: Caption[],
	format: "srt" | "vtt"
): string {
	const stamp = (t: number) => {
		const ms = Math.round(t * 1000);
		return `${String(Math.floor(ms / 3_600_000)).padStart(2, "0")}:${String(Math.floor(ms / 60_000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}${format === "srt" ? "," : "."}${String(ms % 1000).padStart(3, "0")}`;
	};
	return (
		(format === "vtt" ? "WEBVTT\n\n" : "") +
		[...captions]
			.sort((a, b) => a.start - b.start)
			.map(
				(c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`
			)
			.join("\n")
	);
}

export function parseSubtitles(text: string): Caption[] {
	const stamp = (raw: string) => {
		const parts = raw.replace(",", ".").split(":").map(Number);
		return parts.reduce((total, part) => total * 60 + part, 0);
	};
	const cues: Caption[] = [];
	for (const block of text.replace(/\r/g, "").split(/\n\s*\n/)) {
		const lines = block.split("\n");
		const index = lines.findIndex((l) => l.includes(" --> "));
		if (index < 0) {
			continue;
		}
		const match = lines[index]?.match(/^([\d:.,]+) --> ([\d:.,]+)/);
		if (!(match?.[1] && match[2])) {
			throw new Error("Invalid subtitle timestamp.");
		}
		const cue = captionSchema.parse({
			id: crypto.randomUUID(),
			start: stamp(match[1]),
			end: stamp(match[2]),
			text: lines.slice(index + 1).join("\n"),
		});
		if (cue.end <= cue.start) {
			throw new Error("Caption end must follow its start.");
		}
		cues.push(cue);
	}
	if (!cues.length || cues.length > 5000) {
		throw new Error("Import between 1 and 5000 timed captions.");
	}
	return cues;
}

export function animationPoints(
	segment: Segment,
	property: Keyframe["property"]
) {
	const frames = segment.keyframes
		.filter((f) => f.property === property)
		.sort((a, b) => a.time - b.time);
	return frames[0]?.time === 0
		? frames
		: [
				{ id: "initial", time: 0, property, value: segment[property] },
				...frames,
			];
}
export function animatedValue(
	segment: Segment,
	property: Keyframe["property"],
	at: number
): number {
	const points = animationPoints(segment, property);
	let previous = points[0];
	if (!previous) {
		return segment[property];
	}
	for (const next of points.slice(1)) {
		if (at <= next.time) {
			const fraction = Math.max(
				0,
				(at - previous.time) / (next.time - previous.time)
			);
			return previous.value + (next.value - previous.value) * fraction;
		}
		previous = next;
	}
	return previous.value;
}
export function animationExpression(
	segment: Segment,
	property: Keyframe["property"],
	clock = "t"
): string {
	const points = animationPoints(segment, property);
	let result = String(points.at(-1)?.value ?? segment[property]);
	for (let i = points.length - 2; i >= 0; i--) {
		const a = points[i];
		const b = points[i + 1];
		if (!(a && b)) {
			continue;
		}
		result = `if(lt(${clock},${b.time}),${a.value}+(${b.value - a.value})*max(0,(${clock}-${a.time}))/${b.time - a.time},${result})`;
	}
	return result;
}
