import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import type { Asset } from "../../shared/project.ts";
import {
	type ConformGeneratedAudioInput,
	conformGeneratedAudioRequestSchema,
	SOUNDTRACK_LAYER_THRESHOLDS,
	SOUNDTRACK_STYLES,
	type SoundtrackJob,
	type SoundtrackLayer,
	type SoundtrackRequest,
	soundtrackClockLead,
	soundtrackIntensitySteps,
	soundtrackLayersOf,
	soundtrackRequestSchema,
} from "../../shared/soundtrack.ts";
import { importMediaAsset } from "./import-media.ts";
import { MEDIA_FORMATS, probe, runMedia, thumbnail } from "./media.ts";
import type { StudioStore } from "./store.ts";

type SoundtrackInput = z.input<typeof soundtrackRequestSchema>;

// The physical sidecar owns the budget, not a store or HTTP-server instance.
// Soundtracks and sound effects share it: both are local audio synthesis.
const MAX_ACTIVE_SOUNDTRACKS = 2;
let activeSoundtracks = 0;
export class SoundtrackBusyError extends Error {
	constructor() {
		super(
			"Two local audio jobs (soundtracks or sound effects) are already running. Wait for one to finish, then try again."
		);
	}
}
const voiceGains = [0.28, 0.18, 0.14] as const;
const beatsPerBar = 4;
/** Attack time in seconds so each beat starts from silence (no clicks on chord changes). */
const attackSeconds = 0.015;
/** Seconds over which a section's intensity change ramps in. */
const intensityRampSeconds = 0.05;
/** Intensity width over which a layer fades in above its threshold. */
const layerGateWidth = 0.1;
/** Peak contribution of each layer, used to keep the full band below clipping. */
const layerPeaks = {
	pluck: 0.6,
	pad: 0.28,
	bass: 0.22,
	arpeggio: 0.09,
	kick: 0.5,
	hat: 0.06,
	snare: 0.18,
} as const satisfies Record<SoundtrackLayer, number>;
const bandHeadroom = 1.1;
/** `aevalsrc` variable slots; 0 and 1 are the hat and snare noise states. */
const ratioRegister = 2;
const intensityRegister = 3;
const positionRegister = 4;
const beatRegister = 5;

function formatNumber(value: number): string {
	return Number(value.toFixed(6)).toString();
}

interface ScoreTiming {
	beat: string;
	beatIndex: string;
	beatSeconds: number;
	beatsPerSecond: string;
	/** Rhythm clock: `t`, or `t` shifted so bars land on a downbeat offset. */
	clock: string;
	position: string;
	ratio: string;
	request: Pick<SoundtrackRequest, "mood">;
}

function chordRatio(
	request: Pick<SoundtrackRequest, "mood" | "sections">,
	beatIndex: string
): string {
	// Section starts are absolute timeline times, so they read `t`, not the
	// phased rhythm clock.
	const progression = SOUNDTRACK_STYLES[request.mood].progression;
	const bar = `floor(${beatIndex}/${beatsPerBar})`;
	// Each new section starts two chords further on, so sections are heard
	// as harmonic changes and not only as level changes.
	const sectionStarts = (request.sections ?? [])
		.map((section) => section.start)
		.filter((start) => start > 0);
	const sectionOffset = sectionStarts.length
		? `+2*(${sectionStarts.map((start) => `gte(t,${formatNumber(start)})`).join("+")})`
		: "";
	const barIndex = `mod(${bar}${sectionOffset},${progression.length})`;
	const [first, second, third, fourth] = progression;
	return `if(eq(${barIndex},0),${first},if(eq(${barIndex},1),${second},if(eq(${barIndex},2),${third},${fourth})))`;
}

