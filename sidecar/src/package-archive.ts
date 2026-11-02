/**
 * Self-contained project archives: a ZIP holding the editable project
 * package (`package.json`), the media file of every asset it refers to
 * (`media/<asset id>`), the canonical `.cube` file of every imported LUT it
 * grades with (`luts/<lut id>.cube`) and every imported title font it uses
 * (`fonts/<font id>.<ttf|otf>`). Importing one on another node re-ingests the
 * media, LUTs and fonts under the same ids (all are random UUIDs, so an id
 * that already exists on the node is the same file and is reused), then opens
 * the project as a new copy, exactly like a JSON package import.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { customFontIdsIn, lutIdsIn } from "../../shared/library-refs.ts";
import {
	ARCHIVE_PACKAGE_NAME,
	archiveFontName,
	archiveLutName,
	archiveMediaName,
	type ProjectPackage,
	projectArchivePackage,
	projectPackageSchema,
} from "../../shared/package.ts";
import { type Asset, assetSchema, type Project } from "../../shared/project.ts";
import { readZip } from "../../shared/zip-read.ts";
import { MAX_ZIP_BYTES, writeZip, type ZipEntry } from "./export-zip.ts";
import { fontLibraryForStore } from "./font-library.ts";
import { lutStoreFor } from "./lut-store.ts";
import { probe } from "./media.ts";
import type { StudioStore } from "./store.ts";

/** Archives are kept for download this long after they are built. */
const ARCHIVE_TTL_MS = 60 * 60_000;
/** At most this many archives wait for download at once. */
const MAX_PENDING_ARCHIVES = 4;

export interface BuiltArchive {
	/** Asset ids whose media file was missing (offline) and left out. */
	missing: string[];
	/** Imported font ids the titles use that are not in the font library. */
	missingFonts: string[];
	/** LUT ids the project grades with that are not in the LUT library. */
	missingLuts: string[];
	package: ProjectPackage;
	path: string;
	size: number;
}

/** Build the archive for `project` into a new temporary file. */
export async function buildProjectArchive(
	store: StudioStore,
	project: Project
): Promise<BuiltArchive> {
	const luts = lutStoreFor(store.directory);
	const fontLibrary = fontLibraryForStore(store);
	const bundle = projectArchivePackage(project, store.assets(), {
		fonts: await fontLibrary.list(),
		luts: [...(await luts.list()), ...(await luts.retired())],
	});
	const lutTexts = new Map<string, string>();
	for (const lut of bundle.luts ?? []) {
		const text = await luts.read(lut.id).catch(() => null);
		if (text !== null) {
			lutTexts.set(lut.id, text);
		}
	}
	const fontFiles = new Map<string, Uint8Array>();
	for (const font of bundle.fonts ?? []) {
		const bytes = await fontLibrary.read(font.id).catch(() => null);
		if (bytes) {
			fontFiles.set(font.id, bytes);
		}
	}
	const missingLuts = [...lutIdsIn(project)].filter((id) => !lutTexts.has(id));
	const missingFonts = [...customFontIdsIn(project)].filter(
		(id) => !fontFiles.has(id)
	);
	if (missingLuts.length || missingFonts.length) {
		bundle.luts = bundle.luts?.filter((lut) => lutTexts.has(lut.id));
		bundle.fonts = bundle.fonts?.filter((font) => fontFiles.has(font.id));
	}
	const missing: string[] = [];
	const present: Asset[] = [];
	let mediaBytes = 0;
	for (const asset of bundle.assets) {
		const info = await stat(store.mediaPath(asset.id)).catch(() => null);
		if (info?.isFile()) {
			present.push(asset);
			mediaBytes += info.size;
		} else {
			missing.push(asset.id);
		}
	}
	if (mediaBytes > MAX_ZIP_BYTES) {
		throw new Error(
			"The project's media is larger than 4 GB, the archive limit. Download the package without media instead."
		);
	}
	const directory = await mkdtemp(join(tmpdir(), "ryu-project-archive-"));
	const path = join(directory, "project.zip");
	const writer = Bun.file(path).writer();
	async function* entries(): AsyncGenerator<ZipEntry> {
		yield {
			data: new TextEncoder().encode(JSON.stringify(bundle, null, 2)),
			name: ARCHIVE_PACKAGE_NAME,
		};
		for (const lut of bundle.luts ?? []) {
			yield {
				data: new TextEncoder().encode(lutTexts.get(lut.id) ?? ""),
				name: archiveLutName(lut.id),
			};
		}
		for (const font of bundle.fonts ?? []) {
			yield {
				data: fontFiles.get(font.id) ?? new Uint8Array(),
				name: archiveFontName(font),
			};
		}
		for (const asset of present) {
			yield {
				data: await Bun.file(store.mediaPath(asset.id)).bytes(),
				name: archiveMediaName(asset.id),
			};
		}
	}
	try {
		const size = await writeZip(entries(), {
			write: (chunk) => {
				writer.write(chunk);
			},
		});
		await writer.end();
		return {
			missing,
			missingFonts,
			missingLuts,
			package: bundle,
			path,
			size,
		};
	} catch (error) {
		await writer.end();
		await rm(directory, { force: true, recursive: true });
		throw error;
	}
}

