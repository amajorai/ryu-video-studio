import type { Asset, Segment } from "../../../shared/project.ts";
import type { TimeWindow } from "./virtualize.ts";

/** What every per-clip visual slot (waveform, filmstrip, badges…) receives. */
export interface ClipSlotProps {
	asset?: Asset;
	/**
	 * Timeline seconds around the viewport that wide visuals (filmstrip,
	 * waveform) draw; absent or `null` draws the whole clip.
	 */
	drawWindow?: TimeWindow | null;
	fps: number;
	locked: boolean;
	segment: Segment;
	selected: boolean;
	/** Timeline zoom in pixels per second. */
	zoom: number;
}
