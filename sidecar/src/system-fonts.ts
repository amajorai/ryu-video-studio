/**
 * Installed system font families, listed with fontconfig's `fc-list`. The
 * same fontconfig provider is what libass searches when a title or caption
 * names a `systemFont`, so every listed family can render. Nodes without
 * `fc-list` (some macOS builds) report `available: false`.
 */
import { fontFamilyNameSchema } from "../../shared/schema/font.ts";

/** At most this many families are listed. */
export const MAX_SYSTEM_FONTS = 2000;
const CACHE_MS = 60_000;
const TIMEOUT_MS = 10_000;

export interface SystemFontList {
	/** Whether `fc-list` ran on this node. */
	available: boolean;
	/** Family names, sorted and de-duplicated. */
	fonts: string[];
}

/**
 * Family names from `fc-list : family` output. Each line lists one face's
 * families separated by commas (the primary name first, then style or
 * localized aliases); only the primary name is kept. Names unsafe for an ASS
 * style line or a CSS family are dropped.
 */
export function parseFcListFamilies(output: string): string[] {
	const families = new Set<string>();
	for (const line of output.split("\n")) {
		const primary = line.split(",")[0]?.replaceAll("\\-", "-").trim() ?? "";
		const parsed = fontFamilyNameSchema.safeParse(primary);
		if (parsed.success && !parsed.data.startsWith(".")) {
			families.add(parsed.data);
		}
	}
	return [...families]
		.sort((left, right) =>
			left.localeCompare(right, "en", { sensitivity: "base" })
		)
		.slice(0, MAX_SYSTEM_FONTS);
}

const fcListBinary = () => process.env.RYU_VIDEO_STUDIO_FC_LIST || "fc-list";

async function readFcList(): Promise<SystemFontList> {
	try {
		const child = Bun.spawn([fcListBinary(), ":", "family"], {
			stderr: "ignore",
			stdin: "ignore",
			stdout: "pipe",
		});
		const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
		const [output, code] = await Promise.all([
			new Response(child.stdout).text(),
			child.exited,
		]);
		clearTimeout(timer);
		return code === 0
			? { available: true, fonts: parseFcListFamilies(output) }
			: { available: false, fonts: [] };
	} catch {
		return { available: false, fonts: [] };
	}
}

let cached: { at: number; list: Promise<SystemFontList> } | null = null;

/** The installed families, cached for a minute. */
export function listSystemFonts(now = Date.now()): Promise<SystemFontList> {
	if (!cached || now - cached.at > CACHE_MS) {
		cached = { at: now, list: readFcList() };
	}
	return cached.list;
}

/** Forget the cached list (tests). */
export function resetSystemFonts() {
	cached = null;
}
