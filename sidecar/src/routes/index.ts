/**
 * Every route module, in dispatch order. Wave 0 pre-registers each planned
 * module (empty stubs included) so feature items only edit their own file.
 */

import { routes as adjustmentRoutes } from "./adjustment.ts";
import { routes as aiMatteRoutes } from "./ai-matte.ts";
import { routes as assetTranscriptRoutes } from "./asset-transcript.ts";
import { routes as assetsBulkRoutes } from "./assets-bulk.ts";
import { routes as autoEditRoutes } from "./auto-edit.ts";
import { routes as avatarLipsyncRoutes } from "./avatar-lipsync.ts";
import { routes as backgroundRoutes } from "./background.ts";
import { routes as beatsRoutes } from "./beats.ts";
import { routes as capabilitiesRoutes } from "./capabilities.ts";
import { routes as captionsExtRoutes } from "./captions-ext.ts";
import { routes as clipboardRoutes } from "./clipboard.ts";
import { routes as cutOpsRoutes } from "./cut-ops.ts";
import { routes as cutoutRoutes } from "./cutout.ts";
import { routes as deadAirRoutes } from "./dead-air.ts";
import { routes as derivativesRoutes } from "./derivatives.ts";
import { routes as filmstripRoutes } from "./filmstrip.ts";
import { routes as fontsRoutes } from "./fonts.ts";
import { routes as gapFillRoutes } from "./gap-fill.ts";
import { routes as generationInputsRoutes } from "./generation-inputs.ts";
import { routes as graphicMasksRoutes } from "./graphic-masks.ts";
import { routes as historyRoutes } from "./history.ts";
import { routes as keyframesExtRoutes } from "./keyframes-ext.ts";
import { routes as lutsRoutes } from "./luts.ts";
import { routes as markersRoutes } from "./markers.ts";
import { routes as matteRoutes } from "./matte.ts";
import { routes as multicamRoutes } from "./multicam.ts";
import { routes as nestRoutes } from "./nest.ts";
import { routes as overlayEditsRoutes } from "./overlay-edits.ts";
import { routes as overviewRoutes } from "./overview.ts";
import { routes as packageArchiveRoutes } from "./package-archive.ts";
import { routes as placementRoutes } from "./placement.ts";
import { routes as projectsExtRoutes } from "./projects-ext.ts";
import { routes as proxyRoutes } from "./proxy.ts";
import { routes as reattachRoutes } from "./reattach.ts";
import { routes as reframeRoutes } from "./reframe.ts";
import type { StudioRoute } from "./registry.ts";
import { routes as relinkRoutes } from "./relink.ts";
import { routes as renderRoutes } from "./render.ts";
import { routes as scopesRoutes } from "./scopes.ts";
import { routes as scriptToVideoRoutes } from "./script-to-video.ts";
import { routes as settingsRoutes } from "./settings.ts";
import { routes as sfxRoutes } from "./sfx.ts";
import { routes as shotsRoutes } from "./shots.ts";
import { routes as silenceRoutes } from "./silence.ts";
import { routes as soundtrackRoutes } from "./soundtrack.ts";
import { routes as speakersRoutes } from "./speakers.ts";
import { routes as splitRemoveRoutes } from "./split-remove.ts";
import { routes as stickersRoutes } from "./stickers.ts";
import { routes as syncRoutes } from "./sync.ts";
import { routes as templatesRoutes } from "./templates.ts";
import { routes as titleNarrationRoutes } from "./title-narration.ts";
import { routes as trackingRoutes } from "./tracking.ts";
import { routes as tracksRoutes } from "./tracks.ts";
import { routes as transitionsRoutes } from "./transitions.ts";
import { routes as upscaleRoutes } from "./upscale.ts";

export const studioRoutes: readonly StudioRoute[] = [
	...renderRoutes,
	...tracksRoutes,
	...markersRoutes,
	...beatsRoutes,
	...silenceRoutes,
	...deadAirRoutes,
	...assetTranscriptRoutes,
	...settingsRoutes,
	...syncRoutes,
	...multicamRoutes,
	...upscaleRoutes,
	...soundtrackRoutes,
	...scopesRoutes,
	...historyRoutes,
	...splitRemoveRoutes,
	...capabilitiesRoutes,
	...cutOpsRoutes,
	...transitionsRoutes,
	...clipboardRoutes,
	...placementRoutes,
	...titleNarrationRoutes,
	...stickersRoutes,
	...overlayEditsRoutes,
	...graphicMasksRoutes,
	...filmstripRoutes,
	...keyframesExtRoutes,
	...reattachRoutes,
	...projectsExtRoutes,
	...packageArchiveRoutes,
	...assetsBulkRoutes,
	...cutoutRoutes,
	...aiMatteRoutes,
	...lutsRoutes,
	...fontsRoutes,
	...adjustmentRoutes,
	...backgroundRoutes,
	...proxyRoutes,
	...derivativesRoutes,
	...matteRoutes,
	...relinkRoutes,
	...captionsExtRoutes,
	...speakersRoutes,
	...shotsRoutes,
	...overviewRoutes,
	...avatarLipsyncRoutes,
	...sfxRoutes,
	...nestRoutes,
	...templatesRoutes,
	...reframeRoutes,
	...trackingRoutes,
	...gapFillRoutes,
	...generationInputsRoutes,
	...scriptToVideoRoutes,
	...autoEditRoutes,
];
