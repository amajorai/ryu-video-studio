import {
	type Asset,
	assetSchema,
	type Segment,
} from "../../../shared/project.ts";
import {
	bundledStickerAsset,
	STICKER_FOLDER,
	type StickerEntry,
	stickerAssetName,
	stickerOrigin,
} from "../../../shared/stickers/catalog.ts";
import {
	placeSticker,
	STICKER_CLIP_SECONDS,
	STICKER_TRACKS_BUSY_MESSAGE,
	type StickerAnimationPreset,
	stickerTrack,
} from "../../../shared/stickers/place.ts";
import {
	request,
	StudioRequestError,
	studioResponseSchema,
} from "../bridge.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { blobToBase64, rasterizeSticker } from "./rasterize.ts";
import { stickerUrl } from "./sticker-urls.ts";

/** Body of `POST /assets/import` for a rasterized sticker. */
export interface StickerImportBody {
	derivation?: "sticker";
	folder: string;
	name: string;
	origin?: ReturnType<typeof stickerOrigin>;
	source: { bytes: string; mimeType: "image/png" };
	[key: string]: unknown;
}

/**
 * The import request for a sticker PNG. With `provenance`, it also carries
 * the bundled `origin` (attribution, license, rights) and
 * `derivation: "sticker"` so the asset appears in the project credits.
 */
export function stickerImportBody(
	entry: StickerEntry,
	bytes: string,
	provenance = true
): StickerImportBody {
	const body: StickerImportBody = {
		folder: STICKER_FOLDER,
		name: stickerAssetName(entry),
		source: { bytes, mimeType: "image/png" },
	};
	if (provenance) {
		body.derivation = "sticker";
		body.origin = stickerOrigin(entry);
	}
	return body;
}

/**
 * What this session learned about the sidecar's import contract: whether it
 * accepts sticker provenance (`origin`, `derivation`). Once a sidecar has
 * rejected provenance, later stickers import plainly in one request instead
 * of uploading the PNG twice.
 */
export interface StickerImportContract {
	provenance: "accepted" | "rejected" | "unknown";
}

export interface StickerDependencies {
	/** Session memo of the import contract; shared by default. */
	contract?: StickerImportContract;
	/** POST to `/assets/import`; resolves with the created asset JSON. */
	importAsset: (body: StickerImportBody) => Promise<unknown>;
	/** Rasterize a sticker to PNG bytes. */
	rasterize: (entry: StickerEntry) => Promise<Blob>;
}

const defaultDependencies: StickerDependencies = {
	contract: { provenance: "unknown" },
	importAsset: (body) =>
		request(studioResponseSchema, "/assets/import", "POST", body),
	rasterize: async (entry) => {
		const url = stickerUrl(entry);
		if (!url) {
			throw new Error(`${entry.name} is not bundled with this build.`);
		}
		return (await rasterizeSticker(url, entry.aspect)).blob;
	},
};

/**
 * The message the sidecar answers when a request body fails its schema (for
 * an otherwise well-formed sticker body: the provenance keys are unknown).
 */
export const CONTRACT_MISMATCH_MESSAGE =
	"The request does not match the Video Studio contract.";

/**
 * True only when the sidecar refused the body itself as off-contract. Probe,
 * storage, busy, and other failures share the INVALID_REQUEST code but carry
 * their own message, and must surface instead of triggering a retry.
 */
export function isContractMismatch(error: unknown): boolean {
	return (
		error instanceof StudioRequestError &&
		error.code === "INVALID_REQUEST" &&
		error.message === CONTRACT_MISMATCH_MESSAGE
	);
}

/**
 * Rasterize and import a sticker. The request carries its provenance unless
 * this session already saw the sidecar reject it; an off-contract refusal of
 * the provenance body is retried once as a plain import so the sticker still
 * lands (`attributed: false` tells the caller the credit was not recorded).
 */
export async function importSticker(
	entry: StickerEntry,
	dependencies: StickerDependencies = defaultDependencies,
	/** PNG already rasterized for this sticker; drawn here when omitted. */
	png?: Blob
): Promise<{ asset: Asset; attributed: boolean }> {
	const contract = dependencies.contract ?? { provenance: "unknown" };
	const bytes = await blobToBase64(
		png ?? (await dependencies.rasterize(entry))
	);
	if (contract.provenance !== "rejected") {
		try {
			const asset = assetSchema.parse(
				await dependencies.importAsset(stickerImportBody(entry, bytes))
			);
			contract.provenance = "accepted";
			return { asset, attributed: Boolean(asset.origin) };
		} catch (error) {
			if (contract.provenance === "accepted" || !isContractMismatch(error)) {
				throw error;
			}
			contract.provenance = "rejected";
		}
	}
	const asset = assetSchema.parse(
		await dependencies.importAsset(stickerImportBody(entry, bytes, false))
	);
	return { asset, attributed: false };
}

