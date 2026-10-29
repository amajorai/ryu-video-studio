import { describe, expect, test } from "bun:test";
import { MAX_TRACK_INDEX } from "./limits.ts";
import {
	type Asset,
	type Caption,
	newProject,
	newSegment,
	type Project,
	type Segment,
	sameMediaTimebase,
	sharesSourceTime,
	updateTrackSetting,
	validateProject,
} from "./project.ts";
import {
	applySplitEdit,
	applySplitEditRequest,
	applySplitEdits,
	applySplitEditsRequestSchema,
	type CutPoint,
	findCutPoints,
	proposeSplitEdits,
	resolveCutForClip,
	type SplitEditEvidence,
	scanCutPoints,
	speechEvidenceFromTranscript,
	splitEditRequestSchema,
} from "./split-edits.ts";

function camera(name: string, duration = 10): Asset {
	return {
		createdAt: new Date().toISOString(),
		duration,
		hasAudio: true,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video",
		name,
		width: 640,
	};
}

function extracted(video: Asset): Asset {
	return {
		createdAt: new Date().toISOString(),
		derivation: "audio",
		derivedFromAssetId: video.id,
		duration: video.duration,
		hasAudio: true,
		height: 0,
		id: crypto.randomUUID(),
		kind: "audio",
		name: `${video.name} audio`,
		width: 0,
	};
}

interface Take {
	audio: Asset;
	video: Asset;
}

function take(name: string, duration = 10): Take {
	const video = camera(name, duration);
	return { audio: extracted(video), video };
}

/** One linked camera clip: picture on track 0, detached audio on `audioTrack`. */
function linked(
	source: Take,
	start: number,
	sourceIn: number,
	sourceOut: number,
	options: { audioTrack?: number; speed?: number; visual?: Asset } = {}
): [Segment, Segment] {
	const groupId = crypto.randomUUID();
	const speed = options.speed ?? 1;
	const range = { sourceIn, sourceOut, speed, linkGroupId: groupId };
	return [
		{
			...newSegment(options.visual ?? source.video, start, 0),
			...range,
			volume: 0,
		},
		{ ...newSegment(source.audio, start, options.audioTrack ?? 1), ...range },
	];
}

const assetsOf = (...takes: Take[]) =>
	takes.flatMap((item) => [item.video, item.audio]);

function timeline(segments: Segment[], assets: Asset[], title = "Split edits") {
	return validateProject({ ...newProject(title), segments }, assets);
}

/** Interview A (source 2..6) cuts at 4s to interview B (source 3..7). */
function interview() {
	const a = take("A");
	const b = take("B");
	const [aVideo, aAudio] = linked(a, 0, 2, 6);
	const [bVideo, bAudio] = linked(b, 4, 3, 7);
	const assets = assetsOf(a, b);
	return {
		a,
		aAudio,
		aVideo,
		assets,
		b,
		bAudio,
		bVideo,
		project: timeline([aVideo, aAudio, bVideo, bAudio], assets),
	};
}

function segment(project: Project, id: string) {
	const found = project.segments.find((item) => item.id === id);
	if (!found) {
		throw new Error("missing segment");
	}
	return found;
}

function onlyCut(project: Project, assets: Asset[]): CutPoint {
	const [cut] = findCutPoints(project, assets);
	if (!cut) {
		throw new Error("missing cut");
	}
	return cut;
}

function word(start: number, end: number, text = "word"): Caption {
	return { end, id: crypto.randomUUID(), start, text };
}

function evidence(
	words: Record<string, Caption[]>,
	waveforms: Record<string, { bins: number[]; duration: number }> = {},
	measured = true
): SplitEditEvidence {
	return {
		waveformFor: (id) => waveforms[id],
		wordsFor: (id) => (words[id] ? { measured, words: words[id] } : undefined),
	};
}

