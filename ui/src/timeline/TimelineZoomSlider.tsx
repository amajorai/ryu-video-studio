import { useLiteralMessages } from "@ryu/i18n/react";
import { Slider } from "@ryu/ui/components/slider.tsx";
import type { EditorStore } from "../editor/store.ts";
import { useEditorStore } from "../editor/store.ts";
import { zoomTimeline } from "./useTimelineZoom.ts";
import { sliderToZoom, zoomToSlider } from "./zoom-math.ts";

/** Slider steps across the logarithmic 5–600 px/s range. */
const SLIDER_STEPS = 1000;

/** Logarithmic timeline zoom slider (5–600 px/s), anchored on the playhead. */
export function TimelineZoomSlider({
	className,
	store,
}: {
	className?: string;
	store: EditorStore;
}) {
	const tl = useLiteralMessages();
	const zoom = useEditorStore(store, (state) => state.zoomPxPerSec);
	return (
		<Slider
			aria-label="Timeline zoom level"
			className={className}
			max={SLIDER_STEPS}
			min={0}
			onValueChange={(values) => {
				const position = Array.isArray(values) ? values[0] : values;
				if (typeof position === "number") {
					zoomTimeline(store, sliderToZoom(position / SLIDER_STEPS));
				}
			}}
			step={1}
			title={tl(
				"Timeline zoom: {zoom} px/s (Ctrl+wheel to zoom, Shift+Z to fit)",
				{ zoom: Math.round(zoom) }
			)}
			value={[Math.round(zoomToSlider(zoom) * SLIDER_STEPS)]}
		/>
	);
}