/**
 * A library asset already imported for this sticker, so adding the same
 * sticker again places that asset instead of uploading a duplicate (one
 * credit entry per distinct sticker). An attributed asset is matched by its
 * bundled origin; an unattributed one only by folder and name, and only once
 * the sidecar is known to reject provenance, so a sidecar that now records
 * credits gets a fresh, attributed import.
 */
export function existingStickerAsset(
	assets: readonly Asset[],
	entry: StickerEntry,
	contract: StickerImportContract
): { asset: Asset; attributed: boolean } | null {
	const attributed = bundledStickerAsset(assets, entry);
	if (attributed) {
		return { asset: attributed, attributed: true };
	}
	if (contract.provenance !== "rejected") {
		return null;
	}
	const plain = assets.find(
		(asset) =>
			asset.kind === "image" &&
			!asset.origin &&
			asset.folder === STICKER_FOLDER &&
			asset.name === stickerAssetName(entry)
	);
	return plain ? { asset: plain, attributed: false } : null;
}

type StickerRuntime = Pick<
	EditorRuntime,
	| "act"
	| "assets"
	| "edit"
	| "project"
	| "routeEdit"
	| "setAssets"
	| "setSelected"
	| "setStatus"
	| "time"
>;

/**
 * Place a sticker through the sidecar (`POST /projects/:id/stickers`), which
 * draws the SVG with FFmpeg and records its license credit. Used when the
 * editor cannot draw the artwork itself; it is the same route agents call.
 */
export const placeStickerOnSidecar = (
	runtime: Pick<StickerRuntime, "routeEdit">,
	entry: StickerEntry,
	time: number,
	preset: StickerAnimationPreset
) =>
	runtime.routeEdit(
		"stickers",
		{ preset, stickerId: entry.id, time },
		() => `${entry.name} added at the playhead.`,
		{ refreshAssets: true }
	);

/**
 * Import a sticker and place it as an image clip at the playhead on the
 * first free track above the picture, with the chosen animation preset.
 * When the editor cannot draw the SVG (no 2D canvas, or the artwork is
 * missing from this build), the sidecar draws and places it instead.
 */
export async function addSticker(
	runtime: StickerRuntime,
	entry: StickerEntry,
	preset: StickerAnimationPreset,
	dependencies: StickerDependencies = defaultDependencies
): Promise<void> {
	let sidecarStart: number | null = null;
	await runtime.act(async () => {
		if (!runtime.project) {
			throw new Error("Create a project before adding stickers.");
		}
		const time = runtime.time;
		const start = Math.max(0, Number.isFinite(time) ? time : 0);
		if (
			stickerTrack(
				runtime.project,
				runtime.assets,
				start,
				STICKER_CLIP_SECONDS
			) === null
		) {
			throw new Error(STICKER_TRACKS_BUSY_MESSAGE);
		}
		const contract = dependencies.contract ?? { provenance: "unknown" };
		const reused = existingStickerAsset(runtime.assets, entry, contract);
		runtime.setStatus(`Adding ${entry.name}…`);
		let png: Blob | undefined;
		if (!reused) {
			try {
				png = await dependencies.rasterize(entry);
			} catch {
				sidecarStart = start;
				return;
			}
		}
		const { asset, attributed } =
			reused ??
			(await importSticker(entry, { ...dependencies, contract }, png));
		if (!reused) {
			runtime.setAssets((current) => [asset, ...current]);
		}
		let placed: Segment | undefined;
		runtime.edit((current) => {
			const result = placeSticker(current, runtime.assets, asset, time, preset);
			placed = result.segment;
			return result.project;
		}, `Add sticker ${entry.name}`);
		if (placed) {
			runtime.setSelected(placed.id);
		}
		runtime.setStatus(
			attributed
				? `${entry.name} added at the playhead.`
				: `${entry.name} added at the playhead. Its license credit was not recorded in the project credits; see the sticker panel for attribution.`
		);
	});
	if (sidecarStart !== null) {
		runtime.setStatus(`Drawing ${entry.name} in Video Studio…`);
		await placeStickerOnSidecar(runtime, entry, sidecarStart, preset);
	}
}
