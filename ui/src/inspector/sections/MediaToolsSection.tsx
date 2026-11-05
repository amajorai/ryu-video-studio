import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useState } from "react";
import {
	type InterpolateMode,
	interpolateModeSchema,
	type StabilizeLevel,
	smoothSlowMotionFps,
	stabilizeLevelSchema,
} from "../../../../shared/derivatives.ts";
import { frameInterpolationSchema } from "../../../../shared/schema/transition.ts";
import { useEditorProject } from "../../editor/context.tsx";
import type { ClipSectionProps } from "../section-props.ts";
import {
	applyMediaTool,
	INTERPOLATE_RATES,
	renderSmoothSlowMotion,
	STABILIZE_LEVEL_LABELS,
	smoothSlowMotionReady,
	useMediaToolSupport,
} from "./media-tools.ts";

const INTERPOLATION_LABELS = {
	blend: "Frame blending",
	none: "None (repeat frames)",
	"optical-flow": "Optical flow",
} as const;

const OPTICAL_FLOW_UNAVAILABLE =
	"Optical flow needs FFmpeg's minterpolate filter; this node blends frames instead.";

/**
 * Media derivatives for the inspected clip: stabilize, frame-rate
 * conversion, smooth slow motion, and enhanced upscale. Each renders a new
 * library asset from the original media and swaps the clip onto it.
 */
export function MediaToolsSection({ onChange, segment }: ClipSectionProps) {
	const runtime = useEditorProject();
	const { assets, busy, project } = runtime;
	const support = useMediaToolSupport();
	const tl = useLiteralMessages();
	const [level, setLevel] = useState<StabilizeLevel>("medium");
	const [rate, setRate] = useState<number>(60);
	const [mode, setMode] = useState<InterpolateMode>("optical-flow");
	const asset = assets.find((item) => item.id === segment.assetId);
	if (!(asset && asset.kind !== "audio")) {
		return null;
	}
	const opticalFlowMissing = support.opticalFlow === false;
	const effectiveMode: InterpolateMode =
		opticalFlowMissing && mode === "optical-flow" ? "blend" : mode;
	const isVideo = asset.kind === "video";
	const slowTarget =
		segment.speed < 1 ? smoothSlowMotionFps(project.fps, segment.speed) : null;
	return (
		<>
			{isVideo && (
				<>
					<RyuAppField label="Stabilize">
						<NativeSelect
							aria-label="Stabilize level"
							onChange={(event) =>
								setLevel(stabilizeLevelSchema.parse(event.target.value))
							}
							value={level}
						>
							{stabilizeLevelSchema.options.map((option) => (
								<NativeSelectOption key={option} value={option}>
									{STABILIZE_LEVEL_LABELS[option]}
								</NativeSelectOption>
							))}
						</NativeSelect>
						<small>
							{support.vidstab === false
								? "Uses the built-in two-pass tracker (camera shift only)."
								: "Smooths the camera path and zooms slightly to hide the edges."}
						</small>
					</RyuAppField>
					<RyuAppActions>
						<Button
							disabled={busy}
							onClick={() =>
								void applyMediaTool(runtime, segment, {
									kind: "stabilize",
									level,
								})
							}
							size="sm"
							variant="outline"
						>
							Stabilize clip
						</Button>
					</RyuAppActions>
					<RyuAppField label="Frame interpolation">
						<NativeSelect
							aria-label="Frame interpolation"
							onChange={(event) => {
								const next = frameInterpolationSchema.parse(event.target.value);
								onChange({
									frameInterpolation: next === "none" ? undefined : next,
								});
							}}
							value={segment.frameInterpolation ?? "none"}
						>
							{frameInterpolationSchema.options.map((option) => (
								<NativeSelectOption
									disabled={option === "optical-flow" && opticalFlowMissing}
									key={option}
									value={option}
								>
									{INTERPOLATION_LABELS[option]}
								</NativeSelectOption>
							))}
						</NativeSelect>
						<small>
							{slowTarget === null
								? "Smooth slow motion applies to clips slower than 1x."
								: tl(
										"At {speed}x, smooth slow motion renders {targetFps} fps media.",
										{ speed: segment.speed, targetFps: slowTarget }
									)}
						</small>
					</RyuAppField>
					{slowTarget !== null && (
						<RyuAppActions>
							<Button
								disabled={busy || !smoothSlowMotionReady(segment)}
								onClick={() => void renderSmoothSlowMotion(runtime, segment)}
								size="sm"
								variant="outline"
							>
								Render smooth slow motion
							</Button>
						</RyuAppActions>
					)}
					<RyuAppField label="Convert frame rate">
						<div className="flex flex-wrap gap-1">
							<NativeSelect
								aria-label="Target frame rate"
								onChange={(event) => setRate(Number(event.target.value))}
								value={String(rate)}
							>
								{INTERPOLATE_RATES.map((option) => (
									<NativeSelectOption key={option} value={String(option)}>
										{tl("{fps} fps", { fps: option })}
									</NativeSelectOption>
								))}
							</NativeSelect>
							<NativeSelect
								aria-label="Interpolation method"
								onChange={(event) =>
									setMode(interpolateModeSchema.parse(event.target.value))
								}
								value={effectiveMode}
							>
								<NativeSelectOption
									disabled={opticalFlowMissing}
									value="optical-flow"
								>
									Optical flow
								</NativeSelectOption>
								<NativeSelectOption value="blend">
									Frame blending
								</NativeSelectOption>
							</NativeSelect>
						</div>
						{opticalFlowMissing && <small>{OPTICAL_FLOW_UNAVAILABLE}</small>}
					</RyuAppField>
					<RyuAppActions>
						<Button
							disabled={busy}
							onClick={() =>
								void applyMediaTool(runtime, segment, {
									fps: rate,
									kind: "interpolate",
									mode: effectiveMode,
								})
							}
							size="sm"
							variant="outline"
						>
							{tl("Convert to {fps} fps", { fps: rate })}
						</Button>
					</RyuAppActions>
				</>
			)}
			<RyuAppField label="Enhance">
				<small>
					Denoise, Lanczos upscale, and sharpen into new media (up to 8192 px).
				</small>
			</RyuAppField>
			<RyuAppActions>
				{([2, 4] as const).map((factor) => (
					<Button
						disabled={busy}
						key={factor}
						onClick={() =>
							void applyMediaTool(runtime, segment, {
								factor,
								kind: "enhance",
							})
						}
						size="sm"
						variant="outline"
					>
						{tl("Enhance {factor}×", { factor })}
					</Button>
				))}
			</RyuAppActions>
		</>
	);
}
