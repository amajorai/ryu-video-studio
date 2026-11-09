/**
 * Speaker detection and speaker list edits.
 *
 * Detection labels every active caption word (or a word-less caption as a
 * whole) with a speaker. Mode "mic-dominance" picks, per word, the audible
 * source with the highest RMS (linked or multicam multi-mic recordings).
 * Mode "cluster" extracts a small voice feature vector per word (13 log-mel
 * band energies, spectral centroid, autocorrelation pitch) from the loudest
 * audible source and groups words with deterministic k-means.
 *
 * Everything here is pure; the sidecar decodes PCM and calls in.
 */
import { z } from "zod";
import {
	type Asset,
	activeCaptions,
	type Caption,
	type Project,
	type Segment,
	segmentDuration,
	trackSettingFor,
	withActiveCaptions,
} from "./project.ts";
import { hexColorSchema, idSchema } from "./schema/primitives.ts";
import { MAX_SPEAKERS, type Speaker, speakerSchema } from "./schema/speaker.ts";
import { clipHeard } from "./sync-lock.ts";

export const MIN_CLUSTER_SPEAKERS = 2;
export const MAX_CLUSTER_SPEAKERS = 6;
/** Speakers a cluster run produces when the request names no `k`. */
export const DEFAULT_CLUSTER_SPEAKERS = 2;
/** Share of a clip's labelled speech one speaker needs to tag the clip. */
export const SEGMENT_DOMINANCE = 0.6;
/** RMS (full scale 1) below which a word window counts as silent (-50 dBFS). */
export const SPEECH_RMS_FLOOR = 0.003_16;
/** Analysis sample rate the sidecar decodes to. */
export const SPEAKER_SAMPLE_RATE = 16_000;

/** Original, high-contrast tint palette; cycles past its length. */
export const SPEAKER_PALETTE = [
	"#f59e0b",
	"#38bdf8",
	"#f472b6",
	"#4ade80",
	"#a78bfa",
	"#fb7185",
	"#2dd4bf",
	"#facc15",
] as const;

const revisionSchema = z.number().int().nonnegative();

export const speakerDetectModeSchema = z.enum(["mic-dominance", "cluster"]);
export type SpeakerDetectMode = z.infer<typeof speakerDetectModeSchema>;

export const speakerDetectRequestSchema = z
	.object({
		mode: speakerDetectModeSchema,
		/** Speaker count for `cluster`; ignored by `mic-dominance`. */
		k: z
			.number()
			.int()
			.min(MIN_CLUSTER_SPEAKERS)
			.max(MAX_CLUSTER_SPEAKERS)
			.optional(),
		revision: revisionSchema,
	})
	.strict();
export type SpeakerDetectRequest = z.infer<typeof speakerDetectRequestSchema>;

export const speakerEditRequestSchema = z.discriminatedUnion("action", [
	z
		.object({
			action: z.literal("rename"),
			label: speakerSchema.shape.label,
			revision: revisionSchema,
			speakerId: idSchema,
		})
		.strict(),
	z
		.object({
			action: z.literal("recolor"),
			color: hexColorSchema,
			revision: revisionSchema,
			speakerId: idSchema,
		})
		.strict(),
	z
		.object({
			action: z.literal("merge"),
			/** Speakers folded into `into`, then removed from the list. */
			speakerIds: z
				.array(idSchema)
				.min(1)
				.max(MAX_SPEAKERS - 1),
			into: idSchema,
			revision: revisionSchema,
		})
		.strict(),
]);
export type SpeakerEditRequest = z.infer<typeof speakerEditRequestSchema>;

/** Resolved count for a detection request. */
export const clusterCountOf = (request: Pick<SpeakerDetectRequest, "k">) =>
	request.k ?? DEFAULT_CLUSTER_SPEAKERS;

/** The speaker with `id`, when the project lists one. */
export function speakerById(
	project: Pick<Project, "speakers">,
	id: string | undefined
): Speaker | undefined {
	if (id === undefined) {
		return undefined;
	}
	return project.speakers?.find((speaker) => speaker.id === id);
}

/** Tint color of a speaker reference, or undefined when it has none. */
export function speakerColorFor(
	project: Pick<Project, "speakers">,
	id: string | undefined
): string | undefined {
	return speakerById(project, id)?.color;
}

export const paletteColor = (index: number): string =>
	SPEAKER_PALETTE[index % SPEAKER_PALETTE.length] ?? SPEAKER_PALETTE[0];

