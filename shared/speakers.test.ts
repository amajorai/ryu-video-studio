import { describe, expect, test } from "bun:test";
import {
	type Asset,
	type Caption,
	newProject,
	newSegment,
	type Project,
	projectSchema,
	updateTrackSetting,
	validateProject,
} from "./project.ts";
import {
	applySpeakerLabels,
	clusterSpeakers,
	editSpeakers,
	estimatePitch,
	fft,
	kMeans,
	labelsFromSources,
	micDominance,
	paletteColor,
	rmsOf,
	SPEAKER_SAMPLE_RATE,
	segmentLabelsFromSources,
	smoothLabels,
	speakerCandidates,
	speakerColorFor,
	speakerDetectRequestSchema,
	speakerEditRequestSchema,
	speakerUsage,
	speakerWindows,
	voiceFeatures,
} from "./speakers.ts";

const created = "2026-01-01T00:00:00.000Z";
const uuid = (n: number) =>
	`00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function asset(
	id: number,
	kind: Asset["kind"],
	name: string,
	extra: Partial<Asset> = {}
): Asset {
	return {
		createdAt: created,
		duration: 60,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : 1080,
		id: uuid(id),
		kind,
		name,
		width: kind === "audio" ? 0 : 1920,
		...extra,
	};
}

function words(
	captionId: number,
	spans: [number, number][],
	firstWordId: number
): Caption {
	const list = spans.map(([start, end], index) => ({
		end,
		id: uuid(firstWordId + index),
		start,
		text: `w${index}`,
	}));
	return {
		end: spans.at(-1)?.[1] ?? 0,
		id: uuid(captionId),
		start: spans[0]?.[0] ?? 0,
		text: list.map((word) => word.text).join(" "),
		words: list,
	};
}

function baseProject(patch: Partial<Project> = {}): Project {
	return projectSchema.parse({ ...newProject("Speakers"), ...patch });
}

/** Sine-AM "voice": a carrier at `pitch` with a 4 Hz syllable envelope. */
function voice(pitch: number, seconds: number, amplitude = 0.4): Float32Array {
	const samples = new Float32Array(Math.round(seconds * SPEAKER_SAMPLE_RATE));
	for (let index = 0; index < samples.length; index++) {
		const time = index / SPEAKER_SAMPLE_RATE;
		const envelope = 0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * time);
		samples[index] =
			amplitude *
			envelope *
			(Math.sin(2 * Math.PI * pitch * time) +
				0.5 * Math.sin(2 * Math.PI * 2 * pitch * time) +
				0.25 * Math.sin(2 * Math.PI * 3 * pitch * time)) *
			0.6;
	}
	return samples;
}

describe("request schemas", () => {
	test("detect accepts k 2-6 and rejects unknown keys", () => {
		expect(
			speakerDetectRequestSchema.parse({ k: 3, mode: "cluster", revision: 1 })
		).toEqual({ k: 3, mode: "cluster", revision: 1 });
		expect(() =>
			speakerDetectRequestSchema.parse({ k: 7, mode: "cluster", revision: 1 })
		).toThrow();
		expect(() =>
			speakerDetectRequestSchema.parse({
				mode: "mic-dominance",
				revision: 1,
				extra: true,
			})
		).toThrow();
	});
	test("edit is a strict discriminated union", () => {
		expect(
			speakerEditRequestSchema.parse({
				action: "recolor",
				color: "#112233",
				revision: 0,
				speakerId: uuid(1),
			}).action
		).toBe("recolor");
		expect(() =>
			speakerEditRequestSchema.parse({
				action: "rename",
				label: "",
				revision: 0,
				speakerId: uuid(1),
			})
		).toThrow();
	});
});

describe("signal features", () => {
	test("FFT finds a pure tone's bin", () => {
		const size = 64;
		const real = Float64Array.from({ length: size }, (_, index) =>
			Math.cos((2 * Math.PI * 5 * index) / size)
		);
		const imaginary = new Float64Array(size);
		fft(real, imaginary);
		const magnitudes = Array.from(real, (value, index) =>
			Math.hypot(value, imaginary[index] ?? 0)
		);
		expect(magnitudes.indexOf(Math.max(...magnitudes.slice(0, 32)))).toBe(5);
		expect(magnitudes[5]).toBeCloseTo(32, 6);
		expect(() => fft(new Float64Array(6), new Float64Array(6))).toThrow();
	});
	test("autocorrelation pitch tracks low and high voices", () => {
		expect(estimatePitch(voice(110, 0.05), SPEAKER_SAMPLE_RATE)).toBeCloseTo(
			110,
			-1
		);
		expect(estimatePitch(voice(240, 0.05), SPEAKER_SAMPLE_RATE)).toBeCloseTo(
			240,
			-1
		);
		expect(estimatePitch(new Float32Array(800), SPEAKER_SAMPLE_RATE)).toBe(0);
	});
	test("features are null for silence and gain-independent in the mel bands", () => {
		expect(voiceFeatures(new Float32Array(8000))).toBeNull();
		const loud = voiceFeatures(voice(150, 0.4, 0.5));
		const quiet = voiceFeatures(voice(150, 0.4, 0.1));
		expect(loud).not.toBeNull();
		expect(loud?.length).toBe(15);
		for (const [index, value] of (loud ?? []).entries()) {
			expect(value).toBeCloseTo(quiet?.[index] ?? Number.NaN, 3);
		}
		expect(rmsOf([])).toBe(0);
	});
});

describe("assignment", () => {
	test("two synthetic voices cluster into two speakers", () => {
		// Turns of several words, as in conversation.
		const pitches = [
			110, 115, 112, 240, 235, 245, 250, 108, 118, 105, 230, 238,
		];
		const features = pitches.map((pitch, index) =>
			voiceFeatures(voice(pitch, 0.3 + (index % 3) * 0.05))
		);
		const labels = clusterSpeakers(features, 2);
		const low = labels.filter((_, index) => (pitches[index] ?? 0) < 200);
		const high = labels.filter((_, index) => (pitches[index] ?? 0) >= 200);
		expect(new Set(low).size).toBe(1);
		expect(new Set(high).size).toBe(1);
		expect(low[0]).not.toBe(high[0]);
		expect(labels[0]).toBe(0);
	});
	test("null features stay unlabelled and k-means is deterministic", () => {
		const points = [[0], [0.1], [10], [10.2], [0.05]];
		expect(kMeans(points, 2)).toEqual([0, 0, 1, 1, 0]);
		expect(kMeans(points, 2)).toEqual(kMeans(points, 2));
		expect(clusterSpeakers([[0], null, [0.1], [9], [9.1]], 2)).toEqual([
			0,
			null,
			0,
			1,
			1,
		]);
	});
	test("three-word majority smooths a lone flip but not a run", () => {
		expect(smoothLabels([0, 0, 1, 0, 0])).toEqual([0, 0, 0, 0, 0]);
		expect(smoothLabels([0, 1, 1, 0])).toEqual([0, 1, 1, 0]);
		expect(smoothLabels([0, null, 1, null, 0])).toEqual([0, null, 0, null, 0]);
	});
	test("mic dominance picks the loudest source above the floor", () => {
		expect(
			micDominance([
				[
					{ rms: 0.2, sourceKey: "a" },
					{ rms: 0.05, sourceKey: "b" },
				],
				[
					{ rms: 0.01, sourceKey: "a" },
					{ rms: 0.3, sourceKey: "b" },
				],
				[{ rms: 0.0001, sourceKey: "a" }],
				[],
			])
		).toEqual(["a", "b", null, null]);
		expect(
			labelsFromSources(["b", null, "a", "b"], (key) => key.toUpperCase())
		).toEqual({
			labelOfSource: new Map([
				["b", 0],
				["a", 1],
			]),
			labels: [0, null, 1, 0],
			names: ["B", "A"],
		});
	});
});

describe("candidates", () => {
	test("linked mics map through source in and speed, one per physical source", () => {
		const camera = asset(1, "video", "Camera");
		const detached = asset(2, "audio", "Camera audio", {
			derivation: "audio",
			derivedFromAssetId: camera.id,
		});
		const lav = asset(3, "audio", "Lav B");
		const link = uuid(90);
		const project = baseProject({
			segments: [
				{ ...newSegment(camera, 0, 0), id: uuid(10), linkGroupId: link },
				{ ...newSegment(detached, 0, 1), id: uuid(11), linkGroupId: link },
				{
					...newSegment(lav, 2, 2),
					id: uuid(12),
					sourceIn: 5,
					speed: 2,
				},
			],
		});
		const list = speakerCandidates(project, [camera, detached, lav], {
			end: 4,
			start: 3,
		});
		expect(list.map((item) => [item.segmentId, item.sourceKey])).toEqual([
			[uuid(11), camera.id],
			[uuid(12), lav.id],
		]);
		const lavCandidate = list[1];
		expect(lavCandidate?.sourceStart).toBeCloseTo(7, 9);
		expect(lavCandidate?.sourceEnd).toBeCloseTo(9, 9);
		expect(lavCandidate?.label).toBe("Lav B");
		const muted = {
			...project,
			segments: project.segments.map((segment) =>
				segment.id === uuid(12) ? { ...segment, muted: true } : segment
			),
		};
		expect(
			speakerCandidates(muted, [camera, detached, lav], { end: 4, start: 3 })
		).toHaveLength(1);
		const hidden = {
			...project,
			segments: project.segments.map((segment) =>
				segment.id === uuid(12) ? { ...segment, hidden: true } : segment
			),
		};
		expect(
			speakerCandidates(hidden, [camera, detached, lav], { end: 4, start: 3 })
		).toHaveLength(1);
		const hiddenTrack = updateTrackSetting(project, 2, { hidden: true });
		expect(
			speakerCandidates(hiddenTrack, [camera, detached, lav], {
				end: 4,
				start: 3,
			})
		).toHaveLength(1);
	});
	test("multicam member labels name the source", () => {
		const a = asset(1, "audio", "a.wav");
		const b = asset(2, "audio", "b.wav");
		const groupId = uuid(80);
		const project = baseProject({
			multicamGroups: [
				{
					duration: 10,
					id: groupId,
					masterAssetId: a.id,
					members: [
						{ assetId: a.id, kind: "mic", label: "Host", offsetSeconds: 0 },
						{ assetId: b.id, kind: "mic", label: "Guest", offsetSeconds: 0 },
					],
					name: "Pod",
					segmentIds: [uuid(10)],
					start: 0,
					switches: [{ angle: "Host", end: 10, start: 0 }],
				},
			],
			segments: [
				{ ...newSegment(a, 0, 0), id: uuid(10), multicamGroupId: groupId },
				{ ...newSegment(b, 0, 1), id: uuid(11) },
			],
		});
		expect(
			speakerCandidates(project, [a, b], { end: 1, start: 0 }).map(
				(item) => item.label
			)
		).toEqual(["Host", "Guest"]);
	});
});

function labelledFixture() {
	const media = asset(1, "audio", "Mic");
	const project = baseProject({
		captions: [
			words(
				20,
				[
					[0, 0.5],
					[0.5, 1],
					[1, 1.5],
				],
				100
			),
			words(
				21,
				[
					[4, 4.5],
					[4.5, 5],
				],
				110
			),
			{ end: 9, id: uuid(22), start: 8, text: "Hello there" },
		],
		segments: [
			{ ...newSegment(media, 0, 0), id: uuid(10), sourceOut: 3 },
			{ ...newSegment(media, 3, 0), id: uuid(11), sourceIn: 3, sourceOut: 10 },
		],
	});
	return { media, project };
}

describe("writing results", () => {
	test("labels words, caption majority, dominated clips and speakers", () => {
		const { media, project } = labelledFixture();
		const windows = speakerWindows(project);
		expect(windows.map((window) => window.wordId)).toEqual([
			uuid(100),
			uuid(101),
			uuid(102),
			uuid(110),
			uuid(111),
			null,
		]);
		let next = 500;
		const result = applySpeakerLabels(
			project,
			windows,
			[0, 1, 1, 0, 0, null],
			["Ann", "Bo"],
			() => uuid(next++)
		);
		expect(result.assigned).toBe(5);
		expect(result.unassigned).toBe(1);
		expect(result.speakers).toEqual([
			{ color: paletteColor(0), id: uuid(500), label: "Ann" },
			{ color: paletteColor(1), id: uuid(501), label: "Bo" },
		]);
		const [first, second, third] = result.project.captions;
		expect(first?.words?.map((word) => word.speakerId)).toEqual([
			uuid(500),
			uuid(501),
			uuid(501),
		]);
		expect(first?.speakerId).toBe(uuid(501));
		expect(second?.speakerId).toBe(uuid(500));
		expect(third?.speakerId).toBeUndefined();
		expect(result.project.segments.map((segment) => segment.speakerId)).toEqual(
			[uuid(501), uuid(500)]
		);
		// Validates against the frozen schema references.
		expect(() => validateProject(result.project, [media])).not.toThrow();
		expect(speakerColorFor(result.project, uuid(501))).toBe(paletteColor(1));
		expect(speakerUsage(result.project).get(uuid(500))).toEqual({
			clips: 1,
			words: 3,
		});
	});
	test("an evenly split clip gets no speaker", () => {
		const { project } = labelledFixture();
		const windows = speakerWindows(project);
		const result = applySpeakerLabels(
			project,
			windows,
			[0, 0, 1, 1, 0, null],
			[],
			() => crypto.randomUUID()
		);
		// Clip 1 holds 1.0 s of speaker 0 and 0.5 s of speaker 1 (67%).
		expect(result.project.segments[0]?.speakerId).toBe(result.speakers[0]?.id);
		// Clip 2 holds 0.5 s each: no single speaker dominates.
		expect(result.project.segments[1]?.speakerId).toBeUndefined();
		expect(result.speakers.map((speaker) => speaker.label)).toEqual([
			"Speaker 1",
			"Speaker 2",
		]);
	});
	test("re-running keeps ids, colors and custom names by position and clears stale refs", () => {
		const { project } = labelledFixture();
		const windows = speakerWindows(project);
		const first = applySpeakerLabels(
			project,
			windows,
			[0, 1, 1, 0, 0, 1],
			[],
			() => crypto.randomUUID()
		).project;
		const renamed = editSpeakers(first, {
			action: "rename",
			label: "Alice",
			revision: 0,
			speakerId: first.speakers?.[0]?.id ?? "",
		});
		const again = applySpeakerLabels(
			renamed,
			windows,
			[0, 0, 0, 0, 0, 0],
			[],
			() => crypto.randomUUID()
		);
		expect(again.speakers).toEqual([
			{ ...(renamed.speakers?.[0] ?? { color: "", id: "", label: "" }) },
		]);
		expect(again.speakers[0]?.label).toBe("Alice");
		expect(
			again.project.captions.every(
				(caption) => caption.speakerId === again.speakers[0]?.id
			)
		).toBe(true);
	});
	test("mic dominance tags each candidate clip with its own mic, even on a 70/30 split", () => {
		const alice = asset(1, "audio", "Alice lav", { duration: 10 });
		const bob = asset(2, "audio", "Bob lav", { duration: 10 });
		const broll = asset(3, "video", "B-roll", {
			duration: 10,
			hasAudio: false,
		});
		const spans = Array.from({ length: 10 }, (_, index): [number, number] => [
			index,
			index + 1,
		]);
		const project = baseProject({
			captions: [words(20, spans, 100)],
			segments: [
				{ ...newSegment(alice, 0, 0), id: uuid(10) },
				{ ...newSegment(bob, 0, 1), id: uuid(11) },
				{ ...newSegment(broll, 0, 2), id: uuid(12) },
			],
		});
		const windows = speakerWindows(project);
		const candidates = windows.map((window) =>
			speakerCandidates(project, [alice, bob, broll], window)
		);
		const keys = windows.map((_, index) => (index < 7 ? alice.id : bob.id));
		const names = new Map([
			[alice.id, "Alice lav"],
			[bob.id, "Bob lav"],
		]);
		const fromSources = labelsFromSources(
			keys,
			(key) => names.get(key) ?? "Speaker"
		);
		expect([...fromSources.labelOfSource]).toEqual([
			[alice.id, 0],
			[bob.id, 1],
		]);
		const segmentLabels = segmentLabelsFromSources(
			candidates,
			fromSources.labelOfSource
		);
		expect([...segmentLabels]).toEqual([
			[uuid(10), 0],
			[uuid(11), 1],
		]);
		const result = applySpeakerLabels(
			project,
			windows,
			fromSources.labels,
			fromSources.names,
			() => crypto.randomUUID(),
			{ segmentLabels }
		);
		const labelOf = (id: string | undefined) =>
			result.speakers.find((speaker) => speaker.id === id)?.label;
		expect(
			result.project.segments.map((segment) => labelOf(segment.speakerId))
		).toEqual(["Alice lav", "Bob lav", undefined]);
		// Without the mic map, majority overlap would tag both lavs as Alice.
		const majority = applySpeakerLabels(
			project,
			windows,
			fromSources.labels,
			fromSources.names
		);
		expect(
			majority.project.segments.map(
				(segment) =>
					majority.speakers.find((speaker) => speaker.id === segment.speakerId)
						?.label
			)
		).toEqual(["Alice lav", "Alice lav", "Alice lav"]);
	});
	test("re-running matches mic-named speakers by name, not position", () => {
		const { project } = labelledFixture();
		const windows = speakerWindows(project);
		const first = applySpeakerLabels(
			project,
			windows,
			[0, 0, 1, 1, 1, 1],
			["Alice lav", "Bob lav"]
		);
		// Bob's mic is heard first on the second run.
		const second = applySpeakerLabels(
			first.project,
			windows,
			[0, 0, 1, 1, 1, 1],
			["Bob lav", "Alice lav"]
		);
		const firstBy = (label: string) =>
			first.speakers.find((speaker) => speaker.label === label);
		expect(second.speakers).toEqual([
			firstBy("Bob lav") ?? first.speakers[0],
			firstBy("Alice lav") ?? first.speakers[0],
		]);
		expect(second.project.captions[0]?.words?.[0]?.speakerId).toBe(
			firstBy("Bob lav")?.id
		);
		// A new mic name reuses an unmatched speaker but not its old mic name.
		const third = applySpeakerLabels(
			first.project,
			windows,
			[0, 0, 1, 1, 1, 1],
			["Alice lav", "Carol lav"]
		);
		expect(third.speakers.map((speaker) => speaker.label)).toEqual([
			"Alice lav",
			"Bob lav",
		]);
	});
	test("an unmatched old mic name counts as custom only when no run names it", () => {
		const { project } = labelledFixture();
		const windows = speakerWindows(project);
		const first = applySpeakerLabels(
			project,
			windows,
			[0, 0, 1, 1, 1, 1],
			["Alice lav", "Bob lav"]
		);
		const swapped = applySpeakerLabels(
			{
				...first.project,
				speakers: [...(first.speakers ?? [])].reverse(),
			},
			windows,
			[0, 0, 0, 0, 0, 0],
			["Bob lav"]
		);
		expect(swapped.speakers).toEqual([
			first.speakers.find((speaker) => speaker.label === "Bob lav") ??
				first.speakers[0],
		]);
		// New speakers avoid colors already used by reused ones.
		const grown = applySpeakerLabels(
			{ ...first.project, speakers: [first.speakers[1] ?? first.speakers[0]] },
			windows,
			[0, 0, 1, 1, 1, 1],
			["Alice lav", "Bob lav"]
		);
		expect(grown.speakers[1]?.id).toBe(first.speakers[1]?.id);
		expect(grown.speakers[0]?.color).not.toBe(grown.speakers[1]?.color);
	});
	test("clips on locked tracks keep their speaker tags", () => {
		const { project } = labelledFixture();
		const windows = speakerWindows(project);
		const tagged = applySpeakerLabels(
			project,
			windows,
			[0, 0, 0, 0, 0, 0],
			[]
		).project;
		const locked: Project = {
			...tagged,
			segments: tagged.segments.map((segment) =>
				segment.id === uuid(11) ? { ...segment, speakerId: uuid(999) } : segment
			),
			trackSettings: [
				{ locked: true, muted: false, name: "Track 1", solo: false, track: 0 },
			],
		};
		const result = applySpeakerLabels(locked, windows, [1, 1, 1, 1, 1, 1], []);
		expect(result.project.segments).toEqual(locked.segments);
		const fresh = applySpeakerLabels(
			{ ...project, trackSettings: locked.trackSettings },
			windows,
			[0, 0, 0, 0, 0, 0],
			[]
		);
		expect(
			fresh.project.segments.every((segment) => segment.speakerId === undefined)
		).toBe(true);
	});
	test("legacy projects without speakers stay without the field when nothing is heard", () => {
		const { project } = labelledFixture();
		const windows = speakerWindows(project);
		const result = applySpeakerLabels(
			project,
			windows,
			windows.map(() => null),
			[]
		);
		expect("speakers" in result.project).toBe(false);
		expect(result.project).toEqual(project);
	});
	test("labels the active caption track", () => {
		const { project } = labelledFixture();
		const trackId = uuid(70);
		const tracked = {
			...project,
			captionTrackId: trackId,
			captionTracks: [
				{
					captions: [words(30, [[0, 1]], 300)],
					id: trackId,
					label: "French",
					language: "fr",
				},
			],
		};
		const windows = speakerWindows(tracked);
		expect(windows).toHaveLength(1);
		const result = applySpeakerLabels(tracked, windows, [0], [], () =>
			uuid(600)
		);
		expect(result.project.captionTracks[0]?.captions[0]?.speakerId).toBe(
			uuid(600)
		);
		expect(result.project.captions[0]?.speakerId).toBeUndefined();
	});
});

describe("speaker edits", () => {
	function edited() {
		const { project } = labelledFixture();
		let next = 700;
		return applySpeakerLabels(
			project,
			speakerWindows(project),
			[0, 1, 1, 0, 2, 2],
			[],
			() => uuid(next++)
		).project;
	}
	test("rename and recolor change only the target", () => {
		const project = edited();
		const renamed = editSpeakers(project, {
			action: "rename",
			label: "Host",
			revision: 0,
			speakerId: uuid(701),
		});
		expect(renamed.speakers?.map((speaker) => speaker.label)).toEqual([
			"Speaker 1",
			"Host",
			"Speaker 3",
		]);
		const recolored = editSpeakers(renamed, {
			action: "recolor",
			color: "#000000",
			revision: 0,
			speakerId: uuid(700),
		});
		expect(recolored.speakers?.[0]?.color).toBe("#000000");
		expect(() =>
			editSpeakers(project, {
				action: "rename",
				label: "X",
				revision: 0,
				speakerId: uuid(999),
			})
		).toThrow("Choose a speaker");
	});
	test("merge moves every reference and removes merged speakers", () => {
		const project = edited();
		const merged = editSpeakers(project, {
			action: "merge",
			into: uuid(700),
			revision: 0,
			speakerIds: [uuid(701), uuid(702)],
		});
		expect(merged.speakers?.map((speaker) => speaker.id)).toEqual([uuid(700)]);
		const refs = [
			...merged.captions.flatMap((caption) => [
				caption.speakerId,
				...(caption.words ?? []).map((word) => word.speakerId),
			]),
			...merged.segments.map((segment) => segment.speakerId),
		].filter((value) => value !== undefined);
		expect(new Set(refs)).toEqual(new Set([uuid(700)]));
		expect(() =>
			editSpeakers(project, {
				action: "merge",
				into: uuid(700),
				revision: 0,
				speakerIds: [uuid(700)],
			})
		).toThrow();
	});
});
