/**
 * Test support: what the FFmpeg on this machine was built with. Package
 * builds differ (Homebrew's ffmpeg has neither libass nor librsvg, the
 * Chocolatey "essentials" build has no librsvg), so tests that need an
 * optional filter or decoder check it here. Each answer is `true` only when
 * FFmpeg runs and does not list the component, so a missing FFmpeg still
 * fails the tests that need it.
 */
import { spawnSync } from "node:child_process";
import { parseFfmpegFilters } from "./ffmpeg-capabilities.ts";
import { mediaBinary } from "./media.ts";

const listings = new Map<string, string | null>();

function listing(kind: "-decoders" | "-filters"): string | null {
	let output = listings.get(kind);
	if (output === undefined) {
		const result = spawnSync(mediaBinary("ffmpeg"), ["-hide_banner", kind], {
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
			timeout: 15_000,
		});
		output = result.status === 0 && result.stdout ? result.stdout : null;
		listings.set(kind, output);
	}
	return output;
}

/** Whether this FFmpeg runs but has no `name` filter. */
export function ffmpegLacksFilter(name: string): boolean {
	const output = listing("-filters");
	return output !== null && !parseFfmpegFilters(output).has(name);
}

// ` V....D librsvg   Librsvg rasterizer` (same columns as `-encoders`).
const decoderLine = /^\s*[VASD][A-Z.]{5}\s+([\w-]+)\s/;

/** Whether this FFmpeg runs but has no `name` decoder. */
export function ffmpegLacksDecoder(name: string): boolean {
	const output = listing("-decoders");
	return (
		output !== null &&
		!output.split("\n").some((line) => decoderLine.exec(line)?.[1] === name)
	);
}
