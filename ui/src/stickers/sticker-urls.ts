import type { StickerEntry } from "../../../shared/stickers/catalog.ts";

/**
 * Bundled sticker SVG URLs keyed by `shared/stickers/assets/` path. Vite resolves the glob at
 * build time (the single-file build inlines each SVG as a data URL); outside
 * Vite (unit tests) the glob is unavailable and the map is empty.
 */
function loadStickerUrls(): Record<string, string> {
	try {
		const modules = import.meta.glob<string>(
			"../../../shared/stickers/assets/*/*.svg",
			{
				eager: true,
				import: "default",
				query: "?url",
			}
		);
		return Object.fromEntries(
			Object.entries(modules).map(([path, url]) => [
				path.replace("../../../shared/stickers/assets/", ""),
				url,
			])
		);
	} catch {
		return {};
	}
}

const stickerUrls = loadStickerUrls();

/** URL of a sticker's SVG artwork, or undefined when it is not bundled. */
export function stickerUrl(
	entry: Pick<StickerEntry, "file">,
	urls: Readonly<Record<string, string>> = stickerUrls
): string | undefined {
	return urls[entry.file];
}
