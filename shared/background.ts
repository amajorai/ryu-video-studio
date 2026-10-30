/**
 * Canvas backgrounds (W2-V8): what fills the frame behind the clips, for the
 * whole project (`project.background`) or under one clip while it plays
 * (`segment.background`).
 *
 * - `color`: a solid fill.
 * - `gradient`: a two-stop linear gradient with CSS `linear-gradient`
 *   semantics (0deg points up, 90deg right; the corners sit exactly on the
 *   0 and 1 stops), so the preview's CSS and the render's math agree.
 * - `blur`: a blurred, dimmed extension of the clip itself fills the area the
 *   clip leaves empty. Project-level blur applies under every base-track
 *   clip; a clip-level blur applies under that clip.
 * - `image`: a library image or video scaled to cover the canvas, looped
 *   (project level only; see `renderableClipBackground`).
 *
 * Everything here is pure and deterministic.
 */
import { z } from "zod";
import { blurBrightness, blurSigma, round } from "./background-math.ts";
import type { Asset, Project, Segment } from "./project.ts";
import {
	type CanvasBackground,
	canvasBackgroundSchema,
} from "./schema/background.ts";
import { styleProfileConfig } from "./styles.ts";

export type { CanvasBackground };

export type BackgroundType = CanvasBackground["type"];

export const backgroundTypes: readonly BackgroundType[] = [
	"color",
	"gradient",
	"blur",
	"image",
];

export const backgroundTypeLabels: Record<BackgroundType, string> = {
	blur: "Blur fill",
	color: "Color",
	gradient: "Gradient",
	image: "Image",
};

/** The track whose clips receive a project-level blur fill. */
export const BASE_TRACK = 0;

export {
	BLUR_GRID_WIDTH,
	BLUR_SIGMA_PER_AMOUNT,
	blurBrightness,
	blurSigma,
	GRADIENT_GRID_WIDTH,
	type GradientCoefficients,
	type GradientLine,
	gradientCoefficients,
	gradientGrid,
	gradientLine,
	gradientPosition,
	hexToRgb,
	pushPullLevels,
	type Rgb,
} from "./background-math.ts";

/** Defaults used when the user switches a background to a new type. */
export const DEFAULT_GRADIENT = {
	angle: 180,
	color2: "#000000",
} as const;
export const DEFAULT_BLUR = { amount: 0.5, dim: 0.2 } as const;

/**
 * The background drawn under one clip: its own, or the project's blur fill
 * when the clip sits on the base track.
 */
export function clipBackgroundOf(
	project: Pick<Project, "background">,
	segment: Pick<Segment, "background" | "track">
): CanvasBackground | undefined {
	if (segment.background) {
		return segment.background;
	}
	if (project.background?.type === "blur" && segment.track === BASE_TRACK) {
		return project.background;
	}
	return undefined;
}

/**
 * Whether a clip draws its picture from an audio asset (a waveform). The
 * render's clip stage has no asset list, so a clip shown as a waveform counts
 * as audio there too; the preview passes the asset kind as well.
 */
function drawsWaveform(
	segment: Pick<Segment, "visualization">,
	assetKind: Asset["kind"] | undefined
): boolean {
	return assetKind === "audio" || segment.visualization === "waveform";
}

/** Whether a clip has a key or mask that cuts holes into its picture. */
function cutsHoles(segment: Pick<Segment, "key" | "masks">): boolean {
	return Boolean(segment.key) || (segment.masks?.length ?? 0) > 0;
}

/**
 * The clip background the render and preview draw, or undefined for none.
 *
 * - Waveform (audio) clips get no fill: a fill extended from a waveform
 *   would paint its color over the whole frame.
 * - The project blur fill skips keyed or masked clips, so their holes show
 *   the layers below. An explicit clip fill still shows through the holes
 *   (that is how a color goes behind a keyed subject).
 * - A clip-level image (the first frame of a video) is scaled to cover the
 *   clip's box under the clip, in the render and the preview. A project
 *   image background is never repeated per clip: it is the canvas itself.
 */
