import { spawnSync } from "node:child_process";
import {
	KEY_FILTERS,
	type KeyFilter,
	type KeyFilterAvailability,
	keyFilterPlan,
} from "../../../shared/keying.ts";
import type { Segment } from "../../../shared/project.ts";
import { parseFfmpegFilters } from "../ffmpeg-capabilities.ts";
import { mediaBinary } from "../media.ts";

/**
 * Chroma, color, HSV and luma keying plus spill suppression (W2-V4). The
 * filter strings and capability fallbacks live in `shared/keying.ts`; this
 * stage only supplies which optional filters this FFmpeg build has.
 *
 * Clips without `key` add no filters, so legacy renders stay byte-identical
 * and never probe FFmpeg.
 */

let override: KeyFilterAvailability | undefined;
let probed: KeyFilterAvailability | undefined;

/**
 * Replace the probed filter availability (tests, or a caller that already
 * holds `GET /capabilities`). `undefined` restores probing.
 */
export function setKeyFilterAvailability(
	filters: KeyFilterAvailability | undefined
) {
	override = filters;
}

/**
 * One synchronous `ffmpeg -filters` listing per process, made the first time
 * a keyed clip renders. When FFmpeg cannot be listed every filter counts as
 * available, so the render itself reports the real failure.
 */
function probeKeyFilters(): KeyFilterAvailability {
	try {
		const result = spawnSync(
			mediaBinary("ffmpeg"),
			["-hide_banner", "-filters"],
			{
				encoding: "utf8",
				maxBuffer: 4 * 1024 * 1024,
				timeout: 15_000,
			}
		);
		if (result.status !== 0 || !result.stdout) {
			return {};
		}
		const names = parseFfmpegFilters(result.stdout);
		const availability: Partial<Record<KeyFilter, boolean>> = {};
		for (const name of KEY_FILTERS) {
			availability[name] = names.has(name);
		}
		return availability;
	} catch {
		return {};
	}
}

export function keyFilterAvailability(): KeyFilterAvailability {
	if (override) {
		return override;
	}
	probed ??= probeKeyFilters();
	return probed;
}

export function keyFilters(segment: Segment): string[] {
	if (!segment.key) {
		return [];
	}
	// A hue key branches (split → two hsvkey → lut2); its labels must be
	// unique in the render graph, so they carry the segment id.
	return keyFilterPlan(
		segment.key,
		keyFilterAvailability(),
		`key${segment.id.replaceAll("-", "")}`
	).filters;
}
