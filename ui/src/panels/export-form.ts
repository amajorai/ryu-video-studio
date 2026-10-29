import { z } from "zod";
import {
	OUTPUT_RESOLUTION_LABELS,
	OUTPUT_RESOLUTIONS,
	type OutputResolution,
	outputResolutionError,
	outputResolutionOf,
	outputSizeForResolution,
} from "../../../shared/output-resolution.ts";
import type { ExportCodec, Project } from "../../../shared/project.ts";
import {
	EXPORT_FILE_FORMATS,
	type ExportFileFormat,
	type ExportOverrides,
	exportJobOutputSchema,
	exportKindOf,
	exportSupportsAlpha,
	type RenderPlan,
	type RenderRequest,
	requestedExportContainer,
	requiredEncoders,
	resolveRenderPlan,
} from "../../../shared/render-options.ts";
import {
	type EncoderPreset,
	type ExportContainer,
	type ExportSettings,
	exportSettingsSchema,
} from "../../../shared/schema/export.ts";

/**
 * Pure state for the Export panel: the form, its request body, the resolved
 * plan preview, capability gating and download naming. Kept free of React
 * so it is tested without a DOM.
 */

export type RateControl = "crf" | "cbr" | "vbr";

export interface ExportForm {
	/** Transparency; unset inherits the project's setting. */
	alpha?: boolean;
	audioBitrateKbps?: number;
	bitrateKbps?: number;
	codec?: ExportCodec;
	container?: ExportContainer;
	crf?: number;
	/** The Custom size choice, kept even when its fields match a tier. */
	customOutputSize?: boolean;
	encoderPreset?: EncoderPreset;
	gifFps?: number;
	gifWidth?: number;
	/** HDR tags for 10-bit HEVC; unset inherits the project's setting. */
	hdr?: boolean;
	/** Audio in video exports; unset inherits the project's setting. */
	includeAudio?: boolean;
	outputHeight?: number;
	outputWidth?: number;
	/** A publish preset other than the project's; unset uses the project's. */
	platformPreset?: string;
	/** Render only the editor's I/O range. */
	rangeOnly: boolean;
	rateControl?: RateControl;
	saveAsAsset: boolean;
}

/**
 * The initial form: nothing overridden, so every field (including the
 * project's stored publish preset, alpha, audio and HDR choices) comes from
 * the project's `exportSettings` exactly as a body-less render resolves it.
 */
export function initialExportForm(): ExportForm {
	return { rangeOnly: false, saveAsAsset: false };
}

/** Whether transparency is possible for the container. */
export function alphaApplies(container: ExportContainer): boolean {
	return exportSupportsAlpha(container);
}

/**
 * The container the form exports to, before alpha and audio choices (which
 * never change it). Falls back to the form's choice for an unknown preset.
 */
export function formContainer(
	project: Pick<Project, "exportCodec" | "exportPreset" | "exportSettings">,
	form: ExportForm
): ExportContainer {
	try {
		return requestedExportContainer(project, {
			...(form.codec ? { codec: form.codec } : {}),
			overrides: {
				...(form.platformPreset ? { platformPreset: form.platformPreset } : {}),
				...(form.container ? { container: form.container } : {}),
			},
		});
	} catch {
		return form.container ?? "mp4";
	}
}

/**
 * Settings overrides for the form; unset fields fall back to the project.
 * Toggles hidden for `container` (alpha outside MOV/WebM/PNG frames, audio
 * outside video files) are not sent, so a value set under another format
 * can never block this one.
 */
export function exportOverridesOf(
	form: ExportForm,
	container: ExportContainer
): ExportOverrides {
	const overrides: ExportOverrides = {};
	const assign = <Key extends keyof ExportOverrides>(
		key: Key,
		value: ExportOverrides[Key] | undefined
	) => {
		if (value !== undefined) {
			overrides[key] = value;
		}
	};
	assign("platformPreset", form.platformPreset);
	assign("container", form.container);
	assign("rateControl", form.rateControl);
	assign("crf", form.rateControl === "crf" ? form.crf : undefined);
	assign(
		"bitrateKbps",
		form.rateControl && form.rateControl !== "crf"
			? form.bitrateKbps
			: undefined
	);
	assign("audioBitrateKbps", form.audioBitrateKbps);
	assign("encoderPreset", form.encoderPreset);
	if (form.outputWidth !== undefined && form.outputHeight !== undefined) {
		overrides.outputWidth = form.outputWidth;
		overrides.outputHeight = form.outputHeight;
	}
	if (container === "gif") {
		assign("gifFps", form.gifFps);
		assign("gifWidth", form.gifWidth);
	}
	if (exportKindOf(container) === "video") {
		assign("includeAudio", form.includeAudio);
	}
	if (alphaApplies(container)) {
		assign("alpha", form.alpha);
	}
	if (form.hdr !== undefined) {
		overrides.hdr = form.hdr ? "auto" : "off";
	}
	return overrides;
}

