/**
 * Media library multi-selection (W1-L1): plain click selects one asset,
 * Cmd/Ctrl toggles, Shift selects the range from the anchor in the visible
 * order, and Cmd/Ctrl+Shift adds that range. Pure, so the tile, keyboard and
 * tests share one rule.
 */

export interface LibrarySelection {
	/** Last asset clicked without Shift; the fixed end of a Shift range. */
	anchor: string | null;
	/** Selected asset ids, in visible order. */
	ids: string[];
}

export const EMPTY_LIBRARY_SELECTION: LibrarySelection = {
	anchor: null,
	ids: [],
};

export interface SelectModifiers {
	/** Shift: select the range from the anchor. */
	range: boolean;
	/** Cmd/Ctrl: toggle (or, with Shift, add to the selection). */
	toggle: boolean;
}

/** Keep ids in visible order without duplicates. */
function ordered(ids: Iterable<string>, visible: readonly string[]): string[] {
	const wanted = new Set(ids);
	return visible.filter((id) => wanted.has(id));
}

/** Apply one click on `id` with keyboard modifiers. */
export function selectLibraryAsset(
	selection: LibrarySelection,
	visible: readonly string[],
	id: string,
	{ range, toggle }: SelectModifiers
): LibrarySelection {
	const target = visible.indexOf(id);
	if (target === -1) {
		return selection;
	}
	if (range) {
		const anchorIndex =
			selection.anchor === null ? -1 : visible.indexOf(selection.anchor);
		const from = anchorIndex === -1 ? target : anchorIndex;
		const span = visible.slice(
			Math.min(from, target),
			Math.max(from, target) + 1
		);
		return {
			anchor: anchorIndex === -1 ? id : selection.anchor,
			ids: ordered(toggle ? [...selection.ids, ...span] : span, visible),
		};
	}
	if (toggle) {
		const has = selection.ids.includes(id);
		return {
			anchor: id,
			ids: has
				? selection.ids.filter((item) => item !== id)
				: ordered([...selection.ids, id], visible),
		};
	}
	return { anchor: id, ids: [id] };
}

/** Select every visible asset. */
export function selectAllLibraryAssets(
	visible: readonly string[]
): LibrarySelection {
	return { anchor: visible[0] ?? null, ids: [...visible] };
}

/**
 * Drop ids that are no longer visible (deleted, filtered out). Returns the
 * same object when nothing changed, so it is safe inside a state updater.
 */
export function pruneLibrarySelection(
	selection: LibrarySelection,
	visible: readonly string[]
): LibrarySelection {
	const ids = ordered(selection.ids, visible);
	const anchor =
		selection.anchor !== null && visible.includes(selection.anchor)
			? selection.anchor
			: null;
	if (
		anchor === selection.anchor &&
		ids.length === selection.ids.length &&
		ids.every((id, index) => id === selection.ids[index])
	) {
		return selection;
	}
	return { anchor, ids };
}

/** Read the selection modifiers from a pointer or keyboard event. */
export function selectModifiers(event: {
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
}): SelectModifiers {
	return { range: event.shiftKey, toggle: event.metaKey || event.ctrlKey };
}