export function renderableClipBackground(
	project: Pick<Project, "background">,
	segment: Pick<
		Segment,
		"background" | "key" | "masks" | "track" | "visualization"
	>,
	assetKind?: Asset["kind"]
): CanvasBackground | undefined {
	if (drawsWaveform(segment, assetKind)) {
		return undefined;
	}
	if (!segment.background && cutsHoles(segment)) {
		return undefined;
	}
	return clipBackgroundOf(project, segment);
}

/**
 * Where a looped canvas video is at timeline `time`: the time wrapped into
 * the asset's duration (0 when the duration is unknown).
 */
export function loopedMediaTime(time: number, duration: number): number {
	if (!(duration > 0 && Number.isFinite(time) && time > 0)) {
		return 0;
	}
	return round(time % duration, 6);
}

const drawsAsset = (
	background: CanvasBackground | undefined,
	assetId: string
): boolean => background?.type === "image" && background.assetId === assetId;

/** Whether a project or any of its clips draws `assetId` as a background. */
export function backgroundReferencesAsset(
	project: Pick<Project, "background" | "segments">,
	assetId: string
): boolean {
	return (
		drawsAsset(project.background, assetId) ||
		project.segments.some((segment) => drawsAsset(segment.background, assetId))
	);
}

/**
 * The project without any background that draws `assetId`: the canvas falls
 * back to the style color and clips to the project canvas. Used when the
 * asset is deleted, so the project keeps validating.
 */
export function clearAssetBackgrounds<
	T extends Pick<Project, "background" | "segments">,
>(project: T, assetId: string): T {
	if (!backgroundReferencesAsset(project, assetId)) {
		return project;
	}
	const segments = project.segments.map((segment) => {
		if (!drawsAsset(segment.background, assetId)) {
			return segment;
		}
		const { background: _cleared, ...kept } = segment;
		return kept;
	});
	if (!drawsAsset(project.background, assetId)) {
		return { ...project, segments };
	}
	const { background: _cleared, ...rest } = project;
	return { ...rest, segments } as T;
}

/** CSS `background` value for a color or gradient fill. */
export function cssBackgroundOf(
	background: Extract<CanvasBackground, { type: "color" | "gradient" }>
): string {
	if (background.type === "color") {
		return background.color;
	}
	return `linear-gradient(${round(background.angle, 3)}deg, ${background.color}, ${background.color2})`;
}

/**
 * CSS filter of a blur fill drawn at preview size. `--studio-preview-width`
 * is the preview frame's width, so the sigma scales with the frame.
 */
export function blurFillCss(
	background: Extract<CanvasBackground, { type: "blur" }>,
	projectWidth: number
): string {
	const sigma = blurSigma(background.amount);
	const blur =
		sigma > 0
			? `blur(calc(var(--studio-preview-width) * ${round(sigma / projectWidth, 6)})) `
			: "";
	return `${blur}brightness(${blurBrightness(background.dim)})`;
}

/** Visual library media a background image may use. */
export function backgroundImageCandidates(assets: readonly Asset[]): Asset[] {
	return assets.filter(
		(asset) => asset.kind === "image" || asset.kind === "video"
	);
}

/**
 * A background of `type` that keeps what it can of `current` (its color),
 * or undefined for an image when no visual media exists.
 */
export function backgroundForType(
	type: BackgroundType,
	current: CanvasBackground,
	options: { fallbackColor: string; imageAssetId?: string }
): CanvasBackground | undefined {
	const color =
		current.type === "color" || current.type === "gradient"
			? current.color
			: options.fallbackColor;
	switch (type) {
		case "color":
			return { color, type };
		case "gradient":
			return {
				angle: DEFAULT_GRADIENT.angle,
				color,
				color2:
					current.type === "gradient"
						? current.color2
						: DEFAULT_GRADIENT.color2,
				type,
			};
		case "blur":
			return { ...DEFAULT_BLUR, type };
		case "image": {
			const assetId =
				current.type === "image" ? current.assetId : options.imageAssetId;
			return assetId ? { assetId, type } : undefined;
		}
		default:
			return undefined;
	}
}

/**
 * Whole-sentence message formatter for background descriptions; structurally
 * matches `LiteralMessage` from `@ryu/i18n/react`, which this shared module
 * does not import.
 */
export type BackgroundDescriptionMessage = (
	source: string,
	values?: Readonly<Record<string, string | number>>
) => string;