describe("findCutPoints", () => {
	test("finds one cut between two adjacent linked groups", () => {
		const { project, assets, aVideo, bVideo } = interview();
		const cuts = findCutPoints(project, assets);
		expect(cuts).toHaveLength(1);
		expect(cuts[0]).toMatchObject({
			continuousSource: false,
			currentOffset: 0,
			handles: { inAudioBefore: 3, outAudioAfter: 4 },
			key: `${aVideo.linkGroupId}>${bVideo.linkGroupId}`,
			time: 4,
			videoTrack: 0,
		});
	});

	test("ignores a gap wider than one frame", () => {
		const a = take("A");
		const b = take("B");
		const assets = assetsOf(a, b);
		const project = timeline(
			[...linked(a, 0, 2, 6), ...linked(b, 4.1, 3, 7)],
			assets
		);
		expect(findCutPoints(project, assets)).toEqual([]);
	});

	test("marks a split of one take as continuous source", () => {
		const a = take("A");
		const assets = assetsOf(a);
		const project = timeline(
			[...linked(a, 0, 2, 6), ...linked(a, 4, 6, 9)],
			assets
		);
		expect(onlyCut(project, assets).continuousSource).toBe(true);
	});

	test("skips groups with more than one audio or visual member", () => {
		const { project, assets, a, aVideo } = interview();
		const extra = {
			...newSegment(a.audio, 0, 2),
			linkGroupId: aVideo.linkGroupId,
			sourceIn: 2,
			sourceOut: 6,
		};
		const complex = timeline([...project.segments, extra], assets);
		const scan = scanCutPoints(complex, assets);
		expect(scan.cuts).toEqual([]);
		expect(scan.skipped).toEqual([
			{ key: expect.stringContaining(">"), reason: "complex-group" },
		]);
	});

	test("skips cuts that touch a locked track", () => {
		const { project, assets } = interview();
		const locked = updateTrackSetting(project, 1, { locked: true });
		const scan = scanCutPoints(locked, assets);
		expect(scan.cuts).toEqual([]);
		expect(scan.skipped[0]?.reason).toBe("locked-track");
	});

	test("measures handles in timeline seconds at 2x speed", () => {
		const a = take("A");
		const b = take("B");
		const assets = assetsOf(a, b);
		const project = timeline(
			[
				...linked(a, 0, 2, 8, { speed: 2 }),
				...linked(b, 3, 3, 7, { speed: 2 }),
			],
			assets
		);
		expect(onlyCut(project, assets).handles).toEqual({
			inAudioBefore: 1.5,
			outAudioAfter: 1,
		});
	});
});

