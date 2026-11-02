import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUNDLED_FONT_FILES } from "../../shared/text-style.ts";
import { EMBEDDED_FONTS } from "./bundled-fonts.ts";
import { assertPrivateDirectory } from "./render-stages/audio-environment.ts";

/**
 * Where the bundled title fonts live. Development runs read
 * `sidecar/assets/fonts`; the compiled sidecar reads `assets/fonts` next to
 * its executable (copied there by `build.ts`). `RYU_VIDEO_STUDIO_FONTS_DIR`
 * overrides both.
 */
export function fontDirectoryCandidates(
	env: Record<string, string | undefined> = process.env,
	executable: string = process.execPath,
	moduleDirectory: string = import.meta.dir
): string[] {
	return [
		env.RYU_VIDEO_STUDIO_FONTS_DIR,
		join(moduleDirectory, "..", "assets", "fonts"),
		join(dirname(executable), "assets", "fonts"),
	].filter((path): path is string => Boolean(path));
}

/** Whether `directory` holds at least one bundled title font. */
export function hasBundledFonts(
	directory: string,
	exists: (path: string) => boolean = existsSync
): boolean {
	return BUNDLED_FONT_FILES.some((file) => exists(join(directory, file)));
}

/** The first candidate directory with bundled fonts, or null (system fonts). */
export function resolveFontsDirectory(
	candidates: readonly string[] = fontDirectoryCandidates(),
	exists: (path: string) => boolean = existsSync
): string | null {
	return (
		candidates.find((directory) => hasBundledFonts(directory, exists)) ?? null
	);
}

const isVirtual = (path: string) =>
	path.includes("$bunfs") || path.includes("~BUN");

const digestOf = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

function holds(path: string, digest: string): boolean {
	try {
		const stats = lstatSync(path);
		return stats.isFile() && digestOf(readFileSync(path)) === digest;
	} catch {
		return false;
	}
}

/**
 * Copy the fonts embedded in the compiled sidecar into `directory` (a fresh
 * private per-process directory by default), because libass cannot read
 * Bun's virtual file system. Each file is written under a unique temporary
 * name, renamed into place, and checked against the embedded bytes, so a
 * partial or planted file is never handed to FFmpeg. Returns the directory,
 * or null when nothing is embedded (the development tree reads
 * `assets/fonts` directly).
 */
export function materializeEmbeddedFonts(
	embedded: Readonly<Record<string, string>> = EMBEDDED_FONTS,
	directory?: string
): string | null {
	const entries = Object.entries(embedded);
	if (!entries.length) {
		return null;
	}
	const real = entries.every(
		([, path]) => !isVirtual(path) && existsSync(path)
	);
	const first = entries[0]?.[1];
	if (real && first) {
		const parent = dirname(first);
		if (entries.every(([name, path]) => join(parent, name) === path)) {
			return parent;
		}
	}
	const target =
		directory ?? mkdtempSync(join(tmpdir(), "ryu-video-studio-fonts-"));
	assertPrivateDirectory(target);
	for (const [name, source] of entries) {
		const bytes = readFileSync(source);
		const digest = digestOf(bytes);
		const path = join(target, name);
		if (holds(path, digest)) {
			continue;
		}
		const staging = join(target, `.${name}.${process.pid}-${randomUUID()}.tmp`);
		try {
			writeFileSync(staging, bytes, { flag: "wx", mode: 0o600 });
			renameSync(staging, path);
		} finally {
			rmSync(staging, { force: true });
		}
		if (!holds(path, digest)) {
			throw new Error(`The bundled font ${name} could not be written intact.`);
		}
	}
	return target;
}

let bundled: string | null | undefined;

/**
 * Where this process reads the bundled fonts: an override or on-disk
 * `assets/fonts` directory when one exists, otherwise the fonts embedded in
 * the compiled binary, extracted once. Null only when neither is available
 * (exports then use system fonts).
 */
export function bundledFontsDirectory(): string | null {
	if (bundled === undefined) {
		try {
			bundled = resolveFontsDirectory() ?? materializeEmbeddedFonts();
		} catch {
			bundled = null;
		}
	}
	return bundled;
}

/**
 * Escape a path for a filter option value inside a filtergraph: first the
 * option level (`\`, `'`, `:`), then the graph level (`\`, `'`, `[`, `]`,
 * `,`, `;`).
 */
export function escapeFilterPath(path: string): string {
	const option = path.replace(/[\\':]/g, (char) => `\\${char}`);
	return option.replace(/[\\'[\],;]/g, (char) => `\\${char}`);
}

/**
 * The `:fontsdir=…` suffix for the `subtitles` filter, or an empty string
 * when no bundled fonts are found (libass then uses system fonts).
 */
export function subtitlesFontsOption(
	directory: string | null = bundledFontsDirectory()
): string {
	return directory ? `:fontsdir=${escapeFilterPath(directory)}` : "";
}
