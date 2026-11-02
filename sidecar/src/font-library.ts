/**
 * Imported fonts: `<storeDir>/fonts/<id>.ttf|otf` plus a `fonts.json` index
 * of `importedFontSchema` records. Every file is validated by `readFontFile`
 * before it is stored, and its bytes count against the node's media storage
 * allowance (`admit`, and `StudioStore.mediaStorageBytes` once stored).
 * libass takes a single `fontsdir` and reads every file in it when it starts,
 * so each render gets `<storeDir>/fonts/render/<set>/`: the bundled fonts plus
 * only the imported fonts that project uses, hard-linked (not copied) from
 * the library.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	copyFile,
	link,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
	importedFontFile,
	MAX_IMPORTED_FONTS,
	readFontFile,
} from "../../shared/font-file.ts";
import { customFontIdsIn } from "../../shared/library-refs.ts";
import type { Project } from "../../shared/project.ts";
import {
	type FontOrigin,
	type ImportedFont,
	importedFontSchema,
} from "../../shared/schema/font.ts";
import { BUNDLED_FONT_FILES } from "../../shared/text-style.ts";
import { bundledFontsDirectory } from "./fonts.ts";

const indexSchema = z.array(importedFontSchema);

/** Render font sets unused this long are removed (a long export touches its own). */
const RENDER_SET_IDLE_MS = 6 * 60 * 60_000;

/** A storage admission for font bytes (see `StudioStore.reserveMediaStorage`). */
export type FontAdmission = (bytes: number) => { release(): void };

/** The store surface a font library needs to admit bytes. */
export interface FontStore {
	readonly directory: string;
	reserveMediaStorage(
		bytes: number,
		options?: { asset?: boolean }
	): { release(): void };
}

/** Link `source` at `target`, or copy it when the file system cannot link. */
async function linkOrCopy(source: string, target: string) {
	try {
		await link(source, target);
	} catch {
		await copyFile(source, target);
	}
}

/** Thrown when an imported font is still used by a project's titles or captions. */
export class FontInUseError extends Error {
	readonly projects: string[];
	constructor(projects: string[]) {
		super(
			`This font is used by ${projects.length === 1 ? "a project" : `${projects.length} projects`} (${projects.slice(0, 3).join(", ")}). Choose another font for those titles and captions first.`
		);
		this.name = "FontInUseError";
		this.projects = projects;
	}
}

export class FontLibrary {
	readonly directory: string;
	/**
	 * Checks a font's bytes against the media storage allowance before it is
	 * written; the reservation is released once the file is on disk, where
	 * `StudioStore.mediaStorageBytes` counts it. Unset in bare tests.
	 */
	admit: FontAdmission | undefined;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(storeDirectory: string) {
		this.directory = join(storeDirectory, "fonts");
	}

	private get indexPath() {
		return join(this.directory, "fonts.json");
	}

	/** The directory holding the per-render font sets. */
	get renderDirectory() {
		return join(this.directory, "render");
	}

	/** Absolute path of a stored font file. */
	path(font: Pick<ImportedFont, "format" | "id">): string {
		return join(this.directory, importedFontFile(font));
	}

	private exclusive<Value>(operation: () => Promise<Value>): Promise<Value> {
		const next = this.queue.then(operation, operation);
		this.queue = next.catch(() => undefined);
		return next;
	}

	async list(): Promise<ImportedFont[]> {
		if (!existsSync(this.indexPath)) {
			return [];
		}
		const parsed = indexSchema.safeParse(
			JSON.parse(await readFile(this.indexPath, "utf8"))
		);
		return parsed.success ? parsed.data : [];
	}

	async get(id: string): Promise<ImportedFont | undefined> {
		return (await this.list()).find((font) => font.id === id);
	}

	/** The font file's bytes (for the preview's `@font-face`). */
	async read(id: string): Promise<Uint8Array> {
		const font = await this.get(id);
		if (!font) {
			throw new Error("Font not found.");
		}
		return await readFile(this.path(font));
	}

	private async writeIndex(records: ImportedFont[]) {
		const temporary = `${this.indexPath}.${crypto.randomUUID()}.tmp`;
		await writeFile(temporary, JSON.stringify(records, null, "\t"));
		await rename(temporary, this.indexPath);
	}

	/**
	 * Validate and store a font file; returns its record. `origin` records an
	 * online catalog font's source and license for the credits.
	 */
	async add(
		name: string,
		bytes: Uint8Array,
		origin?: FontOrigin,
		options: { admitted?: boolean } = {}
	): Promise<ImportedFont> {
		const { family, format } = readFontFile(bytes);
		return await this.exclusive(async () => {
			const records = await this.list();
			if (records.length >= MAX_IMPORTED_FONTS) {
				throw new Error(
					`The library already holds ${MAX_IMPORTED_FONTS} fonts. Delete one first.`
				);
			}
			const admission = options.admitted
				? undefined
				: this.admit?.(bytes.byteLength);
			try {
				await mkdir(this.directory, { mode: 0o700, recursive: true });
				const record = importedFontSchema.parse({
					createdAt: new Date().toISOString(),
					family,
					format,
					id: crypto.randomUUID(),
					name: name.trim().slice(0, 120) || family,
					...(origin ? { origin } : {}),
					size: bytes.byteLength,
				});
				const target = this.path(record);
				const temporary = `${target}.tmp`;
				await writeFile(temporary, bytes, { mode: 0o600 });
				await rename(temporary, target);
				await this.writeIndex([...records, record]);
				return record;
			} finally {
				admission?.release();
			}
		});
	}