describe("applySplitEdit", () => {
	test("a J-cut extends the incoming audio head, trims the outgoing tail, and re-bases keyframes", () => {
		const { project, assets, aAudio, bAudio, aVideo, bVideo } = interview();
		const keyed = timeline(
			project.segments.map((item) => {
				if (item.id === bAudio.id) {
					return {
						...item,
						keyframes: [
							{
								id: crypto.randomUUID(),
								property: "volume" as const,
								time: 1,
								value: 0.5,
							},
						],
					};
				}
				if (item.id === aAudio.id) {
					return {
						...item,
						keyframes: [
							{
								id: crypto.randomUUID(),
								property: "volume" as const,
								time: 3.8,
								value: 0.2,
							},
						],
					};
				}
				return item;
			}),
			assets
		);
		const result = applySplitEdit(keyed, assets, onlyCut(keyed, assets), {
			crossfade: 0,
			offset: -0.5,
		});
		expect(result.appliedOffset).toBe(-0.5);
		const incoming = segment(result.project, bAudio.id);
		const outgoing = segment(result.project, aAudio.id);
		expect(incoming.start).toBe(3.5);
		expect(incoming.sourceIn).toBe(2.5);
		expect(outgoing.sourceOut).toBe(5.5);
		expect(
			incoming.keyframes.map((frame) => [frame.time, frame.value])
		).toEqual([
			[0, 1],
			[0.5, 1],
			[1.5, 0.5],
		]);
		expect(outgoing.keyframes.map((frame) => frame.time)).toEqual([3.5]);
		expect(outgoing.fadeOut).toBe(0.01);
		expect(incoming.fadeIn).toBe(0.01);
		expect(segment(result.project, aVideo.id)).toEqual(aVideo);
		expect(segment(result.project, bVideo.id)).toEqual(bVideo);
	});

	test("an L-cut mirrors the roll and doubles source movement at 2x speed", () => {
		const a = take("A");
		const b = take("B");
		const assets = assetsOf(a, b);
		const [aVideo, aAudio] = linked(a, 0, 2, 8, { speed: 2 });
		const [bVideo, bAudio] = linked(b, 3, 3, 9, { speed: 2 });
		const project = timeline([aVideo, aAudio, bVideo, bAudio], assets);
		const result = applySplitEdit(project, assets, onlyCut(project, assets), {
			crossfade: 0,
			offset: 0.5,
		});
		expect(result.appliedOffset).toBe(0.5);
		expect(segment(result.project, aAudio.id).sourceOut).toBe(9);
		expect(segment(result.project, bAudio.id)).toMatchObject({
			sourceIn: 4,
			start: 3.5,
		});
	});

	test("clamps to the available source handle", () => {
		const a = take("A");
		const b = take("B");
		const assets = assetsOf(a, b);
		const [bVideo, bAudio] = linked(b, 4, 0.2, 4.2);
		const project = timeline([...linked(a, 0, 2, 6), bVideo, bAudio], assets);
		const result = applySplitEdit(project, assets, onlyCut(project, assets), {
			crossfade: 0,
			offset: -1,
		});
		expect(result.appliedOffset).toBe(-0.2);
		expect(segment(result.project, bAudio.id)).toMatchObject({
			sourceIn: 0,
			start: 3.8,
		});
	});

	test("offset 0 restores the straight cut and a repeated offset is idempotent", () => {
		const { project, assets, aAudio, bAudio } = interview();
		const once = applySplitEdit(project, assets, onlyCut(project, assets), {
			crossfade: 0.1,
			offset: -0.5,
		}).project;
		const twice = applySplitEdit(once, assets, onlyCut(once, assets), {
			crossfade: 0.1,
			offset: -0.5,
		}).project;
		expect(twice.segments).toEqual(once.segments);
		expect(onlyCut(once, assets).currentOffset).toBe(-0.5);
		const restored = applySplitEdit(once, assets, onlyCut(once, assets), {
			crossfade: 0,
			offset: 0,
		}).project;
		expect(segment(restored, aAudio.id)).toEqual(aAudio);
		expect(segment(restored, bAudio.id)).toEqual(bAudio);
	});

	test("a crossfade overlaps each side by half and sets matching fades", () => {
		const { project, assets, aAudio, bAudio } = interview();
		const result = applySplitEdit(project, assets, onlyCut(project, assets), {
			crossfade: 0.1,
			offset: -0.5,
		}).project;
		const outgoing = segment(result, aAudio.id);
		const incoming = segment(result, bAudio.id);
		expect(outgoing.sourceOut).toBe(5.55);
		expect(incoming.start).toBe(3.45);
		expect(outgoing.fadeOut).toBeCloseTo(0.1, 6);
		expect(incoming.fadeIn).toBeCloseTo(0.1, 6);
		expect(incoming.track).toBe(outgoing.track);
	});

	test("only extends the side that has handle for the crossfade", () => {
		const a = take("A");
		const b = take("B");
		const assets = assetsOf(a, b);
		const [aVideo, aAudio] = linked(a, 0, 6, 10);
		const [bVideo, bAudio] = linked(b, 4, 3, 7);
		const project = timeline([aVideo, aAudio, bVideo, bAudio], assets);
		const result = applySplitEdit(project, assets, onlyCut(project, assets), {
			crossfade: 0.2,
			offset: 0,
		}).project;
		expect(segment(result, aAudio.id).sourceOut).toBe(10);
		expect(segment(result, bAudio.id).start).toBe(3.9);
		expect(segment(result, bAudio.id).fadeIn).toBeCloseTo(0.1, 6);
		expect(onlyCut(result, assets).currentOffset).toBe(0);
	});

	test("moves the incoming audio to a free track when its extension collides", () => {
		const a = take("A");
		const b = take("B");
		const music = take("Music");
		const assets = assetsOf(a, b, music);
		const [aVideo, aAudio] = linked(a, 0, 2, 6);
		const [bVideo, bAudio] = linked(b, 4, 3, 7, { audioTrack: 2 });
		const bed = { ...newSegment(music.audio, 1, 2), sourceOut: 2.8 };
		const project = timeline([aVideo, aAudio, bVideo, bAudio, bed], assets);
		const result = applySplitEdit(project, assets, onlyCut(project, assets), {
			crossfade: 0,
			offset: -0.5,
		}).project;
		expect(segment(result, bAudio.id).track).toBe(3);
		expect(segment(result, bed.id)).toEqual(bed);
	});

	test("throws when no audio track is free", () => {
		const a = take("A");
		const b = take("B");
		const music = take("Music");
		const assets = assetsOf(a, b, music);
		const [aVideo, aAudio] = linked(a, 0, 2, 6);
		const [bVideo, bAudio] = linked(b, 4, 3, 7, { audioTrack: 2 });
		const bed = { ...newSegment(music.audio, 1, 2), sourceOut: 2.8 };
		const sting = { ...newSegment(music.audio, 5, 1), sourceOut: 1 };
		let project = timeline(
			[aVideo, aAudio, bVideo, bAudio, bed, sting],
			assets
		);
		for (let track = 3; track <= MAX_TRACK_INDEX; track += 1) {
			project = updateTrackSetting(project, track, { locked: true });
		}
		expect(() =>
			applySplitEdit(project, assets, onlyCut(project, assets), {
				crossfade: 0,
				offset: -0.5,
			})
		).toThrow("No free audio track for the split edit.");
	});

	test("searches every track up to the shared track limit", () => {
		const a = take("A");
		const b = take("B");
		const music = take("Music");
		const assets = assetsOf(a, b, music);
		const [aVideo, aAudio] = linked(a, 0, 2, 6);
		const [bVideo, bAudio] = linked(b, 4, 3, 7, { audioTrack: 2 });
		const bed = { ...newSegment(music.audio, 1, 2), sourceOut: 2.8 };
		const sting = { ...newSegment(music.audio, 5, 1), sourceOut: 1 };
		let project = timeline(
			[aVideo, aAudio, bVideo, bAudio, bed, sting],
			assets
		);
		for (let track = 3; track <= 20; track += 1) {
			project = updateTrackSetting(project, track, { locked: true });
		}
		const result = applySplitEdit(project, assets, onlyCut(project, assets), {
			crossfade: 0,
			offset: -0.5,
		}).project;
		expect(segment(result, bAudio.id).track).toBe(21);
	});

	test("treats an image as the visual member and rolls only the audio", () => {
		const a = take("A");
		const b = take("B");
		const still: Asset = {
			...camera("Still", 0),
			hasAudio: false,
			kind: "image",
		};
		const assets = [...assetsOf(a, b), still];
		const [aVideo, aAudio] = linked(a, 0, 0, 4, { visual: still });
		const [bVideo, bAudio] = linked(b, 4, 3, 8, { visual: still });
		const project = timeline(
			[
				{ ...aVideo, sourceIn: 0, sourceOut: 4 },
				aAudio,
				{ ...bVideo, sourceIn: 0, sourceOut: 5 },
				bAudio,
			],
			assets
		);
		const cut = onlyCut(project, assets);
		expect(cut.outgoing.audio.id).toBe(aAudio.id);
		expect(cut.incoming.audio.id).toBe(bAudio.id);
		const result = applySplitEdit(project, assets, cut, {
			crossfade: 0,
			offset: 0.5,
		});
		expect(segment(result.project, aAudio.id).sourceOut).toBe(4.5);
		expect(segment(result.project, aVideo.id).sourceOut).toBe(4);
	});

	test("clamps the new fade so fadeIn plus fadeOut fits the clip", () => {
		const a = take("A");
		const b = take("B");
		const assets = assetsOf(a, b);
		const [aVideo, aAudio] = linked(a, 0, 2, 6);
		const [bVideo, bAudio] = linked(b, 4, 3, 3.5);
		const project = timeline(
			[aVideo, aAudio, bVideo, { ...bAudio, fadeOut: 0.45 }],
			assets
		);
		const result = applySplitEdit(project, assets, onlyCut(project, assets), {
			crossfade: 0.4,
			offset: 0,
		}).project;
		const incoming = segment(result, bAudio.id);
		expect(incoming.start).toBe(3.8);
		expect(incoming.fadeIn + incoming.fadeOut).toBeLessThanOrEqual(0.7 + 1e-9);
		expect(incoming.fadeOut).toBe(0.45);
		expect(() => validateProject(result, assets)).not.toThrow();
	});

	test("applies manual requests by clip and batches proposals in time order", () => {
		const a = take("A");
		const b = take("B");
		const c = take("C");
		const assets = assetsOf(a, b, c);
		const [aVideo, aAudio] = linked(a, 0, 2, 6);
		const [bVideo, bAudio] = linked(b, 4, 3, 7);
		const [cVideo, cAudio] = linked(c, 8, 3, 7);
		const project = timeline(
			[aVideo, aAudio, bVideo, bAudio, cVideo, cAudio],
			assets
		);
		const second = resolveCutForClip(project, assets, bVideo.id, 7.5);
		expect(second.key).toBe(`${bVideo.linkGroupId}>${cVideo.linkGroupId}`);
		const manual = applySplitEditRequest(
			project,
			assets,
			{ clipId: bAudio.id, kind: "l", offset: 0.5, revision: 0 },
			8
		);
		expect(manual.key).toBe(second.key);
		expect(segment(manual.project, bAudio.id).sourceOut).toBe(7.54);
		const [first] = findCutPoints(project, assets);
		const batch = applySplitEdits(
			project,
			assets,
			[
				{ key: second.key, offset: 0.5 },
				{ key: first?.key ?? "", offset: -3 },
				{ key: `${cVideo.linkGroupId}>${aVideo.linkGroupId}`, offset: 1 },
			],
			{ crossfade: 0 }
		);
		expect(batch.applied).toEqual([
			{ key: first?.key ?? "", offset: -3 },
			{ key: second.key, offset: 0.5 },
		]);
		expect(batch.skipped).toEqual([
			{
				key: `${cVideo.linkGroupId}>${aVideo.linkGroupId}`,
				reason: "missing-cut",
			},
		]);
		expect(segment(batch.project, bAudio.id)).toMatchObject({
			sourceIn: 0,
			sourceOut: 7.5,
			start: 1,
		});
		expect(() =>
			applySplitEdits(project, assets, [
				{ key: second.key, offset: 1 },
				{ key: second.key, offset: 1 },
			])
		).toThrow("Choose each cut once.");
	});

	test("request schemas bound offsets, crossfades and batch size", () => {
		expect(() =>
			splitEditRequestSchema.parse({ kind: "j", offset: 1, revision: 0 })
		).toThrow();
		expect(() =>
			splitEditRequestSchema.parse({
				clipId: crypto.randomUUID(),
				kind: "l",
				offset: 4.5,
				revision: 0,
			})
		).toThrow();
		const key = `${crypto.randomUUID()}>${crypto.randomUUID()}`;
		expect(
			applySplitEditsRequestSchema.parse({
				crossfade: 0.5,
				proposals: [{ key, offset: -4 }],
				revision: 3,
			}).proposals
		).toHaveLength(1);
		expect(() =>
			applySplitEditsRequestSchema.parse({
				proposals: Array.from({ length: 501 }, () => ({ key, offset: 0 })),
				revision: 0,
			})
		).toThrow();
	});
});

