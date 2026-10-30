import type { ReactNode } from "react";
import {
	AdjustmentLayerPanel,
	adjustmentLayerPanelTab,
} from "./AdjustmentLayerPanel.tsx";
import { AutoCutPanel, autoCutPanelTab } from "./AutoCutPanel.tsx";
import { BackgroundPanel, backgroundPanelTab } from "./BackgroundPanel.tsx";
import {
	CaptionStylePanel,
	captionStylePanelTab,
} from "./CaptionStylePanel.tsx";
import { ExportPanel, exportPanelTab } from "./ExportPanel.tsx";
import { HistoryPanel, historyPanelTab } from "./HistoryPanel.tsx";
import { LooksPanel, looksPanelTab } from "./LooksPanel.tsx";
import { MarkersPanel, markersPanelTab } from "./MarkersPanel.tsx";
import { MixerPanel, mixerPanelTab } from "./MixerPanel.tsx";
import {
	ProjectsDashboard,
	projectsDashboardTab,
} from "./ProjectsDashboard.tsx";
import { RecorderPanel, recorderPanelTab } from "./RecorderPanel.tsx";
import { ReframePanel, reframePanelTab } from "./ReframePanel.tsx";
import {
	ScriptToVideoPanel,
	scriptToVideoPanelTab,
} from "./ScriptToVideoPanel.tsx";
import { SpeakerPanel, speakerPanelTab } from "./SpeakerPanel.tsx";
import { StickerPanel, stickerPanelTab } from "./StickerPanel.tsx";
import { TemplatesPanel, templatesPanelTab } from "./TemplatesPanel.tsx";
import {
	TextTemplatesPanel,
	textTemplatesPanelTab,
} from "./TextTemplatesPanel.tsx";
import {
	TimelineTranscriptPanel,
	timelineTranscriptPanelTab,
} from "./TimelineTranscriptPanel.tsx";
import { TrackingPanel, trackingPanelTab } from "./TrackingPanel.tsx";
import type { PanelTab } from "./types.ts";

/** The library tabs that shipped before the panel registry, in display order. */
export const LIBRARY_TABS: readonly PanelTab[] = [
	{ label: "Media", value: "media" },
	{ label: "Find footage", value: "search" },
	{ label: "Stock", value: "stock" },
	{ label: "Reference", value: "reference" },
	{ label: "Plan", value: "storyboard" },
	{ label: "Recipes", value: "recipes" },
	{ label: "Layouts", value: "layouts" },
	{ label: "Sync", value: "sync" },
	{ label: "Multicam", value: "multicam" },
	{ label: "J/L cuts", value: "split-edits" },
	{ label: "Cleanup", value: "cleanup" },
	{ label: "Highlights", value: "highlights" },
	{ label: "Speed & beat", value: "tempo" },
	{ label: "Generate", value: "generate" },
	{ label: "Captions", value: "captions" },
	{ label: "Transcript", value: "transcript" },
	{ label: "Titles", value: "titles" },
	{ label: "Vector graphics", value: "graphics" },
	{ label: "Avatars", value: "avatars" },
	{ label: "3D stage", value: "stage" },
	{ label: "Meshes", value: "meshes" },
	{ label: "Credits", value: "credits" },
	{ label: "Exports", value: "exports" },
];

export type LibraryCategory = (typeof LIBRARY_TABS)[number]["value"];

export interface RegisteredPanel {
	/** A function component reading the editor from context. */
	Component: () => ReactNode;
	/** Existing tab the panel mounts in while it has no tab of its own. */
	home: string;
	id: string;
	/** Its own tab, when the panel declares one. */
	tab: PanelTab | null;
}

/**
 * Planned panels. Each reads the editor from context. A panel mounts in its
 * own tab once it declares one, otherwise inside `home` after the built-in
 * content; panels that render nothing add nothing, and a missing tab stays
 * hidden.
 */
export const PANEL_REGISTRY: readonly RegisteredPanel[] = [
	{
		Component: RecorderPanel,
		home: "media",
		id: "recorder",
		tab: recorderPanelTab,
	},
	{
		Component: ProjectsDashboard,
		home: "media",
		id: "projects",
		tab: projectsDashboardTab,
	},
	{
		Component: ScriptToVideoPanel,
		home: "storyboard",
		id: "script-to-video",
		tab: scriptToVideoPanelTab,
	},
	{
		Component: TemplatesPanel,
		home: "recipes",
		id: "templates",
		tab: templatesPanelTab,
	},
	{
		Component: ReframePanel,
		home: "layouts",
		id: "reframe",
		tab: reframePanelTab,
	},
	{
		Component: AutoCutPanel,
		home: "highlights",
		id: "auto-cut",
		tab: autoCutPanelTab,
	},
	{
		Component: CaptionStylePanel,
		home: "captions",
		id: "caption-style",
		tab: captionStylePanelTab,
	},
	{
		Component: TimelineTranscriptPanel,
		home: "transcript",
		id: "timeline-transcript",
		tab: timelineTranscriptPanelTab,
	},
	{
		Component: SpeakerPanel,
		home: "transcript",
		id: "speakers",
		tab: speakerPanelTab,
	},
	{
		Component: TextTemplatesPanel,
		home: "titles",
		id: "text-templates",
		tab: textTemplatesPanelTab,
	},
	{
		Component: StickerPanel,
		home: "graphics",
		id: "stickers",
		tab: stickerPanelTab,
	},
	{
		Component: AdjustmentLayerPanel,
		home: "graphics",
		id: "adjustment-layers",
		tab: adjustmentLayerPanelTab,
	},
	{
		Component: BackgroundPanel,
		home: "graphics",
		id: "background",
		tab: backgroundPanelTab,
	},
	{
		Component: TrackingPanel,
		home: "graphics",
		id: "tracking",
		tab: trackingPanelTab,
	},
	{ Component: LooksPanel, home: "generate", id: "looks", tab: looksPanelTab },
	{
		Component: MarkersPanel,
		home: "exports",
		id: "markers",
		tab: markersPanelTab,
	},
	{
		Component: HistoryPanel,
		home: "exports",
		id: "history",
		tab: historyPanelTab,
	},
	{ Component: MixerPanel, home: "exports", id: "mixer", tab: mixerPanelTab },
	{
		Component: ExportPanel,
		home: "exports",
		id: "export",
		tab: exportPanelTab,
	},
];

/** Built-in tabs followed by every registered panel that declares a tab. */
export function libraryTabs(
	registry: readonly RegisteredPanel[] = PANEL_REGISTRY
): PanelTab[] {
	return [
		...LIBRARY_TABS,
		...registry.flatMap((entry) => (entry.tab ? [entry.tab] : [])),
	];
}

/** Registered panels mounted under the tab `value`. */
export function panelsFor(
	value: string,
	registry: readonly RegisteredPanel[] = PANEL_REGISTRY
): RegisteredPanel[] {
	return registry.filter((entry) => (entry.tab?.value ?? entry.home) === value);
}

/** Render the registered panels for the open tab. */
export function RegisteredPanels({ value }: { value: string }) {
	return (
		<>
			{panelsFor(value).map(({ Component, id }) => (
				<Component key={id} />
			))}
		</>
	);
}
