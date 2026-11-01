import { z } from "zod";
import {
	animatedValue,
	boundaryKeyframe,
	isLegacyKeyframeProperty,
	keyframeGroups,
	retimeKeyframes,
} from "./animation.ts";
import {
	audioProcessingSchema,
	MAX_CLIP_SPEED,
	MIN_CLIP_SPEED,
} from "./audio.ts";
import { avatarRigKeyframeSchema } from "./avatar.ts";
import { productionDecisionSchema } from "./decisions.ts";
import { effectStackSchema, visualEffectSchema } from "./effects.ts";
import { layoutSchema } from "./layouts.ts";
import {
	MAX_CANVAS,
	MAX_CLIP_OFFSET,
	MAX_OVERLAYS,
	MAX_SEGMENTS,
	MAX_TRACKS,
	trackIndexSchema,
} from "./limits.ts";
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
import {
	adjustmentLayerSchema,
	MAX_ADJUSTMENT_LAYERS,
} from "./schema/adjustment.ts";
import {
	assetColorTransferSchema,
	assetDerivationSchema,
	assetGenerationSchema,
} from "./schema/asset.ts";
import {
	audioCleanupSchema,
	audioEffectSchema,
	channelModeSchema,
	duckSettingsSchema,
	MAX_AUDIO_EFFECTS,
	panSchema,
} from "./schema/audio-ext.ts";
import {
	type CanvasBackground,
	canvasBackgroundSchema,
} from "./schema/background.ts";
import { blendModeSchema } from "./schema/blend.ts";
import { captionGlossarySchema } from "./schema/caption-glossary.ts";
import {
	captionChunkingSchema,
	captionStyleSchema,
} from "./schema/caption-style.ts";
import { colorGradeSchema } from "./schema/color.ts";
import { exportSettingsSchema } from "./schema/export.ts";
import { customFontSchema, systemFontSchema } from "./schema/font.ts";
import { keySchema } from "./schema/key.ts";
import {
	isColorKeyframeProperty,
	type Keyframe,
	type KeyframeOwnerKind,
	keyframePropertyAllowed,
	keyframeSchema,
	keyframeValueBounds,
	maskKeyframeProperties,
	targetedKeyframeProperties,
} from "./schema/keyframe.ts";
import { MAX_CLIP_MASKS, type Mask, maskSchema } from "./schema/mask.ts";
import {
	bounded,
	hexColorSchema,
	idSchema,
	timeSchema,
} from "./schema/primitives.ts";
import { MAX_SPEAKERS, speakerSchema } from "./schema/speaker.ts";
import { speedCurveSchema } from "./schema/speed-curve.ts";
import { projectTemplateSchema } from "./schema/template.ts";
import {
	fontFamilySchema,
	fontWeightSchema,
	letterSpacingSchema,
	lineHeightSchema,
	overlayLaneSchema,
	strokeFractionSchema,
	textAlignSchema,
	titleAnimationInSchema,
	titleAnimationLoopSchema,
	titleAnimationOutSchema,
	titleFillModeSchema,
} from "./schema/text-style.ts";
import {
	clipAnimationSchema,
	edgeTransitionSchema,
	frameInterpolationSchema,
	transitionInSchema,
} from "./schema/transition.ts";
import { splitSpeedCurve } from "./speed-curve.ts";
import { stageCameraKeyframeSchema } from "./stage-camera.ts";
import { styleProfileSchema } from "./styles.ts";

export {
	animatedValue,
	animationExpression,
	animationPoints,
	keyframeBaseValue,
	keyframeProperties,
	retimeKeyframes,
} from "./animation.ts";
export { rippleDeleteRange } from "./ripple.ts";
export { colorGradeSchema } from "./schema/color.ts";
export {
	type Keyframe,
	type KeyframeProperty,
	keyframeSchema,
} from "./schema/keyframe.ts";
export { idSchema } from "./schema/primitives.ts";
export {
	parseSubtitles,
	SUBTITLE_EXPORT_FORMATS,
	type SubtitleExportFormat,
	subtitleText,
} from "./subtitles.ts";
export { snapTimelineTime } from "./timeline-snap.ts";