/** The Output resolution menu value: "" matches the timeline. */
export type OutputResolutionChoice = "" | OutputResolution | "custom";

type Canvas = Pick<Project, "height" | "width">;

/** The menu value the form's size fields correspond to. */
export function outputResolutionChoiceOf(
	canvas: Canvas,
	form: ExportForm
): OutputResolutionChoice {
	if (form.customOutputSize) {
		return "custom";
	}
	if (form.outputWidth === undefined || form.outputHeight === undefined) {
		return "";
	}
	return (
		outputResolutionOf(canvas, {
			width: form.outputWidth,
			height: form.outputHeight,
		}) ?? "custom"
	);
}

/**
 * The form after choosing an Output resolution: a tier fills the size from
 * the canvas (short side at the tier, aspect kept, even sizes), "Match
 * timeline" clears it, and Custom keeps the fields for editing, starting
 * from the current output size.
 */
export function withOutputResolution(
	canvas: Canvas,
	form: ExportForm,
	choice: OutputResolutionChoice,
	current: { height: number; width: number } = canvas
): ExportForm {
	const { customOutputSize: _custom, ...rest } = form;
	if (choice === "") {
		const { outputHeight: _height, outputWidth: _width, ...cleared } = rest;
		return cleared;
	}
	if (choice === "custom") {
		return {
			...rest,
			customOutputSize: true,
			outputWidth: form.outputWidth ?? current.width,
			outputHeight: form.outputHeight ?? current.height,
		};
	}
	const size = outputSizeForResolution(canvas, choice);
	return { ...rest, outputWidth: size.width, outputHeight: size.height };
}

/** Output resolution menu entries, each with its size for this canvas. */
export function outputResolutionOptions(canvas: Canvas): {
	disabled: boolean;
	label: string;
	value: OutputResolution;
}[] {
	return OUTPUT_RESOLUTIONS.map((value) => {
		const size = outputSizeForResolution(canvas, value);
		return {
			disabled: outputResolutionError(canvas, value) !== undefined,
			label: `${OUTPUT_RESOLUTION_LABELS[value]} · ${size.width} × ${size.height}`,
			value,
		};
	});
}

/** The `POST /projects/:id/render` body for the form. */
export function exportRequestOf(
	project: Pick<Project, "exportCodec" | "exportPreset" | "exportSettings">,
	form: ExportForm,
	range: { end: number; start: number },
	revision?: number
): RenderRequest {
	const request: RenderRequest = {};
	if (revision !== undefined) {
		request.revision = revision;
	}
	if (form.codec) {
		request.codec = form.codec;
	}
	if (form.rangeOnly) {
		request.range = { start: range.start, end: range.end };
	}
	if (form.saveAsAsset) {
		request.saveAsAsset = true;
	}
	const overrides = exportOverridesOf(form, formContainer(project, form));
	if (Object.keys(overrides).length) {
		request.overrides = overrides;
	}
	return request;
}

/**
 * The project's new `exportSettings` for "Save as project default": the
 * stored settings with the form's choices applied, so fields the form
 * leaves at "Project default" keep their saved values.
 */
export function projectExportSettingsOf(
	project: Pick<Project, "exportCodec" | "exportPreset" | "exportSettings">,
	form: ExportForm
): ExportSettings {
	const container = formContainer(project, form);
	const { alpha, includeAudio, ...rest }: Partial<ExportSettings> = {
		...project.exportSettings,
		...exportOverridesOf(form, container),
	};
	const settings: ExportSettings = { ...rest, container };
	if (alpha !== undefined && alphaApplies(container)) {
		settings.alpha = alpha;
	}
	if (includeAudio !== undefined && exportKindOf(container) === "video") {
		settings.includeAudio = includeAudio;
	}
	return exportSettingsSchema.parse(settings);
}

/** The resolved plan, or the reason the form cannot export. */
export function previewExport(
	project: Project,
	form: ExportForm,
	range: { end: number; start: number },
	timelineDuration: number
): { error: string } | { plan: RenderPlan } {
	if (form.rangeOnly && !(range.end > range.start)) {
		return { error: "Set an In point before the Out point to export a range." };
	}
	if (!timelineDuration) {
		return { error: "Add media, graphics, or an avatar before exporting." };
	}
	const {
		revision: _revision,
		saveAsAsset,
		...options
	} = exportRequestOf(project, form, range);
	try {
		const plan = resolveRenderPlan(project, options, { timelineDuration });
		if (saveAsAsset && !["video", "audio"].includes(plan.kind)) {
			return {
				error: "Only video and audio exports can be saved to the library.",
			};
		}
		return { plan };
	} catch (error) {
		return {
			error:
				error instanceof Error ? error.message : "This export is not valid.",
		};
	}
}

