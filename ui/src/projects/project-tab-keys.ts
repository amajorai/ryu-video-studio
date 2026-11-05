// The project tab strip is a row of tabs in reading order, so ArrowRight moves
// toward the inline end: the next tab in a left-to-right page and the previous
// tab under `dir="rtl"`, where the strip lays out from the right. (The editor
// timeline is a time axis and stays left-to-right; it does not use this.)

/**
 * `true` when `element` (or, without one, the document) reads right-to-left:
 * the nearest explicit `dir` wins, then the document's direction.
 */
export function readsRightToLeft(element?: Element | null): boolean {
	const scoped = element?.closest("[dir]")?.getAttribute("dir");
	if (scoped === "rtl" || scoped === "ltr") {
		return scoped === "rtl";
	}
	return (
		typeof document !== "undefined" &&
		document.documentElement.getAttribute("dir") === "rtl"
	);
}

/** How many tabs an arrow key moves focus by in reading order, or `undefined`. */
export function projectTabKeyOffset(
	key: string,
	rightToLeft: boolean
): number | undefined {
	const sign = rightToLeft ? -1 : 1;
	if (key === "ArrowRight") {
		return sign;
	}
	if (key === "ArrowLeft") {
		return -sign;
	}
	return undefined;
}
