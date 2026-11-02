import { useEditor } from "../editor/context.tsx";
import { useEditorStore } from "../editor/store.ts";

/**
 * Vertical guide at the active snap target (`store.snapGuideTime`), drawn
 * across every lane while a drag is captured by a target.
 */
export function SnapIndicator({ zoom }: { zoom: number }) {
	const { store } = useEditor();
	const guideTime = useEditorStore(store, (state) => state.snapGuideTime);
	if (guideTime === null) {
		return null;
	}
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute top-[30px] bottom-0 z-[5] w-px bg-warning"
			data-snap-guide={guideTime}
			style={{ left: `${guideTime * zoom}px` }}
		/>
	);
}
