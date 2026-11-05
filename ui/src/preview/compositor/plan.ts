/**
 * What the whole-stack blend compositor draws at a time (`compositorPlan`).
 *
 * The CSS preview stacks one element per clip and blends them with
 * `mix-blend-mode`, which only approximates several of the render's modes
 * (`blendPreviewGaps` in `shared/blend.ts`). When a clip at the playhead
 * uses a blend mode, the compositor instead draws every visible media clip
 * bottom to top into one WebGL2 canvas with the render's own maths, so the
 * preview matches the export while it plays, not only on the paused server
 * frame.
 *
 * The plan reproduces the render's placement, not the CSS preview's:
 * source crop (`sidecar/src/render-stages/crop.ts`), flip, fit/fill/stretch
 * into the clip box with even-rounded sizes, rotation (a `fit` clip rotates
 * at its own size, so its corners clip to the unrotated rectangle like
 * FFmpeg's `rotate=…:ow=iw:oh=ih`), opacity, fades and entry motion
 * (`sidecar/src/render-stages/{transform,opacity,transitions}.ts`), masks on
 * the cropped, flipped frame, and the composite order of the render (track,
 * then start).
 *
 * Stages the compositor does not draw yet are reported as reasons and the
 * whole plan is `off`, so the preview keeps the CSS stack and its paused
 * exact server frame instead of showing a half-right picture.
 */
import {
	activeAdjustmentLayers,
	adjustmentLayerHasEffect,
} from "../../../../shared/adjustment.ts";
import { animatedRange, isAnimated } from "../../../../shared/animation.ts";
import {
	defaultCanvasColor,
	gradientCoefficients,
	hexToRgb,
	renderableClipBackground,
} from "../../../../shared/background.ts";
import { type BlendMode, isBlended } from "../../../../shared/blend.ts";
import {
	maskHasStroke,
	maskSvgPad,
	maskToSvg,
	segmentMasksAt,
} from "../../../../shared/masks.ts";
import {
	type Asset,
	animatedValue,
	type Project,
	type Segment,
} from "../../../../shared/project.ts";
import { blendModeOf } from "../../../../shared/schema/defaults.ts";
import { fitModeOf } from "../../../../shared/transform.ts";
import type { GlPass } from "../gl/pass.ts";
import { hasGradePass } from "../gl/passes/grade.ts";
import { segmentGlPasses } from "../gl/segment-passes.ts";
import { effectFilterCss, vignetteAmount } from "../stages/effects.ts";
import {
	entryTransitionState,
	fadeFactor,
	revealStyle,
} from "../stages/transitions.ts";
import {
	previewSegmentVisible,
	segmentActiveAt,
} from "../stages/visibility.ts";

/** Why the compositor leaves the frame to the CSS preview. */
export type CompositorGap =
	/** An adjustment layer is on screen (it filters the composite below it). */
	| "adjustment-layer"
	/** A canvas image or blur fill (only none, colour and gradient are drawn). */
	| "canvas-background"
	/** A per-clip background fill. */
	| "clip-background"
	/** Legacy effect, CSS effect stack or a basic colour change drawn as a CSS filter. */
	| "css-filter"
	/** Edge rounding or softness. */
	| "edges"
	/** `fill` with keyframed scale X/Y (the render keeps its first-frame crop). */
	| "fill-animated-box"
	/** Mask outline strokes. */
	| "mask-stroke"
	/** The media's pixel size is unknown, so fit cannot be placed exactly. */
	| "media-size"
	/** A shaped reveal or fade through a colour. */
	| "reveal"
	/** A transition or animation blur. */
	| "transition-blur"
	/** A vignette effect. */
	| "vignette"
	/** An audio clip drawn as a waveform. */
	| "waveform";

/** A rectangle in normalized source coordinates (0..1, y down). */
export interface UvRect {
	height: number;
	left: number;
	top: number;
	width: number;
}

export interface CompositorMask {
	/** Blur pad the SVG adds on every side, in mask-frame pixels. */
	pad: number;
	svg: string;
}

export interface CompositorLayer {
	/** Asset id; the layer samples that asset's media element. */
	assetId: string;
	/** Centre of the drawn picture, in project pixels (y down). */
	center: readonly [number, number];
	/** Whether a `fit` clip's rotated picture is clipped to its unrotated rectangle. */
	clipUnrotated: boolean;
	/** Size of the drawn picture before rotation, in project pixels. */
	drawn: readonly [number, number];
	/** Clip-relative seconds (the GL passes' `u_time`). */
	elapsed: number;
	flip: readonly [boolean, boolean];
	/** Key, grade and effects passes the clip runs before it is placed. */
	glPasses: GlPass[];
	/**
	 * Masks on the cropped, flipped frame (`frame` pixels), multiplied
	 * together; `maskWindow` is where the drawn picture sits on that frame.
	 */
	masks: { frame: { height: number; width: number }; list: CompositorMask[] };
	maskWindow: UvRect;
	mode: BlendMode;
	opacity: number;
	/** Rotation in radians, clockwise on screen. */
	rotation: number;
	segmentId: string;
	/** Part of the source the drawn picture shows (crop, then fill). */
	source: UvRect;
	/** The clip's track (its CSS media element sits at z-index `track + 1`). */
	track: number;
	/** Part of the source a keyframed crop still shows; outside it is transparent. */
	visible: UvRect;
}

