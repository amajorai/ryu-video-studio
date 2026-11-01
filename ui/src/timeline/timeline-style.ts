import type { CSSProperties } from "react";

/** CSS custom properties the timeline sets inline for positions and colors. */
export interface EditorTimelineStyle extends CSSProperties {
	"--studio-guide-left"?: string;
	"--studio-guide-width"?: string;
	"--studio-marker-color"?: string;
	"--studio-marker-left"?: string;
	"--studio-marker-width"?: string;
	"--studio-playhead-left"?: string;
	"--studio-range-left"?: string;
	"--studio-range-width"?: string;
	"--studio-ruler-tick-left"?: string;
	"--studio-tracks-width"?: string;
	/** Per-kind default clip fills (the viewer's Timeline colors). */
	[kindColor: `--studio-clip-kind-${string}`]: string | undefined;
}
