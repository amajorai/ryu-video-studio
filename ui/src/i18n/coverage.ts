/**
 * Which UI copy the catalog must cover, and how the catalog test finds it.
 * The test reads every non-test `.ts`/`.tsx` file under the covered paths,
 * extracts static English copy with `extractUiLiterals`, and fails when one
 * is missing from `STUDIO_MESSAGES` (or one of its translations is empty).
 * Test-only: nothing in the app imports this module.
 */

/**
 * Paths relative to `ui/src` whose static copy must be catalogued: the whole
 * UI, so every feature panel (Generate, Soundtrack, Multicam, Search, …) and
 * every editor action's status line is localized, and a new panel is covered
 * the moment it lands.
 */
export const COVERED_SOURCES: readonly string[] = ["."];

/** Covered files that hold no UI copy (key names, test fixtures). */
export const EXCLUDED_SOURCES: readonly string[] = [
	"preview/__fixtures__",
	"shortcuts/keys.ts",
	// Lottie player event names and the stored default asset name.
	"import/lottie-import.ts",
];

/** Keyboard key and code names, compared against events, never shown as prose. */
const KEY_NAME =
	/^(?:Key[A-Z]|Digit[0-9]|Arrow(?:Up|Down|Left|Right)|Mod\+.+|Backspace|Control|Ctrl|Delete|End|Enter|Esc|Escape|Home|Meta|PageDown|PageUp|Shift|Space|Tab)$/;

/**
 * Copy the extractor finds that is not language: units, codecs, file
 * extensions, font and service names, and sample values shown verbatim.
 */
export const UNTRANSLATED_LITERALS: ReadonlySet<string> = new Set([
	"AAC",
	"AI",
	"AV1",
	"Alt",
	"H.264 · MP4",
	"H.265 (HEVC)",
	"H.265 10-bit",
	"H.265 10-bit · HEVC",
	"H.265 · HEVC",
	"HSL",
	"ProRes 422 HQ",
	"ProRes 422 · MOV",
	"ProRes 4444",
	"ProRes 4444 · MOV",
	"VP9 · WebM",
	"Video Studio",
	"WebVTT",
	"dB",
	"https://example.com/footage.mp4",
	"rye you",
	"Anton",
	"Archive.org",
	"Bebas Neue",
	"Inter",
	"Lobster",
	"Merriweather",
	"Montserrat",
	"NASA Images and Video",
	"Oswald",
	"Permanent Marker",
	"Playfair Display",
	"Poppins",
	"Roboto",
	"Source Code Pro",
	"Wikimedia Commons",
	"FFmpeg",
	"GIF",
	"H.264",
	"H.265",
	"HEVC",
	"LUT",
	"MP3",
	"MP4",
	"MOV",
	"PNG",
	"ProRes",
	"RGB",
	"Ryu",
	"SRT",
	"VP9",
	"VTT",
	"WAV",
	"WebM",
	"Pexels",
	"Pixabay",
	// Provider and platform names, and the model-id placeholder.
	"fal",
	"provider/model",
	"Instagram",
	"LinkedIn",
	"TikTok",
	"YouTube",
	"https://example.com/article",
	// Autosave state keys, compared in code and never rendered as copy.
	"conflict",
	"error",
	"saved",
	"saving",
	"unsaved",
	// Stored as the Space description, so it stays stable across languages.
	"Video Studio source transcript index",
]);

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

const hasWords = (text: string) => /[A-Za-z]{2}/.test(text);

/** Static copy rendered by a source file (whitespace collapsed like JSX). */
export function extractUiLiterals(source: string): string[] {
	const found = new Set<string>();
	const add = (raw: string | undefined) => {
		if (raw === undefined) {
			return;
		}
		const text = collapse(raw);
		if (
			text.length > 0 &&
			text.length <= 200 &&
			hasWords(text) &&
			!KEY_NAME.test(text) &&
			!UNTRANSLATED_LITERALS.has(text)
		) {
			found.add(text);
		}
	};
	// JSX attributes that render text or are read by assistive technology.
	for (const match of source.matchAll(
		/\b(?:aria-label|description|label|placeholder|title)=\{?"([^"{}\n]+)"/g
	)) {
		add(match[1]);
	}
	// Copy fields in menu, panel, and shortcut tables.
	for (const match of source.matchAll(
		/\b(?:description|disabledReason|label|title)\s*:\s*"([^"\n]+)"/g
	)) {
		add(match[1]);
	}
	// Copy values in label tables and option lists ({ key: "Copy" }).
	for (const match of source.matchAll(
		/(?:^|[{,\s])[\w$]+\??\s*:\s*"([A-Z][^"\n]*[a-z][^"\n]*)"/gm
	)) {
		add(match[1]);
	}
	// Status messages shown in the status line.
	for (const match of source.matchAll(/\bsetStatus\(\s*"([^"\n]+)"\s*\)/g)) {
		add(match[1]);
	}
	// Conditional copy (`locked && "Unlock…"`, `ready ? "Play" : "Pause"`).
	for (const match of source.matchAll(
		/(?:&&|\?|:|\|\|)\s*"([A-Z][^"\n]*[a-z][^"\n]*[^\s"])"/g
	)) {
		add(match[1]);
	}
	// Menu items built positionally: actionItem(context, "id", "Label", …).
	for (const match of source.matchAll(
		/\b(?:actionItem|commandItem)\(\s*(?:context,\s*)?"[^"]+",\s*"([^"\n]+)"/g
	)) {
		add(match[1]);
	}
	// Module-level copy constants (const LOCKED = "Unlock…").
	for (const match of source.matchAll(
		/\bconst [A-Z][A-Z0-9_]* = "([A-Z][^"\n]*[a-z][^"\n]*)"/g
	)) {
		add(match[1]);
	}
	// JSX text between tags (one whole text node, no expressions).
	for (const match of source.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)<\//g)) {
		const text = match[1] ?? "";
		if (!/[=;&|]|=>|\bconst\b|\breturn\b/.test(text)) {
			add(text);
		}
	}
	return [...found];
}
