/**
 * Real-FFmpeg proof for speed, pitch and the track mixer: a -6 dB track gain
 * lowers the clip RMS by 6±0.3 dB through the full clip chain, a fully left
 * track pan leaves the right channel below -60 dB, tape-style speed doubles
 * the pitch while `atempo` keeps it, both halve the length, clips above 16x
 * are muted unless they opt back in, and unity tracks leave the chain
 * byte-identical.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
	segmentDuration,
	updateTrackSetting,
} from "../../shared/project.ts";
import { segmentAudioFilters } from "./render-segment-audio.ts";
import { trackMixFilters } from "./render-stages/audio-mix.ts";
import { tempoFilters } from "./render-stages/audio-tempo.ts";

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

const SECONDS = 2;
const asset: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: SECONDS,
	hasAudio: true,
	height: 0,
	id: "00000000-0000-4000-8000-0000000000b2",
	kind: "audio",
	name: "Tone",
	width: 0,
};
const clip = (patch: Partial<Segment> = {}): Segment => ({
	...newSegment(asset),
	sourceOut: SECONDS,
	...patch,
});

interface AudioStats {
	duration: number;
	rms: number[];
	zeroCrossings: number[];
}

/**
 * Render a 1 kHz tone through the clip's full audio chain (`[0:a]` → `[a0]`)
 * and report per-channel RMS (dBFS), zero-crossing rate and length.
 */
async function renderClip(project: Project, segment: Segment) {
	const chain = segmentAudioFilters({
		length: segmentDuration(segment),
		n: 0,
		p: project,
		s: segment,
		visualize: false,
	});
	const directory = await mkdtemp(join(tmpdir(), "ryu-verify-mixer-"));
	try {
		const output = join(directory, "out.wav");
		const log = await run([
			"ffmpeg",
			"-hide_banner",
			"-nostats",
			"-f",
			"lavfi",
			"-i",
			`sine=frequency=1000:sample_rate=48000:duration=${SECONDS}`,
			"-filter_complex",
			`${chain.join(";")};[a0]asplit=2[out][stats];[stats]astats=measure_overall=none,anullsink`,
			"-map",
			"[out]",
			"-y",
			output,
		]);
		const values = (label: string) =>
			[...log.matchAll(new RegExp(`${label}: (-?[\\d.]+|-inf)`, "g"))].map(
				(match) =>
					match[1] === "-inf" ? Number.NEGATIVE_INFINITY : Number(match[1])
			);
		const duration = Number(
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
		const stats: AudioStats = {
			duration,
			rms: values("RMS level dB"),
			zeroCrossings: values("Zero crossings rate"),
		};
		return stats;
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

const project = newProject("Mixer proof");
const dry = await renderClip(project, clip());
const dryRms = dry.rms[0] ?? Number.NaN;

// Unity tracks add nothing; default 1x clips keep the legacy anull tempo.
check(
	trackMixFilters(project, 0).length === 0 &&
		tempoFilters(clip()).join(",") === "anull",
	"unity track and 1x clip keep the legacy chain"
);

// Track gain: -6 dB lowers RMS by 6±0.3 dB.
const quieter = await renderClip(
	updateTrackSetting(project, 0, { gainDb: -6 }),
	clip()
);
const drop = dryRms - (quieter.rms[0] ?? Number.NaN);
check(
	Math.abs(drop - 6) <= 0.3,
	`-6 dB track gain lowers RMS by ${drop.toFixed(2)} dB (6±0.3)`
);

// Track pan: fully left silences the right channel.
const panned = await renderClip(
	updateTrackSetting(project, 0, { pan: -1 }),
	clip()
);
check(
	panned.rms.length === 2 && (panned.rms[1] ?? 0) < -60,
	`full-left track pan: right ${panned.rms[1]} dB < -60 dB (left ${panned.rms[0]} dB)`
);

// Speed: atempo keeps pitch, tape-style doubles it; both halve the length.
const kept = await renderClip(project, clip({ speed: 2 }));
const tape = await renderClip(
	project,
	clip({ preservePitch: false, speed: 2 })
);
const dryCrossings = dry.zeroCrossings[0] ?? Number.NaN;
const keptRatio = (kept.zeroCrossings[0] ?? Number.NaN) / dryCrossings;
const tapeRatio = (tape.zeroCrossings[0] ?? Number.NaN) / dryCrossings;
check(
	Math.abs(keptRatio - 1) < 0.05,
	`2x with preserved pitch keeps the pitch (zero-crossing ratio ${keptRatio.toFixed(3)})`
);
check(
	Math.abs(tapeRatio - 2) < 0.1,
	`2x tape-style doubles the pitch (zero-crossing ratio ${tapeRatio.toFixed(3)})`
);
for (const [label, stats] of [
	["atempo", kept],
	["tape", tape],
] as const) {
	check(
		Math.abs(stats.duration - SECONDS / 2) < 0.05,
		`2x ${label} halves the length (${stats.duration.toFixed(3)} s)`
	);
}
const slowTape = await renderClip(
	project,
	clip({ preservePitch: false, speed: 0.5 })
);
check(
	Math.abs(slowTape.duration - SECONDS * 2) < 0.05 &&
		Math.abs((slowTape.zeroCrossings[0] ?? Number.NaN) / dryCrossings - 0.5) <
			0.05,
	`0.5x tape-style doubles the length and halves the pitch (${slowTape.duration.toFixed(3)} s)`
);

// High speed: above 16x the clip is muted unless it opts back in.
const fast = await renderClip(project, clip({ speed: 20 }));
check(
	(fast.rms[0] ?? 0) === Number.NEGATIVE_INFINITY,
	`20x clip is muted by default (${fast.rms[0]} dB)`
);
const fastKept = await renderClip(project, clip({ muted: false, speed: 20 }));
check(
	Math.abs((fastKept.rms[0] ?? Number.NEGATIVE_INFINITY) - dryRms) < 1,
	`20x clip with muted:false keeps its audio (${fastKept.rms[0]?.toFixed(1)} dB)`
);

// An explicit clip mute silences the clip at any speed.
const clipMuted = await renderClip(project, clip({ muted: true, speed: 2 }));
check(
	(clipMuted.rms[0] ?? 0) === Number.NEGATIVE_INFINITY,
	`2x clip with muted:true renders silent (${clipMuted.rms[0]} dB)`
);
