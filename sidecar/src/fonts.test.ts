import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_FONT_FILES } from "../../shared/text-style.ts";
import { EMBEDDED_FONTS } from "./bundled-fonts.ts";
import {
	bundledFontsDirectory,
	escapeFilterPath,
	fontDirectoryCandidates,
	hasBundledFonts,
	materializeEmbeddedFonts,
	resolveFontsDirectory,
	subtitlesFontsOption,
} from "./fonts.ts";

describe("bundled fonts", () => {
	test("candidates: env override, source assets, then next to the executable", () => {
		expect(
			fontDirectoryCandidates(
				{ RYU_VIDEO_STUDIO_FONTS_DIR: "/custom" },
				"/opt/app/ryu-video-studio",
				"/repo/sidecar/src"
			)
		).toEqual([
			"/custom",
			"/repo/sidecar/assets/fonts",
			"/opt/app/assets/fonts",
		]);
		expect(fontDirectoryCandidates({}, "/bin/x", "/m")).toHaveLength(2);
	});

	test("the source checkout resolves to the bundled directory", () => {
		const directory = resolveFontsDirectory();
		expect(directory).toBe(join(import.meta.dir, "..", "assets", "fonts"));
		expect(directory && hasBundledFonts(directory)).toBe(true);
	});

	test("directories without fonts are skipped", () => {
		const present = new Set([join("/b", BUNDLED_FONT_FILES[0] ?? "")]);
		expect(
			resolveFontsDirectory(["/a", "/b"], (path) => present.has(path))
		).toBe("/b");
		expect(resolveFontsDirectory(["/a"], () => false)).toBeNull();
	});

	test("the subtitles option escapes filtergraph characters", () => {
		expect(escapeFilterPath("/plain/dir")).toBe("/plain/dir");
		expect(escapeFilterPath("C:/a,b'c")).toBe("C\\\\:/a\\,b\\\\\\'c");
		expect(subtitlesFontsOption(null)).toBe("");
		expect(subtitlesFontsOption("/fonts")).toBe(":fontsdir=/fonts");
	});
});

describe("embedded fonts", () => {
	test("every bundled font file is embedded in the compiled sidecar", () => {
		expect(Object.keys(EMBEDDED_FONTS).sort()).toEqual(
			[...BUNDLED_FONT_FILES].sort()
		);
	});

	test("in the source tree the embedded paths are the assets directory", () => {
		expect(materializeEmbeddedFonts()).toBe(
			join(import.meta.dir, "..", "assets", "fonts")
		);
		expect(bundledFontsDirectory()).not.toBeNull();
	});

	test("files outside one directory are copied out intact and reused", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "ryu-fonts-test-"));
		try {
			const source = join(scratch, "elsewhere-inter.bin");
			const bytes = await Bun.file(
				join(import.meta.dir, "..", "assets", "fonts", "Inter-Regular.ttf")
			).bytes();
			await Bun.write(source, bytes);
			const target = join(scratch, "out");
			await mkdir(target, { mode: 0o700 });
			expect(
				materializeEmbeddedFonts({ "Inter-Regular.ttf": source }, target)
			).toBe(target);
			const copied = await Bun.file(join(target, "Inter-Regular.ttf")).bytes();
			expect(Buffer.from(copied).equals(Buffer.from(bytes))).toBe(true);
			// A tampered copy is replaced with the embedded bytes.
			await Bun.write(join(target, "Inter-Regular.ttf"), "planted");
			materializeEmbeddedFonts({ "Inter-Regular.ttf": source }, target);
			expect(
				(await Bun.file(join(target, "Inter-Regular.ttf")).bytes()).length
			).toBe(bytes.length);
		} finally {
			await rm(scratch, { force: true, recursive: true });
		}
	});
});
