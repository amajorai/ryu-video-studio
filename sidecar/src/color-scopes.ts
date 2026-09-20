import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
	type ColorScopes,
	colorScopesSchema,
} from "../../shared/color-scopes.ts";
import type { Asset } from "../../shared/project.ts";
import { runMedia } from "./media.ts";
import type { StudioStore } from "./store.ts";

function stats(output: string): Record<string, number> {
	const values: Record<string, number> = {};
	for (const line of output.split("\n")) {
		const match = line.match(
			/^lavfi\.signalstats\.([A-Z]+)=(-?\d+(?:\.\d+)?)$/
		);
		if (match) {
			values[match[1]] = Number(match[2]);
		}
	}
	return values;
}

const channel = (value: number | undefined) =>
	Number(Math.max(0, Math.min(1, (value ?? 0) / 255)).toFixed(6));

export async function inspectColorAsset(
	store: StudioStore,
	asset: Asset,
	sampledAt: number
): Promise<ColorScopes> {
	if (asset.kind === "audio") {
		throw new Error("Color scopes require an image or video asset.");
	}
	// Bun's test runner and some embedded Bun hosts do not expose stdout from
	// child processes reliably. Keep the FFmpeg metadata on a private file in
	// the store and read it through Bun, just like the probe path does.
	const metadataFile = `.ryu-scopes-${crypto.randomUUID()}.log`;
	const metadataPath = join(store.directory, metadataFile);
	try {
		const output = await runMedia(
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostdin",
				"-ss",
				String(Math.min(sampledAt, asset.duration)),
				"-i",
				store.mediaPath(asset.id),
				"-vf",
				`signalstats,metadata=print:file=${metadataFile}`,
				"-frames:v",
				"1",
				"-f",
				"null",
				"-",
			],
			{ cwd: store.directory }
		);
		const metadata = await Bun.file(metadataPath).text();
		const values = stats(metadata || output);
		return colorScopesSchema.parse({
			assetId: asset.id,
			chroma: { u: channel(values.UAVG), v: channel(values.VAVG) },
			clipping: {
				black: (values.YMIN ?? 255) <= 16,
				white: (values.YMAX ?? 0) >= 235,
			},
			hueDegrees: Number(
				Math.max(0, Math.min(360, values.HUEAVG ?? 0)).toFixed(3)
			),
			luma: {
				average: channel(values.YAVG),
				max: channel(values.YMAX),
				min: channel(values.YMIN),
			},
			sampledAt: Math.min(sampledAt, asset.duration),
			saturation: {
				average: channel(values.SATAVG),
				max: channel(values.SATMAX),
				min: channel(values.SATMIN),
			},
		});
	} finally {
		await rm(metadataPath, { force: true });
	}
}
