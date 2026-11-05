/**
 * Real-FFmpeg proof for imported fonts. A copy of the bundled Lobster TTF
 * is renamed to the family "Ryufont" (a name no installed font has), then
 * imported through the font library. One frame of a title is rendered three
 * ways through `buildRender`:
 *
 * - with the imported "Ryufont" (customFont) and the library's fontsdir;
 * - with the bundled Lobster family;
 * - with the imported font missing from the fontsdir (fallback font).
 *
 * The imported title must match the bundled Lobster frame exactly (same
 * glyphs, found by its own family name) and differ from the fallback.
 *
 * The same three renders then burn a styled caption whose caption style
 * names the imported font (customFont), so captions are proven to use the
 * library too. Finally an installed system family from `fc-list` is burned
 * as a caption (systemFont) with only the bundled fontsdir: it must draw
 * text and differ from a caption naming a family that is not installed.
 *
 * Run: `bun src/verify-imported-fonts.ts`
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFontFile } from "../../shared/font-file.ts";
import { newProject, type Project, type Title } from "../../shared/project.ts";
import type { CaptionStyle } from "../../shared/schema/caption-style.ts";
import { TITLE_FONTS } from "../../shared/text-style.ts";
import { FontLibrary } from "./font-library.ts";
import { renameFontFamily } from "./font-rename.ts";
import { bundledFontsDirectory } from "./fonts.ts";
import { runMedia } from "./media.ts";
import { buildRender } from "./render.ts";
import { assCaptions } from "./render-ass.ts";
import { listSystemFonts } from "./system-fonts.ts";

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const bundled = bundledFontsDirectory();
ensure(bundled, "bundled fonts are missing");
const directory = await mkdtemp(join(tmpdir(), "ryu-verify-fonts-"));
const results: string[] = [];
try {
	const renamed = renameFontFamily(
		await readFile(join(bundled, "Lobster-Regular.ttf")),
		"Lobster",
		"Ryufont"
	);
	const library = new FontLibrary(directory);
	const font = await library.add("Ryufont.ttf", renamed);
	ensure(
		font.family === "Ryufont" && readFontFile(renamed).family === "Ryufont",
		`the imported family reads as ${font.family}`
	);
	results.push(`imported ${font.name} as family ${font.family}`);

	const title = (patch: Partial<Title>): Title => ({
		animation: "fade",
		color: "#ffffff",
		end: 2,
		fadeIn: 0,
		fadeOut: 0,
		fontSize: 0.2,
		fontWeight: 400,
		id: "00000000-0000-4000-8000-000000000001",
		start: 0,
		text: "Grumpy wizards",
		x: 0.5,
		y: 0.5,
		...patch,
	});
	const project = (patch: Partial<Title>): Project => ({
		...newProject("Imported font"),
		height: 240,
		titles: [title(patch)],
		width: 640,
	});
	async function frame(
		edit: Project,
		name: string,
		fontsDirectory: string | null
	): Promise<Buffer> {
		const work = join(directory, name);
		await Bun.write(join(work, "captions.ass"), assCaptions(edit));
		const png = join(work, "frame.png");
		await runMedia(
			[
				...buildRender(edit, [], () => "", "captions.ass", [], 0.5, {
					fontsDirectory,
				}),
				png,
			],
			{ cwd: work }
		);
		const raw = join(work, "frame.rgb");
		await runMedia([
			"-y",
			"-i",
			png,
			"-f",
			"rawvideo",
			"-pix_fmt",
			"rgb24",
			raw,
		]);
		return await readFile(raw);
	}
	const fontsDirectory = await library.renderFontsDirectory([font.id], bundled);
	const imported = await frame(
		project({ customFont: { family: font.family, id: font.id } }),
		"imported",
		fontsDirectory
	);
	const lobster = await frame(
		project({ fontFamily: "lobster" }),
		"bundled",
		bundled
	);
	const fallback = await frame(
		project({ customFont: { family: font.family, id: font.id } }),
		"fallback",
		bundled
	);
	const lit = (pixels: Buffer) => {
		let count = 0;
		for (let index = 0; index < pixels.length; index += 3) {
			if ((pixels[index] ?? 0) > 128) {
				count++;
			}
		}
		return count;
	};
	ensure(lit(imported) > 500, "the imported-font title drew no text");
	ensure(
		imported.equals(lobster),
		"the imported font does not render the same glyphs as the bundled Lobster"
	);
	results.push(
		`the "Ryufont" title renders pixel-identical to bundled Lobster (${lit(imported)} lit pixels)`
	);
	let differing = 0;
	for (let index = 0; index < imported.length; index++) {
		if (imported[index] !== fallback[index]) {
			differing++;
		}
	}
	ensure(
		differing > 500,
		"without the imported font in fontsdir the title still matched (the proof would be vacuous)"
	);
	results.push(
		`without the library fontsdir the same title falls back to another font (${differing} bytes differ)`
	);
	const captioned = (style: CaptionStyle): Project => ({
		...newProject("Imported caption font"),
		captionStyle: { fontSize: 0.12, fontWeight: 400, positionY: 0.8, ...style },
		captions: [
			{
				end: 2,
				id: "00000000-0000-4000-8000-000000000002",
				start: 0,
				text: "Grumpy wizards",
			},
		],
		height: 240,
		// Captions alone give no duration; an identical tiny title supplies it.
		titles: [title({ fontSize: 0.02, text: "." })],
		width: 640,
	});
	const differ = (left: Buffer, right: Buffer) => {
		let count = 0;
		for (let index = 0; index < left.length; index++) {
			if (left[index] !== right[index]) {
				count++;
			}
		}
		return count;
	};
	const customFont = { family: font.family, id: font.id };
	const importedCaption = await frame(
		captioned({ customFont }),
		"caption-imported",
		fontsDirectory
	);
	const lobsterCaption = await frame(
		captioned({ fontFamily: "lobster" }),
		"caption-bundled",
		bundled
	);
	const fallbackCaption = await frame(
		captioned({ customFont }),
		"caption-fallback",
		bundled
	);
	ensure(lit(importedCaption) > 500, "the imported-font caption drew no text");
	ensure(
		importedCaption.equals(lobsterCaption),
		"the imported caption font does not render the same glyphs as bundled Lobster"
	);
	ensure(
		differ(importedCaption, fallbackCaption) > 500,
		"without the imported font in fontsdir the caption still matched"
	);
	results.push(
		`a caption styled with customFont "Ryufont" burns in pixel-identical to bundled Lobster (${lit(importedCaption)} lit pixels) and falls back without the library`
	);

	const system = await listSystemFonts();
	const bundledNames = new Set(
		Object.values(TITLE_FONTS).map((entry) => entry.assName)
	);
	const candidates = system.fonts.filter((family) => !bundledNames.has(family));
	ensure(
		system.available && candidates.length > 0,
		"fc-list listed no installed font families to prove systemFont with"
	);
	const missingSystem = await frame(
		captioned({ systemFont: "Ryu Not Installed Family" }),
		"system-missing",
		bundled
	);
	let proven: string | null = null;
	for (const [index, family] of candidates.slice(0, 12).entries()) {
		const drawn = await frame(
			captioned({ systemFont: family }),
			`system-${index}`,
			bundled
		);
		if (lit(drawn) > 500 && differ(drawn, missingSystem) > 500) {
			proven = `${family} (${lit(drawn)} lit pixels, ${differ(drawn, missingSystem)} bytes differ from an uninstalled family)`;
			break;
		}
	}
	ensure(
		proven,
		"no installed system family rendered differently from the fallback"
	);
	results.push(
		`a caption with systemFont burns in the installed family ${proven}; ${system.fonts.length} families listed`
	);
	for (const line of results) {
		process.stdout.write(`ok - ${line}\n`);
	}
} finally {
	await rm(directory, { force: true, recursive: true });
}
