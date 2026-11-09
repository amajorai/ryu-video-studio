/**
 * Preview stage: blend modes (W2-V1). Mirrors `sidecar/src/render-composite.ts`
 * with CSS `mix-blend-mode`. Where CSS cannot match the render exactly
 * (missing modes, the soft light curve, add at partial opacity, clips with a
 * background fill) `blendPreviewGaps` in `shared/blend.ts` says so and the
 * inspector shows an approximate-preview note; renders and frame checks are
 * exact.
 */
import { animationPoints } from "../../../../shared/animation.ts";
import { renderableClipBackground } from "../../../../shared/background.ts";
import {
	type BlendMode,
	type BlendPreviewContext,
	blendPreviewGaps,
	cssBlendModeOf,
	isBlended,
} from "../../../../shared/blend.ts";
import {
	type Project,
	type Segment,
	segmentDuration,
} from "../../../../shared/project.ts";
import { blendModeOf } from "../../../../shared/schema/defaults.ts";
import type { PreviewStyle } from "../preview-style.ts";

/**
 * `mix-blend-mode` for any layer with an optional blend mode (clips,
 * graphics and titles). Normal layers get no style, so legacy previews keep
 * their exact CSS.
 */
export function layerBlendStyle(layer: {
	blendMode?: BlendMode;
}): PreviewStyle {
	if (!isBlended(layer)) {
		return {};
	}
	return { mixBlendMode: cssBlendModeOf(blendModeOf(layer)) };
}

export function blendStyle(segment: Segment, _elapsed: number): PreviewStyle {
	return layerBlendStyle(segment);
}

/**
 * Style for a blended clip's per-clip background element
 * (`PreviewClipBackground` in `background.tsx`). The render blends the fill
 * and the clip as one layer with the tracks below, so the fill must carry the
 * clip's `mix-blend-mode` too; without it an opaque fill hides the lower
 * tracks. The pair still only approximates the render (the clip blends with
 * the already-blended fill), which `blendPreviewContextOf` reports.
 */
export function clipBackgroundBlendStyle(segment: Segment): PreviewStyle {
	return layerBlendStyle(segment);
}

function canDrawPartlyTransparent(segment: Segment): boolean {
	if (segment.opacity < 1 || segment.fadeIn > 0 || segment.fadeOut > 0) {
		return true;
	}
	if (segment.entryTransition !== "none") {
		return true;
	}
	if (segment.exitTransition && segment.exitTransition !== "none") {
		return true;
	}
	return animationPoints(segment, "opacity").some((point) => point.value < 1);
}

/** What the preview needs, beyond the mode, to judge how exact it is. */
export function blendPreviewContextOf(
	project: Pick<Project, "background"> | null | undefined,
	segment: Segment
): BlendPreviewContext {
	return {
		clipBackground:
			renderableClipBackground(project ?? {}, segment) !== undefined,
		partlyTransparent: canDrawPartlyTransparent(segment),
	};
}

/**
 * Whether a clip drawn at `time` uses a blend mode the CSS preview only
 * approximates (`blendPreviewGaps`), so a paused preview should show the
 * exact server frame instead.
 */
export function blendGapAt(
	project: Project,
	time: number,
	visible: (segment: Segment) => boolean
): boolean {
	return project.segments.some(
		(segment) =>
			time >= segment.start &&
			time < segment.start + segmentDuration(segment) &&
			visible(segment) &&
			blendPreviewGaps(
				blendModeOf(segment),
				blendPreviewContextOf(project, segment)
			).length > 0
	);
}

/**
 * Whether a title or graphic drawn at `time` uses a blend mode the CSS
 * preview only approximates. Titles preview without their blend mode, so
 * any blended title counts; graphics use `mix-blend-mode`, so only modes
 * with a preview gap count. The blend compositor draws media clips only, so
 * these keep the paused exact server frame even while it is on screen.
 */
export function overlayBlendGapAt(project: Project, time: number): boolean {
	const onScreen = (layer: { end: number; start: number }) =>
		time >= layer.start && time < layer.end;
	if (project.titles.some((title) => onScreen(title) && isBlended(title))) {
		return true;
	}
	return project.graphics.some(
		(graphic) =>
			onScreen(graphic) &&
			blendPreviewGaps(blendModeOf(graphic), {
				partlyTransparent:
					graphic.opacity < 1 ||
					(graphic.keyframes ?? []).some(
						(frame) => frame.property === "opacity"
					),
			}).length > 0
	);
}
