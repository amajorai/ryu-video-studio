import type { z } from "zod";

/** Every per-viewer key is namespaced so artifacts sharing an origin never collide. */
export const VIEWER_STORAGE_PREFIX = "ryu.video-studio.";

/** Minimal Storage surface, so tests can pass a fake or a throwing store. */
export type ViewerStorageArea = Pick<
	Storage,
	"getItem" | "removeItem" | "setItem"
>;

function defaultArea(): ViewerStorageArea | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		// Accessing localStorage throws when site data is blocked.
		return null;
	}
}

/**
 * Read a per-viewer preference. Missing, unreadable, unparsable, or
 * schema-invalid values all return `fallback`: these are conveniences, never
 * state the editor depends on.
 */
export function readViewerValue<Schema extends z.ZodType>(
	key: string,
	schema: Schema,
	fallback: z.output<Schema>,
	area: ViewerStorageArea | null = defaultArea()
): z.output<Schema> {
	try {
		const raw = area?.getItem(VIEWER_STORAGE_PREFIX + key);
		if (raw === null || raw === undefined) {
			return fallback;
		}
		const parsed = schema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : fallback;
	} catch {
		return fallback;
	}
}

/** Store a per-viewer preference; returns false when storage is unavailable. */
export function writeViewerValue(
	key: string,
	value: unknown,
	area: ViewerStorageArea | null = defaultArea()
): boolean {
	try {
		if (!area) {
			return false;
		}
		area.setItem(VIEWER_STORAGE_PREFIX + key, JSON.stringify(value));
		return true;
	} catch {
		return false;
	}
}

/** Forget a per-viewer preference; returns false when storage is unavailable. */
export function removeViewerValue(
	key: string,
	area: ViewerStorageArea | null = defaultArea()
): boolean {
	try {
		if (!area) {
			return false;
		}
		area.removeItem(VIEWER_STORAGE_PREFIX + key);
		return true;
	} catch {
		return false;
	}
}