const time = timeSchema;
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
			"bundled",
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
		derivedFromAssetId: idSchema.optional(),
		derivation: assetDerivationSchema.optional(),
		frameRate: bounded(1, 240).optional(),
		colorTransfer: assetColorTransferSchema.optional(),
		generation: assetGenerationSchema.optional(),
	})
	.strict();
export const exportCodecSchema = z.enum([
	"h264",
	"h265",
	"prores",
	"h265-10bit",
	"prores-4444",
	"vp9",
]);
export type ExportCodec = z.infer<typeof exportCodecSchema>;

/**
 * Codecs the renderer encodes. Every `exportCodecSchema` value has an encoder
 * since W2-E1 (HEVC 10-bit, ProRes 4444 and VP9 included); `validateProject`
 * still checks membership so a future codec cannot silently fall back to
 * H.264 before its encoder lands.
 */
export const RENDERABLE_EXPORT_CODECS = [
	"h264",
	"h265",
	"prores",
	"h265-10bit",
	"prores-4444",
	"vp9",
] as const satisfies readonly ExportCodec[];

export function isRenderableExportCodec(codec: ExportCodec): boolean {
	return (RENDERABLE_EXPORT_CODECS as readonly ExportCodec[]).includes(codec);
}

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

export type ColorGrade = z.infer<typeof colorGradeSchema>;

export const clipColorLabelSchema = z.enum([
	"red",
	"orange",
	"yellow",
	"green",
	"teal",
	"blue",
	"purple",
	"pink",
]);
export type ClipColorLabel = z.infer<typeof clipColorLabelSchema>;

export const segmentSchema = z
	.object({
		id: idSchema,
		assetId: idSchema,
		multicamGroupId: idSchema.optional(),
		linkGroupId: idSchema.optional(),
		track: trackIndexSchema,
		start: time,
		sourceIn: time,
		sourceOut: time,
		speed: z.number().min(MIN_CLIP_SPEED).max(MAX_CLIP_SPEED),
		/** Continuous speed curve; `speed` stays the clip's average speed. */
		speedCurve: speedCurveSchema.optional(),
		volume: z.number().min(0).max(4),
		opacity: z.number().min(0).max(1),
		scale: z.number().min(0.1).max(4),
		x: z.number().min(-MAX_CLIP_OFFSET).max(MAX_CLIP_OFFSET),
		y: z.number().min(-MAX_CLIP_OFFSET).max(MAX_CLIP_OFFSET),
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
		entryTransition: edgeTransitionSchema.default("none"),
		entryDuration: time.default(0.5),
		entryOffset: time.default(0),
		waveformHeight: z.number().min(0.05).max(1).default(0.2),
		waveformColor: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}$/)
			.default("#ffffff"),
		duckUnderVoice: z.boolean().default(false),
		ducking: duckSettingsSchema.optional(),
		audioProcessing: audioProcessingSchema.optional(),
		muted: z.boolean().optional(),
		hidden: z.boolean().optional(),
		flipH: z.boolean().optional(),
		flipV: z.boolean().optional(),
		preservePitch: z.boolean().optional(),
		label: z.string().trim().min(1).max(80).optional(),
		color: clipColorLabelSchema.optional(),
		blendMode: blendModeSchema.optional(),
		scaleX: bounded(0.1, 4).optional(),
		scaleY: bounded(0.1, 4).optional(),
		fit: z.enum(["fit", "fill", "stretch"]).optional(),
		masks: z.array(maskSchema).max(MAX_CLIP_MASKS).optional(),
		key: keySchema.optional(),
		exitTransition: edgeTransitionSchema.optional(),
		exitDuration: time.optional(),
		transitionIn: transitionInSchema.optional(),
		animation: clipAnimationSchema.optional(),
		frameInterpolation: frameInterpolationSchema.optional(),
		pan: panSchema.optional(),
		channelMode: channelModeSchema.optional(),
		audioCleanup: audioCleanupSchema.optional(),
		audioEffects: z.array(audioEffectSchema).max(MAX_AUDIO_EFFECTS).optional(),
		speakerId: idSchema.optional(),
		background: canvasBackgroundSchema.optional(),
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
						speakerId: idSchema.optional(),
					})
					.strict()
			)
			.max(20)
			.optional(),
		highlightColor: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}$/)
			.optional(),
		speakerId: idSchema.optional(),
	})
	.strict();
