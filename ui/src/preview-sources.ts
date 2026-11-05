import type { Asset } from "../../shared/project.ts";
import type { PreviewQuality } from "./editor/store.ts";

/**
 * Derivations stored as ProRes 4444 with alpha (Lottie imports, cutouts, AI
 * mattes). Browsers cannot decode them, and an H.264 proxy would drop the
 * alpha, so their preview copy is a VP9 WebM with alpha made with the
 * derivative, and no H.264 proxy is ever requested for them.
 */
const ALPHA_MASTER_DERIVATIONS: ReadonlySet<string> = new Set([
	"lottie",
	"cutout",
	"ai-matte",
]);

/** True for a transparent ProRes master whose preview is its VP9 alpha copy. */
export function isAlphaMaster(
	asset: Pick<PreviewAsset, "derivation" | "kind">
): boolean {
	return (
		asset.kind === "video" &&
		asset.derivation !== undefined &&
		ALPHA_MASTER_DERIVATIONS.has(asset.derivation)
	);
}

/**
 * Preview blob type for an asset's stored media. `sourceOf` finds a proxy's
 * source: an alpha master's preview copy is VP9 WebM with alpha.
 */
export const previewMimeType = (
	asset: Pick<Asset, "derivation" | "derivedFromAssetId" | "kind">,
	sourceOf: (id: string) => Pick<Asset, "derivation"> | undefined
) => {
	if (asset.kind === "audio") {
		// Extracted and reversed audio derivatives are stored as WAV.
		return asset.derivation ? "audio/wav" : "audio/mpeg";
	}
	if (asset.kind === "image") {
		return "image/png";
	}
	const sourceDerivation =
		asset.derivation === "proxy" && asset.derivedFromAssetId !== undefined
			? sourceOf(asset.derivedFromAssetId)?.derivation
			: undefined;
	return sourceDerivation !== undefined &&
		ALPHA_MASTER_DERIVATIONS.has(sourceDerivation)
		? "video/webm"
		: "video/mp4";
};

export interface PreviewAsset {
	/** Derived media (extracted, reversed, ...) is stored in the sidecar's own format. */
	derivation?: Asset["derivation"];
	/** Source asset of a derivative; set on proxies. */
	derivedFromAssetId?: string;
	id: string;
	kind: "audio" | "image" | "video";
	/** Pixel width; proxies are ranked by it. */
	width?: number;
}

/** How the preview chooses between original media and proxies. */
export interface ProxyPreference {
	quality: PreviewQuality;
	/** The "Use proxies" toggle: prefer a proxy even at full quality. */
	useProxies: boolean;
}

/** Proxy widths are even, so allow this much rounding below a target. */
const WIDTH_SLACK = 2;
/** Matches the sidecar's import trigger: wider sources are heavy. */
const HEAVY_SOURCE_WIDTH = 1920;

const QUALITY_DIVISOR: Record<PreviewQuality, number> = {
	full: 1,
	half: 2,
	quarter: 4,
};

/** True for an app-owned preview proxy. */
export function isProxyAsset(asset: Pick<PreviewAsset, "derivation">): boolean {
	return asset.derivation === "proxy";
}

/** The media library listing: proxies stay hidden. */
export function withoutProxies<Item extends PreviewAsset>(
	assets: readonly Item[]
): Item[] {
	return assets.filter((asset) => !isProxyAsset(asset));
}

/** Proxies of `sourceId`, narrowest first (ties by id, so the pick is stable). */
export function proxiesOf<Item extends PreviewAsset>(
	library: readonly Item[],
	sourceId: string
): Item[] {
	return library
		.filter(
			(asset) =>
				isProxyAsset(asset) &&
				asset.kind === "video" &&
				asset.derivedFromAssetId === sourceId
		)
		.sort(
			(a, b) => (a.width ?? 0) - (b.width ?? 0) || a.id.localeCompare(b.id)
		);
}

/**
 * The media the preview should load for `asset`. An alpha master (Lottie,
 * cutout, AI matte) always uses its VP9 alpha preview copy. Other video uses a proxy when the
 * quality is below full, or when the "Use proxies" toggle is on and a proxy
 * exists; otherwise the original. Below full quality the narrowest proxy at
 * least `source width / divisor` wide wins, else the widest proxy. With the
 * toggle at full quality the widest proxy wins. Exports never call this:
 * the render reads the clip's original asset.
 */
export function selectPreviewMedia<Item extends PreviewAsset>(
	asset: Item,
	library: readonly Item[],
	preference: ProxyPreference
): Item {
	if (asset.kind !== "video" || isProxyAsset(asset)) {
		return asset;
	}
	// An alpha master is ProRes 4444, which browsers cannot play: the preview
	// always uses its VP9 alpha copy when one was made.
	if (isAlphaMaster(asset)) {
		return proxiesOf(library, asset.id).at(-1) ?? asset;
	}
	if (preference.quality === "full" && !preference.useProxies) {
		return asset;
	}
	const proxies = proxiesOf(library, asset.id);
	const widest = proxies.at(-1);
	if (!widest) {
		return asset;
	}
	if (preference.quality === "full") {
		return widest;
	}
	const target = (asset.width ?? 0) / QUALITY_DIVISOR[preference.quality];
	return (
		proxies.find((proxy) => (proxy.width ?? 0) >= target - WIDTH_SLACK) ??
		widest
	);
}

