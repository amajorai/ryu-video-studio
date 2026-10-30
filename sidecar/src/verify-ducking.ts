/**
 * Real-FFmpeg proof for adjustable ducking. A 440 Hz bed set to "Duck under
 * voice" plays for 8 s under a 1 kHz voice tone from 2 s to 4 s, and the
 * project is exported to WAV through `buildRender`. In the 440 Hz band of
 * the export (the voice filtered out) the bed must dip by the set amount
 * within 0.5 dB while the voice plays, return to full level afterwards, and
 * go down and come back with 10-90% times within 15% (+15 ms) of the set
 * attack and release: the same curves the preview's `setTargetAtTime`
 * draws. A 120-clip timeline exercises the grouped mix with two depths.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ResolvedDuck, resolveDuck } from "../../shared/ducking.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
} from "../../shared/project.ts";
import { buildRender } from "./render.ts";

const RATE = 48_000;
const BED_SECONDS = 8;
const VOICE_START = 2;
const VOICE_SECONDS = 2;

async function run(command: string[], cwd?: string): Promise<Uint8Array> {
	const child = Bun.spawn(command, { cwd, stderr: "pipe", stdout: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).arrayBuffer(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) {
		throw new Error(`${command[0]} exited with ${code}: ${stderr.slice(-800)}`);
	}
	return new Uint8Array(stdout);
}

function ensure(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const audioAsset = (id: string, name: string, duration: number): Asset => ({
	createdAt: "2026-01-01T00:00:00.000Z",
	duration,
	hasAudio: true,
	height: 0,
	id,
	kind: "audio",
	name,
	width: 0,
});
const bed = audioAsset(
	"00000000-0000-4000-8000-0000000000d1",
	"Bed",
	BED_SECONDS
);
const voice = audioAsset(
	"00000000-0000-4000-8000-0000000000d2",
	"Voice",
	VOICE_SECONDS
);

async function tone(path: string, frequency: number, seconds: number) {
	await run([
		"ffmpeg",
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		`sine=frequency=${frequency}:sample_rate=${RATE}:duration=${seconds}`,
		"-af",
		"volume=2",
		path,
	]);
}

/** The export's 440 Hz band as mono float samples. */
async function bedBand(path: string): Promise<Float32Array> {
	const bytes = await run([
		"ffmpeg",
		"-hide_banner",
		"-loglevel",
		"error",
		"-i",
		path,
		"-af",
		"pan=mono|c0=0.5*c0+0.5*c1,lowpass=f=600,lowpass=f=600,lowpass=f=600,lowpass=f=600",
		"-f",
		"f32le",
		"-ar",
		String(RATE),
		"-",
	]);
	return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

function rmsDb(samples: Float32Array, from: number, to: number): number {
	const start = Math.floor(from * RATE);
	const end = Math.min(samples.length, Math.floor(to * RATE));
	let sum = 0;
	for (let index = start; index < end; index++) {
		const sample = samples[index] ?? 0;
		sum += sample * sample;
	}
	return 10 * Math.log10(sum / Math.max(1, end - start));
}

function project(segments: Segment[]): Project {
	return { ...newProject("Ducking proof"), segments };
}

async function exportWav(
	directory: string,
	name: string,
	p: Project,
	assets: Asset[],
	paths: Map<string, string>
): Promise<Float32Array> {
	const output = join(directory, `${name}.wav`);
	await run(
		[
			"ffmpeg",
			...buildRender(
				p,
				assets,
				(id) => paths.get(id) ?? "",
				undefined,
				[],
				undefined,
				{ audioOnly: true, overrides: { container: "wav" } }
			),
			output,
		],
		directory
	);
	return bedBand(output);
}

interface DipResult {
	after: number;
	/** Measured 10-90% times of the dip and the recovery, in ms. */
	attackMs: number;
	before: number;
	during: number;
	releaseMs: number;
}

/**
 * Seconds after `from` at which the dip envelope `e = (1 - g) / cut` first
 * crosses `level` (g is the 440 Hz band's gain against the undipped level,
 * read over 10 ms windows).
 */
function crossing(
	samples: Float32Array,
	from: number,
	level: number,
	rising: boolean,
	reference: number,
	cut: number
): number {
	const step = 0.002;
	for (let at = from; at < BED_SECONDS - 0.01; at += step) {
		const gain = 10 ** ((rmsDb(samples, at, at + 0.01) - reference) / 20);
		const envelope = (1 - gain) / cut;
		if (rising ? envelope >= level : envelope <= level) {
			return at - from;
		}
	}
	return Number.POSITIVE_INFINITY;
}

function measure(samples: Float32Array, duck: ResolvedDuck): DipResult {
	const end = VOICE_START + VOICE_SECONDS;
	const before = rmsDb(samples, 0.3, VOICE_START - 0.2);
	const cut = 1 - 10 ** (-duck.amountDb / 20);
	const time = (from: number, rising: boolean) =>
		(crossing(samples, from, rising ? 0.9 : 0.1, rising, before, cut) -
			crossing(samples, from, rising ? 0.1 : 0.9, rising, before, cut)) *
		1000;
	return {
		after: rmsDb(
			samples,
			end + 0.3 + (duck.releaseMs / 1000) * 2,
			BED_SECONDS - 0.1
		),
		attackMs: time(VOICE_START - 0.05, true),
		before,
		during: rmsDb(samples, VOICE_START + 0.6, end - 0.1),
		releaseMs: time(end - 0.05, false),
	};
}

async function single(
	directory: string,
	paths: Map<string, string>,
	ducking: Segment["ducking"]
): Promise<DipResult & { duck: ResolvedDuck }> {
	const duck = resolveDuck(ducking);
	const samples = await exportWav(
		directory,
		`single-${duck.amountDb}-${duck.attackMs}-${duck.releaseMs}`,
		project([
			{
				...newSegment(bed, 0, 0),
				duckUnderVoice: true,
				...(ducking ? { ducking } : {}),
				sourceOut: BED_SECONDS,
			},
			{
				...newSegment(voice, VOICE_START, 1),
				sourceOut: VOICE_SECONDS,
			},
		]),
		[bed, voice],
		paths
	);
	const result = measure(samples, duck);
	const dip = result.before - result.during;
	ensure(
		Math.abs(dip - duck.amountDb) <= 0.5,
		`${duck.amountDb} dB duck dipped ${dip.toFixed(2)} dB`
	);
	ensure(
		Math.abs(result.before - result.after) <= 0.3,
		`bed did not recover after the voice (${result.before.toFixed(2)} vs ${result.after.toFixed(2)} dB)`
	);
	for (const [name, measured, set] of [
		["attack", result.attackMs, duck.attackMs],
		["release", result.releaseMs, duck.releaseMs],
	] as const) {
		ensure(
			Math.abs(measured - set) <= set * 0.15 + 15,
			`${name} took ${measured.toFixed(1)} ms, set to ${set} ms`
		);
	}
	return { ...result, duck };
}

/**
 * Two groups of ducked clips with different depths over a timeline long
 * enough for the grouped mix: one-second voice blips every other second.
 */
async function grouped(directory: string, paths: Map<string, string>) {
	const clips: Segment[] = [];
	const shortVoice = audioAsset(
		"00000000-0000-4000-8000-0000000000d3",
		"Blip",
		1
	);
	const shortBed = audioAsset("00000000-0000-4000-8000-0000000000d4", "Bed", 2);
	for (let index = 0; index < 60; index++) {
		const start = index * 2;
		clips.push(
			{
				...newSegment(shortBed, start, 0),
				duckUnderVoice: true,
				ducking: { amountDb: index < 30 ? 6 : 18 },
				id: `60000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
				sourceOut: 2,
			},
			{
				...newSegment(shortVoice, start + 0.5, 1),
				id: `61000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
				sourceOut: 1,
			}
		);
	}
	paths.set(shortVoice.id, paths.get(voice.id) ?? "");
	paths.set(shortBed.id, paths.get(bed.id) ?? "");
	const samples = await exportWav(
		directory,
		"grouped",
		project(clips),
		[shortVoice, shortBed],
		paths
	);
	const dipAt = (start: number) =>
		rmsDb(samples, start + 0.05, start + 0.4) -
		rmsDb(samples, start + 0.8, start + 1.45);
	const early = dipAt(10);
	const late = dipAt(100);
	ensure(Math.abs(early - 6) <= 0.6, `grouped 6 dB dipped ${early.toFixed(2)}`);
	ensure(Math.abs(late - 18) <= 0.6, `grouped 18 dB dipped ${late.toFixed(2)}`);
	return { early, late };
}

async function main() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-verify-ducking-"));
	try {
		const bedPath = join(directory, "bed.wav");
		const voicePath = join(directory, "voice.wav");
		await tone(bedPath, 440, BED_SECONDS);
		await tone(voicePath, 1000, VOICE_SECONDS);
		const paths = new Map([
			[bed.id, bedPath],
			[voice.id, voicePath],
		]);
		const results = [
			await single(directory, paths, undefined),
			await single(directory, paths, { amountDb: 6 }),
			await single(directory, paths, {
				amountDb: 18,
				attackMs: 80,
				releaseMs: 100,
			}),
			await single(directory, paths, {
				amountDb: 12,
				attackMs: 40,
				releaseMs: 1500,
			}),
		];
		const groupedDips = await grouped(directory, paths);
		for (const result of results) {
			const { amountDb, attackMs, releaseMs } = result.duck;
			console.info(
				`duck ${amountDb} dB, attack ${attackMs} ms, release ${releaseMs} ms: ` +
					`before ${result.before.toFixed(2)}, during ${result.during.toFixed(2)} ` +
					`(dip ${(result.before - result.during).toFixed(2)} dB), after ${result.after.toFixed(2)} dBFS; ` +
					`measured attack ${result.attackMs.toFixed(1)} ms, release ${result.releaseMs.toFixed(1)} ms`
			);
		}
		console.info(
			`grouped mix (120 clips): dips ${groupedDips.early.toFixed(2)} dB and ${groupedDips.late.toFixed(2)} dB`
		);
		console.info("verify-ducking: ok");
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

await main();
