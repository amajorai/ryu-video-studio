/**
 * Real-FFmpeg proof for soundtrack planning and procedural SFX:
 * a 30 s cinematic plan with three sections (aligned to picture cuts at
 * 10 s and 20 s) renders a score whose loudness envelope changes at the
 * section boundaries and follows the planned intensities; every style
 * renders an audible score; every SFX kind renders an audible, unclipped
 * effect of the requested length, and the same seed is bit-identical while
 * another seed differs. A downbeat offset puts the score's beats and
 * accented bar starts on the beat markers, and synthesis stays within the
 * cost estimate that decides background jobs.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type SfxKind,
	sfxKindSchema,
	sfxParameters,
} from "../../shared/sfx.ts";
import {
	soundtrackBarSeconds,
	soundtrackMoodSchema,
	soundtrackRequestSchema,
} from "../../shared/soundtrack.ts";
import {
	alignSoundtrackPlan,
	soundtrackRequestFromPlan,
} from "../../shared/soundtrack-plan.ts";
import { sfxMediaArgs } from "./sfx.ts";
import { estimatedSynthesisMs, soundtrackMediaArgs } from "./soundtrack.ts";

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

function check(condition: boolean, message: string) {
	if (!condition) {
		throw new Error(message);
	}
	process.stdout.write(`ok  ${message}\n`);
}

/** Mean-square level per `window` seconds, from `astats` with resets. */
async function windowPowers(path: string, window: number): Promise<number[]> {
	const output = await run([
		"ffmpeg",
		"-hide_banner",
		"-nostdin",
		"-i",
		path,
		"-af",
		`aformat=channel_layouts=mono,asetnsamples=${Math.round(48_000 * window)},astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`,
		"-f",
		"null",
		"-",
	]);
	return [...output.matchAll(/lavfi\.astats\.Overall\.RMS_level=(\S+)/gu)].map(
		(match) => {
			const db = Number(match[1]);
			return Number.isFinite(db) ? 10 ** (db / 10) : 0;
		}
	);
}

interface Overall {
	duration: number;
	peakDb: number;
	rmsDb: number;
}

async function overall(path: string): Promise<Overall> {
	const output = await run([
		"ffmpeg",
		"-hide_banner",
		"-nostdin",
		"-i",
		path,
		"-af",
		"astats=measure_perchannel=none",
		"-f",
		"null",
		"-",
	]);
	const value = (label: string) =>
		Number(new RegExp(`${label}: (\\S+)`, "u").exec(output)?.[1]);
	const samples = value("Number of samples");
	return {
		duration: samples / 48_000,
		peakDb: value("Peak level dB"),
		rmsDb: value("RMS level dB"),
	};
}

async function pcmHash(path: string): Promise<string> {
	const output = await run([
		"ffmpeg",
		"-hide_banner",
		"-nostdin",
		"-loglevel",
		"error",
		"-i",
		path,
		"-f",
		"md5",
		"-",
	]);
	return output.trim();
}