export const exportCapabilitiesSchema = z.object({
	encoders: z.record(z.string(), z.boolean()).default({}),
	renderer: z.boolean().default(false),
	x265TenBit: z.boolean().default(false),
});
export type ExportCapabilities = z.infer<typeof exportCapabilitiesSchema>;

/** Why this plan cannot be encoded on this node, or `undefined` when it can. */
export function capabilityGap(
	plan: RenderPlan,
	capabilities: ExportCapabilities | undefined
): string | undefined {
	if (!capabilities?.renderer) {
		return;
	}
	const missing = requiredEncoders(plan).filter(
		(encoder) => capabilities.encoders[encoder] === false
	);
	if (plan.videoCodec === "h265-10bit" && !capabilities.x265TenBit) {
		missing.push("libx265 (10-bit)");
	}
	return missing.length
		? `Requires an FFmpeg build with ${missing.join(", ")}.`
		: undefined;
}

export const CONTAINER_OPTIONS: readonly {
	label: string;
	value: ExportContainer;
}[] = [
	{ value: "mp4", label: "MP4 video" },
	{ value: "mov", label: "MOV video" },
	{ value: "webm", label: "WebM video (VP9)" },
	{ value: "gif", label: "Animated GIF" },
	{ value: "wav", label: "WAV audio" },
	{ value: "mp3", label: "MP3 audio" },
	{ value: "aac", label: "AAC audio (M4A)" },
	{ value: "png-sequence", label: "PNG frames (ZIP)" },
	{ value: "jpeg-sequence", label: "JPEG frames (ZIP)" },
];

export const CODEC_OPTIONS: readonly { label: string; value: ExportCodec }[] = [
	{ value: "h264", label: "H.264" },
	{ value: "h265", label: "H.265 (HEVC)" },
	{ value: "h265-10bit", label: "H.265 10-bit" },
	{ value: "prores", label: "ProRes 422 HQ" },
	{ value: "prores-4444", label: "ProRes 4444" },
	{ value: "vp9", label: "VP9" },
];

/** Whether the codec picker applies (MP4 and MOV choose; WebM is VP9). */
export function codecApplies(container: ExportContainer): boolean {
	return container === "mp4" || container === "mov";
}

const jobDetailsSchema = z
	.object({
		codec: z.string().optional(),
		export: exportJobOutputSchema.optional(),
	})
	.passthrough();

/** Download format of a finished job (legacy jobs carry only a codec). */
export function jobFileFormat(value: unknown): ExportFileFormat {
	const job = jobDetailsSchema.parse(value);
	if (job.export) {
		return {
			extension: job.export.extension,
			label: job.export.label,
			mime: job.export.mime,
		};
	}
	return job.codec === "prores"
		? EXPORT_FILE_FORMATS.mov
		: EXPORT_FILE_FORMATS.mp4;
}

/** Publish metadata recorded on a finished job, if a preset wrote one. */
export function jobMetadata(value: unknown): string | undefined {
	return jobDetailsSchema.parse(value).export?.metadata;
}

/** A safe download name: the project title plus the export span. */
export function exportFileName(
	title: string,
	format: ExportFileFormat,
	range?: { end: number; start: number }
): string {
	const base = title.replace(/[\\/:*?"<>|]+/g, "-").trim() || "export";
	const span = range
		? ` ${range.start.toFixed(1)}-${range.end.toFixed(1)}s`
		: "";
	return `${base}${span}.${format.extension}`;
}

/** One-line summary of a plan for the panel. */
export function planSummary(plan: RenderPlan): string {
	const parts = [plan.file.label];
	if (plan.videoCodec) {
		parts.push(
			CODEC_OPTIONS.find((option) => option.value === plan.videoCodec)?.label ??
				plan.videoCodec
		);
	}
	if (exportKindOf(plan.container) !== "audio") {
		parts.push(`${plan.output.width} × ${plan.output.height}`);
	}
	parts.push(`${plan.duration.toFixed(1)} s`);
	if (plan.kind === "video") {
		parts.push(plan.includeAudio ? "with audio" : "no audio");
	}
	if (plan.alpha) {
		parts.push("transparent");
	}
	if (plan.hdr) {
		parts.push("HDR tags");
	}
	return parts.join(" · ");
}