export const captionTrackSchema = z
	.object({
		captions: z.array(captionSchema).max(5000),
		id: idSchema,
		label: z.string().trim().min(1).max(80),
		language: z.string().trim().min(2).max(35),
		style: captionStyleSchema.optional(),
	})
	.strict();
const overlayKeyframes = z.array(keyframeSchema).max(200);
const overlayRotation = bounded(-180, 180);
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
		fontFamily: fontFamilySchema.optional(),
		/** An imported font; `fontFamily` is the fallback when it is missing. */
		customFont: customFontSchema.optional(),
		/** An installed system font by family; ignored when `customFont` is set. */
		systemFont: systemFontSchema.optional(),
		fontWeight: fontWeightSchema.optional(),
		italic: z.boolean().optional(),
		underline: z.boolean().optional(),
		strike: z.boolean().optional(),
		letterSpacing: letterSpacingSchema.optional(),
		lineHeight: lineHeightSchema.optional(),
		align: textAlignSchema.optional(),
		outlineColor: hexColorSchema.optional(),
		outlineWidth: strokeFractionSchema.optional(),
		shadowColor: hexColorSchema.optional(),
		shadowDepth: strokeFractionSchema.optional(),
		shadowBlur: bounded(0, 10).optional(),
		backgroundColor: hexColorSchema.optional(),
		backgroundOpacity: bounded(0, 1).optional(),
		backgroundPadding: bounded(0, 0.05).optional(),
		/** Horizontal box padding (canvas-height fraction); falls back to `backgroundPadding`. */
		backgroundPaddingX: bounded(0, 0.05).optional(),
		/** Vertical box padding (canvas-height fraction); falls back to `backgroundPadding`. */
		backgroundPaddingY: bounded(0, 0.05).optional(),
		/** Box shift right of the text, as a fraction of the canvas width. */
		backgroundOffsetX: bounded(-0.1, 0.1).optional(),
		/** Box shift below the text, as a fraction of the canvas height. */
		backgroundOffsetY: bounded(-0.1, 0.1).optional(),
		backgroundRadius: bounded(0, 0.5).optional(),
		animationIn: titleAnimationInSchema.optional(),
		animationOut: titleAnimationOutSchema.optional(),
		animationLoop: titleAnimationLoopSchema.optional(),
		animationInDuration: bounded(0, 5).optional(),
		animationOutDuration: bounded(0, 5).optional(),
		highlightColor: hexColorSchema.optional(),
		/** `gradient` fills the text from `color` (left) to `gradientColor` (right). */
		fillMode: titleFillModeSchema.optional(),
		gradientColor: hexColorSchema.optional(),
		/** Gaussian blur of the text, as a fraction of the canvas height. */
		textBlur: strokeFractionSchema.optional(),
		rotation: overlayRotation.optional(),
		keyframes: overlayKeyframes.optional(),
		templateId: z.string().trim().min(1).max(64).optional(),
		lane: overlayLaneSchema.optional(),
		blendMode: blendModeSchema.optional(),
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
			.enum([
				"rectangle",
				"ellipse",
				"triangle",
				"line",
				"polygon",
				"star",
				"heart",
				"arrow",
			])
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
		sides: z.number().int().min(3).max(12).optional(),
		points: z.number().int().min(3).max(12).optional(),
		innerRadius: bounded(0.1, 0.95).optional(),
		cornerRadius: bounded(0, 0.5).optional(),
		strokeAlign: z.enum(["center", "inside", "outside"]).optional(),
		rotation: overlayRotation.optional(),
		keyframes: overlayKeyframes.optional(),
		blendMode: blendModeSchema.optional(),
		lane: overlayLaneSchema.optional(),
		/**
		 * Masks in the graphic's own box (before its rotation), like clip
		 * masks in the clip frame. Static and never text: the graphic is
		 * rasterized with them applied.
		 */
		masks: z
			.array(maskSchema)
			.max(MAX_CLIP_MASKS)
			.refine(
				(masks) => masks.every((mask) => mask.shape !== "text"),
				"Graphic masks cannot be text masks."
			)
			.optional(),
	})
	.strict();
