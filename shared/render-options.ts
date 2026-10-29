import { z } from "zod";
import {
	type OutputResolution,
	outputResolutionError,
	outputResolutionSchema,
	outputSizeForResolution,
} from "./output-resolution.ts";
import {
	type ExportCodec,
	exportCodecSchema,
	type Project,
} from "./project.ts";
import {
	type PublishPreset,
	publishPresetFor,
	publishPresetWarnings,
} from "./publish-presets.ts";
import type { AssetColorTransfer } from "./schema/asset.ts";
import {
	exportSettingsOf,
	type ResolvedExportSettings,
} from "./schema/defaults.ts";
import {
	type ExportContainer,
	type ExportSettings,
	exportContainerSchema,
	exportSettingsSchema,
} from "./schema/export.ts";
import { timeSchema } from "./schema/primitives.ts";

/**
 * Export request contract and its pure resolution into a render plan.
 *
 * `POST /projects/:id/render` parses its body with `renderRequestSchema`; an
 * empty body is the legacy export (whole timeline, project codec and preset).
 * `resolveRenderPlan` layers the export settings and validates every
 * container, codec, alpha, audio and range combination before any FFmpeg
 * work starts, so the sidecar only ever runs a plan that can succeed.
 */

export const renderRangeSchema = z
	.object({ start: timeSchema, end: timeSchema })
	.strict()
	.refine((range) => range.end > range.start, {
		message: "The export range must end after it starts.",
		path: ["end"],
	});
export type RenderRange = z.infer<typeof renderRangeSchema>;

/** Any subset of the export settings, applied over the project's own. */
export const exportOverridesSchema = z
	.object(exportSettingsSchema.shape)
	.partial()
	.strict()
	.refine(
		(settings) =>
			(settings.outputWidth === undefined) ===
			(settings.outputHeight === undefined),
		"Provide output width and height together."
	);
export type ExportOverrides = z.infer<typeof exportOverridesSchema>;

/** Everything that changes the rendered file (no revision or library side effects). */
export const renderOptionsSchema = z
	.object({
		range: renderRangeSchema.optional(),
		audioOnly: z.boolean().optional(),
		/** Video codec for this export; defaults to the project codec. */
		codec: exportCodecSchema.optional(),
		overrides: exportOverridesSchema.optional(),
		/**
		 * Resolution tier: scales the canvas so its short side is 720, 1080,
		 * 1440 (2K) or 2160 (4K) px, keeping the aspect. Replaces a stored or
		 * preset output size; cannot be combined with an explicit one.
		 */
		outputResolution: outputResolutionSchema.optional(),
	})
	.strict();
export type RenderOptions = z.infer<typeof renderOptionsSchema>;

export const renderRequestSchema = z
	.object({
		...renderOptionsSchema.shape,
		/** When present, the export is refused unless the project is at this revision. */
		revision: z.number().int().nonnegative().optional(),
		/** Import the finished file into the library (`derivation: "render"`). */
		saveAsAsset: z.boolean().optional(),
	})
	.strict();
export type RenderRequest = z.infer<typeof renderRequestSchema>;

/** The file a container produces, as it is downloaded. */
export interface ExportFileFormat {
	extension: string;
	label: string;
	mime: string;
}

export const EXPORT_FILE_FORMATS: Record<ExportContainer, ExportFileFormat> = {
	mp4: { extension: "mp4", label: "MP4", mime: "video/mp4" },
	mov: { extension: "mov", label: "MOV", mime: "video/quicktime" },
	webm: { extension: "webm", label: "WebM", mime: "video/webm" },
	gif: { extension: "gif", label: "GIF", mime: "image/gif" },
	wav: { extension: "wav", label: "WAV", mime: "audio/wav" },
	mp3: { extension: "mp3", label: "MP3", mime: "audio/mpeg" },
	aac: { extension: "m4a", label: "AAC (M4A)", mime: "audio/mp4" },
	"png-sequence": {
		extension: "zip",
		label: "PNG frames (ZIP)",
		mime: "application/zip",
	},
	"jpeg-sequence": {
		extension: "zip",
		label: "JPEG frames (ZIP)",
		mime: "application/zip",
	},
};

