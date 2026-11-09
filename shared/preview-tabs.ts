import { z } from "zod";

/**
 * Preview tabs: a fixed Timeline tab plus closeable source tabs, one per
 * opened library asset, with back/forward history over the tabs the viewer
 * switched between. Pure, so the tab strip, the per-viewer persistence, and
 * tests share one set of rules.
 */
export const TIMELINE_TAB = "timeline";

/** Most source tabs kept open; opening another closes the oldest inactive one. */
export const MAX_SOURCE_TABS = 12;
/** Most back (and forward) history entries kept. */
export const MAX_TAB_HISTORY = 50;

export interface PreviewTabsState {
	/** `TIMELINE_TAB` or the asset id of an open source tab. */
	active: string;
	/** Tabs to return to with Back, most recent last. */
	back: string[];
	/** Tabs Back left, for Forward, most recent last. */
	forward: string[];
	/** Asset ids of open source tabs, in strip order. */
	tabs: string[];
}

export function emptyPreviewTabs(): PreviewTabsState {
	return { active: TIMELINE_TAB, back: [], forward: [], tabs: [] };
}

const isOpen = (state: Pick<PreviewTabsState, "tabs">, id: string) =>
	id === TIMELINE_TAB || state.tabs.includes(id);

const capHistory = (entries: string[]) => entries.slice(-MAX_TAB_HISTORY);

/** Drop history entries that are closed or repeat their neighbour. */
function cleanHistory(entries: readonly string[], tabs: readonly string[]) {
	const cleaned: string[] = [];
	for (const entry of entries) {
		if (
			(entry === TIMELINE_TAB || tabs.includes(entry)) &&
			cleaned.at(-1) !== entry
		) {
			cleaned.push(entry);
		}
	}
	return capHistory(cleaned);
}

/**
 * Switch to an open tab. The tab left behind goes on the back stack and the
 * forward stack clears, like a browser. Unknown tabs change nothing.
 */
export function activatePreviewTab(
	state: PreviewTabsState,
	target: string
): PreviewTabsState {
	if (target === state.active || !isOpen(state, target)) {
		return state;
	}
	return {
		...state,
		active: target,
		back: capHistory([...state.back, state.active]),
		forward: [],
	};
}

/**
 * Open `assetId` in a source tab (or switch to its open tab) and make it
 * active. Past `MAX_SOURCE_TABS` the oldest tab other than the new one
 * closes.
 */
export function openSourceTab(
	state: PreviewTabsState,
	assetId: string
): PreviewTabsState {
	if (!assetId || assetId === TIMELINE_TAB) {
		return state;
	}
	if (state.tabs.includes(assetId)) {
		return activatePreviewTab(state, assetId);
	}
	let tabs = [...state.tabs, assetId];
	while (tabs.length > MAX_SOURCE_TABS) {
		const oldest = tabs.find((id) => id !== assetId && id !== state.active);
		tabs = tabs.filter((id) => id !== (oldest ?? tabs[0]));
	}
	return activatePreviewTab({ ...state, tabs }, assetId);
}

/**
 * Close a source tab. Closing the active tab returns to the most recent
 * still-open tab in the back history, else the Timeline tab.
 */
export function closePreviewTab(
	state: PreviewTabsState,
	assetId: string
): PreviewTabsState {
	if (!state.tabs.includes(assetId)) {
		return state;
	}
	const tabs = state.tabs.filter((id) => id !== assetId);
	const back = cleanHistory(state.back, tabs);
	const forward = cleanHistory(state.forward, tabs);
	if (state.active !== assetId) {
		return { active: state.active, back, forward, tabs };
	}
	const active = back.at(-1) ?? TIMELINE_TAB;
	return {
		active,
		back: back.length ? back.slice(0, -1) : back,
		forward,
		tabs,
	};
}

export const canGoBack = (state: PreviewTabsState) =>
	state.back.some((entry) => entry !== state.active && isOpen(state, entry));
export const canGoForward = (state: PreviewTabsState) =>
	state.forward.some((entry) => entry !== state.active && isOpen(state, entry));

/** Back: return to the previous tab, skipping closed ones. */
export function previewTabBack(state: PreviewTabsState): PreviewTabsState {
	const back = [...state.back];
	while (back.length) {
		const target = back.pop() as string;
		if (target !== state.active && isOpen(state, target)) {
			return {
				...state,
				active: target,
				back,
				forward: capHistory([...state.forward, state.active]),
			};
		}
	}
	return state;
}

/** Forward: undo the last Back, skipping closed tabs. */
export function previewTabForward(state: PreviewTabsState): PreviewTabsState {
	const forward = [...state.forward];
	while (forward.length) {
		const target = forward.pop() as string;
		if (target !== state.active && isOpen(state, target)) {
			return {
				...state,
				active: target,
				back: capHistory([...state.back, state.active]),
				forward,
			};
		}
	}
	return state;
}

/** Close tabs whose assets are no longer in the library. */
export function prunePreviewTabs(
	state: PreviewTabsState,
	assetIds: ReadonlySet<string>
): PreviewTabsState {
	let next = state;
	for (const id of state.tabs) {
		if (!assetIds.has(id)) {
			next = closePreviewTab(next, id);
		}
	}
	return next;
}

const idSchema = z.string().min(1).max(200);

/**
 * Stored tabs (per viewer and project). Malformed entries are dropped and
 * the result is made consistent rather than rejected.
 */
export const previewTabsSchema = z
	.object({
		active: idSchema.catch(TIMELINE_TAB),
		back: z.array(idSchema).catch([]),
		forward: z.array(idSchema).catch([]),
		tabs: z.array(idSchema).catch([]),
	})
	.transform((raw): PreviewTabsState => {
		const tabs = [...new Set(raw.tabs)]
			.filter((id) => id !== TIMELINE_TAB)
			.slice(-MAX_SOURCE_TABS);
		return {
			active: isOpen({ tabs }, raw.active) ? raw.active : TIMELINE_TAB,
			back: cleanHistory(raw.back, tabs),
			forward: cleanHistory(raw.forward, tabs),
			tabs,
		};
	});