export type Graphic = z.infer<typeof graphicSchema>;

export const avatarLipSyncSchema = z
	.object({
		assetId: idSchema,
		segmentId: idSchema.optional(),
		sensitivity: bounded(0, 1),
		smoothing: bounded(0, 1),
	})
	.strict();
export type AvatarLipSync = z.infer<typeof avatarLipSyncSchema>;

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
		lipSync: avatarLipSyncSchema.optional(),
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
		track: trackIndexSchema,
		hidden: z.boolean().optional(),
		/** Absent means sync-locked (`syncLockedOf`). */
		syncLocked: z.boolean().optional(),
		height: z.enum(["small", "medium", "large"]).optional(),
		gainDb: bounded(-60, 12).optional(),
		pan: panSchema.optional(),
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

const multicamLabel = z.string().trim().min(1).max(80);
export const multicamSwitchLayoutSchema = z
	.object({
		layout: layoutSchema,
		angles: z.array(multicamLabel).min(2).max(9),
		fit: z.enum(["fit", "fill"]),
	})
	.strict();
export const multicamSwitchSchema = z
	.object({
		angle: multicamLabel,
		end: multicamTime,
		start: multicamTime,
		/** The mic member label heard during this switch. */
		audio: multicamLabel.optional(),
		layout: multicamSwitchLayoutSchema.optional(),
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

/** Project frame rates, including NTSC fractional rates. */
export const projectFpsSchema = z.union([
	z.literal(23.976),
	z.literal(24),
	z.literal(25),
	z.literal(29.97),
	z.literal(30),
	z.literal(48),
	z.literal(50),
	z.literal(59.94),
	z.literal(60),
	z.literal(120),
]);
export type ProjectFps = z.infer<typeof projectFpsSchema>;

/**
 * Whether render and interchange can carry this rate. Every project rate is
 * writable since W2-X3: fractional NTSC rates use exact rational timebases
 * (`ffmpegFrameRate` in `frame-rate.ts`: 30000/1001 and so on) in FFmpeg,
 * FCPXML and XMEML.
 */
export function isWritableProjectFps(fps: ProjectFps): boolean {
	return projectFpsSchema.safeParse(fps).success;
}

export const projectSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: idSchema,
		revision: z.number().int().nonnegative(),
		title: z.string().trim().min(1).max(200),
		width: z.number().int().min(128).max(MAX_CANVAS).multipleOf(2),
		height: z.number().int().min(128).max(MAX_CANVAS).multipleOf(2),
		fps: projectFpsSchema,
		exportPreset: z.enum(["master", "review", "social"]).default("master"),
		exportCodec: exportCodecSchema.default("h264"),
		styleProfile: styleProfileSchema.default("clean-professional"),
		markers: z.array(markerSchema).max(500).default([]),
		trackSettings: z.array(trackSettingSchema).max(MAX_TRACKS).default([]),
		segments: z.array(segmentSchema).max(MAX_SEGMENTS),
		captions: z.array(captionSchema).max(5000),
		captionTracks: z.array(captionTrackSchema).max(20).default([]),
		captionTrackId: idSchema.nullable().default(null),
		titles: z.array(titleSchema).max(MAX_OVERLAYS).default([]),
		graphics: z.array(graphicSchema).max(MAX_OVERLAYS).default([]),
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
		background: canvasBackgroundSchema.optional(),
		adjustmentLayers: z
			.array(adjustmentLayerSchema)
			.max(MAX_ADJUSTMENT_LAYERS)
			.optional(),
		speakers: z.array(speakerSchema).max(MAX_SPEAKERS).optional(),
		captionStyle: captionStyleSchema.optional(),
		captionChunking: captionChunkingSchema.optional(),
		/** "Fix names and terms" pairs applied to captions and transcripts. */
		captionGlossary: captionGlossarySchema.optional(),
		exportSettings: exportSettingsSchema.optional(),
		rippleMarkers: z.boolean().optional(),
		template: projectTemplateSchema.optional(),
	})
	.strict();