export type ExportKind = "video" | "audio" | "gif" | "sequence";

export function exportKindOf(container: ExportContainer): ExportKind {
	switch (container) {
		case "wav":
		case "mp3":
		case "aac":
			return "audio";
		case "gif":
			return "gif";
		case "png-sequence":
		case "jpeg-sequence":
			return "sequence";
		default:
			return "video";
	}
}

/** Containers that can be imported back into the library as media. */
export function importableExport(container: ExportContainer): boolean {
	const kind = exportKindOf(container);
	return kind === "video" || kind === "audio";
}

/** Image sequences are zipped in one pass; longer ones are refused up front. */
export const MAX_SEQUENCE_FRAMES = 3600;
export const DEFAULT_GIF_FPS = 15;
export const DEFAULT_GIF_WIDTH = 640;
/** `-bufsize` multiple of the target bitrate. */
const CBR_BUFFER = 2;
/** VBR ceiling (`-maxrate`) relative to the target bitrate. */
export const VBR_PEAK = 1.5;

export type HdrTransfer = "smpte2084" | "arib-std-b67";

export interface RenderPlan {
	alpha: boolean;
	/** Target video bitrate for CBR/VBR (kbps); absent for CRF. */
	bitrateKbps?: number;
	container: ExportContainer;
	/** Output length in seconds (the range length, or the whole timeline). */
	duration: number;
	file: ExportFileFormat;
	/** GIF frame rate and size. */
	gif?: { fps: number; height: number; width: number };
	/** HDR transfer tags for 10-bit HEVC, when any source is PQ or HLG. */
	hdr?: HdrTransfer;
	includeAudio: boolean;
	kind: ExportKind;
	/** Encoded frame size. */
	output: { height: number; width: number };
	preset?: PublishPreset;
	/** Set only when the request names a range. */
	range?: RenderRange;
	settings: ResolvedExportSettings;
	/** Output start on the timeline (0 without a range). */
	start: number;
	/** Video codec for `video` exports. */
	videoCodec?: ExportCodec;
	warnings: string[];
}

function definedFields<T extends object>(value: T | undefined): Partial<T> {
	const fields: Partial<T> = {};
	for (const key of Object.keys(value ?? {}) as (keyof T)[]) {
		if (value?.[key] !== undefined) {
			fields[key] = value[key];
		}
	}
	return fields;
}

/**
 * Settings layers, lowest first: the codec/preset defaults, the publish
 * preset, the project's `exportSettings`, then the request overrides. A
 * request that picks a different publish preset than the project's replaces
 * the project's settings layer, so switching presets never inherits another
 * preset's size; repeating the project's own preset keeps its saved values.
 */
function layeredSettings(
	project: Pick<Project, "exportCodec" | "exportPreset" | "exportSettings">,
	options: RenderOptions
): {
	codec: ExportCodec;
	preset?: PublishPreset;
	settings: ResolvedExportSettings;
} {
	const overrides = options.overrides;
	const requestedPreset = overrides?.platformPreset;
	const presetId = requestedPreset ?? project.exportSettings?.platformPreset;
	const preset = publishPresetFor(presetId);
	if (presetId !== undefined && !preset) {
		throw new Error(`Unknown publish preset ${presetId}.`);
	}
	const codec = options.codec ?? preset?.codec ?? project.exportCodec;
	const projectLayer =
		requestedPreset === undefined ||
		requestedPreset === project.exportSettings?.platformPreset
			? project.exportSettings
			: undefined;
	const settings: ResolvedExportSettings = {
		...exportSettingsOf({
			exportCodec: codec,
			exportPreset: project.exportPreset,
			exportSettings: undefined,
		}),
		...definedFields(preset?.settings),
		...definedFields(projectLayer),
		...definedFields(overrides),
	};
	return { codec, preset, settings };
}