const DEFAULT_LABEL = /^Speaker \d+$/;
export const defaultSpeakerLabel = (index: number) => `Speaker ${index + 1}`;

// ---------------------------------------------------------------------------
// Windows and candidates
// ---------------------------------------------------------------------------

/** A timeline span to label: one caption word, or a word-less caption. */
export interface SpeakerWindow {
	captionId: string;
	end: number;
	start: number;
	/** Null when the window is the caption itself. */
	wordId: string | null;
}

/** Active caption words (or word-less captions) in timeline order. */
export function speakerWindows(project: Project): SpeakerWindow[] {
	const windows: SpeakerWindow[] = [];
	for (const caption of activeCaptions(project)) {
		if (caption.words?.length) {
			for (const word of caption.words) {
				if (word.end > word.start) {
					windows.push({
						captionId: caption.id,
						end: word.end,
						start: word.start,
						wordId: word.id,
					});
				}
			}
		} else if (caption.end > caption.start) {
			windows.push({
				captionId: caption.id,
				end: caption.end,
				start: caption.start,
				wordId: null,
			});
		}
	}
	return windows.sort(
		(a, b) =>
			a.start - b.start ||
			a.end - b.end ||
			a.captionId.localeCompare(b.captionId)
	);
}

/** One audible source heard during a window, with its source-time span. */
export interface SpeakerCandidate {
	assetId: string;
	label: string;
	segmentId: string;
	sourceEnd: number;
	/** Physical recording: a detached-audio derivative shares its video's key. */
	sourceKey: string;
	sourceStart: number;
}

const segmentEnd = (segment: Segment) =>
	segment.start + segmentDuration(segment);

function hasAudibleAudio(
	project: Project,
	segment: Segment,
	asset: Asset | undefined
): asset is Asset {
	if (!asset) {
		return false;
	}
	const bearsAudio =
		asset.kind === "audio" || (asset.kind === "video" && asset.hasAudio);
	return bearsAudio && clipHeard(project, segment);
}

function sourceKeyOf(asset: Asset): string {
	return asset.derivation === "audio" && asset.derivedFromAssetId
		? asset.derivedFromAssetId
		: asset.id;
}

function candidateLabel(
	project: Project,
	segment: Segment,
	asset: Asset,
	assets: ReadonlyMap<string, Asset>
): string {
	const key = sourceKeyOf(asset);
	for (const group of project.multicamGroups) {
		if (
			group.id === segment.multicamGroupId ||
			group.members.some((member) => member.assetId === key)
		) {
			const member = group.members.find(
				(item) => item.assetId === key || item.assetId === asset.id
			);
			if (member) {
				return member.label;
			}
		}
	}
	return (assets.get(key) ?? asset).name.slice(0, 40).trim() || "Speaker";
}

/**
 * Audible audio-bearing clips under a window's midpoint, one per physical
 * source (audio clips win over their linked video). The source span is the
 * window intersected with the clip, mapped through `sourceIn` and `speed`.
 */
export function speakerCandidates(
	project: Project,
	assets: readonly Asset[],
	window: Pick<SpeakerWindow, "end" | "start">
): SpeakerCandidate[] {
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	const middle = (window.start + window.end) / 2;
	const bySource = new Map<string, SpeakerCandidate & { audio: boolean }>();
	const ordered = [...project.segments].sort(
		(a, b) => a.track - b.track || a.start - b.start || a.id.localeCompare(b.id)
	);
	for (const segment of ordered) {
		const asset = byId.get(segment.assetId);
		if (!hasAudibleAudio(project, segment, asset)) {
			continue;
		}
		const end = segmentEnd(segment);
		if (middle < segment.start || middle >= end) {
			continue;
		}
		const toSource = (time: number) =>
			segment.sourceIn + (time - segment.start) * segment.speed;
		const sourceStart = Math.max(
			segment.sourceIn,
			toSource(Math.max(window.start, segment.start))
		);
		const sourceEnd = Math.min(
			segment.sourceOut,
			asset.duration,
			toSource(Math.min(window.end, end))
		);
		if (!(sourceEnd > sourceStart)) {
			continue;
		}
		const key = sourceKeyOf(asset);
		const previous = bySource.get(key);
		const audio = asset.kind === "audio";
		if (previous && (previous.audio || !audio)) {
			continue;
		}
		bySource.set(key, {
			assetId: asset.id,
			audio,
			label: candidateLabel(project, segment, asset, byId),
			segmentId: segment.id,
			sourceEnd,
			sourceKey: key,
			sourceStart,
		});
	}
	return [...bySource.values()].map(({ audio: _audio, ...candidate }) => ({
		...candidate,
	}));
}