export type Asset = z.infer<typeof assetSchema>;
export type Segment = z.infer<typeof segmentSchema>;
export type Caption = z.infer<typeof captionSchema>;
export type CaptionTrack = z.infer<typeof captionTrackSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type Project = z.infer<typeof projectSchema>;

/**
 * Derivations whose time 0 is not their source's time 0: a reversal runs
 * backwards, and AI edits, lip-sync takes and AI mattes start at the source
 * range they were made from (`sourceIn`), not at the start of the file.
 */
const OFFSET_TIME_DERIVATIONS: ReadonlySet<string> = new Set([
	"reverse",
	"ai-edit",
	"lipsync",
	"ai-matte",
]);

/**
 * Whether a derivative's media time equals its source's media time, so the
 * source's transcript and waveform describe it at the same seconds.
 */
export function sharesSourceTime(
	asset: Pick<Asset, "derivation" | "derivedFromAssetId">
): boolean {
	return (
		asset.derivedFromAssetId !== undefined &&
		!(asset.derivation && OFFSET_TIME_DERIVATIONS.has(asset.derivation))
	);
}

/**
 * True when both assets share source time: the same file, or derivatives
 * whose time 0 is the source's time 0 (not reversed or offset AI takes).
 */
export function sameMediaTimebase(
	a: Pick<Asset, "id" | "derivedFromAssetId" | "derivation">,
	b: Pick<Asset, "id" | "derivedFromAssetId" | "derivation">
): boolean {
	if (a.id === b.id) {
		return true;
	}
	const offset = (asset: typeof a) =>
		asset.derivation !== undefined &&
		OFFSET_TIME_DERIVATIONS.has(asset.derivation);
	if (offset(a) || offset(b)) {
		return false;
	}
	return (
		a.derivedFromAssetId === b.id ||
		b.derivedFromAssetId === a.id ||
		(a.derivedFromAssetId !== undefined &&
			a.derivedFromAssetId === b.derivedFromAssetId)
	);
}

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
			keyframes: retimeKeyframes(segment, boundedDelta, duration),
		};
	}
	const requestedOut = segment.sourceOut + deltaSeconds * segment.speed;
	const nextOut = Math.max(
		segment.sourceIn + minimumSource,
		Math.min(assetDuration, requestedOut)
	);
	const duration = (nextOut - segment.sourceIn) / segment.speed;
	// Keep the curve up to the new end: a boundary keyframe holds the value
	// there and eased intervals are refit, as ripple and roll trims do. With
	// nothing past the end the keyframes stay as stored.
	const cut = segment.keyframes.some((keyframe) => keyframe.time > duration);
	return {
		...segment,
		sourceOut: nextOut,
		keyframes: cut ? retimeKeyframes(segment, 0, duration) : segment.keyframes,
	};
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

export type ProjectInput = z.input<typeof projectSchema>;

