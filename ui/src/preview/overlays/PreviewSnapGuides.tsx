import { useContext, useSyncExternalStore } from "react";
import { EditorContext } from "../../editor/context.tsx";
import type { PreviewOverlayProps } from "./overlay-props.ts";
import { canvasGuideStoreFor } from "./preview-snap.ts";

/**
 * Canvas snapping guides: the center, edge, and item lines a dragged box is
 * currently snapped to (published through `canvasGuideStoreFor`). Hidden
 * during playback.
 */
export function PreviewSnapGuides({ playing }: PreviewOverlayProps) {
	const runtime = useContext(EditorContext);
	const guideStore = canvasGuideStoreFor(runtime?.store);
	const guides = useSyncExternalStore(
		guideStore.subscribe,
		guideStore.get,
		guideStore.get
	);
	if (playing || !(guides.x.length || guides.y.length)) {
		return null;
	}
	return (
		<svg
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 z-[6] size-full overflow-visible text-warning"
			data-testid="preview-snap-guides"
			preserveAspectRatio="none"
			viewBox="0 0 100 100"
		>
			{guides.x.map((x) => (
				<line
					data-axis="x"
					key={`x${x}`}
					stroke="currentColor"
					strokeDasharray="4 3"
					strokeWidth={1}
					vectorEffect="non-scaling-stroke"
					x1={x * 100}
					x2={x * 100}
					y1={0}
					y2={100}
				/>
			))}
			{guides.y.map((y) => (
				<line
					data-axis="y"
					key={`y${y}`}
					stroke="currentColor"
					strokeDasharray="4 3"
					strokeWidth={1}
					vectorEffect="non-scaling-stroke"
					x1={0}
					x2={100}
					y1={y * 100}
					y2={y * 100}
				/>
			))}
		</svg>
	);
}
