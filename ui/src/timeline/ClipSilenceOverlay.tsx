import {
	clipSilenceBands,
	type SourceRange,
	silenceOverlayEnabled,
	useAssetSilence,
	useSilenceSettings,
} from "../silence-vad.ts";
import type { ClipSlotProps } from "./clip-slot-props.ts";

/** Red non-speech spans for one clip, positioned as percentages of its width. */
export function ClipSilenceBands({
	ranges,
	segment,
}: Pick<ClipSlotProps, "segment"> & { ranges: readonly SourceRange[] }) {
	const bands = clipSilenceBands(segment, ranges);
	if (bands.length === 0) {
		return null;
	}
	return (
		<span
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 z-[1] overflow-hidden"
			data-testid="clip-silence-overlay"
		>
			{bands.map((band) => (
				<span
					className="absolute inset-y-0 bg-red-500/30"
					data-silence-end={band.end}
					data-silence-start={band.start}
					key={`${band.start}-${band.end}`}
					style={{
						left: `${band.leftPercent}%`,
						width: `${band.widthPercent}%`,
					}}
				/>
			))}
		</span>
	);
}

/**
 * Detected non-speech shading, shown when the Cleanup panel's "Show
 * non-speech on clips" is on. Uses the panel's VAD parameters.
 */
export function ClipSilenceOverlay({ asset, segment }: ClipSlotProps) {
	const settings = useSilenceSettings();
	const enabled = silenceOverlayEnabled(settings, asset);
	const ranges = useAssetSilence(asset?.id, settings.params, enabled);
	if (!(enabled && ranges)) {
		return null;
	}
	return <ClipSilenceBands ranges={ranges} segment={segment} />;
}