function containerCodec(
	container: ExportContainer,
	codec: ExportCodec,
	explicitCodec: boolean,
	alpha: boolean
): ExportCodec {
	if (container === "webm") {
		if (explicitCodec && codec !== "vp9") {
			throw new Error("WebM exports are encoded with VP9.");
		}
		return "vp9";
	}
	if (codec === "vp9") {
		throw new Error("VP9 exports use the WebM container.");
	}
	if (container === "mp4" && (codec === "prores" || codec === "prores-4444")) {
		throw new Error("ProRes exports use the MOV container.");
	}
	if (alpha) {
		if (container !== "mov") {
			throw new Error(
				"Transparent video exports need MOV (ProRes 4444) or WebM (VP9)."
			);
		}
		if (explicitCodec && codec !== "prores-4444") {
			throw new Error("Transparent MOV exports are encoded with ProRes 4444.");
		}
		return "prores-4444";
	}
	return codec;
}

/** Containers that can carry an alpha channel. */
export function exportSupportsAlpha(container: ExportContainer): boolean {
	return (
		container === "mov" || container === "webm" || container === "png-sequence"
	);
}

/** Whether a stored (not requested) alpha setting carries over to this export. */
function inheritedAlphaApplies(
	container: ExportContainer,
	codec: ExportCodec | undefined
): boolean {
	if (!exportSupportsAlpha(container) || codec === undefined) {
		return exportSupportsAlpha(container);
	}
	if (container === "mov") {
		return codec === "prores-4444";
	}
	return container === "webm" ? codec === "vp9" : true;
}

/**
 * The container an export request resolves to, before alpha, audio and
 * range validation. Throws only for an unknown publish preset.
 */
export function requestedExportContainer(
	project: Pick<Project, "exportCodec" | "exportPreset" | "exportSettings">,
	options: RenderOptions
): ExportContainer {
	const { settings } = layeredSettings(project, options);
	if (options.audioOnly && exportKindOf(settings.container) !== "audio") {
		return "wav";
	}
	return settings.container;
}

function resolveRange(
	range: RenderRange | undefined,
	timelineDuration: number
): { range?: RenderRange; start: number; duration: number } {
	if (!range) {
		return { start: 0, duration: timelineDuration };
	}
	if (range.start >= timelineDuration) {
		throw new Error("The export range starts after the end of the timeline.");
	}
	const end = Math.min(range.end, timelineDuration);
	return {
		range: { start: range.start, end },
		start: range.start,
		duration: end - range.start,
	};
}

/** A bitrate that suits the frame size when CBR/VBR has no explicit target. */
export function defaultBitrateKbps(
	width: number,
	height: number,
	fps: number
): number {
	const kbps = Math.round((width * height * fps * 0.07) / 1000 / 100) * 100;
	return Math.min(200_000, Math.max(1000, kbps));
}

function hdrTransfer(
	codec: ExportCodec | undefined,
	settings: ExportSettings,
	transfers: readonly AssetColorTransfer[]
): HdrTransfer | undefined {
	if (codec !== "h265-10bit" || settings.hdr !== "auto") {
		return;
	}
	if (transfers.includes("pq")) {
		return "smpte2084";
	}
	return transfers.includes("hlg") ? "arib-std-b67" : undefined;
}

/** Sets the tier's output size on `settings`, or throws when it cannot apply. */
function applyOutputResolution(
	settings: ExportSettings,
	canvas: { height: number; width: number },
	resolution: OutputResolution,
	explicitSize: boolean
): void {
	if (explicitSize) {
		throw new Error(
			"Choose an output resolution or an output width and height, not both."
		);
	}
	const error = outputResolutionError(canvas, resolution);
	if (error) {
		throw new Error(error);
	}
	const size = outputSizeForResolution(canvas, resolution);
	settings.outputWidth = size.width;
	settings.outputHeight = size.height;
}

export interface RenderPlanFacts {
	/** Color transfers of the sources the timeline uses. */
	sourceTransfers?: readonly AssetColorTransfer[];
	/** Whole-timeline duration in seconds. */
	timelineDuration: number;
}

type PlanProject = Pick<
	Project,
	"exportCodec" | "exportPreset" | "exportSettings" | "fps" | "height" | "width"
>;

/**
 * Resolve the effective export: container, codec, audio, alpha, range, size,
 * rate control and warnings. Throws a user-facing `Error` for combinations
 * that cannot be encoded. Pure and deterministic.
 */
