/**
 * Real-FFmpeg proof for title text to speech. A title layer at 1.5 s is
 * spoken by a real local speech synthesizer (FFmpeg's `flite` source stands
 * in for the node's speech engine; the editor uses Ryu's `media.tts`), the
 * WAV is placed through the sidecar's `title-narration` route, and the
 * project is rendered to MP4 through `buildRender`:
 *
 * - the route puts the narration on track 1 at the title's start, in one
 *   revision, and refuses the stale revision;
 * - the rendered audio is silent before the title and the voice starts at
 *   the title's start plus the WAV's own lead-in (within 90 ms);
 * - the voice ends where the WAV's voice ends, offset by the title start.
 *
 * Run: `bun src/verify-title-narration.ts`
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Asset,
	newSegment,
	projectSchema,
	type Title,
} from "../../shared/project.ts";
import { titleNarrationText } from "../../shared/title-narration.ts";
import { runMedia } from "./media.ts";
import { buildRender } from "./render.ts";
import { routes } from "./routes/title-narration.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const WIDTH = 320;
const HEIGHT = 180;
const TITLE_START = 1.5;
/** Allowed onset error: one silencedetect analysis window plus a frame. */
const ONSET_TOLERANCE = 0.09;

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-title-narration-"));
const results: string[] = [];

async function probeDuration(path: string, audio = false): Promise<number> {
	const output = await runMedia(
		[
			"-v",
			"error",
			...(audio ? ["-select_streams", "a:0"] : []),
			"-show_entries",
			audio ? "stream=duration" : "format=duration",
			"-of",
			"default=noprint_wrappers=1:nokey=1",
			path,
		],
		{ probe: true }
	);
	const seconds = Number(output.trim());
	ensure(Number.isFinite(seconds) && seconds > 0, `no duration for ${path}`);
	return seconds;
}

/** Non-silent spans of the file's audio, as [start, end] seconds. */
async function soundSpans(path: string, total: number): Promise<number[][]> {
	const child = Bun.spawn(
		[
			"ffmpeg",
			"-hide_banner",
			"-i",
			path,
			"-af",
			"silencedetect=noise=-45dB:d=0.05",
			"-f",
			"null",
			"-",
		],
		{ stderr: "pipe", stdout: "ignore" }
	);
	const [log, code] = await Promise.all([
		new Response(child.stderr).text(),
		child.exited,
	]);
	ensure(code === 0, `silencedetect failed: ${log.slice(-400)}`);
	const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((match) =>
		Number(match[1])
	);
	const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((match) =>
		Number(match[1])
	);
	// Sound runs from each silence end to the next silence start.
	const spans: number[][] = [];
	let cursor = starts[0] === 0 || (starts[0] ?? 1) < 0.01 ? null : 0;
	const events = [
		...starts.map((time) => ({ kind: "start" as const, time })),
		...ends.map((time) => ({ kind: "end" as const, time })),
	].sort((left, right) => left.time - right.time);
	for (const event of events) {
		if (event.kind === "start" && cursor !== null) {
			spans.push([cursor, event.time]);
			cursor = null;
		} else if (event.kind === "end") {
			cursor = event.time;
		}
	}
	if (cursor !== null) {
		spans.push([cursor, total]);
	}
	// silencedetect closes an open silence at end of stream; that is not sound.
	return spans.filter(
		([start = 0, end = 0]) => end - start > 0.02 && start < total - 0.02
	);
}

