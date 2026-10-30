/**
 * Real-FFmpeg proof for the clip audio chain (cleanup, effects, pan and
 * channels): a 1 kHz tone panned fully left leaves the right channel below
 * -60 dB, the telephone effect cuts a 100 Hz tone by more than 20 dB, voice
 * isolation runs with the bundled RNNoise model (through a path that needs
 * filter escaping), pitch shifts keep the clip length with and without
 * rubberband, and every effect type renders inside a full clip chain.
 */
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AUDIO_EFFECT_TYPES,
	newAudioEffect,
} from "../../shared/audio-effects.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Segment,
} from "../../shared/project.ts";
import { segmentAudioFilters } from "./render-segment-audio.ts";
import { cleanupFilters } from "./render-stages/audio-cleanup.ts";
import { audioEffectFilters } from "./render-stages/audio-effects.ts";
import {
	type AudioRenderEnvironment,
	processAudioEnvironment,
	staticAudioEnvironment,
} from "./render-stages/audio-environment.ts";
import { clipPanFilters } from "./render-stages/audio-pan.ts";

async function run(command: string[]): Promise<string> {
	const child = Bun.spawn(command, { stderr: "pipe", stdout: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) {
		throw new Error(`${command[0]} exited with ${code}: ${stderr.slice(-800)}`);
	}
	return `${stdout}${stderr}`;
}

const asset: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 2,
	hasAudio: true,
	height: 0,
	id: "00000000-0000-4000-8000-0000000000a1",
	kind: "audio",
	name: "Tone",
	width: 0,
};
const clip = (patch: Partial<Segment>): Segment => ({
	...newSegment(asset),
	...patch,
});

interface ChannelStats {
	rms: number[];
	zeroCrossings: number[];
}

/** Per-channel RMS (dBFS) and zero-crossing rate of `source` through `filters`. */
async function measure(
	source: string,
	filters: string[],
	seconds = 2
): Promise<ChannelStats> {
	const graph = [...filters, "astats=measure_overall=none"].join(",");
	const output = await run([
		"ffmpeg",
		"-hide_banner",
		"-nostats",
		"-f",
		"lavfi",
		"-i",
		`${source}:sample_rate=48000:duration=${seconds}`,
		"-af",
		graph,
		"-f",
		"null",
		"-",
	]);
	const values = (label: string) =>
		[...output.matchAll(new RegExp(`${label}: (-?[\\d.]+|-inf)`, "g"))].map(
			(match) =>
				match[1] === "-inf" ? Number.NEGATIVE_INFINITY : Number(match[1])
		);
	return {
		rms: values("RMS level dB"),
		zeroCrossings: values("Zero crossings rate"),
	};
}