// ---------------------------------------------------------------------------
// Signal features
// ---------------------------------------------------------------------------

export function rmsOf(samples: ArrayLike<number>): number {
	if (samples.length === 0) {
		return 0;
	}
	let sum = 0;
	for (let index = 0; index < samples.length; index++) {
		const value = samples[index] ?? 0;
		sum += value * value;
	}
	return Math.sqrt(sum / samples.length);
}

/** In-place iterative radix-2 FFT; `real.length` must be a power of two. */
export function fft(real: Float64Array, imaginary: Float64Array): void {
	const size = real.length;
	if (size !== imaginary.length || size & (size - 1)) {
		throw new Error("FFT size must be a matching power of two.");
	}
	for (let index = 1, swap = 0; index < size; index++) {
		let bit = size >> 1;
		for (; swap & bit; bit >>= 1) {
			swap ^= bit;
		}
		swap ^= bit;
		if (index < swap) {
			const re = real[index] ?? 0;
			real[index] = real[swap] ?? 0;
			real[swap] = re;
			const im = imaginary[index] ?? 0;
			imaginary[index] = imaginary[swap] ?? 0;
			imaginary[swap] = im;
		}
	}
	for (let length = 2; length <= size; length <<= 1) {
		const angle = (-2 * Math.PI) / length;
		const stepRe = Math.cos(angle);
		const stepIm = Math.sin(angle);
		const half = length >> 1;
		for (let start = 0; start < size; start += length) {
			let twiddleRe = 1;
			let twiddleIm = 0;
			for (let offset = 0; offset < half; offset++) {
				const even = start + offset;
				const odd = even + half;
				const oddRe = real[odd] ?? 0;
				const oddIm = imaginary[odd] ?? 0;
				const productRe = oddRe * twiddleRe - oddIm * twiddleIm;
				const productIm = oddRe * twiddleIm + oddIm * twiddleRe;
				const evenRe = real[even] ?? 0;
				const evenIm = imaginary[even] ?? 0;
				real[even] = evenRe + productRe;
				imaginary[even] = evenIm + productIm;
				real[odd] = evenRe - productRe;
				imaginary[odd] = evenIm - productIm;
				const nextRe = twiddleRe * stepRe - twiddleIm * stepIm;
				twiddleIm = twiddleRe * stepIm + twiddleIm * stepRe;
				twiddleRe = nextRe;
			}
		}
	}
}

const FRAME_SIZE = 512;
const MAX_FRAMES = 12;
export const MEL_BANDS = 13;
const MEL_MIN_HZ = 80;

const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel: number) => 700 * (10 ** (mel / 2595) - 1);

/** Triangular mel filter weights, `[band][bin]`, for a power spectrum. */
export function melFilterbank(
	frameSize: number,
	sampleRate: number,
	bands = MEL_BANDS
): Float64Array[] {
	const bins = frameSize / 2 + 1;
	const low = hzToMel(MEL_MIN_HZ);
	const high = hzToMel(sampleRate / 2);
	const edges = Array.from({ length: bands + 2 }, (_, index) =>
		melToHz(low + ((high - low) * index) / (bands + 1))
	);
	const binHz = sampleRate / frameSize;
	return Array.from({ length: bands }, (_, band) => {
		const left = edges[band] ?? 0;
		const center = edges[band + 1] ?? 0;
		const right = edges[band + 2] ?? 0;
		const weights = new Float64Array(bins);
		for (let bin = 0; bin < bins; bin++) {
			const hz = bin * binHz;
			if (hz > left && hz < right) {
				weights[bin] =
					hz <= center
						? (hz - left) / (center - left)
						: (right - hz) / (right - center);
			}
		}
		return weights;
	});
}

const filterbanks = new Map<number, Float64Array[]>();
function filterbankFor(sampleRate: number) {
	const cached = filterbanks.get(sampleRate);
	if (cached) {
		return cached;
	}
	const bank = melFilterbank(FRAME_SIZE, sampleRate);
	filterbanks.set(sampleRate, bank);
	return bank;
}

const hann = Float64Array.from(
	{ length: FRAME_SIZE },
	(_, index) => 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (FRAME_SIZE - 1))
);

/**
 * Fundamental frequency in Hz by normalized autocorrelation over 60-400 Hz,
 * or 0 when the frame is unvoiced (peak correlation below 0.3).
 */
