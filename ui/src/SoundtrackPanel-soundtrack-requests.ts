import { z } from "zod";
import type { Asset, Project } from "../../shared/project.ts";
import { assetSchema, newSegment } from "../../shared/project.ts";
import {
	type SoundtrackLayer,
	type SoundtrackMood,
	type SoundtrackSection,
	soundtrackJobSchema,
	soundtrackLayerSchema,
	soundtrackLayersOf,
} from "../../shared/soundtrack.ts";
import {
	clipSoundtrackSections,
	type SoundtrackRange,
} from "../../shared/soundtrack-plan.ts";
import { firstFreeTrack } from "../../shared/track-placement.ts";
import { request } from "./bridge.ts";

/** A readable status line; schema errors never reach the user as raw JSON. */
export function errorMessage(error: unknown, fallback: string): string {
	if (error instanceof z.ZodError) {
		return fallback;
	}
	return error instanceof Error && error.message ? error.message : fallback;
}

const JOB_POLL_MS = 2000;
const soundtrackResponseSchema = z.union([
	z.object({ job: soundtrackJobSchema }).strict(),
	assetSchema,
]);

/**
 * Create a soundtrack: an inline 201 asset, or a background job (202) that
 * is polled until it finishes.
 */
export async function createSoundtrack(
	body: ReturnType<typeof soundtrackBody>,
	options: {
		onBackground?: () => void;
		wait?: (milliseconds: number) => Promise<void>;
	} = {}
): Promise<Asset> {
	const wait =
		options.wait ??
		((milliseconds: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
	const result = await request(
		soundtrackResponseSchema,
		"/soundtrack",
		"POST",
		body
	);
	if (!("job" in result)) {
		return result;
	}
	options.onBackground?.();
	let job = result.job;
	while (job.status === "running") {
		await wait(JOB_POLL_MS);
		job = await request(
			soundtrackJobSchema,
			`/soundtrack-jobs?id=${encodeURIComponent(job.id)}`
		);
	}
	if (job.status === "failed") {
		throw new Error(job.error?.message ?? "Soundtrack generation failed.");
	}
	return assetSchema.parse(job.asset);
}

export const formatSeconds = (value: number) => `${value.toFixed(1)} s`;

/**
 * Place a scored soundtrack at `range.start` on the first audio-compatible
 * track that is free for the whole range (audio tracks start at 1).
 */
export function placeAtRange(
	project: Project,
	assets: readonly Asset[],
	asset: Asset,
	range: SoundtrackRange
): Project {
	const end = range.start + asset.duration;
	const track = firstFreeTrack(project, range.start, end, {
		assets: [...assets, asset],
		from: 1,
		kind: "audio",
	});
	if (track === undefined) {
		throw new Error("No free audio track covers the marked range.");
	}
	return {
		...project,
		segments: [...project.segments, newSegment(asset, range.start, track)],
	};
}

/** The `POST /soundtrack` body for the panel's current settings. */
export function soundtrackBody(settings: {
	bpm: number;
	downbeatOffset?: number;
	duration: number;
	layers?: SoundtrackLayer[];
	mood: SoundtrackMood;
	sections: SoundtrackSection[];
}) {
	const sections = clipSoundtrackSections(settings.sections, settings.duration);
	return {
		bpm: settings.bpm,
		...(settings.downbeatOffset === undefined
			? {}
			: { downbeatOffset: settings.downbeatOffset }),
		duration: settings.duration,
		mood: settings.mood,
		...(settings.layers ? { layers: settings.layers } : {}),
		...(sections.length ? { sections } : {}),
	};
}

/** Toggle one layer, starting from the style's default band. */
export function toggleLayer(
	mood: SoundtrackMood,
	layers: SoundtrackLayer[] | undefined,
	layer: SoundtrackLayer,
	enabled: boolean
): SoundtrackLayer[] | undefined {
	const current = new Set(soundtrackLayersOf({ layers, mood }));
	if (enabled) {
		current.add(layer);
	} else {
		current.delete(layer);
	}
	const next = soundtrackLayerSchema.options.filter((item) =>
		current.has(item)
	);
	// The sidecar needs at least one layer; keep the last one playing.
	return next.length ? next : layers;
}