describe("proposeSplitEdits", () => {
	test("proposes an L-cut when outgoing speech runs past the cut", () => {
		const { project, assets, a, b } = interview();
		const { proposals } = proposeSplitEdits(
			project,
			assets,
			evidence({
				[a.audio.id]: [word(4.8, 5.5), word(5.6, 6.6)],
				[b.audio.id]: [],
			})
		);
		expect(proposals[0]?.kind).toBe("l");
		expect(proposals[0]?.reason).toBe("clipped-outgoing-speech");
		expect(proposals[0]?.offset).toBeCloseTo(0.68, 6);
		expect(proposals[0]?.evidence).toEqual({
			inWords: 0,
			outWords: 1,
			source: "transcript",
		});
		expect(proposals[0]?.confidence).toBeGreaterThanOrEqual(0.7);
	});

	test("proposes a J-cut when incoming speech starts before its picture", () => {
		const { project, assets, a, b } = interview();
		const [proposal] = proposeSplitEdits(
			project,
			assets,
			evidence({ [a.audio.id]: [word(3, 5)], [b.audio.id]: [word(2.6, 3.5)] })
		).proposals;
		expect(proposal?.kind).toBe("j");
		expect(proposal?.reason).toBe("clipped-incoming-speech");
		expect(proposal?.offset).toBeCloseTo(-0.48, 6);
	});

	test("shortens an L-cut so the incoming speaker stays audible", () => {
		const { project, assets, a, b } = interview();
		const [proposal] = proposeSplitEdits(
			project,
			assets,
			evidence({
				[a.audio.id]: [word(5.6, 6.6)],
				[b.audio.id]: [word(3.4, 4)],
			})
		).proposals;
		expect(proposal?.kind).toBe("l");
		expect(proposal?.offset).toBeCloseTo(0.32, 6);
	});

	test("leaves overlapping dialogue to the editor", () => {
		const { project, assets, a, b } = interview();
		const [proposal] = proposeSplitEdits(
			project,
			assets,
			evidence({
				[a.audio.id]: [word(5.5, 6.5)],
				[b.audio.id]: [word(2.5, 3.5)],
			})
		).proposals;
		expect(proposal).toMatchObject({
			kind: "none",
			offset: 0,
			reason: "both-sides-speaking",
		});
	});

	test("reports no-handle when neither source extends past the cut", () => {
		const a = take("A");
		const b = take("B");
		const assets = assetsOf(a, b);
		const project = timeline(
			[...linked(a, 0, 6, 10), ...linked(b, 4, 0, 4)],
			assets
		);
		const [proposal] = proposeSplitEdits(
			project,
			assets,
			evidence({ [a.audio.id]: [word(9, 10)], [b.audio.id]: [] })
		).proposals;
		expect(proposal?.reason).toBe("no-handle");
		expect(proposal?.kind).toBe("none");
	});

	test("caps confidence for cue-only transcripts", () => {
		const { project, assets, a, b } = interview();
		const [proposal] = proposeSplitEdits(
			project,
			assets,
			evidence(
				{ [a.audio.id]: [word(5, 6.6), word(6.7, 6.9)], [b.audio.id]: [] },
				{},
				false
			)
		).proposals;
		expect(proposal?.kind).toBe("l");
		expect(proposal?.confidence).toBeLessThanOrEqual(0.5);
	});

	test("falls back to waveform energy for an L-cut", () => {
		const { project, assets, a, b } = interview();
		const outBins = Array.from({ length: 100 }, (_, index) =>
			index < 65 ? 0.6 : 0.01
		);
		const inBins = Array.from({ length: 100 }, (_, index) =>
			index >= 50 ? 0.6 : 0.01
		);
		const [proposal] = proposeSplitEdits(
			project,
			assets,
			evidence(
				{},
				{
					[a.audio.id]: { bins: outBins, duration: 10 },
					[b.audio.id]: { bins: inBins, duration: 10 },
				}
			)
		).proposals;
		expect(proposal).toMatchObject({
			evidence: { source: "waveform" },
			kind: "l",
			reason: "energy-tail",
		});
		expect(proposal?.offset).toBeCloseTo(0.5, 6);
		expect(proposal?.confidence).toBeLessThanOrEqual(0.4);
	});

	test("refuses to guess from a coarse waveform", () => {
		const { project, assets, a, b } = interview();
		const [proposal] = proposeSplitEdits(
			project,
			assets,
			evidence(
				{},
				{
					[a.audio.id]: { bins: [0.6, 0.6, 0.01], duration: 10 },
					[b.audio.id]: { bins: [0.01, 0.6, 0.6], duration: 10 },
				}
			)
		).proposals;
		expect(proposal?.reason).toBe("no-evidence");
		expect(proposal?.kind).toBe("none");
	});

	test("resolves transcripts through the parent of a derived audio asset", () => {
		const { project, assets, a, b } = interview();
		const [proposal] = proposeSplitEdits(
			project,
			assets,
			evidence({
				[a.video.id]: [word(5.6, 6.6)],
				[b.video.id]: [],
			})
		).proposals;
		expect(proposal?.kind).toBe("l");
		expect(
			speechEvidenceFromTranscript({
				assetId: a.video.id,
				cues: [word(0, 4)],
				duration: 10,
				nextOffset: 10,
				origin: "ryu-transcription",
				revision: 1,
				status: "completed",
				timing: "segments",
				updatedAt: new Date().toISOString(),
				words: [],
			})?.measured
		).toBe(false);
	});

	test("caps proposals at maxOffset", () => {
		const { project, assets, a, b } = interview();
		const [proposal] = proposeSplitEdits(
			project,
			assets,
			evidence({ [a.audio.id]: [word(5, 9)], [b.audio.id]: [] }),
			{ maxOffset: 0.5 }
		).proposals;
		expect(proposal?.offset).toBe(0.5);
	});

	test("skips continuous sources and existing split edits unless replacing", () => {
		const { project, assets, a, b } = interview();
		const words = evidence({
			[a.audio.id]: [word(5.6, 6.6)],
			[b.audio.id]: [],
		});
		const split = applySplitEdit(project, assets, onlyCut(project, assets), {
			offset: -0.5,
		}).project;
		expect(proposeSplitEdits(split, assets, words).proposals[0]?.reason).toBe(
			"already-split"
		);
		expect(
			proposeSplitEdits(split, assets, words, { replaceExisting: true })
				.proposals[0]?.kind
		).toBe("l");
		const continuous = timeline(
			[...linked(a, 0, 2, 6), ...linked(a, 4, 6, 9)],
			assets
		);
		expect(
			proposeSplitEdits(continuous, assets, words).proposals[0]?.reason
		).toBe("continuous-source");
	});

	test("orders proposals by cut time, is deterministic, and never mutates input", () => {
		const a = take("A");
		const b = take("B");
		const c = take("C");
		const assets = assetsOf(a, b, c);
		const project = timeline(
			[...linked(c, 8, 3, 7), ...linked(b, 4, 3, 7), ...linked(a, 0, 2, 6)],
			assets
		);
		const before = structuredClone(project);
		const words = evidence({
			[a.audio.id]: [word(5.6, 6.6)],
			[b.audio.id]: [word(2.6, 3.5)],
			[c.audio.id]: [],
		});
		const first = proposeSplitEdits(project, assets, words);
		const second = proposeSplitEdits(project, assets, words);
		expect(first).toEqual(second);
		expect(first.proposals.map((proposal) => proposal.cutTime)).toEqual([4, 8]);
		expect(project).toEqual(before);
	});
});