function layerExpression(layer: SoundtrackLayer, timing: ScoreTiming): string {
	const {
		beat,
		beatIndex,
		beatSeconds,
		beatsPerSecond,
		clock,
		position,
		ratio,
	} = timing;
	const eighth = formatNumber(beatSeconds / 2);
	const [root, third, fifth] = SOUNDTRACK_STYLES[timing.request.mood].voices;
	switch (layer) {
		case "pluck": {
			const accent = `if(eq(mod(${beatIndex},${beatsPerBar}),0),1,0.72)`;
			const envelope = `min(1,${position}/${attackSeconds})*(0.25+0.75*exp(-3*${position}/${beat}))*${accent}`;
			const voices = [root, third, fifth]
				.map(
					(frequency, index) =>
						`${voiceGains[index]}*sin(2*PI*${frequency}*${ratio}*t)`
				)
				.join("+");
			return `(${voices})*${envelope}`;
		}
		case "pad": {
			const bar = formatNumber(beatSeconds * beatsPerBar);
			const swell = `(0.85+0.15*sin(2*PI*t/${formatNumber(beatSeconds * beatsPerBar * 2)}))`;
			const attack = `min(1,mod(${clock},${bar})/0.08)`;
			return `(0.1*sin(2*PI*${root}*${ratio}*t)+0.08*sin(2*PI*${third}*${ratio}*t)+0.07*sin(2*PI*${fifth}*${ratio}*t)+0.03*sin(2*PI*${formatNumber(root * 2.003)}*${ratio}*t))*${swell}*${attack}`;
		}
		case "bass":
			return `0.22*sin(2*PI*${formatNumber(root / 2)}*${ratio}*t)*min(1,${position}/0.01)*(0.35+0.65*exp(-4*${position}/${beat}))`;
		case "arpeggio": {
			const step = `mod(${clock},${eighth})`;
			const note = `mod(floor(${clock}*${beatsPerSecond}*2),4)`;
			const frequency = `if(eq(${note},0),${root},if(eq(${note},1),${third},if(eq(${note},2),${fifth},${third})))`;
			return `0.09*sin(2*PI*2*${frequency}*${ratio}*t)*min(1,${step}/0.005)*exp(-8*${step}/${eighth})`;
		}
		case "kick":
			return `0.5*sin(2*PI*(50*${position}+3.6*(1-exp(-25*${position}))))*exp(-9*${position})*(1-${position}/${beat})`;
		case "hat":
			return `0.06*(2*random(0)-1)*exp(-40*mod(${clock},${eighth}))`;
		case "snare":
			return `eq(mod(${beatIndex},2),1)*(0.12*(2*random(1)-1)+0.06*sin(2*PI*185*${position}))*exp(-14*${position})*(1-${position}/${beat})`;
		default:
			return "0";
	}
}

/** `aevalsrc` expression for the section intensity curve. */
export function intensityExpression(
	sections: NonNullable<SoundtrackRequest["sections"]>
): string {
	const steps = soundtrackIntensitySteps(sections);
	const [initial, ...changes] = steps;
	let expression = formatNumber(initial?.[1] ?? 0);
	let previous = initial?.[1] ?? 0;
	for (const [time, value] of changes) {
		const delta = formatNumber(value - previous);
		expression += `+${delta}*clip((t-${formatNumber(time)})/${intensityRampSeconds},0,1)`;
		previous = value;
	}
	return expression;
}

/**
 * Build the ffmpeg `aevalsrc` expression for the score. The tempo drives the
 * rhythm: every beat (bpm/60 Hz) the chord is re-struck with a short attack and
 * exponential decay, the downbeat of each bar is accented, and the chord root
 * moves once per bar through a four-bar progression. A request with the
 * original moods and no layers or sections keeps the original score.
 *
 * With sections, an intensity curve scales the band and gates layers in as
 * it rises past each layer's threshold, and each section shifts the chord
 * progression so the change is harmonic as well as dynamic.
 */