export function validateProject(value: ProjectInput, assets: Asset[]): Project {
	const p = projectSchema.parse(value);
	if (!isRenderableExportCodec(p.exportCodec)) {
		throw new Error(`Export codec ${p.exportCodec} is not supported yet.`);
	}
	if (!isWritableProjectFps(p.fps)) {
		throw new Error(`Frame rate ${p.fps} is not supported yet.`);
	}
	const ids = new Set<string>();
	const speakerIds = new Set<string>();
	for (const speaker of p.speakers ?? []) {
		if (speakerIds.has(speaker.id)) {
			throw new Error("Duplicate speaker ID.");
		}
		speakerIds.add(speaker.id);
	}
	const checkSpeaker = (speakerId: string | undefined) => {
		if (speakerId !== undefined && !speakerIds.has(speakerId)) {
			throw new Error("A speaker reference is not in the project speakers.");
		}
	};
	const checkBackgroundAsset = (background: CanvasBackground | undefined) => {
		if (background?.type !== "image") {
			return;
		}
		const source = assets.find((asset) => asset.id === background.assetId);
		if (!source || source.kind === "audio") {
			throw new Error("A background image references missing visual media.");
		}
	};
	checkBackgroundAsset(p.background);
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
		if (asset.derivation === "proxy") {
			throw new Error(
				"A timeline segment cannot use a preview proxy; use its source media."
			);
		}
		if (ids.has(s.id)) {
			throw new Error("Duplicate timeline segment ID.");
		}
		ids.add(s.id);
		const duration = segmentDuration(s);
		const maskIds = uniqueMaskIds(s.masks);
		validateKeyframes(
			s.keyframes,
			duration,
			{
				effects: uniqueEffectIds(s.effects),
				masks: maskIds,
			},
			"clip"
		);
		if (s.key && asset.kind === "audio") {
			throw new Error("Keying applies only to visual clips.");
		}
		checkSpeaker(s.speakerId);
		checkBackgroundAsset(s.background);
		if (s.exitDuration !== undefined && s.exitDuration > duration) {
			throw new Error("A clip exit transition exceeds the clip.");
		}

		if (
			duration < 0.04 ||
			s.fadeIn + s.fadeOut > duration ||
			(asset.kind !== "image" && s.sourceOut > asset.duration + 0.05)
		) {
			throw new Error("Segment trim or fades exceed the source duration.");
		}
	}
	validateRevealTransitions(p.segments);
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
		validateKeyframes(
			title.keyframes ?? [],
			title.end - title.start,
			NO_TARGETS,
			"title"
		);
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
		validateKeyframes(
			graphic.keyframes ?? [],
			graphic.end - graphic.start,
			NO_TARGETS,
			"graphic"
		);
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
		if (avatar.lipSync) {
			const { assetId, segmentId } = avatar.lipSync;
			const source = assets.find((asset) => asset.id === assetId);
			if (
				!(source && (source.kind === "audio" || source.hasAudio)) ||
				(segmentId !== undefined &&
					!p.segments.some((segment) => segment.id === segmentId))
			) {
				throw new Error("Avatar lip-sync references missing audio.");
			}
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
			checkSpeaker(cue.speakerId);
			for (const word of cue.words ?? []) {
				checkSpeaker(word.speakerId);
			}
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
		const micLabels = new Set(
			group.members
				.filter((member) => member.kind !== "angle")
				.map((member) => member.label)
		);
		for (const switchPoint of group.switches) {
			if (
				switchPoint.audio !== undefined &&
				!micLabels.has(switchPoint.audio)
			) {
				throw new Error("A multicam switch names a missing microphone.");
			}
			const angles = switchPoint.layout?.angles ?? [];
			if (
				new Set(angles).size !== angles.length ||
				angles.some((angle) => !members.has(angle))
			) {
				throw new Error("A multicam layout names a missing angle.");
			}
		}
		ids.add(group.id);
	}
	for (const layer of p.adjustmentLayers ?? []) {
		if (ids.has(layer.id) || layer.end <= layer.start) {
			throw new Error("Invalid adjustment layer timing or duplicate ID.");
		}
		validateKeyframes(
			layer.keyframes ?? [],
			layer.end - layer.start,
			{
				effects: uniqueEffectIds(layer.effects ?? []),
				masks: uniqueMaskIds(layer.masks),
			},
			"clip"
		);
		ids.add(layer.id);
	}
	if (p.template) {
		const slotIds = new Set<string>();
		for (const slot of p.template.slots) {
			if (
				slotIds.has(slot.id) ||
				!p.segments.some((segment) => segment.id === slot.segmentId)
			) {
				throw new Error("A template slot references a missing clip.");
			}
			slotIds.add(slot.id);
		}
	}
	return p;
}

