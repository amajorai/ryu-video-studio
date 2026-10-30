/**
 * Library references inside a project that are not media assets: imported
 * `.cube` LUTs (any `lutId` string property) and imported fonts (any `customFont: { id }`
 * on a title or caption style). Both walk the whole value instead of listing fields,
 * so a new place that refers to a LUT or font is never missed by the delete
 * guards or by self-contained project archives.
 */

/** Every LUT id referenced by a `lutId` string property anywhere in `value`. */
export function lutIdsIn(
	value: unknown,
	found = new Set<string>()
): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) {
			lutIdsIn(item, found);
		}
		return found;
	}
	if (value && typeof value === "object") {
		for (const [key, entry] of Object.entries(value)) {
			if (key === "lutId" && typeof entry === "string") {
				found.add(entry);
			} else {
				lutIdsIn(entry, found);
			}
		}
	}
	return found;
}

/** Every imported font id referenced by a `customFont` anywhere in `value`. */
export function customFontIdsIn(
	value: unknown,
	found = new Set<string>()
): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) {
			customFontIdsIn(item, found);
		}
		return found;
	}
	if (value && typeof value === "object") {
		for (const [key, entry] of Object.entries(value)) {
			if (
				key === "customFont" &&
				entry &&
				typeof entry === "object" &&
				"id" in entry &&
				typeof entry.id === "string"
			) {
				found.add(entry.id);
			} else {
				customFontIdsIn(entry, found);
			}
		}
	}
	return found;
}