export function soundtrackExpression(
	request: Pick<SoundtrackRequest, "bpm" | "mood"> &
		Partial<Pick<SoundtrackRequest, "downbeatOffset" | "layers" | "sections">>
): string {
	const beat = formatNumber(60 / request.bpm);
	const beatsPerSecond = formatNumber(request.bpm / 60);
	const lead = soundtrackClockLead(request);
	const clock = lead > 0 ? `(t+${formatNumber(lead)})` : "t";
	const beatIndex = `floor(${clock}*${beatsPerSecond})`;
	const timing: ScoreTiming = {
		beat,
		beatSeconds: 60 / request.bpm,
		beatIndex,
		beatsPerSecond,
		clock,
		position: `mod(${clock},${beat})`,
		ratio: chordRatio(request, beatIndex),
		request,
	};
	const layers = soundtrackLayersOf(request);
	const sections = request.sections;
	const legacy = isLegacyScore(request);
	// The band evaluates the chord ratio and intensity many times per sample;
	// store each once per sample (ffmpeg `st`/`ld`) and read it back.
	const prelude: string[] = [];
	if (!legacy) {
		prelude.push(
			`st(${positionRegister},${timing.position})`,
			`st(${beatRegister},${timing.beatIndex})`,
			`st(${ratioRegister},${timing.ratio})`
		);
		timing.position = `ld(${positionRegister})`;
		timing.beatIndex = `ld(${beatRegister})`;
		timing.ratio = `ld(${ratioRegister})`;
	}
	let intensity: string | undefined;
	if (sections?.length) {
		prelude.push(`st(${intensityRegister},${intensityExpression(sections)})`);
		intensity = `ld(${intensityRegister})`;
	}
	const parts = layers.map((layer) => {
		const sound = layerExpression(layer, timing);
		const threshold = SOUNDTRACK_LAYER_THRESHOLDS[layer];
		if (!intensity || threshold === 0) {
			return sound;
		}
		return `(${sound})*clip((${intensity}-${threshold})/${layerGateWidth},0,1)`;
	});
	const peak = layers.reduce((total, layer) => total + layerPeaks[layer], 0);
	const scale = Math.min(1, bandHeadroom / peak);
	let expression = parts.length === 1 ? (parts[0] ?? "0") : parts.join("+");
	if (scale < 1) {
		expression = `${formatNumber(scale)}*(${expression})`;
	}
	if (intensity) {
		expression = `(0.35+0.65*${intensity})*(${expression})`;
	}
	return [...prelude, expression].join(";");
}

const styleFilters: Partial<Record<SoundtrackRequest["mood"], string>> = {
	ambient: "aecho=0.8:0.6:180|330:0.35|0.22",
	"lo-fi": "lowpass=f=3200",
};

/** Build the full ffmpeg argument list for a generated soundtrack. */
export function soundtrackMediaArgs(
	request: SoundtrackRequest,
	output: string
): string[] {
	const fadeIn = Math.min(0.4, request.duration / 4);
	const fadeOut = Math.min(0.6, request.duration / 3);
	const style = styleFilters[request.mood];
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-y",
		"-f",
		"lavfi",
		"-i",
		`aevalsrc=exprs='${soundtrackExpression(request)}':s=48000:d=${request.duration}`,
		"-filter_complex",
		`[0:a]${style ? `${style},` : ""}volume=0.75,afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${Math.max(0, request.duration - fadeOut)}:d=${fadeOut}`,
		"-t",
		String(request.duration),
		"-ar",
		"48000",
		"-ac",
		"2",
		output,
	];
}

export interface SynthesizedAudio {
	/** ffmpeg arguments; the last argument must be the output path. */
	args: (output: string) => string[];
	/** Folder beneath `imports/` for the temporary WAV. */
	folder: string;
	/** Library name for the imported asset. */
	name: string;
	/** Synthesis time limit; long scores need more than the default. */
	timeoutMs?: number;
}

const DEFAULT_SYNTHESIS_TIMEOUT_MS = 120_000;
/**
 * Measured synthesis cost per second of output, with headroom for slower
 * machines: the original pluck score costs about 45 ms and the full band
 * with sections about 255 ms on one container core.
 */
const LEGACY_SYNTHESIS_MS_PER_SECOND = 90;
const BAND_SYNTHESIS_MS_PER_SECOND = 500;
/** Timeout headroom over the estimate, so slow disks or busy cores still finish. */
const SYNTHESIS_TIMEOUT_FACTOR = 2;

/**
 * Longest synthesis the HTTP request may hold open. The sidecar closes a
 * request after 120 idle seconds, so anything predicted to take longer than
 * this renders as a background job instead (`POST /soundtrack` returns 202).
 */
export const INLINE_SYNTHESIS_BUDGET_MS = 60_000;

/** Whether a request plays only the original re-struck chord score. */
const isLegacyScore = (
	request: Pick<SoundtrackRequest, "layers" | "mood" | "sections">
) => {
	const layers = soundtrackLayersOf(request);
	return layers.length === 1 && layers[0] === "pluck" && !request.sections;
};

/** Conservative synthesis time estimate for a soundtrack request. */
export function estimatedSynthesisMs(
	request: Pick<SoundtrackRequest, "duration" | "layers" | "mood" | "sections">
): number {
	const rate = isLegacyScore(request)
		? LEGACY_SYNTHESIS_MS_PER_SECOND
		: BAND_SYNTHESIS_MS_PER_SECOND;
	return Math.ceil(request.duration * rate);
}

