import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Asset, Project } from "../../shared/project.ts";
import {
	bundledStickerAsset,
	rasterSize,
	STICKER_CATALOG,
	STICKER_FOLDER,
	type StickerEntry,
	stickerAssetName,
	stickerById,
	stickerOrigin,
} from "../../shared/stickers/catalog.ts";
import {
	placeSticker,
	type StickerPlacementRequest,
	stickerPlacementRequestSchema,
} from "../../shared/stickers/place.ts";
import { EMBEDDED_STICKERS } from "./bundled-stickers.ts";
import { importMediaAsset } from "./import-media.ts";
import { runMedia } from "./media.ts";
import { type MediaOperation, withMediaOperation } from "./media-operation.ts";
import { ConflictError, type StudioStore } from "./store.ts";

const OPERATION_TIMEOUT_MS = 60_000;
const MAX_STICKER_PNG_BYTES = 12 * 1024 * 1024;

export const STICKER_RASTER_UNAVAILABLE_MESSAGE =
	"This FFmpeg build cannot draw SVG stickers (it lacks the librsvg decoder). Install a full FFmpeg build, or add the sticker from the Stickers panel, which draws it in the editor.";

/** The embedded SVG source of a bundled sticker. */
export function stickerSvg(
	entry: Pick<StickerEntry, "file" | "name">,
	embedded: Readonly<Record<string, string>> = EMBEDDED_STICKERS
): string {
	const svg = embedded[entry.file];
	if (!svg) {
		throw new Error(`${entry.name} is not bundled with this sidecar.`);
	}
	return svg;
}

/**
 * True when an FFmpeg failure means the SVG decoder is missing. A build
 * that has the `svg_pipe` demuxer but no librsvg decoder (Homebrew, the
 * Chocolatey essentials build) refuses the decoder's own `-keep_ar` option
 * before it reads any input.
 */
export function isMissingSvgDecoder(message: string): boolean {
	return /svg_pipe|librsvg|decoder .*svg|codec svg|Unknown input format|Invalid data found when processing input|Unrecognized option '?keep_ar'?/i.test(
		message
	);
}

export interface StickerRasterOptions {
	operation: MediaOperation;
	/** Replaces FFmpeg (tests). */
	run?: typeof runMedia;
	workDirectory: string;
}

/**
 * Rasterize a bundled sticker's SVG to a transparent RGBA PNG whose longest
 * edge is `STICKER_RASTER_EDGE`, through FFmpeg's librsvg decoder (the same
 * size the editor's canvas rasterizer produces).
 */
export async function rasterizeBundledSticker(
	entry: StickerEntry,
	options: StickerRasterOptions
): Promise<Uint8Array> {
	const size = rasterSize(entry.aspect);
	const input = join(options.workDirectory, "sticker.svg");
	const output = join(options.workDirectory, "sticker.png");
	await mkdir(options.workDirectory, { mode: 0o700, recursive: true });
	await writeFile(input, stickerSvg(entry), { mode: 0o600 });
	try {
		await (options.run ?? runMedia)(
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostdin",
				"-y",
				"-protocol_whitelist",
				"file",
				"-f",
				"svg_pipe",
				"-width",
				String(size.width),
				"-height",
				String(size.height),
				"-keep_ar",
				"0",
				"-i",
				input,
				"-frames:v",
				"1",
				"-pix_fmt",
				"rgba",
				"-c:v",
				"png",
				"-f",
				"image2",
				"-update",
				"1",
				output,
			],
			{
				cwd: options.workDirectory,
				maxOutputBytes: MAX_STICKER_PNG_BYTES,
				outputPath: output,
				signal: options.operation.signal,
				timeoutMs: options.operation.remainingMs(),
			}
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isMissingSvgDecoder(message)) {
			throw new Error(STICKER_RASTER_UNAVAILABLE_MESSAGE);
		}
		throw error;
	}
	options.operation.check();
	const bytes = await stat(output).then(
		(metadata) => metadata.size,
		() => 0
	);
	if (!bytes || bytes > MAX_STICKER_PNG_BYTES) {
		throw new Error(`${entry.name} could not be drawn as a PNG.`);
	}
	return new Uint8Array(await readFile(output));
}