/** English fallback: fills `{name}` placeholders verbatim. */
const englishDescription: BackgroundDescriptionMessage = (
	source,
	values = {}
) =>
	source.replace(/\{(\w+)\}/g, (match, key: string) =>
		key in values ? String(values[key]) : match
	);

/**
 * One line describing a background, for status text and agent summaries.
 * Pass the editor's `tl` (from `useLiteralMessages`) to localize it; without
 * it the line stays English.
 */
export function describeBackground(
	background: CanvasBackground,
	assets: readonly Asset[] = [],
	tl: BackgroundDescriptionMessage = englishDescription
): string {
	switch (background.type) {
		case "color":
			return `Color ${background.color}`;
		case "gradient":
			return tl("Gradient {color} to {color2} at {angle}°", {
				angle: String(round(background.angle, 1)),
				color: background.color,
				color2: background.color2,
			});
		case "blur":
			return tl("Blur fill {amount}%, dimmed {dim}%", {
				amount: String(Math.round(background.amount * 100)),
				dim: String(Math.round(background.dim * 100)),
			});
		case "image": {
			const name = assets.find(
				(asset) => asset.id === background.assetId
			)?.name;
			return `Image ${name ?? background.assetId}`;
		}
		default:
			return "Background";
	}
}

/** The project's effective canvas color when no explicit background is set. */
export function defaultCanvasColor(
	project: Pick<Project, "styleProfile">
): string {
	return styleProfileConfig(project.styleProfile).background;
}

export const backgroundEditRequestSchema = z
	.object({
		/**
		 * The new background; `null` returns the project to the style color, or
		 * the clip (with `clipId`) to the project canvas.
		 */
		background: canvasBackgroundSchema.nullable(),
		/** Set this clip's own background instead of the project canvas. */
		clipId: z.string().min(1).optional(),
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type BackgroundEditRequest = z.infer<typeof backgroundEditRequestSchema>;

/**
 * Set (or clear with `null`) the project background. An image must reference
 * visual library media; the result is validated like any saved project.
 */
export function setProjectBackground(
	project: Project,
	assets: readonly Asset[],
	background: CanvasBackground | null
): Project {
	if (background?.type === "image") {
		const asset = assets.find((item) => item.id === background.assetId);
		if (!(asset && (asset.kind === "image" || asset.kind === "video"))) {
			throw new Error("Choose an image or video from the library.");
		}
	}
	const { background: _previous, ...rest } = project;
	return background ? { ...rest, background } : rest;
}

/**
 * Set (or clear with `null`, back to the project canvas) one clip's own
 * background: a color, gradient or blur fill, or a library image (or a
 * video's first frame) scaled to cover the clip box.
 */
export function setClipBackground(
	project: Project,
	clipId: string,
	background: CanvasBackground | null,
	assets: readonly Asset[] = []
): Project {
	if (background?.type === "image") {
		const asset = assets.find((item) => item.id === background.assetId);
		if (!(asset && (asset.kind === "image" || asset.kind === "video"))) {
			throw new Error("Choose an image or video from the library.");
		}
	}
	if (!project.segments.some((segment) => segment.id === clipId)) {
		throw new Error("Clip not found.");
	}
	return {
		...project,
		segments: project.segments.map((segment) => {
			if (segment.id !== clipId) {
				return segment;
			}
			const { background: _previous, ...rest } = segment;
			return background ? { ...rest, background } : rest;
		}),
	};
}

/** Apply a background edit request to the project or one of its clips. */
export function applyBackgroundEdit(
	project: Project,
	assets: readonly Asset[],
	request: Pick<BackgroundEditRequest, "background" | "clipId">
): Project {
	return request.clipId === undefined
		? setProjectBackground(project, assets, request.background)
		: setClipBackground(project, request.clipId, request.background, assets);
}

/**
 * A `#rrggbb` color from a picker value (`#rgb`, `#rrggbb` or `#rrggbbaa`,
 * any case), or undefined when it is not a hex color.
 */
export function normalizeHexColor(value: string): string | undefined {
	const trimmed = value.trim().toLowerCase();
	const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(trimmed);
	if (short) {
		return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
	}
	const long = /^(#[0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(trimmed);
	return long?.[1];
}