const store = new StudioStore(join(directory, "store"));
const token = crypto.randomUUID();
const app = createStudioServer({ store, token, port: 0, routes });
try {
	const title: Title = {
		animation: "fade",
		color: "#ffffff",
		end: TITLE_START + 2.5,
		fadeIn: 0.2,
		fadeOut: 0.2,
		fontSize: 0.08,
		id: "66666666-6666-4666-8666-666666666666",
		start: TITLE_START,
		text: "Opening night",
		x: 0.5,
		y: 0.5,
	};
	const text = titleNarrationText(title.text);
	ensure(text === "Opening night.", `unexpected narration text: ${text}`);

	const card = join(directory, "card.mp4");
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=c=black:s=${WIDTH}x${HEIGHT}:d=6:r=30`,
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		card,
	]);
	const speech = join(directory, "narration.wav");
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		`flite=text='${text.replace(/'/g, "")}':voice=slt`,
		"-ar",
		"48000",
		"-ac",
		"1",
		speech,
	]);
	const speechSeconds = await probeDuration(speech);
	ensure(speechSeconds > 0.4, `speech is only ${speechSeconds}s`);
	const own = await soundSpans(speech, speechSeconds);
	const ownOnset = own[0]?.[0] ?? 0;
	const ownEnd = own.at(-1)?.[1] ?? speechSeconds;
	ensure(own.length > 0, "the synthesized WAV is silent");
	results.push(
		`flite spoke "${text}" in ${speechSeconds.toFixed(2)} s (voice from ${ownOnset.toFixed(3)} s)`
	);

	const footage: Asset = {
		createdAt: "2026-01-01T00:00:00.000Z",
		duration: 6,
		hasAudio: false,
		height: HEIGHT,
		id: "00000000-0000-4000-8000-0000000000c1",
		kind: "video",
		name: "card.mp4",
		width: WIDTH,
	};
	const narration: Asset = {
		createdAt: "2026-01-01T00:00:00.000Z",
		duration: speechSeconds,
		hasAudio: true,
		height: 0,
		id: "00000000-0000-4000-8000-0000000000c2",
		kind: "audio",
		name: "narration.wav",
		width: 0,
	};
	store.putAsset(footage);
	store.putAsset(narration);
	const created = store.create("Title narration proof");
	const project = store.save({
		...created,
		height: HEIGHT,
		segments: [newSegment(footage, 0, 0)],
		titles: [title],
		width: WIDTH,
	});

	const post = (revision: number) =>
		fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/title-narration`,
			{
				body: JSON.stringify({
					assetId: narration.id,
					revision,
					titleId: title.id,
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
	const response = await post(project.revision);
	ensure(response.ok, `title-narration answered ${response.status}`);
	const placed = projectSchema.parse(await response.json());
	const clip = placed.segments.find(
		(segment) => segment.assetId === narration.id
	);
	ensure(
		clip?.start === TITLE_START && clip.track === 1,
		`narration landed at ${clip?.start} on track ${clip?.track}`
	);
	ensure(
		placed.revision === project.revision + 1,
		"placement was not one revision"
	);
	results.push(
		`route placed the narration at ${TITLE_START.toFixed(2)} s on track 1`
	);
	const stale = await post(project.revision);
	ensure(stale.status === 409, `stale revision answered ${stale.status}`);
	results.push("route refused the stale revision (409)");

	const paths = new Map([
		[footage.id, card],
		[narration.id, speech],
	]);
	const output = join(directory, "narrated.mp4");
	await runMedia(
		[
			...buildRender(placed, [footage, narration], (id) => paths.get(id) ?? ""),
			output,
		],
		{ cwd: directory }
	);
	const total = await probeDuration(output, true);
	const spans = await soundSpans(output, total);
	const first = spans[0];
	ensure(first, "rendered audio has no speech");
	const [onset = 0, offset = 0] = first;
	const expectedOnset = TITLE_START + ownOnset;
	ensure(
		Math.abs(onset - expectedOnset) <= ONSET_TOLERANCE,
		`speech starts at ${onset.toFixed(3)} s, expected ${expectedOnset.toFixed(3)} s`
	);
	results.push(`render is silent until ${onset.toFixed(3)} s, then speaks`);
	const last = spans.at(-1)?.[1] ?? offset;
	const expectedEnd = TITLE_START + ownEnd;
	ensure(
		Math.abs(last - expectedEnd) <= ONSET_TOLERANCE,
		`speech ends at ${last.toFixed(3)} s, expected ${expectedEnd.toFixed(3)} s`
	);
	results.push(
		`speech ends at ${last.toFixed(3)} s, inside the narration clip`
	);
	process.stdout.write(
		`PASS: title text to speech\n${results.map((line) => `  - ${line}`).join("\n")}\n`
	);
} finally {
	app.server.stop(true);
	store.close();
	await rm(directory, { force: true, recursive: true });
}