export type CompositorBackground =
	| { color: readonly [number, number, number]; type: "color" }
	| {
			/** Gradient position at pixel (X, Y) is `a·X + b·Y + c`, clamped. */
			coefficients: readonly [number, number, number];
			from: readonly [number, number, number];
			to: readonly [number, number, number];
			type: "gradient";
	  };

export type CompositorPlan =
	| { active: false; gaps: CompositorGap[] }
	| {
			active: true;
			background: CompositorBackground;
			height: number;
			layers: CompositorLayer[];
			width: number;
	  };

const unitRgb = (hex: string): [number, number, number] => {
	const { b, g, r } = hexToRgb(hex);
	return [r / 255, g / 255, b / 255];
};

function backgroundOf(
	project: Project
): CompositorBackground | "canvas-background" {
	const background = project.background;
	if (!background) {
		return { color: unitRgb(defaultCanvasColor(project)), type: "color" };
	}
	if (background.type === "color") {
		return { color: unitRgb(background.color), type: "color" };
	}
	if (background.type === "gradient") {
		const frame = { height: project.height, width: project.width };
		const { a, b, c } = gradientCoefficients(background.angle, frame, frame);
		return {
			coefficients: [a, b, c],
			from: unitRgb(background.color),
			to: unitRgb(background.color2),
			type: "gradient",
		};
	}
	return "canvas-background";
}

/** Whether the compositor can draw the project's canvas background. */
export function compositorBackgroundSupported(project: Project): boolean {
	return backgroundOf(project) !== "canvas-background";
}

const CROP_EDGES = [
	["left", "cropLeft"],
	["top", "cropTop"],
	["right", "cropRight"],
	["bottom", "cropBottom"],
] as const;

type Edges = Record<"bottom" | "left" | "right" | "top", number>;

const clampEdge = (value: number) => Math.min(0.9, Math.max(0, value));
const MAX_AXIS_CROP = 0.98;
const decimal = (value: number) => Number(value.toFixed(6));

/** Shrink an axis's two edges so the window keeps 2% of it (render `fitAxis`). */
function fitAxis(a: number, b: number): [number, number] {
	const total = a + b;
	if (total <= MAX_AXIS_CROP) {
		return [a, b];
	}
	const factor = MAX_AXIS_CROP / total;
	return [decimal(a * factor), decimal(b * factor)];
}

/**
 * The fixed crop window and the part a keyframed crop still shows, both as
 * edges of the source. A static crop is the window; a keyframed one crops to
 * each edge's minimum over the clip and hides the rest per frame.
 */
function cropWindows(
	segment: Segment,
	elapsed: number
): { visible: Edges; window: Edges } {
	const animated = CROP_EDGES.some(([, property]) =>
		isAnimated(segment, property)
	);
	if (!animated) {
		const window = { ...segment.crop };
		return { visible: window, window };
	}
	const minimum = (property: (typeof CROP_EDGES)[number][1]) =>
		clampEdge(animatedRange(segment, property).min);
	const [left, right] = fitAxis(minimum("cropLeft"), minimum("cropRight"));
	const [top, bottom] = fitAxis(minimum("cropTop"), minimum("cropBottom"));
	const visible = Object.fromEntries(
		CROP_EDGES.map(([edge, property]) => [
			edge,
			clampEdge(animatedValue(segment, property, elapsed)),
		])
	) as Edges;
	return { visible, window: { bottom, left, right, top } };
}

const rectOf = (edges: Edges): UvRect => ({
	height: Math.max(0, 1 - edges.top - edges.bottom),
	left: edges.left,
	top: edges.top,
	width: Math.max(0, 1 - edges.left - edges.right),
});

/** FFmpeg's even pixel size of a box edge (`2*max(1,round(v/2))`). */
const evenSize = (value: number) => 2 * Math.max(1, Math.round(value / 2));

const NEUTRAL = 1e-6;