export function estimatePitch(
	samples: ArrayLike<number>,
	sampleRate: number
): number {
	const minLag = Math.max(2, Math.floor(sampleRate / 400));
	const maxLag = Math.min(samples.length - 2, Math.ceil(sampleRate / 60));
	if (maxLag <= minLag) {
		return 0;
	}
	let energy = 0;
	for (let index = 0; index < samples.length; index++) {
		const value = samples[index] ?? 0;
		energy += value * value;
	}
	if (energy <= 0) {
		return 0;
	}
	let bestLag = 0;
	let bestScore = 0.3;
	for (let lag = minLag; lag <= maxLag; lag++) {
		let sum = 0;
		for (let index = 0; index + lag < samples.length; index++) {
			sum += (samples[index] ?? 0) * (samples[index + lag] ?? 0);
		}
		const score = sum / energy;
		if (score > bestScore) {
			bestScore = score;
			bestLag = lag;
		}
	}
	return bestLag ? sampleRate / bestLag : 0;
}

/**
 * Voice feature vector for one word window: 13 mean log-mel energies with the
 * window's mean removed (gain-independent), spectral centroid in kHz, and
 * log2 pitch. Null when no frame is louder than the speech floor.
 */
export function voiceFeatures(
	samples: Float32Array,
	sampleRate = SPEAKER_SAMPLE_RATE
): number[] | null {
	if (samples.length < FRAME_SIZE / 2) {
		return null;
	}
	const bank = filterbankFor(sampleRate);
	const frameCount = Math.max(
		1,
		Math.min(MAX_FRAMES, Math.floor((samples.length - FRAME_SIZE) / 256) + 1)
	);
	const span = Math.max(0, samples.length - FRAME_SIZE);
	const mel = new Float64Array(MEL_BANDS);
	const pitches: number[] = [];
	let centroid = 0;
	let voiced = 0;
	const real = new Float64Array(FRAME_SIZE);
	const imaginary = new Float64Array(FRAME_SIZE);
	for (let frame = 0; frame < frameCount; frame++) {
		const offset =
			frameCount === 1 ? 0 : Math.round((span * frame) / (frameCount - 1));
		const slice = samples.subarray(offset, offset + FRAME_SIZE);
		if (rmsOf(slice) < SPEECH_RMS_FLOOR) {
			continue;
		}
		voiced++;
		real.fill(0);
		imaginary.fill(0);
		for (let index = 0; index < slice.length; index++) {
			real[index] = (slice[index] ?? 0) * (hann[index] ?? 0);
		}
		fft(real, imaginary);
		let weighted = 0;
		let total = 0;
		const power = new Float64Array(FRAME_SIZE / 2 + 1);
		for (let bin = 0; bin < power.length; bin++) {
			const value = (real[bin] ?? 0) ** 2 + (imaginary[bin] ?? 0) ** 2;
			power[bin] = value;
			weighted += value * ((bin * sampleRate) / FRAME_SIZE);
			total += value;
		}
		centroid += total > 0 ? weighted / total : 0;
		for (let band = 0; band < MEL_BANDS; band++) {
			const weights = bank[band];
			let energy = 0;
			for (let bin = 0; bin < power.length; bin++) {
				energy += (power[bin] ?? 0) * (weights?.[bin] ?? 0);
			}
			// A floor relative to the frame keeps empty bands gain-independent.
			mel[band] = (mel[band] ?? 0) + Math.log(energy + total * 1e-6 + 1e-20);
		}
		const pitch = estimatePitch(slice, sampleRate);
		if (pitch > 0) {
			pitches.push(pitch);
		}
	}
	if (voiced === 0) {
		return null;
	}
	const bands = Array.from(mel, (value) => value / voiced);
	const meanBand = bands.reduce((sum, value) => sum + value, 0) / MEL_BANDS;
	pitches.sort((a, b) => a - b);
	const pitch = pitches.length
		? (pitches[Math.floor(pitches.length / 2)] ?? 0)
		: 0;
	return [
		...bands.map((value) => value - meanBand),
		centroid / voiced / 1000,
		pitch > 0 ? Math.log2(pitch) : 0,
	];
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/**
 * Mic dominance: per window, the source key with the highest RMS above the
 * speech floor, or null when every source is silent or absent.
 */
export function micDominance(
	levels: readonly (readonly { rms: number; sourceKey: string }[])[]
): (string | null)[] {
	return levels.map((candidates) => {
		let best: { rms: number; sourceKey: string } | undefined;
		for (const candidate of candidates) {
			if (
				candidate.rms >= SPEECH_RMS_FLOOR &&
				(!best || candidate.rms > best.rms)
			) {
				best = candidate;
			}
		}
		return best?.sourceKey ?? null;
	});
}

const squaredDistance = (a: readonly number[], b: readonly number[]) => {
	let sum = 0;
	for (let index = 0; index < a.length; index++) {
		sum += ((a[index] ?? 0) - (b[index] ?? 0)) ** 2;
	}
	return sum;
};

/** Z-score each dimension so no feature dominates by scale. */
export function standardize(points: readonly number[][]): number[][] {
	const dimensions = points[0]?.length ?? 0;
	const means = new Array<number>(dimensions).fill(0);
	const deviations = new Array<number>(dimensions).fill(0);
	for (const point of points) {
		for (let index = 0; index < dimensions; index++) {
			means[index] = (means[index] ?? 0) + (point[index] ?? 0) / points.length;
		}
	}
	for (const point of points) {
		for (let index = 0; index < dimensions; index++) {
			deviations[index] =
				(deviations[index] ?? 0) +
				((point[index] ?? 0) - (means[index] ?? 0)) ** 2 / points.length;
		}
	}
	return points.map((point) =>
		point.map((value, index) => {
			const deviation = Math.sqrt(deviations[index] ?? 0);
			return deviation > 1e-9 ? (value - (means[index] ?? 0)) / deviation : 0;
		})
	);
}

/**
 * Deterministic k-means: farthest-first seeding from the point nearest the
 * mean, then Lloyd iterations. Labels are renumbered by first appearance.
 */
export function kMeans(points: readonly number[][], k: number): number[] {
	if (points.length === 0) {
		return [];
	}
	const clusters = Math.max(1, Math.min(k, points.length));
	const dimensions = points[0]?.length ?? 0;
	const mean = new Array<number>(dimensions).fill(0);
	for (const point of points) {
		for (let index = 0; index < dimensions; index++) {
			mean[index] = (mean[index] ?? 0) + (point[index] ?? 0) / points.length;
		}
	}
	let seed = 0;
	for (let index = 1; index < points.length; index++) {
		if (
			squaredDistance(points[index] ?? [], mean) <
			squaredDistance(points[seed] ?? [], mean)
		) {
			seed = index;
		}
	}
	const centroids: number[][] = [[...(points[seed] ?? [])]];
	while (centroids.length < clusters) {
		let farthest = 0;
		let farthestDistance = -1;
		for (const [index, point] of points.entries()) {
			const nearest = Math.min(
				...centroids.map((centroid) => squaredDistance(point, centroid))
			);
			if (nearest > farthestDistance) {
				farthestDistance = nearest;
				farthest = index;
			}
		}
		centroids.push([...(points[farthest] ?? [])]);
	}
	let labels = new Array<number>(points.length).fill(0);
	for (let iteration = 0; iteration < 100; iteration++) {
		const next = points.map((point) => {
			let best = 0;
			for (let index = 1; index < centroids.length; index++) {
				if (
					squaredDistance(point, centroids[index] ?? []) <
					squaredDistance(point, centroids[best] ?? [])
				) {
					best = index;
				}
			}
			return best;
		});
		const stable =
			iteration > 0 && next.every((label, index) => label === labels[index]);
		labels = next;
		if (stable) {
			break;
		}
		for (let cluster = 0; cluster < centroids.length; cluster++) {
			const members = points.filter((_, index) => labels[index] === cluster);
			if (members.length === 0) {
				continue;
			}
			centroids[cluster] = Array.from(
				{ length: dimensions },
				(_, index) =>
					members.reduce((sum, member) => sum + (member[index] ?? 0), 0) /
					members.length
			);
		}
	}
	return renumberByAppearance(labels);
}

function renumberByAppearance(labels: readonly number[]): number[] {
	const order = new Map<number, number>();
	return labels.map((label) => {
		const known = order.get(label);
		if (known !== undefined) {
			return known;
		}
		order.set(label, order.size);
		return order.size - 1;
	});
}

/**
 * Three-word majority: a word whose two neighbours agree on another speaker
 * takes theirs. Unlabelled windows are skipped, not counted as neighbours.
 */
export function smoothLabels<T>(labels: readonly (T | null)[]): (T | null)[] {
	const positions = labels.flatMap((label, index) =>
		label === null ? [] : [index]
	);
	const result = [...labels];
	for (let index = 1; index + 1 < positions.length; index++) {
		const previous = labels[positions[index - 1] ?? -1] ?? null;
		const next = labels[positions[index + 1] ?? -1] ?? null;
		const position = positions[index] ?? -1;
		if (
			previous !== null &&
			previous === next &&
			labels[position] !== previous
		) {
			result[position] = previous;
		}
	}
	return result;
}

/** Cluster per-window features; null features stay unlabelled. */
export function clusterSpeakers(
	features: readonly (number[] | null)[],
	k: number
): (number | null)[] {
	const indices = features.flatMap((feature, index) =>
		feature ? [index] : []
	);
	const labels = kMeans(
		standardize(indices.map((index) => features[index] ?? [])),
		k
	);
	const result: (number | null)[] = features.map(() => null);
	for (const [position, index] of indices.entries()) {
		result[index] = labels[position] ?? null;
	}
	return renumberNullable(smoothLabels(result));
}

function renumberNullable(labels: readonly (number | null)[]) {
	const present = labels.flatMap((label) => (label === null ? [] : [label]));
	const renumbered = renumberByAppearance(present);
	let cursor = 0;
	return labels.map((label) =>
		label === null ? null : (renumbered[cursor++] ?? 0)
	);
}

// ---------------------------------------------------------------------------
// Writing results
// ---------------------------------------------------------------------------

type WordOf = NonNullable<Caption["words"]>[number];

function withoutSpeaker<T extends { speakerId?: string }>(value: T): T {
	if (value.speakerId === undefined) {
		return value;
	}
	const { speakerId: _removed, ...rest } = value;
	return rest as T;
}

function withSpeaker<T extends { speakerId?: string }>(
	value: T,
	speakerId: string | undefined
): T {
	return speakerId === undefined
		? withoutSpeaker(value)
		: { ...value, speakerId };
}

function remapCaptions(
	captions: Caption[],
	remap: (speakerId: string | undefined) => string | undefined
): Caption[] {
	return captions.map((caption) => {
		const next = withSpeaker(caption, remap(caption.speakerId));
		return caption.words
			? {
					...next,
					words: caption.words.map((word) =>
						withSpeaker(word, remap(word.speakerId))
					),
				}
			: next;
	});
}

/** Rewrite every speaker reference in segments and all caption sets. */
export function remapSpeakerReferences(
	project: Project,
	remap: (speakerId: string | undefined) => string | undefined
): Project {
	return {
		...project,
		captions: remapCaptions(project.captions, remap),
		captionTracks: project.captionTracks.map((track) => ({
			...track,
			captions: remapCaptions(track.captions, remap),
		})),
		segments: project.segments.map((segment) =>
			withSpeaker(segment, remap(segment.speakerId))
		),
	};
}

export interface SpeakerAssignment {
	/** Labelled windows (words or word-less captions). */
	assigned: number;
	project: Project;
	speakers: Speaker[];
	/** Windows left without a speaker (silent or no audible source). */
	unassigned: number;
}

/** The label with the most time in `spans`; ties go to the lower index. */
function dominant(
	spans: readonly { duration: number; label: number }[]
): { label: number; share: number } | undefined {
	const totals = new Map<number, number>();
	let sum = 0;
	for (const span of spans) {
		totals.set(span.label, (totals.get(span.label) ?? 0) + span.duration);
		sum += span.duration;
	}
	let best: { label: number; total: number } | undefined;
	for (const [label, total] of totals) {
		if (
			!best ||
			total > best.total + 1e-9 ||
			(Math.abs(total - best.total) <= 1e-9 && label < best.label)
		) {
			best = { label, total };
		}
	}
	return best && sum > 0
		? { label: best.label, share: best.total / sum }
		: undefined;
}

/** How `applySpeakerLabels` tags clips. */
export interface SpeakerLabelOptions {
	/**
	 * Mic dominance: the label each candidate clip's own mic was given. When
	 * present, only these clips are tagged (with their own mic's speaker),
	 * instead of tagging every clip by the majority speech over it.
	 */
	segmentLabels?: ReadonlyMap<string, number>;
}

/**
 * Reuse existing speakers for a re-run. A speaker whose label equals a
 * label's auto-generated name (a mic name) is matched by that name first, so
 * mic-named speakers keep their meaning when another mic appears first; the
 * rest are reused by position. A reused label is kept when it is custom: not
 * the default pattern and not one of this run's auto-generated names.
 */
function reuseSpeakers(
	existing: readonly Speaker[],
	used: readonly number[],
	names: readonly string[],
	mintId: () => string
): Speaker[] {
	const autoNames = new Set(names.map((name) => name.slice(0, 40)));
	const nameOf = (label: number, index: number) =>
		(names[label] ?? defaultSpeakerLabel(index)).slice(0, 40);
	const claimed = new Set<number>();
	const matched = used.map((label, index) => {
		if (names[label] === undefined) {
			return undefined;
		}
		const name = nameOf(label, index);
		const found = existing.findIndex(
			(speaker, position) => !claimed.has(position) && speaker.label === name
		);
		if (found < 0) {
			return undefined;
		}
		claimed.add(found);
		return existing[found];
	});
	const reused = used.map((label, index): Speaker | undefined => {
		const direct = matched[index];
		if (direct) {
			return { ...direct, label: nameOf(label, index) };
		}
		const position = existing.findIndex(
			(_speaker, candidate) => !claimed.has(candidate)
		);
		const previous = existing[position];
		if (!previous) {
			return undefined;
		}
		claimed.add(position);
		const custom = !(
			DEFAULT_LABEL.test(previous.label) || autoNames.has(previous.label)
		);
		return {
			...previous,
			label: custom ? previous.label : nameOf(label, index),
		};
	});
	const takenColors = new Set(
		reused.flatMap((speaker) => (speaker ? [speaker.color] : []))
	);
	return used.map((label, index): Speaker => {
		const speaker = reused[index];
		if (speaker) {
			return speaker;
		}
		const color =
			SPEAKER_PALETTE.find((candidate) => !takenColors.has(candidate)) ??
			paletteColor(index);
		takenColors.add(color);
		return { color, id: mintId(), label: nameOf(label, index) };
	});
}

/**
 * Replace `project.speakers` with one entry per used label and write
 * `speakerId` onto active caption words, captions (duration majority) and
 * clips (dominated by one speaker, or each mic clip's own speaker when
 * `options.segmentLabels` is given). Existing speakers are reused (mic name
 * first, then position), so ids, colors and custom names survive a re-run;
 * earlier references are cleared first. Clips on locked tracks are left
 * untouched.
 */
export function applySpeakerLabels(
	project: Project,
	windows: readonly SpeakerWindow[],
	labels: readonly (number | null)[],
	names: readonly string[],
	mintId: () => string = () => crypto.randomUUID(),
	options: SpeakerLabelOptions = {}
): SpeakerAssignment {
	const used = [
		...new Set(labels.flatMap((label) => (label === null ? [] : [label]))),
	].sort((a, b) => a - b);
	if (used.length > MAX_SPEAKERS) {
		throw new Error(
			`Speaker detection found ${used.length} speakers; at most ${MAX_SPEAKERS} are supported.`
		);
	}
	const speakers = reuseSpeakers(project.speakers ?? [], used, names, mintId);
	const idOf = new Map(
		used.map((label, index) => [label, speakers[index]?.id ?? ""])
	);
	const cleared = remapSpeakerReferences(project, () => undefined);
	const wordLabel = new Map<string, number>();
	const captionLabel = new Map<string, number>();
	let assigned = 0;
	for (const [index, window] of windows.entries()) {
		const label = labels[index] ?? null;
		if (label === null) {
			continue;
		}
		assigned++;
		if (window.wordId === null) {
			captionLabel.set(window.captionId, label);
		} else {
			wordLabel.set(`${window.captionId}:${window.wordId}`, label);
		}
	}
	const labelSpeaker = (label: number | undefined) =>
		label === undefined ? undefined : idOf.get(label);
	const captions = activeCaptions(cleared).map((caption) => {
		if (!caption.words?.length) {
			return withSpeaker(caption, labelSpeaker(captionLabel.get(caption.id)));
		}
		const words: WordOf[] = caption.words.map((word) =>
			withSpeaker(word, labelSpeaker(wordLabel.get(`${caption.id}:${word.id}`)))
		);
		const majority = dominant(
			caption.words.flatMap((word) => {
				const label = wordLabel.get(`${caption.id}:${word.id}`);
				return label === undefined
					? []
					: [{ duration: Math.max(word.end - word.start, 1e-6), label }];
			})
		);
		return withSpeaker({ ...caption, words }, labelSpeaker(majority?.label));
	});
	const labelled = windows.flatMap((window, index) => {
		const label = labels[index] ?? null;
		return label === null ? [] : [{ label, window }];
	});
	const original = new Map(
		project.segments.map((segment) => [segment.id, segment])
	);
	const segments = cleared.segments.map((segment) => {
		if (trackSettingFor(project, segment.track).locked) {
			return original.get(segment.id) ?? segment;
		}
		if (options.segmentLabels) {
			return withSpeaker(
				segment,
				labelSpeaker(options.segmentLabels.get(segment.id))
			);
		}
		const end = segmentEnd(segment);
		const winner = dominant(
			labelled.flatMap(({ label, window }) => {
				const overlap =
					Math.min(end, window.end) - Math.max(segment.start, window.start);
				return overlap > 0 ? [{ duration: overlap, label }] : [];
			})
		);
		return winner && winner.share >= SEGMENT_DOMINANCE
			? withSpeaker(segment, labelSpeaker(winner.label))
			: segment;
	});
	const withCaptions = withActiveCaptions(cleared, captions);
	const next: Project = { ...withCaptions, segments };
	if (speakers.length > 0 || project.speakers !== undefined) {
		next.speakers = speakers;
	}
	return {
		assigned,
		project: next,
		speakers,
		unassigned: windows.length - assigned,
	};
}

/**
 * Turn per-window source keys (mic dominance) into numbered labels ordered
 * by first appearance, with each label's display name.
 */
export function labelsFromSources(
	keys: readonly (string | null)[],
	nameOf: (sourceKey: string) => string
): {
	labels: (number | null)[];
	/** Label per source key that won at least one window. */
	labelOfSource: Map<string, number>;
	names: string[];
} {
	const order = new Map<string, number>();
	const names: string[] = [];
	const labels = keys.map((key) => {
		if (key === null) {
			return null;
		}
		const known = order.get(key);
		if (known !== undefined) {
			return known;
		}
		order.set(key, order.size);
		names.push(nameOf(key));
		return order.size - 1;
	});
	return { labelOfSource: order, labels, names };
}

/**
 * Mic dominance clip tags: every candidate clip (an audible audio-bearing
 * clip heard under some word) maps to the label of its own mic, when that
 * mic won at least one word.
 */
export function segmentLabelsFromSources(
	candidates: readonly (readonly SpeakerCandidate[])[],
	labelOfSource: ReadonlyMap<string, number>
): Map<string, number> {
	const result = new Map<string, number>();
	for (const list of candidates) {
		for (const candidate of list) {
			const label = labelOfSource.get(candidate.sourceKey);
			if (label !== undefined) {
				result.set(candidate.segmentId, label);
			}
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Speaker list edits
// ---------------------------------------------------------------------------

function requireSpeaker(project: Project, id: string): Speaker {
	const speaker = speakerById(project, id);
	if (!speaker) {
		throw new Error("Choose a speaker that is in this project.");
	}
	return speaker;
}

/** Apply a rename, recolor or merge to the speaker list and its references. */
export function editSpeakers(
	project: Project,
	request: SpeakerEditRequest
): Project {
	if (request.action === "rename" || request.action === "recolor") {
		requireSpeaker(project, request.speakerId);
		return {
			...project,
			speakers: (project.speakers ?? []).map((speaker) => {
				if (speaker.id !== request.speakerId) {
					return speaker;
				}
				return request.action === "rename"
					? { ...speaker, label: request.label }
					: { ...speaker, color: request.color };
			}),
		};
	}
	requireSpeaker(project, request.into);
	const merged = new Set(request.speakerIds);
	if (merged.has(request.into)) {
		throw new Error("Merge speakers into a speaker that is not being merged.");
	}
	for (const id of merged) {
		requireSpeaker(project, id);
	}
	const remapped = remapSpeakerReferences(project, (speakerId) =>
		speakerId !== undefined && merged.has(speakerId) ? request.into : speakerId
	);
	return {
		...remapped,
		speakers: (project.speakers ?? []).filter(
			(speaker) => !merged.has(speaker.id)
		),
	};
}

/** Count of caption words (or captions) and clips tagged per speaker. */
export function speakerUsage(
	project: Project
): Map<string, { clips: number; words: number }> {
	const usage = new Map<string, { clips: number; words: number }>();
	const bump = (id: string | undefined, key: "clips" | "words") => {
		if (id === undefined) {
			return;
		}
		const entry = usage.get(id) ?? { clips: 0, words: 0 };
		entry[key]++;
		usage.set(id, entry);
	};
	for (const caption of activeCaptions(project)) {
		if (caption.words?.length) {
			for (const word of caption.words) {
				bump(word.speakerId, "words");
			}
		} else {
			bump(caption.speakerId, "words");
		}
	}
	for (const segment of project.segments) {
		bump(segment.speakerId, "clips");
	}
	return usage;
}
