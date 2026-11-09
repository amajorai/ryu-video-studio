/**
 * Real-FFmpeg proof for nest and decompose (W4-N1).
 *
 * 1. A parent timeline holds a full-frame red clip (0-2 s, track 0, with a
 *    440 Hz tone), a half-size green picture-in-picture clip above it
 *    (0.5-1.5 s, track 1), and an unselected blue clip (2.5-3.5 s). The
 *    render is sampled at the frame centre and corner and for audio level.
 * 2. Nesting only the green picture-in-picture is refused: its opaque
 *    sequence would cover the unselected red clip below it (the corner would
 *    turn black). Nothing is created and the parent keeps its revision.
 * 3. Nesting the red and green clips creates a child project, renders it
 *    through the sequence path, and leaves one sequence clip. The parent's
 *    render matches step 1: red corner, green centre during the overlap,
 *    tone audible in the nested span, blue after it.
 * 4. Trimming the sequence clip's head by 1 s and decomposing it brings the
 *    clips back trimmed: the timeline is black before 1 s and the green
 *    centre and red corner return from 1 to 1.5 s.
 * 5. A second parent hides the picture-in-picture track. Nesting both clips
 *    carries the hidden track into the child, so the parent still renders a
 *    red centre at 1 s.
 *
 * Run: `bun src/verify-nest.ts`
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Asset,
	assetSchema,
	newSegment,
	trimSegment,
	updateTrackSetting,
} from "../../shared/project.ts";
import { probe, runMedia } from "./media.ts";
import { RenderQueue } from "./render.ts";
import { decomposeSequenceClip, nestClips } from "./sequence.ts";
import { StudioStore } from "./store.ts";

interface Rgb {
	blue: number;
	green: number;
	red: number;
}

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

async function importClip(
	store: StudioStore,
	work: string,
	color: string,
	seconds: number
): Promise<Asset> {
	const path = join(work, `${color}.mp4`);
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=c=${color}:s=320x180:r=30:d=${seconds}`,
		"-f",
		"lavfi",
		"-i",
		`sine=frequency=440:duration=${seconds}`,
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-shortest",
		path,
	]);
	const asset = assetSchema.parse({
		...(await probe(path)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name: color,
	});
	await Bun.write(store.mediaPath(asset.id), Bun.file(path));
	store.putAsset(asset);
	return asset;
}

async function render(store: StudioStore, projectId: string): Promise<string> {
	const queue = new RenderQueue(store);
	const job = queue.start(store.project(projectId));
	for (let attempt = 0; attempt < 600; attempt++) {
		const current = store.jobs().find((candidate) => candidate.id === job.id);
		if (current?.status === "completed") {
			return store.renderPath(job.id, current.codec);
		}
		if (current?.status === "failed" || current?.status === "canceled") {
			throw new Error(`Render ${current.status}: ${current.error ?? ""}`);
		}
		await Bun.sleep(100);
	}
	throw new Error("Render timed out.");
}

/** Average RGB of a region (fractions of the frame) at `seconds`. */
async function sample(
	path: string,
	seconds: number,
	region: "centre" | "corner",
	work: string
): Promise<Rgb> {
	const output = join(work, `pixel-${crypto.randomUUID()}.rgb`);
	const crop =
		region === "centre"
			? "crop=iw/10:ih/10:iw*0.45:ih*0.45"
			: "crop=iw/10:ih/10:iw*0.02:ih*0.02";
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-ss",
		String(seconds),
		"-i",
		path,
		"-frames:v",
		"1",
		"-vf",
		`${crop},scale=1:1:flags=area`,
		"-f",
		"rawvideo",
		"-pix_fmt",
		"rgb24",
		output,
	]);
	const [red = 0, green = 0, blue = 0] = new Uint8Array(
		await Bun.file(output).arrayBuffer()
	);
	return { blue, green, red };
}

function dominant(color: Rgb): "black" | "blue" | "green" | "red" {
	const peak = Math.max(color.red, color.green, color.blue);
	if (peak < 40) {
		return "black";
	}
	if (peak === color.red) {
		return "red";
	}
	return peak === color.green ? "green" : "blue";
}

/** RMS level in dBFS of `[start, start + seconds)`. */
async function rmsLevel(
	path: string,
	start: number,
	seconds: number
): Promise<number> {
	const output = await runMedia([
		"-hide_banner",
		"-nostdin",
		"-ss",
		String(start),
		"-t",
		String(seconds),
		"-i",
		path,
		"-vn",
		"-af",
		"astats=metadata=1:reset=0,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
		"-f",
		"null",
		"-",
	]);
	const levels = [
		...output.matchAll(/lavfi\.astats\.Overall\.RMS_level=(\S+)/gu),
	].map((match) => Number(match[1]));
	const last = levels.at(-1);
	return last !== undefined && Number.isFinite(last) ? last : -200;
}

async function expectPicture(
	label: string,
	path: string,
	work: string,
	checks: [seconds: number, region: "centre" | "corner", color: string][]
) {
	for (const [seconds, region, color] of checks) {
		const got = dominant(await sample(path, seconds, region, work));
		ensure(
			got === color,
			`${label}: ${region} at ${seconds}s is ${got}, expected ${color}.`
		);
	}
	console.log(
		`ok ${label}: ${checks.map(([s, r, c]) => `${r}@${s}s=${c}`).join(", ")}`
	);
}