/** Whether the CSS colour filter (`basicFilterCss`) is the identity. */
function basicColorNeutral(segment: Segment, elapsed: number): boolean {
	const value = (
		property:
			| "brightness"
			| "contrast"
			| "exposure"
			| "saturation"
			| "temperature"
	) => animatedValue(segment, property, elapsed);
	const grade = segment.colorGrade;
	return (
		Math.abs(value("brightness") + value("exposure") / 3) < NEUTRAL &&
		Math.abs(value("contrast") - 1) < NEUTRAL &&
		Math.abs(value("saturation") * (1 + grade.vibrance * 0.5) - 1) < NEUTRAL &&
		Math.abs(grade.tint * 18 - value("temperature") * 6) < NEUTRAL
	);
}

/** Every stage of an on-screen clip the compositor cannot draw yet. */
export function compositorLayerGaps(
	project: Project,
	segment: Segment,
	asset: Asset,
	elapsed: number
): CompositorGap[] {
	if (asset.kind === "audio") {
		return segment.visualization === "waveform" ? ["waveform"] : [];
	}
	const gaps: CompositorGap[] = [];
	if (!(asset.width && asset.height)) {
		gaps.push("media-size");
	}
	if (renderableClipBackground(project, segment, asset.kind) !== undefined) {
		gaps.push("clip-background");
	}
	const passes = segmentGlPasses(segment, elapsed);
	if (
		effectFilterCss(segment, elapsed).trim() !== "" ||
		!(hasGradePass(passes) || basicColorNeutral(segment, elapsed))
	) {
		gaps.push("css-filter");
	}
	if (segment.edgeRounding > 0 || segment.edgeSoftness > 0) {
		gaps.push("edges");
	}
	if (
		fitModeOf(segment) === "fill" &&
		segment.keyframes.some(
			(frame) => frame.property === "scaleX" || frame.property === "scaleY"
		)
	) {
		gaps.push("fill-animated-box");
	}
	if (segmentMasksAt(segment, elapsed).some(maskHasStroke)) {
		gaps.push("mask-stroke");
	}
	if (
		Object.keys(revealStyle(segment, elapsed, project.width / project.height))
			.length > 0
	) {
		gaps.push("reveal");
	}
	if ((entryTransitionState(segment, elapsed).blur ?? 0) > 0) {
		gaps.push("transition-blur");
	}
	if (vignetteAmount(segment, elapsed) > 0) {
		gaps.push("vignette");
	}
	return gaps;
}

/** Placement of one visual clip at `elapsed`, in project pixels. */
export function compositorLayerOf(
	project: Project,
	segment: Segment,
	asset: Asset,
	elapsed: number
): CompositorLayer {
	const W = project.width;
	const H = project.height;
	const entry = entryTransitionState(segment, elapsed);
	const { visible, window } = cropWindows(segment, elapsed);
	const media = { height: asset.height ?? H, width: asset.width ?? W };
	const cropped = {
		height: media.height * (1 - window.top - window.bottom),
		width: media.width * (1 - window.left - window.right),
	};
	const scale = animatedValue(segment, "scale", elapsed);
	const scaleX = animatedValue(segment, "scaleX", elapsed);
	const scaleY = animatedValue(segment, "scaleY", elapsed);
	const box = {
		height: evenSize(H * scale * scaleY) * entry.scale,
		width: evenSize(W * scale * scaleX) * entry.scale,
	};
	const mode = fitModeOf(segment);
	// `fill` crops the cropped frame, centred, to the box aspect.
	let fill: UvRect = { height: 1, left: 0, top: 0, width: 1 };
	if (mode === "fill" && cropped.width > 0 && cropped.height > 0) {
		const aspect = Number(((W * scaleX) / (H * scaleY)).toFixed(6));
		const width = Math.min(cropped.width, cropped.height * aspect);
		const height = Math.min(cropped.height, cropped.width / aspect);
		const shareX = width / cropped.width;
		const shareY = height / cropped.height;
		fill = {
			height: shareY,
			left: (1 - shareX) / 2,
			top: (1 - shareY) / 2,
			width: shareX,
		};
	}
	let drawn: [number, number] = [box.width, box.height];
	if (mode === "fit") {
		const factor =
			cropped.width > 0 && cropped.height > 0
				? Math.min(box.width / cropped.width, box.height / cropped.height)
				: 0;
		drawn = [
			Math.round(cropped.width * factor),
			Math.round(cropped.height * factor),
		];
	}
	const windowRect = rectOf(window);
	const source: UvRect = {
		height: windowRect.height * fill.height,
		left: windowRect.left + windowRect.width * fill.left,
		top: windowRect.top + windowRect.height * fill.top,
		width: windowRect.width * fill.width,
	};
	const rotation =
		((animatedValue(segment, "rotation", elapsed) + (entry.rotation ?? 0)) *
			Math.PI) /
		180;
	const opacity =
		animatedValue(segment, "opacity", elapsed) *
		Math.max(0, fadeFactor(segment, elapsed)) *
		entry.opacity;
	const frame = {
		height: Math.max(1, cropped.height),
		width: Math.max(1, cropped.width),
	};
	return {
		assetId: asset.id,
		center: [
			W / 2 + animatedValue(segment, "x", elapsed) * (W / 2) + entry.shiftX * W,
			H / 2 + animatedValue(segment, "y", elapsed) * (H / 2) + entry.shiftY * H,
		],
		clipUnrotated: mode === "fit" && rotation !== 0,
		drawn,
		elapsed,
		flip: [segment.flipH === true, segment.flipV === true],
		glPasses: segmentGlPasses(segment, elapsed),
		maskWindow: fill,
		masks: {
			frame,
			list: segmentMasksAt(segment, elapsed).map((mask) => ({
				pad: maskSvgPadOf(mask, frame),
				svg: maskSvgOf(mask, frame),
			})),
		},
		mode: blendModeOf(segment),
		opacity: Math.min(1, Math.max(0, opacity)),
		rotation,
		segmentId: segment.id,
		source,
		track: segment.track,
		visible: rectOf(visible),
	};
}

