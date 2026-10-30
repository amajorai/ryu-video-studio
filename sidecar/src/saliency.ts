/**
 * Subject tracking for auto reframe (W4-AI1).
 *
 * One FFmpeg pass per clip decodes its visible source range at
 * `REFRAME_SAMPLE_FPS` (lower for long clips) into 8-bit luma frames
 * `REFRAME_FRAME_WIDTH` pixels wide; `saliencyPath` (shared, pure) turns them
 * into per-frame subject positions. Shots come from the source's completed
 * scene analysis when there is one, otherwise from frame differences. The
 * original media is always read (never a preview proxy).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Asset, Segment } from "../../shared/project.ts";
import {
	detectCutIndices,
	type LumaFrame,
	REFRAME_FRAME_WIDTH,
	REFRAME_MAX_SAMPLES,
	REFRAME_SAMPLE_FPS,
	type SubjectTrack,
	saliencyPath,
} from "../../shared/reframe.ts";
import { MEDIA_FORMATS, runMedia } from "./media.ts";
import { type MediaOperation, withMediaOperation } from "./media-operation.ts";
import type { StudioStore } from "./store.ts";

const OPERATION_TIMEOUT_MS = 10 * 60_000;
/** Total source seconds one reframe request may decode across its clips. */
const MAX_DECODE_SECONDS = 7200;

/** Luma frame size for a source: `REFRAME_FRAME_WIDTH` wide, even height. */
export function trackingFrameSize(asset: Pick<Asset, "height" | "width">): {
	height: number;
	width: number;
} {
	const width = REFRAME_FRAME_WIDTH;
	const height = Math.max(
		2,
		Math.min(
			REFRAME_FRAME_WIDTH * 10,
			Math.round((width * asset.height) / Math.max(1, asset.width) / 2) * 2
		)
	);
	return { height, width };
}

/** Sampling rate for a clip: 4 fps, or fewer so it stays within the sample cap. */
export function trackingSampleRate(sourceSeconds: number): number {
	if (!(sourceSeconds > 0)) {
		return REFRAME_SAMPLE_FPS;
	}
	return Math.min(
		REFRAME_SAMPLE_FPS,
		Number((REFRAME_MAX_SAMPLES / sourceSeconds).toFixed(6))
	);
}

/** Split a packed gray8 buffer into frames. */
export function splitLumaFrames(
	bytes: Uint8Array,
	size: { height: number; width: number }
): LumaFrame[] {
	const frameBytes = size.width * size.height;
	const frames: LumaFrame[] = [];
	for (
		let offset = 0;
		offset + frameBytes <= bytes.length;
		offset += frameBytes
	) {
		frames.push({
			data: bytes.subarray(offset, offset + frameBytes),
			height: size.height,
			width: size.width,
		});
	}
	return frames;
}

/** Decode a clip's visible source range to luma frames. */
async function decodeClipFrames(
	store: StudioStore,
	asset: Asset,
	segment: Segment,
	sampleRate: number,
	operation: MediaOperation
): Promise<LumaFrame[]> {
	const size = trackingFrameSize(asset);
	const still = asset.kind === "image";
	const seconds = Math.max(0, segment.sourceOut - segment.sourceIn);
	const expected = still ? 1 : Math.ceil(seconds * sampleRate) + 2;
	const directory = mkdtempSync(join(store.directory, "reframe-"));
	try {
		const output = join(directory, "frames.gray");
		const scale = `scale=${size.width}:${size.height}:flags=area,format=gray`;
		await runMedia(
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostdin",
				"-y",
				"-protocol_whitelist",
				"file,pipe",
				"-format_whitelist",
				MEDIA_FORMATS,
				...(still ? [] : ["-ss", segment.sourceIn.toFixed(6)]),
				"-i",
				store.mediaPath(asset.id),
				...(still ? ["-frames:v", "1"] : ["-t", seconds.toFixed(6)]),
				"-map",
				"0:v:0",
				"-an",
				"-sn",
				"-dn",
				"-vf",
				still ? scale : `fps=${sampleRate},${scale}`,
				"-f",
				"rawvideo",
				output,
			],
			{
				maxOutputBytes: expected * size.width * size.height + 65_536,
				outputPath: output,
				signal: operation.signal,
				timeoutMs: operation.remainingMs(),
			}
		);
		const bytes = new Uint8Array(await Bun.file(output).arrayBuffer());
		return splitLumaFrames(bytes, size).slice(0, expected);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
}

