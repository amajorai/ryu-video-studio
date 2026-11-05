import { useState, useSyncExternalStore } from "react";
import type { EditorRuntime } from "../editor/runtime.ts";
import { noSubscription } from "./ClipKeyframeLane-shared.ts";

/**
 * Whether a clip's keyframe lanes are open. Outside an editor (tests,
 * thumbnails) the open state is local; in the editor it lives in the store
 * so lanes survive the clip remounting.
 */
export function useLaneExpansion(
	store: EditorRuntime["store"] | undefined,
	segmentId: string
) {
	const [localExpanded, setLocalExpanded] = useState(false);
	const storeExpanded = useSyncExternalStore(
		store?.subscribe ?? noSubscription,
		() => store?.getState().openKeyframeLanes.includes(segmentId) ?? false,
		() => false
	);
	const expanded = store ? storeExpanded : localExpanded;
	const setExpanded = (update: (open: boolean) => boolean) => {
		if (!store) {
			setLocalExpanded(update);
			return;
		}
		store.setState((state) => {
			const open = state.openKeyframeLanes.includes(segmentId);
			const next = update(open);
			if (next === open) {
				return {};
			}
			return {
				openKeyframeLanes: next
					? [...state.openKeyframeLanes, segmentId]
					: state.openKeyframeLanes.filter((id) => id !== segmentId),
			};
		});
	};
	return { expanded, setExpanded, setLocalExpanded };
}