/** Time limit for synthesizing `duration` seconds of audio. */
export const synthesisTimeoutMs = (duration: number) =>
	DEFAULT_SYNTHESIS_TIMEOUT_MS +
	Math.ceil(duration * BAND_SYNTHESIS_MS_PER_SECOND * SYNTHESIS_TIMEOUT_FACTOR);

/**
 * Whether a soundtrack must render as a background job. The original pluck
 * score keeps its published synchronous 201 contract at every duration.
 */
export const soundtrackRendersInBackground = (
	request: Pick<SoundtrackRequest, "duration" | "layers" | "mood" | "sections">
) =>
	!isLegacyScore(request) &&
	estimatedSynthesisMs(request) > INLINE_SYNTHESIS_BUDGET_MS;

/** Synthesis slots currently held (tests wait for this to drain). */
export const activeSynthesisSlots = (): number => activeSoundtracks;

/** Throw `SoundtrackBusyError` when no synthesis slot is free. */
export function assertSynthesisSlot(): void {
	if (activeSoundtracks >= MAX_ACTIVE_SOUNDTRACKS) {
		throw new SoundtrackBusyError();
	}
}

/**
 * Synthesize a WAV with ffmpeg and import it as an app-owned audio asset.
 * Holds one slot of the sidecar-wide synthesis budget from launch until the
 * temporary file is removed. Validate input and check the signal before
 * calling so rejected requests consume no slot.
 */
export async function synthesizeAudioAsset(
	store: StudioStore,
	job: SynthesizedAudio,
	options: { signal?: AbortSignal } = {}
): Promise<Asset> {
	options.signal?.throwIfAborted();
	assertSynthesisSlot();
	// Generated media is an app-owned local import. Keep the temporary source
	// beneath the same import root used by the path-confinement guard.
	const directory = join(store.directory, "imports", job.folder);
	const output = join(directory, `${crypto.randomUUID()}.wav`);
	activeSoundtracks++;
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await runMedia(job.args(output), {
			timeoutMs: job.timeoutMs ?? DEFAULT_SYNTHESIS_TIMEOUT_MS,
			signal: options.signal,
		});
		options.signal?.throwIfAborted();
		const asset = await importMediaAsset(
			store,
			{ name: job.name, source: { path: output } },
			{
				probe: async (path) => {
					const metadata = await probe(path, options.signal);
					options.signal?.throwIfAborted();
					return metadata;
				},
				thumbnail,
			}
		);
		return asset;
	} finally {
		try {
			await rm(output, { force: true });
		} finally {
			activeSoundtracks--;
		}
	}
}

const styleLabel = (mood: SoundtrackRequest["mood"]) =>
	SOUNDTRACK_STYLES[mood].label.toLowerCase();

/** Create a bounded local score so projects can prototype a soundtrack offline. */
export async function generateSoundtrack(
	store: StudioStore,
	input: SoundtrackInput,
	options: { signal?: AbortSignal } = {}
): Promise<Asset> {
	const request = soundtrackRequestSchema.parse(input);
	return await synthesizeAudioAsset(
		store,
		{
			args: (output) => soundtrackMediaArgs(request, output),
			folder: "soundtracks",
			timeoutMs: synthesisTimeoutMs(request.duration),
			name: `Local ${styleLabel(request.mood)} soundtrack ${request.bpm} BPM.wav`,
		},
		options
	);
}

const MAX_RETAINED_JOBS = 16;
const JOB_RETENTION_MS = 60 * 60 * 1000;
const jobs = new Map<string, SoundtrackJob & { finishedAt?: number }>();

const publicJob = ({
	finishedAt: _finishedAt,
	...job
}: SoundtrackJob & { finishedAt?: number }): SoundtrackJob => job;

function pruneJobs(now: number) {
	const finished = [...jobs.values()]
		.filter((job) => job.finishedAt !== undefined)
		.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
	for (const job of finished) {
		const expired = now - (job.finishedAt ?? now) > JOB_RETENTION_MS;
		if (expired || jobs.size > MAX_RETAINED_JOBS) {
			jobs.delete(job.id);
		}
	}
}

const jobFailure = (
	error: unknown,
	aborted: boolean
): NonNullable<SoundtrackJob["error"]> => {
	if (error instanceof SoundtrackBusyError) {
		return { code: "SOUNDTRACK_BUSY", message: error.message };
	}
	if (aborted) {
		return {
			code: "CANCELLED",
			message: "The soundtrack was cancelled because the sidecar stopped.",
		};
	}
	return {
		code: "SOUNDTRACK_FAILED",
		message:
			error instanceof Error && error.message
				? error.message
				: "Soundtrack generation failed.",
	};
};