async function main() {
	const work = await mkdtemp(join(tmpdir(), "ryu-verify-nest-"));
	const store = new StudioStore(join(work, "store"));
	try {
		const red = await importClip(store, work, "red", 2);
		const green = await importClip(store, work, "green", 2);
		const blue = await importClip(store, work, "blue", 2);
		const base = { ...newSegment(red, 0, 0), sourceOut: 2 };
		const pip = {
			...newSegment(green, 0.5, 1),
			scale: 0.5,
			sourceOut: 1,
			volume: 0,
		};
		const after = { ...newSegment(blue, 2.5, 0), sourceOut: 1, volume: 0 };
		const parent = store.save({
			...store.create("Nest proof"),
			segments: [base, pip, after],
		});
		const original = await render(store, parent.id);
		const expected: [number, "centre" | "corner", string][] = [
			[0.25, "centre", "red"],
			[1, "centre", "green"],
			[1, "corner", "red"],
			[3, "centre", "blue"],
		];
		await expectPicture("original", original, work, expected);
		const originalTone = await rmsLevel(original, 0.2, 1.5);

		const projectCount = store.projects().length;
		const assetCount = store.assets().length;
		const refusal = await nestClips(store, parent.id, {
			clipIds: [pip.id],
			revision: parent.revision,
		}).then(
			() => "",
			(error: unknown) => String(error)
		);
		ensure(
			refusal.includes("would cover them"),
			`Nesting a picture-in-picture over an unselected clip was not refused: ${refusal || "it succeeded"}.`
		);
		ensure(
			store.projects().length === projectCount &&
				store.assets().length === assetCount &&
				store.project(parent.id).revision === parent.revision,
			"A refused nest left a project, an asset or a revision change behind."
		);
		console.log("ok refused: picture-in-picture over an unselected clip");

		const nested = await nestClips(store, parent.id, {
			clipIds: [base.id, pip.id],
			revision: parent.revision,
		});
		ensure(
			nested.project.segments.length === 2 &&
				nested.sequenceProject.segments.length === 2,
			"Nest did not leave one sequence clip plus the unselected clip."
		);
		const nestedRender = await render(store, parent.id);
		await expectPicture("nested", nestedRender, work, expected);
		const nestedTone = await rmsLevel(nestedRender, 0.2, 1.5);
		ensure(
			Math.abs(nestedTone - originalTone) < 1.5,
			`Nested audio ${nestedTone.toFixed(1)} dB differs from ${originalTone.toFixed(1)} dB.`
		);
		console.log(
			`ok audio: tone ${originalTone.toFixed(1)} dB before, ${nestedTone.toFixed(1)} dB nested`
		);

		const sequence = nested.project.segments.find(
			(segment) => segment.id === nested.clipId
		);
		ensure(sequence, "The sequence clip is missing.");
		const trimmed = trimSegment(sequence, nested.asset.duration, "start", 1);
		const edited = store.save({
			...nested.project,
			segments: nested.project.segments.map((segment) =>
				segment.id === trimmed.id ? trimmed : segment
			),
		});
		const decomposed = decomposeSequenceClip(store, parent.id, {
			clipId: trimmed.id,
			revision: edited.revision,
		});
		ensure(
			decomposed.clipIds.length === 2,
			`Decompose returned ${decomposed.clipIds.length} clips.`
		);
		const restored = await render(store, parent.id);
		await expectPicture("decomposed (head trimmed 1 s)", restored, work, [
			[0.5, "centre", "black"],
			[1.25, "centre", "green"],
			[1.25, "corner", "red"],
			[3, "centre", "blue"],
		]);

		const hiddenPip = { ...pip, id: crypto.randomUUID() };
		const hiddenBase = { ...base, id: crypto.randomUUID() };
		const hiddenParent = store.save(
			updateTrackSetting(
				{
					...store.create("Nest hidden track proof"),
					segments: [hiddenBase, hiddenPip],
				},
				1,
				{ hidden: true }
			)
		);
		const hiddenChecks: [number, "centre" | "corner", string][] = [
			[1, "centre", "red"],
			[1, "corner", "red"],
		];
		await expectPicture(
			"hidden track before nest",
			await render(store, hiddenParent.id),
			work,
			hiddenChecks
		);
		const hiddenNested = await nestClips(store, hiddenParent.id, {
			clipIds: [hiddenBase.id, hiddenPip.id],
			revision: hiddenParent.revision,
		});
		ensure(
			hiddenNested.sequenceProject.trackSettings.some(
				(setting) => setting.track === 1 && setting.hidden
			),
			"The child project lost the hidden track."
		);
		await expectPicture(
			"hidden track after nest",
			await render(store, hiddenParent.id),
			work,
			hiddenChecks
		);
		console.log("verify-nest: all checks passed");
	} finally {
		store.close();
		await rm(work, { force: true, recursive: true });
	}
}

await main();
