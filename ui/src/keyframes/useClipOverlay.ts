import { type RefObject, useLayoutEffect, useState } from "react";

/**
 * A positioned overlay that sits beside a clip (a sibling in its track row)
 * and tracks the clip's box. Slots mounted inside the clip's `<button>` may
 * only render presentational content; interactive controls portal into this
 * overlay instead, so assistive technology sees real controls. `rootRef` is
 * an element the slot renders directly inside the clip.
 */
export function useClipOverlay(
	rootRef: RefObject<HTMLElement | null>,
	attribute: string,
	segmentId: string,
	box: { left: number; width: number }
): HTMLElement | null {
	const [overlay, setOverlay] = useState<HTMLElement | null>(null);
	useLayoutEffect(() => {
		const clip = rootRef.current?.parentElement;
		if (!clip?.parentElement) {
			return;
		}
		const element = clip.ownerDocument.createElement("div");
		element.setAttribute(attribute, segmentId);
		element.className = "pointer-events-none absolute z-[5]";
		clip.after(element);
		setOverlay(element);
		return () => {
			element.remove();
			setOverlay(null);
		};
	}, [attribute, rootRef, segmentId]);
	useLayoutEffect(() => {
		const clip = rootRef.current?.parentElement;
		if (!(overlay && clip)) {
			return;
		}
		overlay.style.left = `${box.left}px`;
		overlay.style.width = `${box.width}px`;
		overlay.style.top = `${clip.offsetTop}px`;
		overlay.style.height = `${clip.offsetHeight}px`;
	});
	return overlay;
}
