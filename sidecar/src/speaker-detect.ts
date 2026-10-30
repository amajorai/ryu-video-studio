import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Asset, Project } from "../../shared/project.ts";
import {
	applySpeakerLabels,
	clusterCountOf,
	clusterSpeakers,
	labelsFromSources,
	micDominance,
	rmsOf,
	SPEAKER_SAMPLE_RATE,
	SPEECH_RMS_FLOOR,
	type SpeakerAssignment,
	type SpeakerCandidate,
	type SpeakerDetectRequest,
	segmentLabelsFromSources,
	speakerCandidates,
	speakerWindows,
	voiceFeatures,
} from "../../shared/speakers.ts";
import { MEDIA_FORMATS, runMedia } from "./media.ts";
import { type MediaOperation, withMediaOperation } from "./media-operation.ts";
import type { StudioStore } from "./store.ts";

/** Longest single decode; longer spans are split. */
const MAX_RANGE_SECONDS = 300;
/** Gaps up to this long are decoded through rather than seeking again. */
const MERGE_GAP_SECONDS = 2;
/** Total source audio one detection may decode. */
const MAX_DECODE_SECONDS = 7200;
const OPERATION_TIMEOUT_MS = 10 * 60_000;
const BYTES_PER_SECOND = SPEAKER_SAMPLE_RATE * 2;

/** Mono PCM at `SPEAKER_SAMPLE_RATE` for `[start, start + duration)` of a source. */
export type DecodeAudio = (
	asset: Asset,
	start: number,
	duration: number
) => Promise<Float32Array>;

export interface SpeakerDetectResult extends SpeakerAssignment {
	mode: SpeakerDetectRequest["mode"];
	/** Words (or word-less captions) considered. */
	windows: number;
}

interface Task {
	candidate: SpeakerCandidate;
	slot: number;
	window: number;
}

interface DecodeRange {
	assetId: string;
	end: number;
	start: number;
	tasks: Task[];
}

/** Group source spans per asset into bounded, merged decode ranges. */
export function planDecodeRanges(tasks: readonly Task[]): DecodeRange[] {
	const byAsset = new Map<string, Task[]>();
	for (const task of tasks) {
		const list = byAsset.get(task.candidate.assetId) ?? [];
		list.push(task);
		byAsset.set(task.candidate.assetId, list);
	}
	const ranges: DecodeRange[] = [];
	for (const [assetId, list] of [...byAsset].sort(([a], [b]) =>
		a.localeCompare(b)
	)) {
		list.sort((a, b) => a.candidate.sourceStart - b.candidate.sourceStart);
		let current: DecodeRange | undefined;
		for (const task of list) {
			const { sourceEnd, sourceStart } = task.candidate;
			if (
				current &&
				sourceStart <= current.end + MERGE_GAP_SECONDS &&
				Math.max(current.end, sourceEnd) - current.start <= MAX_RANGE_SECONDS
			) {
				current.end = Math.max(current.end, sourceEnd);
				current.tasks.push(task);
				continue;
			}
			current = { assetId, end: sourceEnd, start: sourceStart, tasks: [task] };
			ranges.push(current);
		}
	}
	return ranges;
}

/**
 * Label active caption words with speakers using `decode` for audio.
 * Deterministic for a given project, assets and decoded audio.
 */
