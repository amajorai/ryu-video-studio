import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useContext } from "react";
import {
	type BlendMode,
	type BlendPreviewGap,
	blendModeLabels,
	blendModes,
	blendPreviewGaps,
	cssBlendModeOf,
	isBlendMode,
} from "../../../../shared/blend.ts";
import { segmentDuration } from "../../../../shared/project.ts";
import { blendModeOf } from "../../../../shared/schema/defaults.ts";
import { EditorContext } from "../../editor/context.tsx";
import {
	studioFormat,
	studioText,
	useStudioLocale,
} from "../../i18n/format.ts";
import {
	compositorBackgroundSupported,
	compositorLayerGaps,
} from "../../preview/compositor/plan.ts";
import { blendPreviewContextOf } from "../../preview/stages/blend.ts";
import type { ClipSectionProps } from "../section-props.ts";

const cssLabels: Record<string, string> = {
	difference: "Difference",
	"hard-light": "Hard light",
};

function gapSentence(gap: BlendPreviewGap, mode: BlendMode): string {
	switch (gap) {
		case "css-fallback": {
			const css = cssBlendModeOf(mode);
			return studioFormat("shown as {mode}", {
				mode: studioText(cssLabels[css] ?? css),
			});
		}
		case "soft-light-curve":
			return studioFormat("the browser's soft light curve differs slightly");
		case "add-opacity":
			return studioFormat(
				"add brightens more while the clip is partly transparent"
			);
		case "clip-background":
			return studioFormat(
				"the clip background blends separately from the clip"
			);
		case "component-ycbcr":
			return studioFormat(
				"the browser mixes hue, saturation and luma in RGB rather than YCbCr"
			);
		default:
			return gap;
	}
}

/**
 * The inspector note for a mode the CSS preview only approximates.
 *
 * With `composited`, the clip itself can be drawn by the WebGL2 blend
 * compositor (`PreviewBlendCompositor`), which shows the exact mode while
 * playing and paused whenever every clip on screen with it can be drawn
 * there. Otherwise (and always without it) the CSS approximation shows, and
 * while paused with no unsaved edits the preview swaps in the exact rendered
 * frame (`PreviewExactBlendFrame`) once it loads. The note cannot see which
 * one is on screen, so it states the conditions.
 */
export function blendPreviewNote(
	mode: BlendMode,
	gaps: readonly BlendPreviewGap[],
	composited = false
): string | undefined {
	if (gaps.length === 0) {
		return;
	}
	const reasons = gaps.map((gap) => gapSentence(gap, mode)).join("; ");
	const label = studioText(blendModeLabels[mode]).toLocaleLowerCase();
	if (composited) {
		return studioFormat(
			"With WebGL2 the preview shows exact {mode} for this clip, playing or paused, while every clip on screen with it can be composited. Otherwise: {reasons}; once your edits are saved, the paused preview shows the exact frame.",
			{ mode: label, reasons }
		);
	}
	return studioFormat(
		"Once your edits are saved, the paused preview shows the exact frame when it can be rendered. Otherwise, and during playback: {reasons}. Exports and frame checks use exact {mode}.",
		{ mode: label, reasons }
	);
}

/**
 * How the clip combines with the layers below it (W2-V1). Choosing Normal
 * clears the field, so the clip returns to the legacy alpha-over composite.
 * Agents set the same field through `clip-properties`.
 */
export function BlendSection({
	onChange,
	segment,
	visualControls,
}: ClipSectionProps) {
	const editor = useContext(EditorContext);
	const project = editor?.project;
	useStudioLocale();
	if (!visualControls) {
		return null;
	}
	const mode = blendModeOf(segment);
	const asset = editor?.assets.find((item) => item.id === segment.assetId);
	// Judged at the clip's midpoint, past entry reveals and fades.
	const composited =
		project !== null &&
		project !== undefined &&
		asset !== undefined &&
		compositorBackgroundSupported(project) &&
		compositorLayerGaps(project, segment, asset, segmentDuration(segment) / 2)
			.length === 0;
	const note = blendPreviewNote(
		mode,
		blendPreviewGaps(mode, blendPreviewContextOf(project, segment)),
		composited
	);
	return (
		<RyuAppField description={note} label="Blend mode">
			<NativeSelect
				aria-label="Blend mode"
				onChange={(event) => {
					const { value } = event.target;
					if (isBlendMode(value)) {
						onChange({ blendMode: value === "normal" ? undefined : value });
					}
				}}
				value={mode}
			>
				{blendModes.map((option) => (
					<NativeSelectOption key={option} value={option}>
						{blendModeLabels[option]}
					</NativeSelectOption>
				))}
			</NativeSelect>
		</RyuAppField>
	);
}