/**
 * Start rendering a soundtrack in the background and return its job. Claims
 * a synthesis slot synchronously, so a full budget throws
 * `SoundtrackBusyError` before any job is recorded. `signal` must not be tied
 * to the HTTP request, which ends when the 202 response is sent.
 */
export function startSoundtrackJob(
	store: StudioStore,
	input: SoundtrackInput,
	options: {
		/**
		 * Runs with the saved asset before the job is marked done (for example
		 * to place it on a timeline); a throw marks the job failed with its
		 * message while the asset stays in the library.
		 */
		finish?: (asset: Asset) => Promise<void> | void;
		signal?: AbortSignal;
		now?: () => number;
	} = {}
): SoundtrackJob {
	const now = options.now ?? Date.now;
	const request = soundtrackRequestSchema.parse(input);
	options.signal?.throwIfAborted();
	assertSynthesisSlot();
	pruneJobs(now());
	const id = crypto.randomUUID();
	const job: SoundtrackJob & { finishedAt?: number } = {
		id,
		status: "running",
		createdAt: new Date(now()).toISOString(),
	};
	jobs.set(id, job);
	// `generateSoundtrack` claims the slot before its first await.
	generateSoundtrack(store, request, { signal: options.signal })
		.then(async (asset) => {
			await options.finish?.(asset);
			return asset;
		})
		.then(
			(asset) => {
				jobs.set(id, {
					...job,
					asset,
					finishedAt: now(),
					status: "done",
				});
			},
			(error: unknown) => {
				jobs.set(id, {
					...job,
					error: jobFailure(error, options.signal?.aborted === true),
					finishedAt: now(),
					status: "failed",
				});
			}
		);
	return publicJob(job);
}

/** A background soundtrack job, if it is still retained. */
export function soundtrackJob(id: string): SoundtrackJob | undefined {
	const job = jobs.get(id);
	return job ? publicJob(job) : undefined;
}

/** FFmpeg arguments that trim, fade and limit generated audio to WAV. */
export function conformAudioArgs(
	source: string,
	output: string,
	duration: number,
	fadeOut: number,
	available: number
): string[] {
	const length = Math.min(duration, available);
	const fade = Math.min(fadeOut, length / 2);
	const filters = [
		"aresample=48000",
		"alimiter=limit=0.89:level=false",
		...(fade > 0
			? [
					`afade=t=out:st=${Math.max(0, length - fade).toFixed(6)}:d=${fade.toFixed(6)}`,
				]
			: []),
	];
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-y",
		"-protocol_whitelist",
		"file,pipe",
		"-format_whitelist",
		MEDIA_FORMATS,
		"-i",
		source,
		"-map",
		"0:a:0",
		"-vn",
		"-t",
		length.toFixed(6),
		"-af",
		filters.join(","),
		"-ar",
		"48000",
		"-ac",
		"2",
		output,
	];
}

/**
 * Fit a generated music or sound-effect asset to the timeline (G74): trim it
 * to `duration`, fade the tail, and limit peaks. The new asset keeps the
 * model provenance (`generation`) so the credits report names the provider
 * and model; the original generated file stays in the library.
 */
export async function conformGeneratedAudio(
	store: StudioStore,
	input: ConformGeneratedAudioInput,
	folder: "soundtracks" | "sfx",
	options: { signal?: AbortSignal } = {}
): Promise<Asset> {
	const request = conformGeneratedAudioRequestSchema.parse(input);
	const source = store.assets().find((asset) => asset.id === request.assetId);
	if (!source) {
		throw new Error("The generated audio is no longer in the library.");
	}
	if (source.kind !== "audio" || !source.generation) {
		throw new Error("Only generated audio can be fitted to the timeline.");
	}
	const conformed = await synthesizeAudioAsset(
		store,
		{
			args: (output) =>
				conformAudioArgs(
					store.mediaPath(source.id),
					output,
					request.duration,
					request.fadeOut,
					source.duration
				),
			folder,
			name: `${source.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 170)} · fitted.wav`,
			timeoutMs: synthesisTimeoutMs(
				Math.min(request.duration, source.duration)
			),
		},
		options
	);
	const stamped = {
		...conformed,
		derivedFromAssetId: source.id,
		generation: source.generation,
	};
	store.upsertAsset(stamped);
	return stamped;
}