export async function detectSpeakersWith(
	project: Project,
	assets: readonly Asset[],
	request: SpeakerDetectRequest,
	decode: DecodeAudio,
	mintId?: () => string,
	check: () => void = () => undefined
): Promise<SpeakerDetectResult> {
	const windows = speakerWindows(project);
	if (windows.length === 0) {
		throw new Error(
			"Add timed captions (transcribe the dialogue) before detecting speakers."
		);
	}
	const candidates = windows.map((window) =>
		speakerCandidates(project, assets, window)
	);
	const sources = new Map<string, string>();
	for (const list of candidates) {
		for (const candidate of list) {
			sources.set(candidate.sourceKey, candidate.label);
		}
	}
	if (sources.size === 0) {
		throw new Error(
			"No audible clip is under the captions. Unmute a dialogue clip and try again."
		);
	}
	if (request.mode === "mic-dominance" && sources.size < 2) {
		throw new Error(
			"Mic dominance needs at least two audible mics under the captions (linked or multicam). Use voice clustering for a single mic."
		);
	}
	const tasks = candidates.flatMap((list, window) =>
		list.map((candidate, slot) => ({ candidate, slot, window }))
	);
	const ranges = planDecodeRanges(tasks);
	const decodeSeconds = ranges.reduce(
		(sum, range) => sum + (range.end - range.start),
		0
	);
	if (decodeSeconds > MAX_DECODE_SECONDS) {
		throw new Error(
			"Speaker detection is limited to two hours of source audio. Detect on a shorter timeline."
		);
	}
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	const levels = candidates.map((list) => list.map(() => 0));
	const features = candidates.map((list) =>
		list.map((): number[] | null => null)
	);
	for (const range of ranges) {
		check();
		const asset = byId.get(range.assetId);
		if (!asset) {
			continue;
		}
		const samples = await decode(asset, range.start, range.end - range.start);
		check();
		for (const task of range.tasks) {
			const from = Math.max(
				0,
				Math.round(
					(task.candidate.sourceStart - range.start) * SPEAKER_SAMPLE_RATE
				)
			);
			const to = Math.min(
				samples.length,
				Math.round(
					(task.candidate.sourceEnd - range.start) * SPEAKER_SAMPLE_RATE
				)
			);
			const slice = samples.subarray(from, Math.max(from, to));
			const rms = rmsOf(slice);
			const windowLevels = levels[task.window];
			if (windowLevels) {
				windowLevels[task.slot] = rms;
			}
			const windowFeatures = features[task.window];
			if (
				request.mode === "cluster" &&
				rms >= SPEECH_RMS_FLOOR &&
				windowFeatures
			) {
				windowFeatures[task.slot] = voiceFeatures(slice, SPEAKER_SAMPLE_RATE);
			}
		}
	}
	let labels: (number | null)[];
	let names: string[];
	let segmentLabels: Map<string, number> | undefined;
	if (request.mode === "mic-dominance") {
		const keys = micDominance(
			candidates.map((list, window) =>
				list.map((candidate, slot) => ({
					rms: levels[window]?.[slot] ?? 0,
					sourceKey: candidate.sourceKey,
				}))
			)
		);
		const fromSources = labelsFromSources(
			keys,
			(key) => sources.get(key) ?? "Speaker"
		);
		({ labels, names } = fromSources);
		segmentLabels = segmentLabelsFromSources(
			candidates,
			fromSources.labelOfSource
		);
	} else {
		// The loudest audible source carries each word's voice.
		const perWindow = candidates.map((list, window) => {
			let best = -1;
			for (let slot = 0; slot < list.length; slot++) {
				if (
					(levels[window]?.[slot] ?? 0) >
					(best < 0 ? 0 : (levels[window]?.[best] ?? 0))
				) {
					best = slot;
				}
			}
			return best < 0 ? null : (features[window]?.[best] ?? null);
		});
		const voiced = perWindow.filter((feature) => feature !== null).length;
		const k = clusterCountOf(request);
		if (voiced < k) {
			throw new Error(
				`Only ${voiced} audible words were found; voice clustering into ${k} speakers needs at least ${k}.`
			);
		}
		labels = clusterSpeakers(perWindow, k);
		names = [];
	}
	return {
		...applySpeakerLabels(project, windows, labels, names, mintId, {
			segmentLabels,
		}),
		mode: request.mode,
		windows: windows.length,
	};
}

/**
 * Fixed-precision seconds for FFmpeg time options: `String` would print
 * floating-point residue such as 5.5e-17 in exponent form, which FFmpeg
 * rejects.
 */
export const ffmpegSeconds = (seconds: number): string =>
	Math.max(0, Number.isFinite(seconds) ? seconds : 0).toFixed(6);

/** Decode a source span to mono 16 kHz PCM with FFmpeg. */
export async function decodeSpeakerAudio(
	store: StudioStore,
	asset: Asset,
	start: number,
	duration: number,
	operation: MediaOperation
): Promise<Float32Array> {
	const directory = await mkdtemp(join(store.directory, "speakers-"));
	try {
		const output = join(directory, "window.pcm");
		const maxBytes = Math.ceil(duration * BYTES_PER_SECOND * 1.05) + 65_536;
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
				"-ss",
				ffmpegSeconds(start),
				"-t",
				ffmpegSeconds(duration),
				"-i",
				store.mediaPath(asset.id),
				"-vn",
				"-sn",
				"-dn",
				"-map",
				"0:a:0",
				"-ac",
				"1",
				"-ar",
				String(SPEAKER_SAMPLE_RATE),
				"-c:a",
				"pcm_s16le",
				"-f",
				"s16le",
				output,
			],
			{
				maxOutputBytes: maxBytes,
				outputPath: output,
				signal: operation.signal,
				timeoutMs: operation.remainingMs(),
			}
		);
		const bytes = new Uint8Array(await Bun.file(output).arrayBuffer());
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
		for (let index = 0; index < samples.length; index++) {
			samples[index] = view.getInt16(index * 2, true) / 32_768;
		}
		return samples;
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

/** Run speaker detection against store media under one media admission. */
export async function detectSpeakers(
	store: StudioStore,
	project: Project,
	request: SpeakerDetectRequest,
	signal?: AbortSignal,
	mintId?: () => string
): Promise<SpeakerDetectResult> {
	return await withMediaOperation(
		OPERATION_TIMEOUT_MS,
		{ signal },
		async (operation) =>
			await detectSpeakersWith(
				project,
				store.assets(),
				request,
				(asset, start, duration) =>
					decodeSpeakerAudio(store, asset, start, duration, operation),
				mintId,
				() => operation.check()
			)
	);
}