export function resolveRenderPlan(
	project: PlanProject,
	options: RenderOptions,
	facts: RenderPlanFacts
): RenderPlan {
	const layered = layeredSettings(project, options);
	const settings = layered.settings;
	const warnings: string[] = [];
	const overrideContainer = options.overrides?.container;
	if (
		options.audioOnly &&
		overrideContainer &&
		exportKindOf(overrideContainer) !== "audio"
	) {
		throw new Error("Audio-only exports use WAV, MP3 or AAC.");
	}
	if (options.audioOnly && exportKindOf(settings.container) !== "audio") {
		settings.container = "wav";
	}
	const container = exportContainerSchema.parse(settings.container);
	const kind = exportKindOf(container);
	const explicit = options.overrides ?? {};
	if (kind === "audio") {
		if (explicit.includeAudio === false) {
			throw new Error("An audio-only export cannot leave out the audio.");
		}
		// An inherited "no audio" (project or preset) does not apply to audio files.
		settings.includeAudio = true;
	}
	// Inherited transparency applies only where it can be encoded; an explicit
	// request for it is still validated (and refused) below.
	const alpha =
		settings.alpha &&
		(explicit.alpha === true ||
			inheritedAlphaApplies(container, options.codec));
	settings.alpha = alpha;
	if (alpha && kind !== "video" && container !== "png-sequence") {
		throw new Error(
			"Transparency is available for MOV, WebM and PNG sequence exports."
		);
	}
	const videoCodec =
		kind === "video"
			? containerCodec(
					container,
					layered.codec,
					options.codec !== undefined,
					alpha
				)
			: undefined;
	const span = resolveRange(options.range, facts.timelineDuration);
	if (options.outputResolution && kind !== "audio") {
		applyOutputResolution(
			settings,
			project,
			options.outputResolution,
			explicit.outputWidth !== undefined
		);
	}
	let output = { width: project.width, height: project.height };
	if (
		settings.outputWidth !== undefined &&
		settings.outputHeight !== undefined
	) {
		output = { width: settings.outputWidth, height: settings.outputHeight };
	}
	let gif: RenderPlan["gif"];
	if (kind === "gif") {
		const width = Math.min(
			settings.gifWidth ?? DEFAULT_GIF_WIDTH,
			output.width
		);
		gif = {
			fps: Math.min(settings.gifFps ?? DEFAULT_GIF_FPS, project.fps),
			width,
			height: Math.max(2, Math.round((width * output.height) / output.width)),
		};
		output = { width: gif.width, height: gif.height };
	}
	if (kind === "sequence") {
		const frames = Math.ceil(span.duration * project.fps - 1e-9);
		if (frames > MAX_SEQUENCE_FRAMES) {
			throw new Error(
				`Image sequences hold at most ${MAX_SEQUENCE_FRAMES} frames; this export has ${frames}. Export a shorter range.`
			);
		}
	}
	const bitrateKbps =
		kind === "video" && settings.rateControl !== "crf"
			? (settings.bitrateKbps ??
				defaultBitrateKbps(output.width, output.height, project.fps))
			: undefined;
	if (
		videoCodec?.startsWith("prores") &&
		(settings.rateControl !== "crf" || settings.encoderPreset !== undefined)
	) {
		warnings.push(
			"ProRes has a fixed quality profile; rate control and encoder speed are ignored."
		);
	}
	if (layered.preset) {
		warnings.push(
			...publishPresetWarnings(layered.preset, {
				canvasHeight: project.height,
				canvasWidth: project.width,
				duration: span.duration,
				...(options.outputResolution ? { output } : {}),
			})
		);
	}
	const hdr = hdrTransfer(videoCodec, settings, facts.sourceTransfers ?? []);
	const plan: RenderPlan = {
		alpha,
		container,
		duration: span.duration,
		file: EXPORT_FILE_FORMATS[container],
		includeAudio: settings.includeAudio,
		kind,
		output,
		settings: { ...settings, container },
		start: span.start,
		warnings,
	};
	if (span.range) {
		plan.range = span.range;
	}
	if (videoCodec) {
		plan.videoCodec = videoCodec;
	}
	if (bitrateKbps !== undefined) {
		plan.bitrateKbps = bitrateKbps;
	}
	if (gif) {
		plan.gif = gif;
	}
	if (hdr) {
		plan.hdr = hdr;
	}
	if (layered.preset) {
		plan.preset = layered.preset;
	}
	return plan;
}