interface PendingArchive extends BuiltArchive {
	created: number;
	filename: string;
	id: string;
}

/** Built archives waiting for chunked download, by id. */
export class ArchiveShelf {
	private readonly archives = new Map<string, PendingArchive>();

	async add(archive: BuiltArchive, filename: string): Promise<PendingArchive> {
		await this.sweep();
		if (this.archives.size >= MAX_PENDING_ARCHIVES) {
			const oldest = [...this.archives.values()].sort(
				(a, b) => a.created - b.created
			)[0];
			if (oldest) {
				await this.remove(oldest.id);
			}
		}
		const entry: PendingArchive = {
			...archive,
			created: Date.now(),
			filename,
			id: crypto.randomUUID(),
		};
		this.archives.set(entry.id, entry);
		return entry;
	}

	get(id: string): PendingArchive | undefined {
		return this.archives.get(id);
	}

	async remove(id: string) {
		const archive = this.archives.get(id);
		this.archives.delete(id);
		if (archive) {
			await rm(join(archive.path, ".."), { force: true, recursive: true });
		}
	}

	async sweep(now = Date.now()) {
		for (const archive of [...this.archives.values()]) {
			if (now - archive.created > ARCHIVE_TTL_MS) {
				await this.remove(archive.id);
			}
		}
	}
}

/** Library items an archive import wrote or found already present. */
export interface LibraryImport {
	added: string[];
	reused: string[];
}

export interface ArchiveImportResult {
	/** Assets written from the archive. */
	added: string[];
	/** Imported title fonts carried by the archive. */
	fonts: LibraryImport;
	/** Imported LUTs carried by the archive. */
	luts: LibraryImport;
	project: Project;
	/** Assets already on this node (same id), kept as they are. */
	reused: string[];
}

/**
 * Import an archive's bytes: validate the package, re-register its LUTs and
 * fonts under their original ids (validated like a library import), write
 * each asset's media that is not already on the node (re-probing it so a
 * damaged file is refused), then save the project as a new copy.
 */
