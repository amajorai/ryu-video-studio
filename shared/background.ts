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

/** Gaussian sigma, in canvas pixels, of a blur fill at `amount` 1. */
export const BLUR_SIGMA_PER_AMOUNT = 60;

/**
 * Width of the working grid the blur fill is computed on. Filling and
 * blurring a small grid is cheap and already soft; the result is scaled up.
 */
export const BLUR_GRID_WIDTH = 96;

/** Width of the grid a gradient is evaluated on before it is scaled up. */
export const GRADIENT_GRID_WIDTH = 64;

/** Defaults used when the user switches a background to a new type. */
export const DEFAULT_GRADIENT = {
	angle: 180,
	color2: "#000000",
} as const;
export const DEFAULT_BLUR = { amount: 0.5, dim: 0.2 } as const;

const round = (value: number, digits = 6) => {
	const rounded = Number(value.toFixed(digits));
	return Object.is(rounded, -0) ? 0 : rounded;
};

export interface Rgb {
	b: number;
	g: number;
	r: number;
}

/** `#rrggbb` to 0..255 channels. */
export function hexToRgb(hex: string): Rgb {
	const match = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
	if (!match) {
		throw new Error(`Expected a #rrggbb color, got ${hex}.`);
	}
	return {
		b: Number.parseInt(match[3] ?? "0", 16),
		g: Number.parseInt(match[2] ?? "0", 16),
		r: Number.parseInt(match[1] ?? "0", 16),
	};
}

/** Start and end of a CSS gradient line, in pixels of a `width`x`height` frame. */
export interface GradientLine {
	x0: number;
	x1: number;
	y0: number;
	y1: number;
}

/**
 * The CSS gradient line for `angle` degrees: it passes through the frame
 * center, points along `(sin a, -cos a)` (y grows downwards) and is long
 * enough that the two corners farthest along it land exactly on the stops.
 */
export function gradientLine(
	angle: number,
	width: number,
	height: number
): GradientLine {
	const radians = (angle * Math.PI) / 180;
	const dx = Math.sin(radians);
	const dy = -Math.cos(radians);
	const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
	return {
		x0: round(width / 2 - dx * half),
		x1: round(width / 2 + dx * half),
		y0: round(height / 2 - dy * half),
		y1: round(height / 2 + dy * half),
	};
}

/** Position (0 at the first stop, 1 at the second) of point x, y on a line. */
export function gradientPosition(
	line: GradientLine,
	x: number,
	y: number
): number {
	const lx = line.x1 - line.x0;
	const ly = line.y1 - line.y0;
	const lengthSquared = lx * lx + ly * ly;
	if (lengthSquared === 0) {
		return 0;
	}
	const t = ((x - line.x0) * lx + (y - line.y0) * ly) / lengthSquared;
	return Math.min(1, Math.max(0, t));
}

/** Linear coefficients of the gradient position over grid pixel indices. */
export interface GradientCoefficients {
	/** Per grid column. */
	a: number;
	/** Per grid row. */
	b: number;
	/** At grid pixel 0, 0. */
	c: number;
}

/**
 * The gradient position at the center of grid pixel (X, Y) is
 * `a*X + b*Y + c` when a `width`x`height` frame is sampled on a
 * `gridWidth`x`gridHeight` grid. The position is linear over the frame, so a
 * small grid scaled up bilinearly reproduces the full-size gradient.
 */
export function gradientCoefficients(
	angle: number,
	frame: { height: number; width: number },
	grid: { height: number; width: number }
): GradientCoefficients {
	const line = gradientLine(angle, frame.width, frame.height);
	const lx = line.x1 - line.x0;
	const ly = line.y1 - line.y0;
	const lengthSquared = lx * lx + ly * ly;
	const stepX = frame.width / grid.width;
	const stepY = frame.height / grid.height;
	return {
		a: round((stepX * lx) / lengthSquared, 9),
		b: round((stepY * ly) / lengthSquared, 9),
		c: round(
			((stepX / 2 - line.x0) * lx + (stepY / 2 - line.y0) * ly) / lengthSquared,
			9
		),
	};
}

/** Grid a gradient is evaluated on for a frame: fixed width, frame aspect. */
export function gradientGrid(
	width: number,
	height: number
): { height: number; width: number } {
	const gridWidth = Math.min(width, GRADIENT_GRID_WIDTH);
	return {
		height: Math.min(
			height,
			Math.max(2, Math.round((gridWidth * height) / width))
		),
		width: gridWidth,
	};
}

/** Gaussian sigma of a blur fill, in canvas pixels. */
export function blurSigma(amount: number): number {
	return round(amount * BLUR_SIGMA_PER_AMOUNT, 4);
}

/** Brightness multiplier of a blur fill (1 keeps it, 0 is black). */
export function blurBrightness(dim: number): number {
	return round(1 - dim, 4);
}

/**
 * Grid sizes of the blur fill's push-pull pyramid: the working grid (at most
 * `BLUR_GRID_WIDTH` wide, frame aspect), then halved (rounding up) down to
 * a single pixel.
 */
export function pushPullLevels(
	width: number,
	height: number,
	gridWidth = BLUR_GRID_WIDTH
): Array<{ height: number; width: number }> {
	const first = Math.max(1, Math.min(width, gridWidth));
	let level = {
		height: Math.max(1, Math.min(height, Math.round((first * height) / width))),
		width: first,
	};
	const levels = [level];
	while (level.width > 1 || level.height > 1) {
		level = {
			height: Math.ceil(level.height / 2),
			width: Math.ceil(level.width / 2),
		};
		levels.push(level);
	}
	return levels;
}

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

/** One line describing a background, for status text and agent summaries. */
export function describeBackground(
	background: CanvasBackground,
	assets: readonly Asset[] = []
): string {
	switch (background.type) {
		case "color":
			return `Color ${background.color}`;
		case "gradient":
			return `Gradient ${background.color} to ${background.color2} at ${round(background.angle, 1)}°`;
		case "blur":
			return `Blur fill ${Math.round(background.amount * 100)}%, dimmed ${Math.round(background.dim * 100)}%`;
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