describe("offset AI takes do not borrow their source's timebase", () => {
	test("AI edits, lip-sync takes and AI mattes start at their source range", () => {
		const source = camera("source");
		const derived = (derivation: Asset["derivation"]): Asset => ({
			...camera(`${derivation}`),
			derivation,
			derivedFromAssetId: source.id,
		});
		for (const derivation of ["ai-edit", "lipsync", "ai-matte"] as const) {
			const takeAsset = derived(derivation);
			expect(sameMediaTimebase(takeAsset, source)).toBe(false);
			expect(sameMediaTimebase(source, takeAsset)).toBe(false);
			expect(sharesSourceTime(takeAsset)).toBe(false);
		}
		expect(sameMediaTimebase(derived("proxy"), source)).toBe(true);
		expect(sharesSourceTime(derived("audio"))).toBe(true);
	});

	test("an AI take next to its source clip is not continuous source", () => {
		const a = take("A");
		// The AI edit was made from A's source 20..30 s: its time 0 is A's 20 s.
		const edited: Asset = {
			...camera("A edited"),
			derivation: "ai-edit",
			derivedFromAssetId: a.video.id,
		};
		const stabilized: Asset = {
			...camera("A stabilized"),
			derivation: "stabilize",
			derivedFromAssetId: a.video.id,
		};
		const cutWith = (visual: Asset) => {
			const assets = [...assetsOf(a), visual];
			const project = timeline(
				[...linked(a, 0, 0, 4, { visual }), ...linked(a, 4, 4, 8)],
				assets
			);
			return onlyCut(project, assets);
		};
		expect(cutWith(stabilized).continuousSource).toBe(true);
		expect(cutWith(edited).continuousSource).toBe(false);
	});
});

