/**
 * Optional FFmpeg filters and encoders the editor gates features on.
 *
 * Builds differ (distribution packages, static builds, Homebrew), so features
 * that depend on an optional filter or encoder read `GET /capabilities` and
 * disable their controls with a reason instead of failing a render.
 */
import { runMedia } from "./media.ts";

/** Optional filters that gate editor features. */
export const TRACKED_FILTERS = [
	"arnndn",
	"backgroundkey",
	"chromakey",
	"colorkey",
	"deshake",
	"despill",
	"haldclut",
	"hsvkey",
	"lut3d",
	"minterpolate",
	"rubberband",
	"vidstabdetect",
	"vidstabtransform",
	"xfade",
] as const;

/** Optional encoders that gate export formats. */
export const TRACKED_ENCODERS = [
	"aac",
	"libmp3lame",
	"libopus",
	"libvpx-vp9",
	"libx264",
	"libx265",
	"prores_ks",
] as const;

export type TrackedFilter = (typeof TRACKED_FILTERS)[number];
export type TrackedEncoder = (typeof TRACKED_ENCODERS)[number];

export interface FfmpegCapabilities {
	encoders: Record<TrackedEncoder, boolean>;
	filters: Record<TrackedFilter, boolean>;
	/** Whether FFmpeg ran at all. */
	renderer: boolean;
	/** Whether libx265 accepts a 10-bit 4:2:0 pixel format. */
	x265TenBit: boolean;
}

// ` TSC name   V->V   Description` (flag columns vary by FFmpeg release).
const filterLine = /^\s*[A-Z.|]{2,3}\s+([\w-]+)\s+[A-Z|N]*->[A-Z|N]*\s/;
// ` V....D name   Description`; legend lines (` V..... = Video`) never match.
const encoderLine = /^\s*[VASD][A-Z.]{5}\s+([\w-]+)\s/;

function namesFrom(output: string, pattern: RegExp): Set<string> {
	const names = new Set<string>();
	for (const line of output.split("\n")) {
		const name = pattern.exec(line)?.[1];
		if (name) {
			names.add(name);
		}
	}
	return names;
}

/** Filter names listed by `ffmpeg -hide_banner -filters`. */
export function parseFfmpegFilters(output: string): Set<string> {
	return namesFrom(output, filterLine);
}

/** Encoder names listed by `ffmpeg -hide_banner -encoders`. */
export function parseFfmpegEncoders(output: string): Set<string> {
	return namesFrom(output, encoderLine);
}

/** Whether `ffmpeg -h encoder=libx265` lists a 10-bit 4:2:0 format. */
export function parseX265TenBit(help: string): boolean {
	const formats = /Supported pixel formats:([^\n]*)/.exec(help)?.[1] ?? "";
	return formats.split(/\s+/).includes("yuv420p10le");
}

function flags<Name extends string>(
	names: readonly Name[],
	available: ReadonlySet<string>
): Record<Name, boolean> {
	return Object.fromEntries(
		names.map((name) => [name, available.has(name)])
	) as Record<Name, boolean>;
}

/** Capabilities reported when FFmpeg cannot be run. */
export function unavailableCapabilities(): FfmpegCapabilities {
	return {
		encoders: flags(TRACKED_ENCODERS, new Set()),
		filters: flags(TRACKED_FILTERS, new Set()),
		renderer: false,
		x265TenBit: false,
	};
}

/** Pure assembly of capabilities from FFmpeg listing output. */
export function capabilitiesFromOutput(output: {
	encoders: string;
	filters: string;
	x265Help?: string;
}): FfmpegCapabilities {
	const encoders = flags(
		TRACKED_ENCODERS,
		parseFfmpegEncoders(output.encoders)
	);
	return {
		encoders,
		filters: flags(TRACKED_FILTERS, parseFfmpegFilters(output.filters)),
		renderer: true,
		x265TenBit:
			encoders.libx265 && output.x265Help !== undefined
				? parseX265TenBit(output.x265Help)
				: false,
	};
}

export type FfmpegRunner = (args: string[]) => Promise<string>;

const defaultRunner: FfmpegRunner = (args) =>
	runMedia(args, { timeoutMs: 15_000 });

/** Probe FFmpeg once. Rejects when FFmpeg cannot be run. */
export async function probeFfmpegCapabilities(
	run: FfmpegRunner = defaultRunner
): Promise<FfmpegCapabilities> {
	const [filters, encoders] = await Promise.all([
		run(["-hide_banner", "-filters"]),
		run(["-hide_banner", "-encoders"]),
	]);
	const output: { encoders: string; filters: string; x265Help?: string } = {
		encoders,
		filters,
	};
	if (parseFfmpegEncoders(encoders).has("libx265")) {
		output.x265Help = await run(["-hide_banner", "-h", "encoder=libx265"]);
	}
	return capabilitiesFromOutput(output);
}

/**
 * Cache a successful probe for the process lifetime. A failed probe is not
 * cached, so installing FFmpeg later is picked up by the next request.
 */
export function createCapabilityCache(run: FfmpegRunner = defaultRunner) {
	let cached: Promise<FfmpegCapabilities> | undefined;
	return async (): Promise<FfmpegCapabilities> => {
		cached ??= probeFfmpegCapabilities(run).catch((error: unknown) => {
			cached = undefined;
			throw error;
		});
		try {
			return await cached;
		} catch {
			return unavailableCapabilities();
		}
	};
}

/** Process-wide capability probe used by `GET /capabilities`. */
export const ffmpegCapabilities = createCapabilityCache();