/** Whether the encoded frame differs from the canvas and needs a final scale. */
export function needsOutputScale(
	plan: Pick<RenderPlan, "kind" | "output">,
	project: Pick<Project, "height" | "width">
): boolean {
	return (
		plan.kind !== "gif" &&
		(plan.output.width !== project.width ||
			plan.output.height !== project.height)
	);
}

/** CBR/VBR video rate arguments for x264, x265 and VP9. */
export function rateControlArgs(
	rateControl: "cbr" | "vbr",
	kbps: number
): string[] {
	if (rateControl === "cbr") {
		return [
			"-b:v",
			`${kbps}k`,
			"-maxrate",
			`${kbps}k`,
			"-bufsize",
			`${kbps * CBR_BUFFER}k`,
		];
	}
	return [
		"-b:v",
		`${kbps}k`,
		"-maxrate",
		`${Math.round(kbps * VBR_PEAK)}k`,
		"-bufsize",
		`${Math.round(kbps * VBR_PEAK * CBR_BUFFER)}k`,
	];
}

/** Optional FFmpeg encoders a plan needs (names as `GET /capabilities` reports them). */
export function requiredEncoders(
	plan: Pick<RenderPlan, "container" | "includeAudio" | "kind" | "videoCodec">
): string[] {
	const encoders = new Set<string>();
	switch (plan.videoCodec) {
		case "h264":
			encoders.add("libx264");
			break;
		case "h265":
		case "h265-10bit":
			encoders.add("libx265");
			break;
		case "prores":
		case "prores-4444":
			encoders.add("prores_ks");
			break;
		case "vp9":
			encoders.add("libvpx-vp9");
			break;
		default:
			break;
	}
	const audio =
		plan.kind === "audio" || (plan.kind === "video" && plan.includeAudio);
	if (audio) {
		if (plan.container === "webm") {
			encoders.add("libopus");
		} else if (plan.container === "mp3") {
			encoders.add("libmp3lame");
		} else if (plan.container !== "wav") {
			encoders.add("aac");
		}
	}
	return [...encoders].sort();
}

/** What a finished (or queued) export job records about its output. */
export const exportJobOutputSchema = z.object({
	alpha: z.boolean(),
	assetId: z.string().optional(),
	codec: exportCodecSchema.optional(),
	container: exportContainerSchema,
	duration: z.number().finite().nonnegative(),
	extension: z.string(),
	frames: z.number().int().nonnegative().optional(),
	height: z.number().int().positive(),
	includeAudio: z.boolean(),
	kind: z.enum(["video", "audio", "gif", "sequence"]),
	label: z.string(),
	metadata: z.string().optional(),
	mime: z.string(),
	platformPreset: z.string().optional(),
	range: z.object({ start: z.number(), end: z.number() }).optional(),
	request: renderOptionsSchema.optional(),
	saveAsAsset: z.boolean().optional(),
	warnings: z.array(z.string()),
	width: z.number().int().positive(),
});
export type ExportJobOutput = z.infer<typeof exportJobOutputSchema>;

/** The job summary recorded when an export is queued. */
export function exportJobOutputOf(
	plan: RenderPlan,
	request: RenderRequest
): ExportJobOutput {
	const { revision: _revision, saveAsAsset, ...options } = request;
	const output: ExportJobOutput = {
		alpha: plan.alpha,
		container: plan.container,
		duration: plan.duration,
		extension: plan.file.extension,
		height: plan.output.height,
		includeAudio: plan.kind === "audio" || plan.includeAudio,
		kind: plan.kind,
		label: plan.file.label,
		mime: plan.file.mime,
		warnings: plan.warnings,
		width: plan.output.width,
	};
	if (plan.videoCodec) {
		output.codec = plan.videoCodec;
	}
	if (plan.range) {
		output.range = plan.range;
	}
	if (plan.preset) {
		output.platformPreset = plan.preset.id;
	}
	if (Object.keys(options).length) {
		output.request = options;
	}
	if (saveAsAsset) {
		output.saveAsAsset = true;
	}
	return output;
}