export async function importProjectArchive(
	store: StudioStore,
	bytes: Uint8Array,
	maxMediaBytes: number
): Promise<ArchiveImportResult> {
	const files = await readZip(bytes, {
		// package.json + 2000 media + 200 LUTs + 100 fonts.
		maxEntries: 2301,
		maxTotalBytes: maxMediaBytes,
	});
	const raw = files.get(ARCHIVE_PACKAGE_NAME);
	if (!raw) {
		throw new Error("This archive has no package.json.");
	}
	const bundle = projectPackageSchema.parse(
		JSON.parse(new TextDecoder().decode(raw))
	);
	const existing = new Set(store.assets().map((asset) => asset.id));
	const reused: string[] = [];
	const added: string[] = [];
	const missing = bundle.assets.filter(
		(asset) =>
			!(existing.has(asset.id) || files.has(archiveMediaName(asset.id)))
	);
	if (missing.length) {
		throw new Error(
			`The archive is missing media for: ${missing
				.slice(0, 8)
				.map((asset) => asset.name)
				.join(", ")}`
		);
	}
	const lutStore = lutStoreFor(store.directory);
	const fontLibrary = fontLibraryForStore(store);
	const knownLuts = new Set(
		[...(await lutStore.list()), ...(await lutStore.retired())].map(
			(record) => record.id
		)
	);
	const knownFonts = new Set(
		(await fontLibrary.list()).map((record) => record.id)
	);
	const missingLibrary = [
		...(bundle.luts ?? [])
			.filter(
				(lut) => !(knownLuts.has(lut.id) || files.has(archiveLutName(lut.id)))
			)
			.map((lut) => `LUT ${lut.name}`),
		...(bundle.fonts ?? [])
			.filter(
				(font) => !(knownFonts.has(font.id) || files.has(archiveFontName(font)))
			)
			.map((font) => `font ${font.name}`),
	];
	if (missingLibrary.length) {
		throw new Error(
			`The archive is missing files for: ${missingLibrary.slice(0, 8).join(", ")}`
		);
	}
	const luts: LibraryImport = { added: [], reused: [] };
	for (const lut of bundle.luts ?? []) {
		const data = files.get(archiveLutName(lut.id));
		if (knownLuts.has(lut.id) || !data) {
			luts.reused.push(lut.id);
			continue;
		}
		try {
			const outcome = await lutStore.adopt(lut, new TextDecoder().decode(data));
			luts[outcome].push(lut.id);
		} catch (error) {
			throw new Error(
				`The LUT ${lut.name} in the archive is not usable: ${error instanceof Error ? error.message : "invalid .cube"}`
			);
		}
	}
	const fonts: LibraryImport = { added: [], reused: [] };
	for (const font of bundle.fonts ?? []) {
		const data = files.get(archiveFontName(font));
		if (knownFonts.has(font.id) || !data) {
			fonts.reused.push(font.id);
			continue;
		}
		try {
			const outcome = await fontLibrary.adopt(font, data);
			fonts[outcome].push(font.id);
		} catch (error) {
			throw new Error(
				`The font ${font.name} in the archive is not usable: ${error instanceof Error ? error.message : "unreadable font"}`
			);
		}
	}
	for (const asset of bundle.assets) {
		if (existing.has(asset.id)) {
			reused.push(asset.id);
			continue;
		}
		const data = files.get(archiveMediaName(asset.id));
		if (!data) {
			continue;
		}
		const path = store.mediaPath(asset.id);
		// Counts against the media quota and asset limit like an upload.
		const reservation = store.reserveMediaStorage(Math.max(1, data.byteLength));
		try {
			await Bun.write(path, data);
			const info = await probe(path);
			store.putAsset(
				assetSchema.parse({
					...asset,
					duration: info.duration,
					hasAudio: info.hasAudio,
					height: info.height,
					kind: info.kind,
					width: info.width,
				})
			);
			added.push(asset.id);
			reservation.commit();
		} catch (error) {
			reservation.release();
			await rm(path, { force: true });
			throw new Error(
				`${asset.name} in the archive is not readable media: ${error instanceof Error ? error.message : "probe failed"}`
			);
		}
	}
	const created = store.create(
		`${bundle.project.title} (imported)`,
		bundle.project.requireApproval
	);
	const project = store.save({
		...bundle.project,
		id: created.id,
		revision: created.revision,
		title: `${bundle.project.title} (imported)`,
		updatedAt: new Date().toISOString(),
	});
	return { added, fonts, luts, project, reused };
}