interface KeyframeTargets {
	effects: ReadonlySet<string>;
	masks: ReadonlySet<string>;
}
const NO_TARGETS: KeyframeTargets = { effects: new Set(), masks: new Set() };

function uniqueMaskIds(masks: readonly Mask[] | undefined): Set<string> {
	const maskIds = new Set<string>();
	for (const mask of masks ?? []) {
		if (maskIds.has(mask.id)) {
			throw new Error("Mask IDs must be unique within a clip.");
		}
		maskIds.add(mask.id);
	}
	return maskIds;
}

function uniqueEffectIds(effects: readonly { id?: string }[]): Set<string> {
	const effectIds = new Set<string>();
	for (const effect of effects) {
		if (effect.id === undefined) {
			continue;
		}
		if (effectIds.has(effect.id)) {
			throw new Error("Effect IDs must be unique within a clip.");
		}
		effectIds.add(effect.id);
	}
	return effectIds;
}

/** Check keyframe times, per-property bounds, targets and duplicates. */
function validateKeyframes(
	keyframes: readonly Keyframe[],
	duration: number,
	targets: KeyframeTargets,
	owner: KeyframeOwnerKind
) {
	const frameKeys = new Set<string>();
	for (const frame of keyframes) {
		if (!keyframePropertyAllowed(owner, frame.property)) {
			throw new Error(`A ${owner} cannot carry ${frame.property} keyframes.`);
		}
		const colored = isColorKeyframeProperty(frame.property);
		if (
			colored !== (frame.color !== undefined) ||
			(colored && frame.value !== 0)
		) {
			throw new Error(
				"Color keyframes need a #rrggbb color and a zero value; other keyframes take no color."
			);
		}
		const key = `${frame.property}:${frame.target ?? ""}:${frame.time}`;
		const [min, max] = keyframeValueBounds(frame.property);
		const targeted = targetedKeyframeProperties.has(frame.property);
		const pool = maskKeyframeProperties.has(frame.property)
			? targets.masks
			: targets.effects;
		if (
			frame.time > duration ||
			frame.value < min ||
			frame.value > max ||
			frameKeys.has(key) ||
			(targeted
				? frame.target === undefined || !pool.has(frame.target)
				: frame.target !== undefined) ||
			(frame.bezier !== undefined) !== (frame.interpolation === "bezier")
		) {
			throw new Error("Invalid or duplicate animation keyframe.");
		}
		frameKeys.add(key);
	}
}

/**
 * A reveal transition plays over the end of the previous clip on the same
 * track, so that clip must overlap the incoming one by the full duration.
 */
function validateRevealTransitions(segments: readonly Segment[]) {
	const byTrack = new Map<number, Segment[]>();
	for (const segment of segments) {
		const lane = byTrack.get(segment.track) ?? [];
		lane.push(segment);
		byTrack.set(segment.track, lane);
	}
	for (const segment of segments) {
		if (!segment.transitionIn) {
			continue;
		}
		const required = segment.start + segment.transitionIn.duration;
		const covered = (byTrack.get(segment.track) ?? []).some(
			(other) =>
				other.id !== segment.id &&
				other.start < segment.start &&
				other.start + segmentDuration(other) >= required - 1e-6
		);
		if (
			!covered ||
			segment.transitionIn.duration > segmentDuration(segment) + 1e-6
		) {
			throw new Error(
				"A reveal transition needs a same-track predecessor overlapping it by its duration."
			);
		}
	}
}