async function durationOf(filters: string[], seconds: number): Promise<number> {
	const directory = await mkdtemp(join(tmpdir(), "ryu-audio-duration-"));
	try {
		const output = join(directory, "out.wav");
		await run([
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			`sine=frequency=1000:sample_rate=48000:duration=${seconds}`,
			"-af",
			filters.join(","),
			"-y",
			output,
		]);
		return Number(
			(
				await run([
					"ffprobe",
					"-v",
					"error",
					"-show_entries",
					"format=duration",
					"-of",
					"default=noprint_wrappers=1:nokey=1",
					output,
				])
			).trim()
		);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

function check(condition: boolean, message: string) {
	if (!condition) {
		throw new Error(message);
	}
	process.stdout.write(`ok  ${message}\n`);
}

const tone = "sine=frequency=1000";
const environment = processAudioEnvironment();

// Pan: a mono tone panned fully left.
const left = await measure(tone, clipPanFilters(clip({ pan: -1 })));
check(
	left.rms.length === 2 && (left.rms[1] ?? 0) < -60,
	`full-left pan: right channel ${left.rms[1]} dB < -60 dB (left ${left.rms[0]} dB)`
);
const centre = await measure(tone, ["aformat=channel_layouts=stereo"]);
check(
	Math.abs((left.rms[0] ?? 0) - ((centre.rms[0] ?? 0) + 3.01)) < 0.1,
	"full-left pan keeps constant power (+3 dB on the left)"
);
const swapped = await measure(
	"sine=frequency=1000",
	clipPanFilters(clip({ channelMode: "right", pan: 0 }))
);
check(
	swapped.rms.length === 2,
	`channel mode renders stereo (${swapped.rms.join(", ")} dB)`
);

// Telephone: a 100 Hz tone loses more than 20 dB.
const telephone = (
	await measure(
		"sine=frequency=100",
		audioEffectFilters(
			clip({ audioEffects: [newAudioEffect("telephone")] }),
			environment
		)
	)
).rms[0];
const dry = (await measure("sine=frequency=100", ["anull"])).rms[0];
check(
	(dry ?? 0) - (telephone ?? 0) > 20,
	`telephone attenuates 100 Hz by ${((dry ?? 0) - (telephone ?? 0)).toFixed(1)} dB > 20 dB`
);

// Voice isolation through a model path that needs filter escaping.
check(environment.hasFilter("arnndn"), "this FFmpeg has arnndn");
const modelDirectory = await mkdtemp(join(tmpdir(), "ryu-rnnoise-verify-"));
try {
	const awkward = join(modelDirectory, "odd:dir,[x]");
	await mkdir(awkward, { recursive: true });
	const bundled = new URL(
		"../assets/rnnoise/somnolent-hogwash.rnnn",
		import.meta.url
	).pathname;
	const copied = join(awkward, "model.rnnn");
	await copyFile(bundled, copied);
	const isolated = clip({ audioCleanup: { voiceIsolation: 1 } });
	const noiseDry = (
		await measure("anoisesrc=color=white:amplitude=0.3", ["anull"])
	).rms[0];
	for (const model of [
		environment,
		staticAudioEnvironment({ arnndn: true }, copied),
	] satisfies AudioRenderEnvironment[]) {
		const filters = cleanupFilters(isolated, model);
		check(filters[0]?.startsWith("arnndn=m=") === true, filters.join(","));
		const wet = (await measure("anoisesrc=color=white:amplitude=0.3", filters))
			.rms[0];
		check(
			(noiseDry ?? 0) - (wet ?? 0) > 10,
			`voice isolation removes ${((noiseDry ?? 0) - (wet ?? 0)).toFixed(1)} dB of white noise`
		);
	}
} finally {
	await rm(modelDirectory, { force: true, recursive: true });
}

// Pitch: one octave up doubles the zero-crossing rate and keeps the length.
const baseline = (await measure(tone, ["anull"])).zeroCrossings[0] ?? 0;
const octave = clip({
	audioEffects: [{ amount: 0.5, enabled: true, semitones: 12, type: "pitch" }],
});
for (const [label, pitchEnvironment] of [
	["rubberband", staticAudioEnvironment({ rubberband: true })],
	["resample fallback", staticAudioEnvironment({})],
] as const) {
	if (label === "rubberband" && !environment.hasFilter("rubberband")) {
		process.stdout.write("skip rubberband: not in this FFmpeg build\n");
		continue;
	}
	const filters = audioEffectFilters(octave, pitchEnvironment);
	const shifted = (await measure(tone, filters)).zeroCrossings[0] ?? 0;
	check(
		Math.abs(shifted / baseline - 2) < 0.1,
		`${label}: +12 st crossing ratio ${(shifted / baseline).toFixed(3)} ≈ 2`
	);
	const length = await durationOf(filters, 2);
	check(
		Math.abs(length - 2) < 0.05,
		`${label}: length ${length.toFixed(3)}s ≈ 2s`
	);
}

// Every effect type runs inside a full clip chain with cleanup and pan.
const project = newProject("Audio chain verify");
for (const type of AUDIO_EFFECT_TYPES) {
	const segment = clip({
		audioCleanup: { denoise: 0.5, enhance: 0.5, normalize: true },
		audioEffects: [newAudioEffect(type)],
		channelMode: "mono",
		pan: 0.3,
	});
	project.segments = [segment];
	const [chain] = segmentAudioFilters({
		length: 2,
		n: 0,
		p: project,
		s: segment,
		visualize: false,
	});
	await run([
		"ffmpeg",
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:sample_rate=48000:duration=2",
		"-filter_complex",
		`${chain};[a0]anull[out]`,
		"-map",
		"[out]",
		"-f",
		"null",
		"-",
	]);
	process.stdout.write(`ok  ${type} renders in the clip chain\n`);
}
