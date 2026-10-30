import { z } from "zod";
import { projectFpsForRate, sameFrameRate } from "./frame-rate.ts";
import { MAX_CANVAS } from "./limits.ts";
import {
	type Asset,
	isWritableProjectFps,
	type Project,
	type ProjectFps,
	projectFpsSchema,
	projectSchema,
	RENDERABLE_EXPORT_CODECS,
	validateProject,
} from "./project.ts";
import { styleProfileSchema } from "./styles.ts";

const dimension = z.number().int().min(128).max(MAX_CANVAS).multipleOf(2);
/**
 * Codecs the current encoder implements. The project schema also declares
 * `h265-10bit`, `prores-4444` and `vp9`; settings accept them once the export
 * stage encodes them.
 */
const settingsExportCodec = z.enum(RENDERABLE_EXPORT_CODECS);
/**
 * Quality and aspect-ratio presets fit inside UHD, as before the canvas
 * bound grew; only explicit `width`/`height` may reach `MAX_CANVAS`.
 */
const MAX_PRESET_EDGE = 3840;
/**
 * Every project rate, including 48, 50, 120 and the NTSC family. Fractional
 * rates are carried as exact rationals by `frame-rate.ts`; `validateProject`
 * still decides whether a rate is writable.
 */
const fps = projectFpsSchema;
const aspectRatioPreset = z.enum([
	"16:9",
	"9:16",
	"1:1",
	"4:3",
	"9:14",
	"2.4:1",
]);
const aspectRatio = z.union([
	aspectRatioPreset,
	z
		.string()
		.regex(/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/)
		.refine((value) => {
			const [width = Number.NaN, height = Number.NaN] = value
				.split(":")
				.map(Number);
			return (
				Number.isFinite(width) &&
				Number.isFinite(height) &&
				width > 0 &&
				height > 0 &&
				width / height >= 0.1 &&
				width / height <= 10
			);
		}, "Aspect ratio must be between 1:10 and 10:1."),
]);
const quality = z.enum(["720p", "1080p", "2K", "4K"]);
const qualityShortEdges = {
	"720p": 720,
	"1080p": 1080,
	"2K": 1440,
	"4K": 2160,
} as const;

export const projectSettingsRequestSchema = z
	.object({
		aspectRatio: aspectRatio.optional(),
		exportCodec: settingsExportCodec.optional(),
		exportPreset: projectSchema.shape.exportPreset.removeDefault().optional(),
		fps: fps.optional(),
		height: dimension.optional(),
		quality: quality.optional(),
		revision: z.number().int().nonnegative(),
		styleProfile: styleProfileSchema.optional(),
		width: dimension.optional(),
	})
	.strict()
	.refine(
		(input) =>
			(input.width === undefined) === (input.height === undefined) &&
			(input.width === undefined ||
				(input.aspectRatio === undefined && input.quality === undefined)) &&
			(input.width !== undefined ||
				input.height !== undefined ||
				input.aspectRatio !== undefined ||
				input.quality !== undefined ||
				input.exportCodec !== undefined ||
				input.fps !== undefined ||
				input.exportPreset !== undefined ||
				input.styleProfile !== undefined),
		"Provide width and height together, or an aspect ratio/quality preset, plus at least one setting."
	);
export type ProjectSettingsRequest = z.infer<
	typeof projectSettingsRequestSchema
>;

function evenDimension(value: number): number {
	return Math.max(128, Math.min(MAX_PRESET_EDGE, Math.round(value / 2) * 2));
}

function ratioValue(value: string): number {
	const [width = Number.NaN, height = Number.NaN] = value
		.split(":")
		.map(Number);
	if (
		!(Number.isFinite(width) && Number.isFinite(height)) ||
		width <= 0 ||
		height <= 0
	) {
		throw new Error("Aspect ratio must contain two positive numbers.");
	}
	return width / height;
}

function canvasFor(
	project: Project,
	settings: ProjectSettingsRequest
): { height: number; width: number } | null {
	if (settings.width !== undefined && settings.height !== undefined) {
		return { height: settings.height, width: settings.width };
	}
	if (settings.aspectRatio === undefined && settings.quality === undefined) {
		return null;
	}
	const ratio = ratioValue(
		settings.aspectRatio ?? `${project.width}:${project.height}`
	);
	const shortEdge =
		settings.quality === undefined
			? Math.min(project.width, project.height)
			: qualityShortEdges[settings.quality];
	let width = ratio >= 1 ? shortEdge * ratio : shortEdge;
	let height = ratio >= 1 ? shortEdge : shortEdge / ratio;
	const fit = Math.min(1, MAX_PRESET_EDGE / width, MAX_PRESET_EDGE / height);
	width = evenDimension(width * fit);
	height = evenDimension(height * fit);
	return { height, width };
}