/**
 * True when `asset` is an alpha master without a VP9 alpha preview copy (the
 * host's FFmpeg had no VP9 encoder, or the copy failed): the preview cannot
 * show its transparency, though exports still read the master.
 */
export function alphaPreviewMissing(
	asset: PreviewAsset,
	library: readonly PreviewAsset[]
): boolean {
	return isAlphaMaster(asset) && proxiesOf(library, asset.id).length === 0;
}

/**
 * The lazily generated proxy variant the preview would like for `asset` at
 * `quality`, or `null` when an adequate proxy exists (or none applies).
 * The caller requests it with `POST /assets/:id/proxy {variant}`.
 */
export function wantedProxyVariant(
	asset: PreviewAsset,
	library: readonly PreviewAsset[],
	quality: PreviewQuality
): "half" | "quarter" | null {
	// Alpha masters get their preview copy when they are made, never an
	// H.264 proxy (it would drop the alpha channel).
	if (
		quality === "full" ||
		asset.kind !== "video" ||
		isProxyAsset(asset) ||
		isAlphaMaster(asset)
	) {
		return null;
	}
	const width = asset.width ?? 0;
	if (width <= 0) {
		return null;
	}
	const proxies = proxiesOf(library, asset.id);
	// Light media without any proxy plays fine as is.
	if (proxies.length === 0 && width <= HEAVY_SOURCE_WIDTH) {
		return null;
	}
	const target = width / QUALITY_DIVISOR[quality];
	// Any proxy at least the target width (rounding slack) is adequate;
	// `selectPreviewMedia` then picks the narrowest such proxy.
	const adequate = proxies.some(
		(proxy) => (proxy.width ?? 0) >= target - WIDTH_SLACK
	);
	return adequate ? null : quality;
}

/** Owns only the media referenced by the current preview, including pending reads. */
export class PreviewSources {
	private readonly sources: Record<string, string> = {};
	/** Clip asset id → id of the media actually loaded (original or proxy). */
	private readonly loadedMedia = new Map<string, string>();
	private readonly pending = new Map<
		string,
		{ promise: Promise<Blob>; controller: AbortController }
	>();
	private generation = 0;

	constructor(
		private readonly load: (
			asset: PreviewAsset,
			signal: AbortSignal
		) => Promise<Blob>,
		private readonly createUrl = URL.createObjectURL,
		private readonly revokeUrl = URL.revokeObjectURL
	) {}

	snapshot() {
		return { ...this.sources };
	}

	remove(id: string): void {
		this.pending.get(id)?.controller.abort();
		this.pending.delete(id);
		const url = this.sources[id];
		if (url) {
			this.revokeUrl(url);
			delete this.sources[id];
		}
		this.loadedMedia.delete(id);
	}

	/**
	 * Load preview media for `assets`, keyed by each clip asset's id. With
	 * `proxies`, video may load a proxy from `proxies.library` instead
	 * (see `selectPreviewMedia`); a changed choice swaps the loaded media.
	 */
	sync(
		assets: readonly PreviewAsset[],
		onChange: (sources: Record<string, string>) => void,
		onError: (error: Error) => void,
		proxies?: ProxyPreference & { library: readonly PreviewAsset[] }
	): () => void {
		const generation = ++this.generation;
		const active = () => generation === this.generation;
		const media = new Map(
			assets.map((asset) => [
				asset.id,
				proxies ? selectPreviewMedia(asset, proxies.library, proxies) : asset,
			])
		);
		const stale = (id: string) => {
			const chosen = media.get(id);
			return !chosen || (this.loadedMedia.get(id) ?? id) !== chosen.id;
		};
		for (const id of this.pending.keys()) {
			if (stale(id)) {
				this.remove(id);
			}
		}
		let removed = false;
		for (const id of Object.keys(this.sources)) {
			if (stale(id)) {
				this.remove(id);
				removed = true;
			}
		}
		if (removed) {
			onChange(this.snapshot());
		}
		void (async () => {
			for (const asset of assets) {
				if (!active()) {
					return;
				}
				if (this.sources[asset.id]) {
					continue;
				}
				let request = this.pending.get(asset.id);
				const chosen = media.get(asset.id) ?? asset;
				try {
					if (!request) {
						const controller = new AbortController();
						request = {
							controller,
							promise: Promise.resolve().then(() => {
								controller.signal.throwIfAborted();
								return this.load(chosen, controller.signal);
							}),
						};
						this.pending.set(asset.id, request);
						this.loadedMedia.set(asset.id, chosen.id);
						const clear = () => {
							if (this.pending.get(asset.id) === request) {
								this.pending.delete(asset.id);
							}
						};
						void request.promise.then(clear, clear);
					}
					const blob = await request.promise;
					if (!active()) {
						return;
					}
					this.sources[asset.id] = this.createUrl(blob);
					onChange(this.snapshot());
				} catch (error) {
					if (!active()) {
						return;
					}
					if (!request?.controller.signal.aborted) {
						onError(
							error instanceof Error
								? error
								: new Error("The operation failed.")
						);
					}
				}
			}
		})();
		return () => {
			if (active()) {
				this.generation += 1;
			}
		};
	}

	dispose(): void {
		this.generation += 1;
		for (const id of Object.keys(this.sources)) {
			this.remove(id);
		}
		for (const { controller } of this.pending.values()) {
			controller.abort();
		}
		this.pending.clear();
	}
}