export interface StickerPlacementResult {
	asset: Asset;
	project: Project;
	/** True when an earlier import of this sticker was placed again. */
	reused: boolean;
	segmentId: string;
	sticker: { id: string; name: string };
	track: number;
}

export interface StickerPlacementOptions {
	/** Replaces FFmpeg (tests). */
	run?: typeof runMedia;
	signal?: AbortSignal;
}

const CONFLICT_MESSAGE =
	"The project changed. Reload before adding the sticker.";

function placeOn(
	store: StudioStore,
	projectId: string,
	input: StickerPlacementRequest,
	asset: Asset,
	reused: boolean,
	entry: StickerEntry
): StickerPlacementResult {
	const project = store.project(projectId);
	if (project.revision !== input.revision) {
		throw new ConflictError(CONFLICT_MESSAGE);
	}
	const placed = placeSticker(
		project,
		store.assets(),
		asset,
		input.time ?? 0,
		input.preset ?? "none",
		input.duration
	);
	const saved = store.save(placed.project);
	return {
		asset,
		project: saved,
		reused,
		segmentId: placed.segment.id,
		sticker: { id: entry.id, name: entry.name },
		track: placed.segment.track,
	};
}

/**
 * Place a bundled sticker on a project as an image clip, with its license
 * provenance and an optional animation preset. An attributed asset already
 * imported for the sticker is reused; otherwise the SVG is rasterized and
 * imported into the library (folder "Stickers", `derivation: "sticker"`,
 * bundled `origin`) so it appears in the project credits. The revision is
 * checked before the slow work and again when saving; a sticker imported for
 * a refused edit is discarded.
 */
export async function addBundledSticker(
	store: StudioStore,
	projectId: string,
	body: unknown,
	options: StickerPlacementOptions = {},
	catalog: readonly StickerEntry[] = STICKER_CATALOG
): Promise<StickerPlacementResult> {
	const input = stickerPlacementRequestSchema.parse(body);
	const entry = stickerById(input.stickerId, catalog);
	if (!entry) {
		throw new Error(
			`No bundled sticker has the id ${input.stickerId}. List stickers with GET /stickers.`
		);
	}
	const current = store.project(projectId);
	if (current.revision !== input.revision) {
		throw new ConflictError(CONFLICT_MESSAGE);
	}
	const existing = bundledStickerAsset(store.assets(), entry);
	if (existing) {
		return placeOn(store, projectId, input, existing, true, entry);
	}
	const imported = await withMediaOperation(
		OPERATION_TIMEOUT_MS,
		{ signal: options.signal },
		async (operation) => {
			const workDirectory = join(
				store.directory,
				"media",
				`.sticker-${crypto.randomUUID()}`
			);
			try {
				const png = await rasterizeBundledSticker(entry, {
					operation,
					run: options.run,
					workDirectory,
				});
				return await importMediaAsset(
					store,
					{
						derivation: "sticker",
						folder: STICKER_FOLDER,
						name: stickerAssetName(entry),
						origin: stickerOrigin(entry),
						source: {
							bytes: Buffer.from(png).toString("base64"),
							mimeType: "image/png",
						},
					},
					{ signal: operation.signal }
				);
			} finally {
				await rm(workDirectory, { force: true, recursive: true });
			}
		}
	);
	try {
		return placeOn(store, projectId, input, imported, false, entry);
	} catch (error) {
		store.discardAsset(imported.id);
		await Promise.all([
			rm(store.mediaPath(imported.id), { force: true }),
			rm(join(store.directory, "media", `${imported.id}.jpg`), {
				force: true,
			}),
		]);
		throw error;
	}
}