export type UpdateProjectSettingsInput = z.input<
	typeof projectSettingsRequestSchema
>;

/** Apply bounded canvas, aspect ratio, quality, frame-rate, and export-preset settings. */
export function updateProjectSettings(
	project: Project,
	assets: readonly Asset[],
	input: UpdateProjectSettingsInput
): Project {
	const settings = projectSettingsRequestSchema.parse(input);
	const canvas = canvasFor(project, settings);
	const next: Project = { ...project };
	if (settings.exportPreset !== undefined) {
		next.exportPreset = settings.exportPreset;
	}
	if (settings.exportCodec !== undefined) {
		next.exportCodec = settings.exportCodec;
	}
	if (settings.styleProfile !== undefined) {
		next.styleProfile = settings.styleProfile;
	}
	if (settings.fps !== undefined) {
		next.fps = settings.fps;
	}
	if (canvas !== null) {
		Object.assign(next, canvas);
	}
	return validateProject(next, [...assets]);
}

const MIN_CANVAS_EDGE = 128;
const MAX_MEDIA_ASPECT = 10;

function evenCanvasEdge(value: number): number {
	return Math.max(
		MIN_CANVAS_EDGE,
		Math.min(MAX_CANVAS, Math.round(value / 2) * 2)
	);
}

/**
 * The project canvas that matches a media frame: the same aspect ratio, even
 * edges, scaled down to fit `MAX_CANVAS` or up to a 128 px short edge. Null
 * when the media has no picture or an aspect ratio beyond 1:10..10:1.
 */
export function canvasForMedia(
	width: number,
	height: number
): { height: number; width: number } | null {
	if (!(width > 0 && height > 0)) {
		return null;
	}
	const aspect = width / height;
	if (aspect > MAX_MEDIA_ASPECT || aspect < 1 / MAX_MEDIA_ASPECT) {
		return null;
	}
	let scale = Math.min(1, MAX_CANVAS / width, MAX_CANVAS / height);
	const shortEdge = Math.min(width, height) * scale;
	if (shortEdge < MIN_CANVAS_EDGE) {
		scale *= MIN_CANVAS_EDGE / shortEdge;
	}
	return {
		height: evenCanvasEdge(height * scale),
		width: evenCanvasEdge(width * scale),
	};
}

/** Output format presets offered in project settings, as [width, height, label]. */
export const CANVAS_PRESETS = [
	[1920, 1080, "Landscape 16:9 · 1080p"],
	[1080, 1920, "Vertical 9:16 · 1080p"],
	[1080, 1080, "Square 1:1 · 1080p"],
	[1080, 1350, "Portrait 4:5 · 1080p"],
	[1440, 1080, "Classic 4:3 · 1080p"],
	[2560, 1080, "Ultrawide 21:9 · 1080p"],
	[1998, 1080, "Flat 1.85:1 · 2K DCI"],
	[2048, 1080, "Full 2K DCI · 1.9:1"],
	[1280, 720, "Landscape 16:9 · 720p"],
	[2560, 1440, "Landscape 16:9 · 1440p"],
	[3840, 2160, "Landscape 16:9 · 4K UHD"],
	[4096, 2160, "DCI 4K · 1.9:1"],
	[7680, 4320, "8K UHD · 16:9"],
	[640, 360, "Preview · 360p"],
] as const;

/**
 * A custom canvas from typed edges: each edge is rounded to an even number
 * of pixels within 128..`MAX_CANVAS`, and the shorter edge grows when needed
 * so the aspect stays within 1:10..10:1 (the settings route's bound).
 */
export function customCanvas(
	width: number,
	height: number
): { height: number; width: number } {
	let w = evenCanvasEdge(Number.isFinite(width) ? width : MIN_CANVAS_EDGE);
	let h = evenCanvasEdge(Number.isFinite(height) ? height : MIN_CANVAS_EDGE);
	if (w / h > MAX_MEDIA_ASPECT) {
		h = evenCanvasEdge(Math.ceil(w / MAX_MEDIA_ASPECT));
	} else if (h / w > MAX_MEDIA_ASPECT) {
		w = evenCanvasEdge(Math.ceil(h / MAX_MEDIA_ASPECT));
	}
	return { height: h, width: w };
}