const toDb = (power: number) => 10 * Math.log10(Math.max(power, 1e-12));
const mean = (values: readonly number[]) =>
	values.reduce((total, value) => total + value, 0) / values.length;

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-soundtrack-"));
try {
	// 1. Planned 30 s cinematic score: quiet, full, then medium.
	const plan = alignSoundtrackPlan(
		{
			bpm: 90,
			sections: [
				{ start: 0, end: 9.6, intensity: 0.15 },
				{ start: 9.6, end: 20.4, intensity: 1 },
				{ start: 20.4, end: 30, intensity: 0.4 },
			],
			style: "cinematic",
		},
		{ beats: [], duration: 30, sceneCuts: [10, 20] }
	);
	check(
		plan.sections.map((section) => section.start).join(",") === "0,10,20",
		`plan sections align to the picture cuts (${plan.sections.map((section) => section.start).join(", ")})`
	);
	const request = soundtrackRequestSchema.parse(
		soundtrackRequestFromPlan(plan, 30)
	);
	const score = join(directory, "cinematic.wav");
	await run(["ffmpeg", ...soundtrackMediaArgs(request, score)]);
	const scoreStats = await overall(score);
	check(
		Math.abs(scoreStats.duration - 30) < 0.01,
		`planned score lasts 30 s (${scoreStats.duration.toFixed(3)} s)`
	);
	check(
		scoreStats.peakDb < 0,
		`planned score does not clip (peak ${scoreStats.peakDb.toFixed(1)} dBFS)`
	);
	const powers = await windowPowers(score, 0.5);
	/** Mean level in [from, to) seconds. */
	const level = (from: number, to: number) =>
		toDb(mean(powers.slice(Math.round(from * 2), Math.round(to * 2))));
	const quiet = level(1, 9);
	const full = level(11, 19);
	const medium = level(21, 29);
	check(
		full - quiet > 8 && full - medium > 2 && medium - quiet > 2,
		`section loudness follows the plan: 0.15 → ${quiet.toFixed(1)} dB, 1.0 → ${full.toFixed(1)} dB, 0.4 → ${medium.toFixed(1)} dB`
	);
	// Two-second windows either side of each instant; the boundaries carry
	// the largest changes in the score.
	const jumps: { at: number; change: number }[] = [];
	for (let at = 3; at <= 27; at += 0.5) {
		jumps.push({
			at,
			change: Math.abs(level(at, at + 2) - level(at - 2, at)),
		});
	}
	const jumpAt = (time: number) =>
		jumps.find((jump) => jump.at === time)?.change ?? 0;
	const awayFromBoundaries = jumps.filter(
		(jump) => Math.abs(jump.at - 10) > 1.5 && Math.abs(jump.at - 20) > 1.5
	);
	const largestElsewhere = awayFromBoundaries.reduce(
		(largest, jump) => (jump.change > largest.change ? jump : largest),
		{ at: 0, change: 0 }
	);
	check(
		jumpAt(10) > 6 && jumpAt(20) > 3,
		`loudness steps at the boundaries: ${jumpAt(10).toFixed(1)} dB at 10 s, ${jumpAt(20).toFixed(1)} dB at 20 s`
	);
	check(
		jumpAt(10) > largestElsewhere.change &&
			jumpAt(20) > largestElsewhere.change,
		`boundary steps exceed any change inside a section (largest ${largestElsewhere.change.toFixed(1)} dB at ${largestElsewhere.at} s)`
	);

	// 2. Every style renders an audible score with its default band.
	for (const mood of soundtrackMoodSchema.options) {
		const path = join(directory, `style-${mood}.wav`);
		await run([
			"ffmpeg",
			...soundtrackMediaArgs(
				soundtrackRequestSchema.parse({ duration: 4, mood }),
				path
			),
		]);
		const stats = await overall(path);
		check(
			stats.rmsDb > -40 && stats.peakDb < 0,
			`${mood} style is audible and unclipped (RMS ${stats.rmsDb.toFixed(1)} dB, peak ${stats.peakDb.toFixed(1)} dB)`
		);
	}

	// 3. Every SFX kind: audible, unclipped, the requested length, seeded.
	const render = async (kind: SfxKind, seed: number, name: string) => {
		const path = join(directory, `${name}.wav`);
		await run(["ffmpeg", ...sfxMediaArgs(sfxParameters({ kind, seed }), path)]);
		return path;
	};
	for (const kind of sfxKindSchema.options) {
		const parameters = sfxParameters({ kind, seed: 5 });
		const first = await render(kind, 5, `${kind}-a`);
		const again = await render(kind, 5, `${kind}-b`);
		const other = await render(kind, 6, `${kind}-c`);
		const stats = await overall(first);
		check(
			Math.abs(stats.duration - parameters.duration) < 0.002,
			`${kind} lasts ${parameters.duration} s (${stats.duration.toFixed(4)} s)`
		);
		check(
			stats.peakDb > -12 && stats.peakDb < -0.5,
			`${kind} is audible and unclipped (peak ${stats.peakDb.toFixed(1)} dB)`
		);
		const [firstHash, againHash, otherHash] = await Promise.all([
			pcmHash(first),
			pcmHash(again),
			pcmHash(other),
		]);
		check(
			firstHash === againHash && firstHash !== otherHash,
			`${kind} is bit-identical for one seed and differs for another`
		);
	}

	// 4. Bar phase: beats every 60/97.4 s from 0.3 s. Each beat's onset is at
	//    the marker, and the accented pluck lands on every fourth marker.
	const beatSeconds = 60 / 97.4;
	const markers = Array.from(
		{ length: 24 },
		(_, index) => Math.round((0.3 + index * beatSeconds) * 1000) / 1000
	);
	const phased = alignSoundtrackPlan(
		{
			bpm: 100,
			sections: [{ start: 0, end: 16, intensity: 1 }],
			style: "warm",
		},
		{ beats: markers, duration: 16, sceneCuts: [] }
	);
	const phasedRequest = soundtrackRequestSchema.parse({
		...soundtrackRequestFromPlan(phased, 16),
		layers: ["pluck"],
		sections: undefined,
	});
	check(
		phasedRequest.bpm === 97.4 && phasedRequest.downbeatOffset === 0.3,
		`a plan from beat markers keeps 97.4 BPM and a 0.3 s bar phase (got ${phasedRequest.bpm}, ${phasedRequest.downbeatOffset})`
	);
	const phasedPath = join(directory, "phased.wav");
	await run(["ffmpeg", ...soundtrackMediaArgs(phasedRequest, phasedPath)]);
	const slice = 0.01;
	const fine = await windowPowers(phasedPath, slice);
	const at = (time: number) => fine[Math.floor(time / slice)] ?? 0;
	const onsets = markers
		.slice(1, 20)
		.map((time) => toDb(at(time + 0.02)) - toDb(at(time - 0.02)));
	check(
		onsets.every((jump) => jump > 3),
		`each beat starts at its marker (smallest onset jump ${Math.min(...onsets).toFixed(1)} dB)`
	);
	const bar = soundtrackBarSeconds(phasedRequest.bpm);
	const strikes = markers.slice(0, 20).map((time) => toDb(at(time + 0.03)));
	const downbeats = strikes.filter((_, index) => index % 4 === 0);
	const offbeats = strikes.filter((_, index) => index % 4 !== 0);
	check(
		mean(downbeats) - mean(offbeats) > 2,
		`accented bar starts fall on every fourth marker (${(mean(downbeats) - mean(offbeats)).toFixed(1)} dB louder; bar ${bar.toFixed(3)} s)`
	);

	// 5. Synthesis cost stays inside the estimate that decides background jobs.
	const timed = async (name: string, input: unknown) => {
		const request = soundtrackRequestSchema.parse(input);
		const path = join(directory, `${name}.wav`);
		const started = performance.now();
		await run(["ffmpeg", ...soundtrackMediaArgs(request, path)]);
		const elapsed = performance.now() - started;
		const perSecond = elapsed / request.duration;
		const budget = estimatedSynthesisMs(request) / request.duration;
		check(
			perSecond < budget,
			`${name} synthesizes at ${perSecond.toFixed(0)} ms per output second (estimate ${budget} ms)`
		);
	};
	await timed("legacy-warm", { duration: 60, mood: "warm" });
	await timed("full-band-24-sections", {
		duration: 60,
		layers: ["pluck", "pad", "bass", "arpeggio", "kick", "hat", "snare"],
		mood: "upbeat",
		sections: Array.from({ length: 24 }, (_, index) => ({
			start: index * 2.5,
			end: (index + 1) * 2.5,
			intensity: index % 2 ? 1 : 0.4,
		})),
	});
} finally {
	await rm(directory, { force: true, recursive: true });
}