/**
 * Fit a clip's edge transitions to one piece cut out of it. Only the piece
 * that keeps the original head keeps `transitionIn` (its predecessor overlap
 * is unchanged), and only the piece that keeps the original tail keeps the
 * exit transition; both durations are clamped to the piece like fades are.
 * Absent fields stay absent so legacy clips serialize unchanged.
 */
export function fitEdgeTransitions(
	piece: Segment,
	keepsHead: boolean,
	keepsTail: boolean
): Segment {
	if (
		piece.transitionIn === undefined &&
		piece.exitTransition === undefined &&
		piece.exitDuration === undefined
	) {
		return piece;
	}
	const { transitionIn, exitTransition, exitDuration, ...rest } = piece;
	const duration = segmentDuration(piece);
	const fitted: Segment = rest;
	if (keepsHead && transitionIn) {
		fitted.transitionIn = {
			...transitionIn,
			duration: Math.min(transitionIn.duration, duration),
		};
	}
	if (keepsTail && exitTransition !== undefined) {
		fitted.exitTransition = exitTransition;
	}
	if (keepsTail && exitDuration !== undefined) {
		fitted.exitDuration = Math.min(exitDuration, duration);
	}
	return fitted;
}

/**
 * Fit a piece cut out of `original` the way `splitSegment` fits its halves:
 * a piece that lost the head drops its fade-in and advances `entryOffset` by
 * the trimmed time (the entry animation already played), a piece that lost
 * the tail drops its fade-out, kept fades are clamped to the piece, and edge
 * transitions follow `fitEdgeTransitions`.
 */
export function fitCutPiece(
	original: Segment,
	piece: Segment,
	keepsHead: boolean,
	keepsTail: boolean
): Segment {
	const duration = segmentDuration(piece);
	const trimmed = Math.max(
		0,
		(piece.sourceIn - original.sourceIn) / original.speed
	);
	return fitEdgeTransitions(
		{
			...piece,
			entryOffset: keepsHead
				? piece.entryOffset
				: Math.min(7200, piece.entryOffset + trimmed),
			fadeIn: keepsHead ? Math.min(piece.fadeIn, duration) : 0,
			fadeOut: keepsTail ? Math.min(piece.fadeOut, duration) : 0,
		},
		keepsHead,
		keepsTail
	);
}

export function splitSegment(s: Segment, at: number): [Segment, Segment] {
	const offset = at - s.start;
	if (offset < 0.04 || segmentDuration(s) - offset < 0.04) {
		throw new Error("Place the playhead inside the segment to split.");
	}
	// A curved clip splits on the curve: each half keeps its part of it.
	const timing = splitSpeedCurve(s, offset);
	const cut = timing.cut;
	const groups = keyframeGroups(s.keyframes);
	const [left, right]: [Segment, Segment] = [
		{
			...s,
			...timing.left,
			sourceOut: cut,
			fadeIn: Math.min(s.fadeIn, offset),
			fadeOut: 0,
			keyframes: [
				...s.keyframes.filter((f) => f.time < offset),
				...groups.map((group) => boundaryKeyframe(s, group, offset, offset)),
			],
		},
		{
			...s,
			...timing.right,
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
			keyframes: [
				// Legacy properties restart from the clip fields set above; every
				// other channel keeps its value through a time-zero keyframe.
				...groups
					.filter((group) => !isLegacyKeyframeProperty(group.property))
					.map((group) => boundaryKeyframe(s, group, 0, offset)),
				...s.keyframes
					.filter((f) => f.time > offset)
					.map((f) => ({
						...f,
						id: crypto.randomUUID(),
						time: f.time - offset,
					})),
			],
			fadeIn: 0,
			fadeOut: Math.min(s.fadeOut, segmentDuration(s) - offset),
		},
	];
	return [
		fitEdgeTransitions(left, true, false),
		fitEdgeTransitions(right, false, true),
	];
}