/**
 * Lowest z-index of the overlays drawn above the media stack (`.studio-graphic`
 * in `studio.css`; captions are 20 and titles 30).
 */
export const OVERLAY_Z_INDEX = 15;

/**
 * The compositor canvas's z-index: above every media clip it draws (CSS
 * z-index `track + 1`), clamped below the overlays so graphics, captions
 * and titles stay on top as in the render. Only the plan's on-screen
 * visual clips count, not audio or off-screen clips.
 */
export function compositorZIndex(
	plan: Extract<CompositorPlan, { active: true }>
): number {
	const top = Math.max(0, ...plan.layers.map((layer) => layer.track));
	return Math.min(top + 2, OVERLAY_Z_INDEX - 1);
}

type Mask = ReturnType<typeof segmentMasksAt>[number];
const maskSvgOf = (mask: Mask, frame: { height: number; width: number }) =>
	maskToSvg(mask, frame.width, frame.height);
const maskSvgPadOf = (mask: Mask, frame: { height: number; width: number }) =>
	maskSvgPad(mask, frame.width, frame.height);

/** On-screen visual clips in the render's composite order (track, then start). */
function onScreen(
	project: Project,
	assets: readonly Asset[],
	time: number
): { asset: Asset; segment: Segment }[] {
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	return project.segments
		.filter(
			(segment) =>
				segmentActiveAt(segment, time) &&
				previewSegmentVisible(project, segment)
		)
		.flatMap((segment) => {
			const asset = byId.get(segment.assetId);
			return asset ? [{ asset, segment }] : [];
		})
		.sort(
			(a, b) =>
				a.segment.track - b.segment.track || a.segment.start - b.segment.start
		);
}

/** Whether a media clip on screen at `time` uses a blend mode. */
export function blendedClipAt(
	project: Project,
	assets: readonly Asset[],
	time: number
): boolean {
	return onScreen(project, assets, time).some(
		({ asset, segment }) => asset.kind !== "audio" && isBlended(segment)
	);
}

/**
 * The compositor's frame at `time`: active while a blended media clip is on
 * screen and every stage of the stack can be drawn, else the reasons it
 * stays on the CSS path (empty when no clip is blended). A stack of normal
 * clips stays on the CSS path, which composites alpha-over exactly.
 */
export function compositorPlan(
	project: Project,
	assets: readonly Asset[],
	time: number,
	/** `always` composites a stack without blend modes too (parity checks). */
	options: { always?: boolean } = {}
): CompositorPlan {
	if (!(options.always || blendedClipAt(project, assets, time))) {
		return { active: false, gaps: [] };
	}
	const gaps = new Set<CompositorGap>();
	if (activeAdjustmentLayers(project, time).some(adjustmentLayerHasEffect)) {
		gaps.add("adjustment-layer");
	}
	const background = backgroundOf(project);
	if (background === "canvas-background") {
		gaps.add(background);
	}
	const clips = onScreen(project, assets, time);
	for (const { asset, segment } of clips) {
		for (const gap of compositorLayerGaps(
			project,
			segment,
			asset,
			time - segment.start
		)) {
			gaps.add(gap);
		}
	}
	if (gaps.size > 0 || background === "canvas-background") {
		return { active: false, gaps: [...gaps].sort() };
	}
	return {
		active: true,
		background,
		height: project.height,
		layers: clips
			.filter(({ asset }) => asset.kind !== "audio")
			.map(({ asset, segment }) =>
				compositorLayerOf(project, segment, asset, time - segment.start)
			),
		width: project.width,
	};
}
