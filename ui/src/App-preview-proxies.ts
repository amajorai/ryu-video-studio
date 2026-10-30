import { useLiteralMessages } from "@ryu/i18n/react";
import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
} from "react";
import type { Asset, Project } from "../../shared/project.ts";
import { loadAssets, request, studioResponseSchema } from "./bridge.ts";
import { message } from "./editor/format.ts";
import type { useStatusLine } from "./editor/status-notice.ts";
import type { createEditorStore } from "./editor/store.ts";
import {
	alphaPreviewMissing,
	type PreviewSources,
	wantedProxyVariant,
} from "./preview-sources.ts";

type EditorState = ReturnType<ReturnType<typeof createEditorStore>["getState"]>;

export interface StudioPreviewProxiesOptions {
	assets: Asset[];
	previewQuality: EditorState["previewQuality"];
	previewSources: PreviewSources;
	project: Project | null;
	proxyLibrary: Asset[];
	ready: boolean;
	setProxyLibrary: Dispatch<SetStateAction<Asset[]>>;
	setSources: Dispatch<SetStateAction<Record<string, string>>>;
	setStatus: ReturnType<typeof useStatusLine>["setStatus"];
	useProxies: EditorState["useProxies"];
}

/**
 * Keeps the preview's media in step with the timeline: loads the proxy
 * listing, syncs the preview sources, requests missing proxies, and reports
 * transparent clips the browser preview cannot show with alpha.
 */
export function useStudioPreviewProxies({
	assets,
	previewQuality,
	previewSources,
	project,
	proxyLibrary,
	ready,
	setProxyLibrary,
	setSources,
	setStatus,
	useProxies,
}: StudioPreviewProxiesOptions): void {
	const tl = useLiteralMessages();
	useEffect(() => {
		if (!ready) {
			return;
		}
		let live = true;
		loadAssets(true)
			.then((library) => {
				if (live) {
					setProxyLibrary(library);
				}
			})
			.catch(() => {
				// Without the proxy listing the preview keeps the originals.
			});
		return () => {
			live = false;
		};
	}, [assets, ready]);
	const clipAssetKey = project?.segments.map((s) => s.assetId).join(",") ?? "";
	const clipAssets = useCallback(() => {
		const ids = new Set(clipAssetKey.split(",").filter(Boolean));
		return assets.filter((asset) => ids.has(asset.id));
	}, [assets, clipAssetKey]);
	useEffect(
		() =>
			previewSources.sync(
				clipAssets(),
				setSources,
				(error) => setStatus(message(error)),
				{ library: proxyLibrary, quality: previewQuality, useProxies }
			),
		[clipAssets, previewQuality, previewSources, proxyLibrary, useProxies]
	);
	// Half and Quarter quality ask the sidecar for a proxy of that size when
	// none is adequate yet; the listing is reloaded once each one is ready.
	const requestedProxies = useRef(new Set<string>());
	useEffect(() => {
		if (previewQuality === "full") {
			return;
		}
		for (const asset of clipAssets()) {
			const variant = wantedProxyVariant(asset, proxyLibrary, previewQuality);
			const key = `${asset.id}:${variant}`;
			if (!variant || requestedProxies.current.has(key)) {
				continue;
			}
			requestedProxies.current.add(key);
			request(studioResponseSchema, `/assets/${asset.id}/proxy`, "POST", {
				variant,
			})
				.then(() => loadAssets(true))
				.then(setProxyLibrary)
				.catch((error) =>
					setStatus(
						tl("Preview proxy unavailable: {error}", { error: message(error) })
					)
				);
		}
	}, [clipAssets, previewQuality, proxyLibrary]);
	// A transparent ProRes take (AI matte, cutout, Lottie) without its VP9
	// alpha copy cannot play with transparency in the browser: say so once.
	const reportedAlphaGaps = useRef(new Set<string>());
	useEffect(() => {
		// Judge only media the proxy listing already holds: its preview copy is
		// made before the derivative is returned, so a listing with the master
		// has the copy too, when there is one.
		const listed = new Set(proxyLibrary.map((asset) => asset.id));
		for (const asset of clipAssets()) {
			if (
				reportedAlphaGaps.current.has(asset.id) ||
				!listed.has(asset.id) ||
				!alphaPreviewMissing(asset, proxyLibrary)
			) {
				continue;
			}
			reportedAlphaGaps.current.add(asset.id);
			setStatus(
				tl(
					"The preview cannot show “{name}” with transparency: no VP9 alpha preview copy was made (this FFmpeg may lack libvpx-vp9). Exports keep its alpha.",
					{ name: asset.name }
				)
			);
		}
	}, [clipAssets, proxyLibrary]);
}