describe("split edit rounding and clamping", () => {
	const volume = (time: number, value: number) => ({
		id: crypto.randomUUID(),
		property: "volume" as const,
		time,
		value,
	});

	/** A then B with decimal source ranges; B starts where A ends. */
	function decimalPair(
		aRange: [number, number],
		bRange: [number, number],
		options: { speed?: number; outKeys?: boolean; inKeys?: boolean } = {}
	) {
		const speed = options.speed ?? 1;
		const a = take("A", 20);
		const b = take("B", 20);
		const assets = assetsOf(a, b);
		const [aVideo, aAudio] = linked(a, 0, aRange[0], aRange[1], { speed });
		const aLength = (aRange[1] - aRange[0]) / speed;
		const [bVideo, bAudio] = linked(b, aLength, bRange[0], bRange[1], {
			speed,
		});
		const bLength = (bRange[1] - bRange[0]) / speed;
		const keyedA = options.outKeys
			? { ...aAudio, keyframes: [volume(0, 1), volume(aLength, 0.5)] }
			: aAudio;
		const keyedB = options.inKeys
			? { ...bAudio, keyframes: [volume(0, 0.4), volume(bLength, 1)] }
			: bAudio;
		return {
			aAudio,
			assets,
			bAudio,
			project: timeline([aVideo, keyedA, bVideo, keyedB], assets),
		};
	}

	test("rolls audio with a volume keyframe at its tail over decimal ranges", () => {
		const pairs: [[number, number], [number, number]][] = [
			[
				[1.1, 3.3],
				[3.63, 7.97],
			],
			[
				[0.22, 3.3],
				[3.63, 7.97],
			],
			[
				[1.37, 5.83],
				[2.19, 9.41],
			],
		];
		for (const [aRange, bRange] of pairs) {
			const { project, assets } = decimalPair(aRange, bRange, {
				inKeys: true,
				outKeys: true,
			});
			for (const offset of [-0.5, -0.13, 0.27, 0.5]) {
				const result = applySplitEdit(
					project,
					assets,
					onlyCut(project, assets),
					{ offset }
				);
				expect(() => validateProject(result.project, assets)).not.toThrow();
			}
		}
	});

	test("keeps slow-motion partners on their track after rounding", () => {
		const cases: [[number, number], [number, number], number, number][] = [
			[[1.137, 4.208], [5.113, 12.05], -0.37, 0],
			[[1.411, 4.624], [5.339, 12.05], -0.37, 0.08],
		];
		for (const [aRange, bRange, offset, crossfade] of cases) {
			const { project, assets, aAudio, bAudio } = decimalPair(aRange, bRange, {
				speed: 0.5,
			});
			const result = applySplitEdit(project, assets, onlyCut(project, assets), {
				crossfade,
				offset,
			}).project;
			expect(segment(result, aAudio.id).track).toBe(1);
			expect(segment(result, bAudio.id).track).toBe(1);
		}
	});

	test("shortens the opposite fade when the roll leaves too little clip", () => {
		const a = take("A");
		const b = take("B");
		const assets = assetsOf(a, b);
		const [aVideo, aAudio] = linked(a, 0, 2, 6);
		const [bVideo, bAudio] = linked(b, 4, 3, 5);
		const project = timeline(
			[aVideo, aAudio, bVideo, { ...bAudio, fadeOut: 1.5 }],
			assets
		);
		const result = applySplitEdit(project, assets, onlyCut(project, assets), {
			offset: 1,
		}).project;
		const incoming = segment(result, bAudio.id);
		const length = (incoming.sourceOut - incoming.sourceIn) / incoming.speed;
		expect(incoming.fadeOut).toBeLessThan(1.5);
		expect(incoming.fadeIn + incoming.fadeOut).toBeLessThanOrEqual(length);
		expect(() => validateProject(result, assets)).not.toThrow();
	});

	test("a straight cut after a J-cut interpolates trimmed keyframes instead of restoring them", () => {
		const { project, assets, aAudio } = interview();
		const keyed = timeline(
			project.segments.map((item) =>
				item.id === aAudio.id
					? { ...item, keyframes: [volume(0, 1), volume(3.5, 0.2)] }
					: item
			),
			assets
		);
		const split = applySplitEdit(keyed, assets, onlyCut(keyed, assets), {
			crossfade: 0,
			offset: -1,
		}).project;
		const restored = applySplitEdit(split, assets, onlyCut(split, assets), {
			crossfade: 0,
			offset: 0,
		}).project;
		const outgoing = segment(restored, aAudio.id);
		expect(outgoing.sourceOut).toBe(aAudio.sourceOut);
		const frames = outgoing.keyframes.map((frame) => [frame.time, frame.value]);
		expect(frames[0]).toEqual([0, 1]);
		expect(frames[1]?.[0]).toBe(3);
		expect(frames[1]?.[1]).toBeCloseTo(1 - (0.8 * 3) / 3.5, 6);
	});

	test("options require a positive minimum no larger than the maximum", () => {
		const { project, assets } = interview();
		const none = evidence({ [project.segments[1]?.assetId ?? ""]: [] });
		expect(() =>
			proposeSplitEdits(project, assets, none, { minOffset: 0 })
		).toThrow();
		expect(() =>
			proposeSplitEdits(project, assets, none, {
				maxOffset: 0.5,
				minOffset: 0.6,
			})
		).toThrow();
		const [proposal] = proposeSplitEdits(
			project,
			assets,
			{
				waveformFor: () => undefined,
				wordsFor: () => ({ measured: true, words: [] }),
			},
			{ minOffset: 0.04 }
		).proposals;
		expect(proposal?.reason).toBe("no-evidence");
	});
});