/**
 * Shot starts as sample indices (the first sample at or after each cut):
 * the source's analysed scene cuts inside the clip's range, with their
 * exact times in source seconds from `sourceIn`, or cuts detected from the
 * frames themselves (no exact times).
 */
export function clipShotCuts(
	frames: readonly LumaFrame[],
	segment: Pick<Segment, "sourceIn" | "sourceOut">,
	sampleRate: number,
	sceneCuts: readonly number[] | undefined
): Pick<SubjectTrack, "cutTimes" | "cuts"> {
	if (!sceneCuts) {
		return { cuts: detectCutIndices(frames) };
	}
	// Index -> latest cut time before that sample (two cuts between samples
	// leave only the later shot sampled).
	const byIndex = new Map<number, number>();
	for (const cut of sceneCuts) {
		if (!(cut > segment.sourceIn && cut < segment.sourceOut)) {
			continue;
		}
		const offset = cut - segment.sourceIn;
		// Tolerate float noise so a cut exactly on a sample keeps that sample.
		const index = Math.ceil(offset * sampleRate - 1e-6);
		if (index <= 0 || index >= frames.length) {
			continue;
		}
		byIndex.set(index, Math.max(byIndex.get(index) ?? 0, offset));
	}
	const cuts = [...byIndex.keys()].sort((a, b) => a - b);
	return {
		cutTimes: cuts.map((index) => Number((byIndex.get(index) ?? 0).toFixed(6))),
		cuts,
	};
}

/** Measure the subject track of one clip. */
export async function trackClipSubject(
	store: StudioStore,
	asset: Asset,
	segment: Segment,
	operation: MediaOperation
): Promise<SubjectTrack> {
	const seconds = Math.max(0, segment.sourceOut - segment.sourceIn);
	const sampleRate = trackingSampleRate(seconds);
	const frames = await decodeClipFrames(
		store,
		asset,
		segment,
		sampleRate,
		operation
	);
	operation.check();
	const analysis = store.analysis(asset.id);
	const sceneCuts =
		analysis?.status === "completed" ? analysis.sceneCuts : undefined;
	const shots: Pick<SubjectTrack, "cutTimes" | "cuts"> =
		asset.kind === "image"
			? { cuts: [] }
			: clipShotCuts(frames, segment, sampleRate, sceneCuts);
	return {
		...shots,
		points: saliencyPath(frames, shots.cuts),
		sampleRate,
	};
}

/**
 * Subject tracks for every clip in `segments`, under one media admission.
 * Clips beyond the total decode budget get no track (the reframe falls back
 * to a centred crop for them and says so).
 */
export async function trackSubjects(
	store: StudioStore,
	segments: readonly Segment[],
	signal?: AbortSignal
): Promise<Map<string, SubjectTrack>> {
	const assets = new Map(store.assets().map((asset) => [asset.id, asset]));
	return await withMediaOperation(
		OPERATION_TIMEOUT_MS,
		{ signal },
		async (operation) => {
			const tracks = new Map<string, SubjectTrack>();
			let budget = MAX_DECODE_SECONDS;
			for (const segment of segments) {
				const asset = assets.get(segment.assetId);
				if (!asset || asset.kind === "audio") {
					continue;
				}
				const seconds =
					asset.kind === "image" ? 0 : segment.sourceOut - segment.sourceIn;
				if (seconds > budget) {
					continue;
				}
				budget -= seconds;
				tracks.set(
					segment.id,
					await trackClipSubject(store, asset, segment, operation)
				);
			}
			return tracks;
		}
	);
}