	/**
	 * Store a font carried by a project archive under its original id (font
	 * ids are random UUIDs, so an id already on this node is the same font and
	 * is reused). The file is validated like an import and must read as the
	 * record's family and format, so titles keep naming it correctly.
	 */
	async adopt(
		record: ImportedFont,
		bytes: Uint8Array
	): Promise<"added" | "reused"> {
		const { family, format } = readFontFile(bytes);
		if (family !== record.family || format !== record.format) {
			throw new Error(
				`${record.name} in the archive reads as ${family} (${format}), not ${record.family} (${record.format}).`
			);
		}
		const adopted = importedFontSchema.parse({
			...record,
			size: bytes.byteLength,
		});
		return await this.exclusive(async () => {
			const records = await this.list();
			if (records.some((entry) => entry.id === adopted.id)) {
				return "reused";
			}
			if (records.length >= MAX_IMPORTED_FONTS) {
				throw new Error(
					`The library already holds ${MAX_IMPORTED_FONTS} fonts. Delete one before importing ${adopted.name}.`
				);
			}
			const admission = this.admit?.(bytes.byteLength);
			try {
				await mkdir(this.directory, { mode: 0o700, recursive: true });
				const target = this.path(adopted);
				const temporary = `${target}.tmp`;
				await writeFile(temporary, bytes, { mode: 0o600 });
				await rename(temporary, target);
				await this.writeIndex([...records, adopted]);
			} finally {
				admission?.release();
			}
			return "added";
		});
	}

	/** Delete a font unless a current project's titles or captions use it. */
	async remove(id: string, projects: readonly Project[]): Promise<void> {
		await this.exclusive(async () => {
			const records = await this.list();
			const font = records.find((record) => record.id === id);
			if (!font) {
				throw new Error("Font not found.");
			}
			const users = projects
				.filter((project) => customFontIdsIn(project).has(id))
				.map((project) => project.title);
			if (users.length) {
				throw new FontInUseError(users);
			}
			await this.writeIndex(records.filter((record) => record.id !== id));
			await rm(this.path(font), { force: true });
			// Drop render sets that linked it, so its bytes are freed.
			const file = importedFontFile(font);
			for (const set of await this.renderSets()) {
				if (existsSync(join(this.renderDirectory, set, file))) {
					await rm(join(this.renderDirectory, set), {
						force: true,
						recursive: true,
					});
				}
			}
		});
	}

	private async renderSets(): Promise<string[]> {
		if (!existsSync(this.renderDirectory)) {
			return [];
		}
		return await readdir(this.renderDirectory);
	}

	/**
	 * The `fontsdir` for a render of a project that uses `fontIds` (see
	 * `customFontIdsIn`): the bundled fonts directory when it uses no imported
	 * font in the library; otherwise `fonts/render/<set>`, holding the bundled
	 * fonts plus only those imported fonts, hard-linked from the library. libass
	 * loads every file in its `fontsdir`, so fonts the project does not use stay
	 * out. Sets unused for six hours are removed.
	 */
	async renderFontsDirectory(
		fontIds: Iterable<string>,
		bundled: string | null = bundledFontsDirectory()
	): Promise<string | null> {
		const wantedIds = new Set(fontIds);
		const fonts = wantedIds.size
			? (await this.list()).filter((font) => wantedIds.has(font.id))
			: [];
		if (!fonts.length) {
			return bundled;
		}
		return await this.exclusive(async () => {
			const files = new Map<string, string>();
			if (bundled) {
				for (const file of BUNDLED_FONT_FILES) {
					if (existsSync(join(bundled, file))) {
						files.set(file, join(bundled, file));
					}
				}
			}
			for (const font of fonts) {
				files.set(importedFontFile(font), this.path(font));
			}
			const key = createHash("sha256")
				.update(JSON.stringify([bundled, [...files.keys()].sort()]))
				.digest("hex")
				.slice(0, 20);
			const target = join(this.renderDirectory, key);
			await mkdir(target, { mode: 0o700, recursive: true });
			for (const [file, source] of files) {
				const [from, to] = await Promise.all([
					stat(source).catch(() => null),
					stat(join(target, file)).catch(() => null),
				]);
				if (from && from.size !== to?.size) {
					await rm(join(target, file), { force: true });
					await linkOrCopy(source, join(target, file));
				}
			}
			const now = new Date();
			await utimes(target, now, now);
			await this.pruneRenderSets(key, now.getTime());
			return target;
		});
	}

	/** Remove render sets idle past `RENDER_SET_IDLE_MS` and stray files. */
	private async pruneRenderSets(keep: string, now: number) {
		for (const entry of await this.renderSets()) {
			if (entry === keep) {
				continue;
			}
			const path = join(this.renderDirectory, entry);
			const info = await stat(path).catch(() => null);
			if (!info) {
				continue;
			}
			// Files directly in `render/` are from the single shared fontsdir
			// earlier versions synchronized.
			if (!info.isDirectory() || now - info.mtimeMs > RENDER_SET_IDLE_MS) {
				await rm(path, { force: true, recursive: true });
			}
		}
	}
}

const libraries = new Map<string, FontLibrary>();

/** One font library per project-store directory, shared by routes and renders. */
export function fontLibraryFor(storeDirectory: string): FontLibrary {
	let library = libraries.get(storeDirectory);
	if (!library) {
		library = new FontLibrary(storeDirectory);
		libraries.set(storeDirectory, library);
	}
	return library;
}

/**
 * The store's font library, with font bytes admitted against the store's
 * media storage allowance (fonts do not count toward the media asset limit).
 */
export function fontLibraryForStore(store: FontStore): FontLibrary {
	const library = fontLibraryFor(store.directory);
	library.admit = (bytes) => store.reserveMediaStorage(bytes, { asset: false });
	return library;
}