/** How a clip's media differs from the project's output settings. */
export interface MediaSettingsMismatch {
	assetId: string;
	/** Proposed canvas when the media frame differs from the project canvas. */
	canvas?: { height: number; width: number };
	/** Proposed project rate when the media rate differs and can be written. */
	fps?: ProjectFps;
	/** The measured media rate (frames per second), when probed. */
	mediaFrameRate?: number;
	/**
	 * A matching project rate that this build cannot write yet, so the prompt
	 * can say why it is not offered.
	 */
	unsupportedFps?: ProjectFps;
}

/**
 * Compare a visual asset with the project canvas and frame rate. Returns null
 * when nothing would change (audio, matching settings, or a media rate no
 * project rate matches and an equal canvas).
 */
export function mediaSettingsMismatch(
	project: Pick<Project, "fps" | "height" | "width">,
	asset: Asset
): MediaSettingsMismatch | null {
	if (asset.kind === "audio") {
		return null;
	}
	const mismatch: MediaSettingsMismatch = { assetId: asset.id };
	const canvas = canvasForMedia(asset.width, asset.height);
	if (
		canvas &&
		(canvas.width !== project.width || canvas.height !== project.height)
	) {
		mismatch.canvas = canvas;
	}
	if (asset.kind === "video" && asset.frameRate !== undefined) {
		mismatch.mediaFrameRate = asset.frameRate;
		const target = projectFpsForRate(asset.frameRate);
		if (target !== undefined && !sameFrameRate(target, project.fps)) {
			if (isWritableProjectFps(target)) {
				mismatch.fps = target;
			} else {
				mismatch.unsupportedFps = target;
			}
		}
	}
	return mismatch.canvas || mismatch.fps || mismatch.unsupportedFps
		? mismatch
		: null;
}

/**
 * The settings request that matches the project to `mismatch` at `revision`,
 * or null when nothing writable differs.
 */
export function matchMediaSettingsRequest(
	revision: number,
	mismatch: MediaSettingsMismatch
): ProjectSettingsRequest | null {
	if (!(mismatch.canvas || mismatch.fps !== undefined)) {
		return null;
	}
	return projectSettingsRequestSchema.parse({
		revision,
		...(mismatch.canvas ?? {}),
		...(mismatch.fps === undefined ? {} : { fps: mismatch.fps }),
	});
}

/**
 * The visual asset of the project's first clip, while the timeline still holds
 * only that one picture clip (plus audio derived from the same media, such as
 * its detached sound). Undefined for an empty or audio-only timeline and once
 * a second picture clip or another source is placed: this is the moment
 * "Match project to media" is offered.
 */
export function firstClipMediaAsset(
	project: Pick<Project, "segments">,
	assets: readonly Asset[]
): Asset | undefined {
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	let root: string | undefined;
	let picture: Asset | undefined;
	for (const segment of project.segments) {
		const asset = byId.get(segment.assetId);
		if (!asset) {
			return;
		}
		const source = asset.derivedFromAssetId ?? asset.id;
		if (root !== undefined && root !== source) {
			return;
		}
		root = source;
		if (asset.kind !== "audio") {
			if (picture) {
				return;
			}
			picture = asset;
		}
	}
	return picture;
}

export const matchMediaRequestSchema = z
	.object({
		assetId: z.uuid(),
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type MatchMediaRequest = z.infer<typeof matchMediaRequestSchema>;

/**
 * Match the project canvas and frame rate to one asset ("Match project to
 * media"). Throws when the asset is unknown, is audio, or already matches
 * every writable setting.
 */
export function matchProjectToMedia(
	project: Project,
	assets: readonly Asset[],
	input: MatchMediaRequest
): { mismatch: MediaSettingsMismatch; project: Project } {
	const { assetId, revision } = matchMediaRequestSchema.parse(input);
	const asset = assets.find((candidate) => candidate.id === assetId);
	if (!asset) {
		throw new Error("The media asset was not found.");
	}
	if (asset.kind === "audio") {
		throw new Error("Audio has no picture to match the project to.");
	}
	const mismatch = mediaSettingsMismatch(project, asset);
	const request = mismatch && matchMediaSettingsRequest(revision, mismatch);
	if (!(mismatch && request)) {
		throw new Error(
			mismatch?.unsupportedFps === undefined
				? "The project already matches this media."
				: `The media runs at ${mismatch.unsupportedFps} fps, which this build cannot export yet.`
		);
	}
	return {
		mismatch,
		project: updateProjectSettings(project, assets, request),
	};
}
